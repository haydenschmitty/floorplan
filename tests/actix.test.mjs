// actix-web: routes registered on a ServiceConfig (`cfg.route("/p", web::get().to(h))`, also split over lines)
// or on an App, and a `web::scope("/api")…configure(routes::configure_routes)` putting its prefix on every
// route of the module it configures. axum's `.route("/p", get(h))` and the attribute macros keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const arch = {
  project: { name: 'notes', summary: 'Test fixture.' },
  nodes: [
    { id: 'server', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['server/**'] },
    { id: 'web', label: 'Web app', kind: 'ui', summary: 'The sample web app.', paths: ['web/**'] },
  ],
};

const CARGO = '[package]\nname = "server"\nversion = "0.1.0"\n\n[dependencies]\nactix-web = "4"\n';

const MAIN = `mod routes;
use actix_web::{web, App, HttpServer};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .route("/health", web::get().to(routes::health))
            .route(
                "/api/exports/{id}/download",
                web::get().to(routes::download),
            )
            .service(
                web::scope("/api")
                    .wrap(Auth)
                    .configure(routes::configure_routes),
            )
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}
`;

const ROUTES = `use actix_web::web;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/atoms", web::get().to(atoms::list));
    cfg.route("/atoms", web::post().to(atoms::create));
    cfg.route(
        "/voice/transcribe",
        web::post().to(voice::transcribe),
    );
    cfg.route("/atoms/{id}", web::delete().to(atoms::delete));
}

pub async fn health() -> &'static str { "ok" }
`;

const CLIENT = `export async function transcribe(audio: Blob) {
  return fetch('/api/voice/transcribe', { method: 'POST', body: audio });
}
export const atoms = () => fetch('/api/atoms');
`;

function mapOf(files) {
  const root = makeProject(files, { arch });
  try {
    scanAndBuild(root);
    return readGraph(root);
  } finally {
    cleanup(root);
  }
}

test('actix-web: cfg.route and App.route, on one line or several', () => {
  const routes = extract(ROUTES, 'rust').routes.map((r) => `${r.method} ${r.path} :${r.line}`);
  assert.deepEqual(routes, ['GET /atoms :4', 'POST /atoms :5', 'POST /voice/transcribe :6', 'DELETE /atoms/{id} :10']);
  const main = extract(MAIN, 'rust').routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(main, ['GET /health', 'GET /api/exports/{id}/download']);
});

test('actix-web: web::scope(...).configure(module::fn) is a mount of that module under the prefix', () => {
  const { mounts } = extract(MAIN, 'rust');
  assert.deepEqual(mounts.map((m) => [m.prefix, m.spec]), [['/api', 'routes']]);
});

test('actix-web: full paths, and the web app calls matched to them', () => {
  const graph = mapOf({ 'server/Cargo.toml': CARGO, 'server/src/main.rs': MAIN, 'server/src/routes.rs': ROUTES, 'web/src/api.ts': CLIENT });
  const routes = graph.routes.map((r) => `${r.m} ${r.p} <- ${r.f}`).sort();
  assert.deepEqual(routes, [
    'DELETE /api/atoms/{id} <- server/src/routes.rs',
    'GET /api/atoms <- server/src/routes.rs',
    'GET /api/exports/{id}/download <- server/src/main.rs',
    'GET /health <- server/src/main.rs',
    'POST /api/atoms <- server/src/routes.rs',
    'POST /api/voice/transcribe <- server/src/routes.rs',
  ]);
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a} -> ${l.b}`);
  assert.ok(http.some((l) => l.startsWith('f:web/src/api.ts') && l.includes('server/src/routes.rs')), `no web -> server link in ${JSON.stringify(http)}`);
});

test('axum and the attribute macros are unchanged', () => {
  const axum = extract('let app = Router::new().route("/users", get(list_users)).route("/users", post(create));', 'rust');
  assert.deepEqual(axum.routes.map((r) => `${r.method} ${r.path}`), ['GET /users', 'POST /users']);
  const macro = extract('#[get("/items/{id}")]\nasync fn item() {}', 'rust');
  assert.deepEqual(macro.routes.map((r) => `${r.method} ${r.path}`), ['GET /items/{id}']);
});

test('actix-web: the configured module found beside main.rs when it comes in through the crate (use server::{routes})', () => {
  const main = MAIN.replace('mod routes;\n', 'use server::{routes};\n');
  const graph = mapOf({ 'server/Cargo.toml': CARGO, 'server/src/main.rs': main, 'server/src/lib.rs': 'pub mod routes;\n', 'server/src/routes/mod.rs': ROUTES });
  const routes = graph.routes.map((r) => `${r.m} ${r.p} <- ${r.f}`).sort();
  assert.ok(routes.includes('POST /api/voice/transcribe <- server/src/routes/mod.rs'), JSON.stringify(routes));
});
