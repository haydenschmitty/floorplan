// FastAPI / Starlette: an @app.middleware("http") function that turns callers away protects every
// route, and one that doesn't protects nothing (#86).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, scanAndBuild, readGraph, cleanup, openEndpoints } from './helpers.mjs';

const arch = {
  project: { name: 'devices', summary: 'Test fixture.' },
  nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['**'] }],
};

const HEAD = [
  `from fastapi import FastAPI, HTTPException, Request, status`,
  `from fastapi.responses import JSONResponse, RedirectResponse`,
  `from .routes import router`,
  ``,
  `app = FastAPI()`,
  `app.include_router(router, prefix="/api")`,
  ``,
];

/** Maps a one-repo FastAPI app with `middleware` in app/main.py and its routes in app/routes.py. */
function mapWith(middleware) {
  const root = makeProject({
    'app/__init__.py': '',
    'app/main.py': [...HEAD, middleware, ``, `@app.get("/devices")`, `async def list_devices():`, `    return [{"name": "laptop"}]`, ``].join('\n'),
    'app/routes.py': [
      `from fastapi import APIRouter`,
      `router = APIRouter()`,
      ``,
      `@router.delete("/devices/{device_id}")`,
      `async def delete_device(device_id: str):`,
      `    return {"deleted": device_id}`,
      ``,
    ].join('\n'),
  }, { repos: ['.'], arch });
  try {
    scanAndBuild(root);
    return readGraph(root);
  } finally {
    cleanup(root);
  }
}

const ALL_OPEN = ['DELETE /api/devices/{device_id}', 'GET /devices'];

test('FastAPI: an HTTP middleware that answers 401 protects every route, in every file (#86)', () => {
  const graph = mapWith([
    `@app.middleware("http")`,
    `async def require_login(request: Request, call_next):`,
    `    if request.url.path != "/login" and not request.cookies.get("session"):`,
    `        return JSONResponse({"error": "unauthorized"}, status_code=401)`,
    `    return await call_next(request)`,
  ].join('\n'));
  assert.ok(graph.routes.some((r) => r.p === '/api/devices/{device_id}'), 'expected the router\'s endpoint');
  assert.deepEqual(openEndpoints(graph), []);
});

test('FastAPI: other ways an HTTP middleware turns callers away count too (#86)', () => {
  for (const middleware of [
    // an allow list first, then a 401 for API calls and a redirect for pages
    [`@app.middleware("http")`, `async def guard(request: Request, call_next):`,
      `    if request.url.path in ("/login", "/api/login") or valid_session(request.cookies):`,
      `        return await call_next(request)`,
      `    if request.url.path.startswith("/api/"):`,
      `        return JSONResponse(`, `            {"error": "unauthorized"},`, `            status_code=status.HTTP_401_UNAUTHORIZED,`, `        )`,
      `    return RedirectResponse("/login")`],
    [`@app.middleware("http")`, `async def check_api_key(request: Request, call_next):`,
      `    if request.headers.get("x-api-key") != settings.api_key:`,
      `        raise HTTPException(status_code=403, detail="Forbidden")`,
      `    return await call_next(request)`],
  ]) assert.deepEqual(openEndpoints(mapWith(middleware.join('\n'))), [], middleware[1]);
});

test('FastAPI: an HTTP middleware that never turns anyone away protects nothing (#86)', () => {
  for (const middleware of [
    // adds a header
    [`@app.middleware("http")`, `async def no_store(request: Request, call_next):`,
      `    response = await call_next(request)`,
      `    response.headers["Cache-Control"] = "no-store"`,
      `    return response`],
    // reads a 401 from the response, but lets every request through
    [`@app.middleware("http")`, `async def log_denied(request: Request, call_next):`,
      `    response = await call_next(request)`,
      `    if response.status_code == 401:`,
      `        print("unauthorized", request.url.path)`,
      `    return response`],
    // named like a guard, but only measures time
    [`@app.middleware("http")`, `async def auth_timer(request: Request, call_next):`,
      `    started = time.monotonic()`,
      `    response = await call_next(request)`,
      `    response.headers["X-Time"] = str(time.monotonic() - started)`,
      `    return response`],
  ]) assert.deepEqual(openEndpoints(mapWith(middleware.join('\n'))), ALL_OPEN, middleware[1]);
});
