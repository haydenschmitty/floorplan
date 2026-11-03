// Route tables keyed by "METHOD /path" (#54): a server without a framework keeps its endpoints in a
// lookup a dispatcher reads ({ "GET /api/orders": listOrders } in JS, a dict of handlers in Python).
// The keys are the endpoints, the website's requests reach them, and Health stays quiet about their
// sign-in because the dispatcher or the handler checks it, out of sight of a per-route reading.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

let root, graph;
before(() => {
  root = makeProject({}, { arch: {
    project: { name: 'route-table-keys', summary: 'Test fixture.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      { id: 'api', label: 'Library server', kind: 'service', summary: 'Python server.', paths: ['api/**'] },
      { id: 'shop', label: 'Shop server', kind: 'service', summary: 'Node server.', paths: ['shop/**'] },
    ],
  } });
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'route-table-keys'), root, { recursive: true });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('the keys of a Python and a JS route table are endpoints; tables of other values are not', () => {
  assert.deepEqual(routeKeys(graph), [
    'GET /api/books', 'GET /api/books/{book_id}', 'GET /api/orders', 'GET /api/orders/:id', 'GET /api/status',
    'POST /api/books/{book_id}/loans', 'POST /api/login', 'POST /api/orders',
  ]);
  const files = new Set(graph.routes.map((r) => r.f));
  assert.deepEqual([...files].sort(), ['api/library/app.py', 'shop/server.js']);
});

test('each entry names its handler: a function, a module function, a lambda that calls one, a wrapped one', () => {
  const py = extract(fs.readFileSync(path.join(root, 'api/library/app.py'), 'utf8'), 'python', 'api/library/app.py');
  assert.deepEqual(py.routes.map((r) => `${r.method} ${r.path} ${r.handler}`), [
    'GET /api/books list_books', 'GET /api/books/{book_id} get_book', 'POST /api/books/{book_id}/loans lend',
    'POST /api/login login', 'GET /api/status health',
  ]);
  // the handler's docstring is the route's, not the next def's after the table
  assert.equal(py.routes.find((r) => r.path === '/api/books').doc, 'The whole catalogue, newest first.');
  const js = extract(fs.readFileSync(path.join(root, 'shop/server.js'), 'utf8'), 'javascript', 'shop/server.js');
  assert.deepEqual(js.routes.map((r) => `${r.method} ${r.path} ${r.handler}`), [
    'GET /api/orders listOrders', 'POST /api/orders createOrder', 'GET /api/orders/:id getOrder',
  ]);
});

test("the website's requests reach the tables' endpoints", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`).sort();
  assert.deepEqual(http, [
    'web/src/api.js -> api/library/app.py GET /api/books, GET /api/books/{book_id}, POST /api/books/{book_id}/loans',
    'web/src/api.js -> shop/server.js GET /api/orders, POST /api/orders',
  ]);
});

test('Health does not call table endpoints open: their sign-in check is out of its sight', () => {
  assert.deepEqual(openEndpoints(graph), []);
});
