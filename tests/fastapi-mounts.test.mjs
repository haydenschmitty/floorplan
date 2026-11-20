// FastAPI: routers included with app.include_router() under a prefix, and names handed to it that this file
// neither made nor imported (what a factory returned, a router from an installed package), which must not put
// their prefix, or the checks added where they're included, on the file's other routers (the Python side of #71).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, makeProject, run, scanAndBuild, readGraph, readJson, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

/** "METHOD /path <- file" for every endpoint the scan finds in `files` (over a copy of a fixture, if given). */
function routesOf(files, fixture) {
  const root = makeProject(files);
  try {
    if (fixture) fs.cpSync(path.join(REPO, 'tests', 'fixtures', fixture), root, { recursive: true });
    run('scan.mjs', root);
    return readJson(path.join(root, 'floorplan', '.cache', 'scan.json')).routes.map((r) => `${r.method} ${r.path} <- ${r.file}`).sort();
  } finally {
    cleanup(root);
  }
}

test('a router a factory returned keeps its prefix to itself, so the other routers get only their own', () => {
  // main.py includes a router it made, one make_graphql_router() returned under /api/v1/graphql, and items
  // under /api/v1/items. Taking graphql_router for a router of main.py put /api/v1/graphql on the items too.
  assert.deepEqual(routesOf({}, 'fastapi-mounts'), [
    'DELETE /api/v1/items/{item_id} <- app/routers/items.py',
    'GET /api/v1/items/list <- app/routers/items.py',
    'GET /api/v1/status/ping <- app/main.py',
  ]);
});

test('a check added where that router is included does not protect the other routers, so Health still finds them', () => {
  const arch = { project: { name: 'items', summary: 'Test fixture.' }, nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['**'] }] };
  const root = makeProject({
    'app/__init__.py': '',
    'app/deps.py': [
      `from fastapi import Header, HTTPException`,
      ``,
      `def require_admin(authorization: str = Header(...)):`,
      `    if authorization != "Bearer admin":`,
      `        raise HTTPException(status_code=401)`,
    ].join('\n'),
    'app/main.py': [
      `from fastapi import Depends, FastAPI`,
      `from app.deps import require_admin`,
      `from app.graphql import make_graphql_router`,
      `from app.routers import items`,
      ``,
      `app = FastAPI()`,
      `graphql_router = make_graphql_router()`,
      `app.include_router(graphql_router, prefix="/graphql", dependencies=[Depends(require_admin)])`,
      `app.include_router(items.router, prefix="/items")`,
    ].join('\n'),
    'app/graphql.py': `from graphql_kit import router_for\n\ndef make_graphql_router():\n    return router_for("schema.graphql")\n`,
    'app/routers/__init__.py': '',
    'app/routers/items.py': `from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.delete("/{item_id}")\nasync def delete_item(item_id: int):\n    return {"deleted": item_id}\n`,
  }, { repos: ['.'], arch });
  try {
    scanAndBuild(root);
    const graph = readGraph(root);
    assert.deepEqual(openEndpoints(graph), ['DELETE /items/{item_id}']);
    assert.deepEqual(routeKeys(graph), ['DELETE /items/{item_id}']);
  } finally {
    cleanup(root);
  }
});

test('a factory called in place and a router from an installed package are not this file\'s routers either', () => {
  assert.deepEqual(routesOf({
    'app/__init__.py': '',
    'app/main.py': [
      `from fastapi import FastAPI`,
      `from shared_health import health_router`,
      `from app.routers import orders`,
      ``,
      `app = FastAPI()`,
      ``,
      `def make_admin_router():`,
      `    return build_admin_router()`,
      ``,
      `app.include_router(health_router, prefix="/health")`,
      `app.include_router(make_admin_router(), prefix="/admin")`,
      `app.include_router(orders.router, prefix="/api")`,
    ].join('\n'),
    'app/routers/__init__.py': '',
    'app/routers/orders.py': `from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.post("/orders")\nasync def place_order():\n    return {"ok": True}\n`,
  }), ['POST /api/orders <- app/routers/orders.py']);
});

