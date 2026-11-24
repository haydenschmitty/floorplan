// actix-web: an endpoint registered with `web::post().to(voice::transcribe)` is answered by the function
// `transcribe` in the module `voice`. The endpoint sits in that function's file when the file is found and
// really defines it; where it was registered is kept beside it. Anything else stays at the registration
// line, with the reason, rather than a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const arch = {
  project: { name: 'notes', summary: 'Test fixture.' },
  nodes: [
    { id: 'server', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['server/**'] },
    { id: 'web', label: 'Web app', kind: 'ui', summary: 'The sample web app.', paths: ['web/**'] },
  ],
};

const FILES = {
  'server/Cargo.toml': '[package]\nname = "server"\nversion = "0.1.0"\n\n[dependencies]\nactix-web = "4"\n',
  'server/src/lib.rs': 'pub mod routes;\npub mod ws;\n',
  'server/src/main.rs': `use server::{routes, ws};
use actix_web::{web, App};

async fn health() -> &'static str {
    "ok"
}

fn app() {
    App::new()
        .route("/health", web::get().to(health))
        .route("/ws", web::get().to(ws::ws_handler))
        .route("/oauth/token", web::post().to(routes::oauth::token))
        .route("/gone", web::get().to(missing::thing))
        .service(web::scope("/api").configure(routes::configure_routes));
}
`,
  'server/src/ws.rs': '// the live connection\npub async fn ws_handler() {}\n',
  'server/src/routes/mod.rs': `pub mod voice;
pub mod atoms;
pub mod oauth;
use actix_web::web;
use shared::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route(
        "/voice/transcribe",
        web::post().to(voice::transcribe),
    );
    cfg.route("/atoms", web::get().to(atoms::list));
    cfg.route("/atoms/old", web::get().to(atoms::reexported));
    cfg.route("/ext", web::get().to(handlers::thing));
}
`,
  'server/src/routes/voice.rs': `use actix_web::HttpResponse;

/// Turn a spoken message into text.
pub async fn transcribe() -> HttpResponse {
    HttpResponse::Ok().finish()
}
`,
  'server/src/routes/atoms/mod.rs': 'mod inner;\npub use self::inner::reexported;\n\npub(crate) async fn list() {}\n',
  'server/src/routes/atoms/inner.rs': 'pub async fn reexported() {}\n',
  'server/src/routes/oauth.rs': 'pub async fn token() {}\n',
  'web/src/api.ts': "export const transcribe = (audio: Blob) => fetch('/api/voice/transcribe', { method: 'POST', body: audio });\n",
};

function graphOf(files) {
  const root = makeProject(files, { arch });
  try {
    scanAndBuild(root);
    return readGraph(root);
  } finally {
    cleanup(root);
  }
}

const graph = graphOf(FILES);
const route = (key) => {
  const r = graph.routes.find((x) => `${x.m} ${x.p}` === key);
  assert.ok(r, `no ${key} in ${JSON.stringify(graph.routes.map((x) => `${x.m} ${x.p}`))}`);
  return r;
};

test('actix-web: a handler in a module file is where the endpoint sits, the registration kept beside it', () => {
  const r = route('POST /api/voice/transcribe');
  assert.deepEqual([r.f, r.l, r.h], ['server/src/routes/voice.rs', 4, 'transcribe']);
  assert.deepEqual([r.rf, r.rl], ['server/src/routes/mod.rs', 8]);
  assert.equal(r.hu, undefined);
});

test('actix-web: module directories (mod.rs), the crate import in main.rs, and a function in the same file', () => {
  const at = (key) => { const r = route(key); return [r.f, r.l, r.h, r.rf, r.rl]; };
  assert.deepEqual(at('GET /api/atoms'), ['server/src/routes/atoms/mod.rs', 4, 'list', 'server/src/routes/mod.rs', 12]);
  assert.deepEqual(at('POST /oauth/token'), ['server/src/routes/oauth.rs', 1, 'token', 'server/src/main.rs', 12]);
  assert.deepEqual(at('GET /ws'), ['server/src/ws.rs', 2, 'ws_handler', 'server/src/main.rs', 11]);
  assert.deepEqual(at('GET /health'), ['server/src/main.rs', 4, 'health', 'server/src/main.rs', 10]);
});

test('actix-web: a handler it cannot verify stays at its registration line, with the reason', () => {
  const cases = { 'GET /api/atoms/old': /no fn reexported/, 'GET /api/ext': /crate shared/, 'GET /gone': /missing/ };
  for (const [key, why] of Object.entries(cases)) {
    const r = route(key);
    assert.match(r.hu || '', why, `${key}: ${r.hu}`);
    assert.equal(r.h, null, key);
    assert.equal(r.rf, undefined, key);
  }
  assert.equal(route('GET /api/atoms/old').f, 'server/src/routes/mod.rs');
  assert.equal(route('GET /api/atoms/old').l, 13);
  assert.equal(route('GET /gone').f, 'server/src/main.rs');
});

test('actix-web: the web app call links to the handler file', () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a} -> ${l.b}`);
  assert.ok(http.includes('f:web/src/api.ts -> f:server/src/routes/voice.rs'), JSON.stringify(http));
});

test('actix-web: nested use braces, a path through the crate\'s own name, and registrations are not calls', () => {
  const g = graphOf({
    'server/Cargo.toml': FILES['server/Cargo.toml'],
    'server/src/lib.rs': 'pub mod routes;\npub mod ws;\npub mod state;\n\npub fn openapi_spec() {}\n',
    'server/src/state.rs': 'pub struct AppState;\n',
    'server/src/ws.rs': 'pub async fn ws_handler() {}\n',
    'server/src/main.rs': `use server::{
    state::{AppState},
    routes,
    ws,
};
use actix_web::{web, App};

fn app() {
    App::new()
        .route("/ws", web::get().to(ws::ws_handler))
        .route("/api/docs", web::get().to(server::openapi_spec))
        .configure(routes::configure_public_routes);
}
`,
    'server/src/routes/mod.rs': `pub mod checkout;
use actix_web::web;

pub fn configure_public_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/api/checkout", web::post().to(checkout::create));
}
`,
    'server/src/routes/checkout.rs': 'pub async fn create() {}\n',
  });
  const at = (key) => { const r = g.routes.find((x) => `${x.m} ${x.p}` === key); return r && [r.f, r.h, r.hu]; };
  assert.deepEqual(at('GET /ws'), ['server/src/ws.rs', 'ws_handler', undefined]);
  assert.deepEqual(at('GET /api/docs'), ['server/src/lib.rs', 'openapi_spec', undefined]);
  assert.deepEqual(at('POST /api/checkout'), ['server/src/routes/checkout.rs', 'create', undefined]);
  const http = g.links.filter((l) => l.k === 'http').map((l) => `${l.a} -> ${l.b}`);
  assert.deepEqual(http, [], 'a registration string is not a call to the handler it names');
});
