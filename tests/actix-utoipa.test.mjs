// utoipa's `#[utoipa::path(put, path = "/api/tags/{id}", …)]` documents an endpoint for OpenAPI. It is not a
// call: a file that documents endpoints answered elsewhere must not be linked to them as their caller. A real
// request in the same file still counts, on its own line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const DOCS = `use actix_web::HttpResponse;

#[utoipa::path(
    put,
    path = "/api/tags/{id}",
    params(("id" = String, Path, description = "Tag ID")),
    responses((status = 200, description = "Updated tag")),
    tag = "tags",
)]
pub async fn update_tag() -> HttpResponse { HttpResponse::Ok().finish() }

#[utoipa::path(get, path = "/api/tags/{id}/children", tag = "tags")]
pub async fn children() -> HttpResponse { HttpResponse::Ok().finish() }

pub async fn ping(client: &reqwest::Client) {
    client.get("/api/tags/{id}").send().await;
}
`;

test('a utoipa path annotation is not a call; a request below it still is, on its own line', () => {
  const calls = extract(DOCS, 'rust').calls.map((c) => `${c.method} ${c.path} :${c.line}`);
  assert.deepEqual(calls, ['GET /api/tags/{id} :16']);
});

test('a file that only documents endpoints answered elsewhere is not linked to them', () => {
  const arch = {
    project: { name: 'notes', summary: 'Test fixture.' },
    nodes: [{ id: 'server', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['server/**'] }],
  };
  const files = {
    'server/Cargo.toml': '[package]\nname = "server"\nversion = "0.1.0"\n\n[dependencies]\nactix-web = "4"\n',
    'server/src/main.rs': `mod docs;
mod tags;
use actix_web::{web, App};
fn app() {
    App::new()
        .route("/api/tags/{id}", web::put().to(tags::update))
        .route("/api/tags/{id}/children", web::get().to(tags::children));
}
`,
    'server/src/tags.rs': 'pub async fn update() {}\npub async fn children() {}\n',
    'server/src/docs.rs': DOCS.replace(/\npub async fn ping[\s\S]*$/, '\n'),
  };
  const root = makeProject(files, { arch });
  let graph;
  try {
    scanAndBuild(root);
    graph = readGraph(root);
  } finally {
    cleanup(root);
  }
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a} -> ${l.b}`);
  assert.deepEqual(http.filter((l) => l.includes('docs.rs')), [], JSON.stringify(http));
  assert.ok(graph.routes.some((r) => r.p === '/api/tags/{id}' && r.f === 'server/src/tags.rs'), JSON.stringify(graph.routes));
});