test('a router this file made still gets the prefix it is included with, however it is declared', () => {
  assert.deepEqual(routesOf({
    'app/__init__.py': '',
    'app/main.py': [
      `from fastapi import APIRouter, FastAPI`,
      `from app.lib import make_router`,
      ``,
      `app = FastAPI()`,
      `status_router = APIRouter()`,
      `admin_router: APIRouter = APIRouter()`,
      // made by a factory, but the routes declared on it here make it this file's router
      `jobs_router = make_router()`,
      ``,
      `@status_router.get("/ping")`,
      `async def ping():`,
      `    return {"ok": True}`,
      ``,
      `@admin_router.post("/reset")`,
      `async def reset():`,
      `    return {"ok": True}`,
      ``,
      `@jobs_router.get("/{job_id}")`,
      `async def job(job_id: int):`,
      `    return {"id": job_id}`,
      ``,
      `app.include_router(status_router, prefix="/status")`,
      `app.include_router(admin_router, prefix="/admin")`,
      `app.include_router(jobs_router, prefix="/jobs")`,
    ].join('\n'),
  }), [
    'GET /jobs/{job_id} <- app/main.py',
    'GET /status/ping <- app/main.py',
    'POST /admin/reset <- app/main.py',
  ]);
});

test('a router that only holds other routers hands its prefix on to them, however it is declared', () => {
  const users = `from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get("/me")\nasync def me():\n    return {}\n`;
  const withMain = (main) => ({ 'app/__init__.py': '', 'app/routers/__init__.py': '', 'app/routers/users.py': users, 'app/main.py': main.join('\n') });
  for (const made of ['api_router: APIRouter = APIRouter()', 'api_router = fastapi.routing.APIRouter()']) {
    assert.deepEqual(routesOf(withMain([
      `import fastapi`,
      `from fastapi import APIRouter, FastAPI`,
      `from app.routers import users`,
      ``,
      `app = FastAPI()`,
      made,
      `api_router.include_router(users.router, prefix="/users")`,
      `app.include_router(api_router, prefix="/api")`,
    ])), ['GET /api/users/me <- app/routers/users.py'], made);
  }
  // the same for a Flask blueprint registered in another one
  assert.deepEqual(routesOf({
    'app/__init__.py': '',
    'app/views/__init__.py': '',
    'app/views/users.py': `from flask import Blueprint\n\nbp = Blueprint("users", __name__)\n\n@bp.route("/me")\ndef me():\n    return {}\n`,
    'app/main.py': [
      `from flask import Blueprint, Flask`,
      `from app.views import users`,
      ``,
      `app = Flask(__name__)`,
      `api: Blueprint = Blueprint("api", __name__)`,
      `api.register_blueprint(users.bp, url_prefix="/users")`,
      `app.register_blueprint(api, url_prefix="/api")`,
    ].join('\n'),
  }), ['GET /api/users/me <- app/views/users.py']);
});

test('a router made with a type annotation or a longer module name gets the prefix it is made with', () => {
  assert.deepEqual(routesOf({
    'app/__init__.py': '',
    'app/main.py': [
      `import fastapi`,
      `from fastapi import APIRouter, FastAPI`,
      ``,
      `app = FastAPI()`,
      `admin_router: APIRouter = APIRouter(prefix="/admin")`,
      `jobs_router = fastapi.routing.APIRouter(prefix="/jobs")`,
      ``,
      `@admin_router.post("/reset")`,
      `async def reset():`,
      `    return {"ok": True}`,
      ``,
      `@jobs_router.get("/{job_id}")`,
      `async def job(job_id: int):`,
      `    return {"id": job_id}`,
      ``,
      `app.include_router(admin_router)`,
      `app.include_router(jobs_router)`,
    ].join('\n'),
  }), ['GET /jobs/{job_id} <- app/main.py', 'POST /admin/reset <- app/main.py']);
});
