// Health check regression tests: build a map of a small sample project and check which endpoints
// Health reports as open to anyone. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'skills', 'floorplan', 'scripts');

/** Copies a fixture to a temp folder, maps it as one module, and returns the built graph. */
function buildFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `floorplan-${name}-`));
  fs.cpSync(path.join(here, 'fixtures', name), root, { recursive: true });
  fs.mkdirSync(path.join(root, 'floorplan'));
  fs.writeFileSync(path.join(root, 'floorplan', 'architecture.json'), JSON.stringify({
    project: { name, summary: 'Test fixture.' },
    nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['**'] }],
  }));
  for (const s of ['scan.mjs', 'build.mjs']) execFileSync(process.execPath, [path.join(scripts, s), root, '--no-claude-md'], { stdio: 'pipe' });
  const graph = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', 'graph.json'), 'utf8'));
  fs.rmSync(root, { recursive: true, force: true });
  return graph;
}

/** "METHOD /path" for every endpoint Health reports as callable by anyone. */
function openEndpoints(graph) {
  return graph.health.issues
    .filter((i) => i.kind === 'unprotected-endpoint')
    .flatMap((i) => i.items.filter((id) => id.startsWith('r:')).map((id) => graph.routes[+id.slice(2)]))
    .map((r) => `${r.m} ${r.p}`)
    .sort();
}

test('FastAPI: Annotated dependency aliases count as sign-in checks (#4)', () => {
  const graph = buildFixture('fastapi-annotated');
  assert.ok(graph.routes.length >= 8, `expected the sample's 8 endpoints, found ${graph.routes.length}`);
  // imported alias (AdminUser), same-file alias (MemberUser), an alias whose dependency takes
  // AdminUser (OwnedOffice) and an alias whose own name reads as a check (AdminAccess) are all protected;
  // routes with only a database session (SessionDep, SqlSessionDep over get_sql_session) aren't
  assert.deepEqual(openEndpoints(graph), ['POST /comments', 'POST /feedback']);
});

test('FastAPI: dependencies with guard in their name protect routes (#7)', () => {
  const graph = buildFixture('fastapi-annotated');
  assert.ok(graph.routes.some((r) => r.p === '/internal/metrics'));
  assert.ok(!openEndpoints(graph).includes('GET /internal/metrics'));
});

test('FastAPI: checks added where a router is included count as sign-in checks', () => {
  const graph = buildFixture('fastapi-include-router');
  assert.equal(graph.routes.length, 4, `expected the sample's 4 endpoints, found ${graph.routes.length}`);
  // the router imported under another name (item_routes) still gets its prefix
  assert.ok(graph.routes.some((r) => r.p === '/items/{item_id}'), 'expected /items/{item_id}');
  // app.include_router(staff.router, dependencies=[Depends(require_admin)]) protects every staff route,
  // even with a package also called staff imported first; so does a check beside a database session,
  // over several lines; a database session alone (orders) protects nothing
  assert.deepEqual(openEndpoints(graph), ['POST /orders']);
});
