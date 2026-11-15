// Endpoints declared as data instead of app.get(…) calls: route-table objects ({ method, path, handle })
// with string or regex paths, and the literal keys of Bun.serve({ routes }). The website's requests
// reach them, and Health stays quiet about login checks it can't see (they live in the dispatcher).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { regexRoutePaths } = await lib('route-tables.mjs');

const routesOf = (src, file = 'server/routes.ts') =>
  extract(src, 'typescript', file).routes.map((r) => `${r.method} ${r.path} ${r.framework} L${r.line} ${r.handler ?? '-'}`);

test('a regex path becomes route paths: captures are parameters, literal alternatives expand', () => {
  const cases = [
    [String.raw`^\/api\/items\/([^/]+)\/content$`, ['/api/items/:p1/content']],
    [String.raw`^\/api\/rules\/(?!check$)([^/]+)$`, ['/api/rules/:p1']],
    [String.raw`^\/api\/(?:mails|inbox)\/([^/]+)\/files$`, ['/api/mails/:p1/files', '/api/inbox/:p1/files']],
    [String.raw`^\/api\/templates\/([^/]+)\/(?:reset-to-defaults|reset)$`, ['/api/templates/:p1/reset-to-defaults', '/api/templates/:p1/reset']],
    [String.raw`^\/files\/(.+)$`, ['/files/*']],
    [String.raw`^\/api\/orders\/(\d+)\/lines\/(\w+)\/?$`, ['/api/orders/:p1/lines/:p2']],
    [String.raw`^\/api\/report\.csv$`, ['/api/report.csv']],
    [String.raw`^\/api\/items(?:\/)?$`, ['/api/items']],
    [String.raw`^\/api\/items\/([^/]+)(?:\/edit)?$`, ['/api/items/:p1', '/api/items/:p1/edit']],
    [String.raw`^\/api\/a$|^\/shop\/b$`, ['/api/a', '/shop/b']],
  ];
  for (const [source, paths] of cases) assert.deepEqual(regexRoutePaths(source), paths, source);
});

test('up to eight combinations expand; a group that would pass eight becomes a wildcard segment', () => {
  assert.equal(regexRoutePaths(String.raw`^\/api\/(?:aa|bb)\/(?:cc|dd)\/(?:ee|ff)$`).length, 8);
  assert.deepEqual(regexRoutePaths(String.raw`^\/api\/(?:aa|bb|cc)\/(?:dd|ee|ff)$`), ['/api/aa/*', '/api/bb/*', '/api/cc/*']);
  // the eight are counted across the whole regex, not per alternative
  assert.deepEqual(
    regexRoutePaths(String.raw`^\/api\/(?:aa|bb|cc|dd|ee)$|^\/shop\/(?:ff|gg|hh|ii)$`),
    ['/api/aa', '/api/bb', '/api/cc', '/api/dd', '/api/ee', '/shop/*'],
  );
});

test('odd or unanchored regexes never throw and only yield paths with a real word in them', () => {
  for (const source of ['', '^$', '(', ')', '[', '\\', '^(?:', '^\\/(', '^\\/([^/]+)$', '^\\/\\d+$', 'a|b', '^.*$', '(?<=x', '[^/]+)', '^\\/(a|b']) {
    const paths = regexRoutePaths(source);
    assert.ok(Array.isArray(paths), source);
    for (const p of paths) assert.match(p, /^\/(?:.*\/)?[A-Za-z]{2,}/, `${source} -> ${p}`);
  }
  assert.deepEqual(regexRoutePaths('^\\/([^/]+)$'), []);
  // regex syntax left in a segment drops that path rather than widening it to match anything
  assert.deepEqual(regexRoutePaths(String.raw`^\/api\/report.csv$`), []);
  assert.deepEqual(regexRoutePaths(String.raw`^\/api\/(?:items|orders)+$`), []);
  assert.deepEqual(regexRoutePaths(String.raw`^\/api\/item-(\d+)$`), []);
  assert.deepEqual(regexRoutePaths('api\\/items'), []);
});

test('route-table objects are endpoints, in any key order, with the line of their path and their handler', () => {
  const src = [
    `import { listItems, removeItem } from './handlers';`,
    `export const ROUTES = [`,
    `  { method: "GET", path: "/api/items", handle: listItems },`,
    `  {`,
    `    path: /^\\/api\\/items\\/([^/]+)\\/notes$/,`,
    `    limits: { perMinute: 10 },`,
    `    method: "POST",`,
    `    handle: async ({ req, params }) => {`,
    `      return await addNote(req, params[0], "}, {");`,
    `    },`,
    `  },`,
    `  { method: 'DELETE', path: '/api/items/:id', handler: removeItem },`,
    "  { method: `PATCH`, path: `/api/items/:id/tags`, action: function (ctx) { return tagItem(ctx); } },",
    `  { method: "get", path: "/api/search", resolve: (ctx) => search.run(ctx) },`,
    `  { method: "PUT", path: /^\\/api\\/(?:items|products)\\/([^/]+)$/, fetch: (ctx) => saveItem(ctx) },`,
    `];`,
    `export function formatItem(item) { return item; }`,
  ].join('\n');
  assert.deepEqual(routesOf(src), [
    'GET /api/items table L3 listItems',
    'POST /api/items/:p1/notes table L5 addNote',
    'DELETE /api/items/:id table L12 removeItem',
    'PATCH /api/items/:id/tags table L13 tagItem',
    'GET /api/search table L14 run',
    'PUT /api/items/:p1 table L15 saveItem',
    'PUT /api/products/:p1 table L15 saveItem',
  ]);
});

test('objects without a handler, and paths the scanner cannot read, are not endpoints', () => {
  const src = [
    `const ITEMS = "/api/items";`,
    `queue.push({ method: "POST", path: "/api/items/sync", body: payload });`,
    `fetch(url, { method: "POST", headers: { path: "/x" } });`,
    `export const ROUTES = [`,
    `  { method: "GET", path: ITEMS, handle: listItems },`,
    `  { method: "GET", path: new RegExp("^/api/items/" + kind + "$"), handle: listItems },`,
    `  { method: "GET", path: buildPath("items"), handle: listItems },`,
    `  { method: "FETCH", path: "/api/odd", handle: listItems },`,
    `  { method: "GET", path: "api/relative", handle: listItems },`,
    `  { method: "GET", path: /^\\/\\d+$/, handle: listItems },`,
    `];`,
  ].join('\n');
  assert.deepEqual(routesOf(src), []);
});

test('Bun.serve routes: method objects give one endpoint per method, anything else serves every method', () => {
  const src = [
    `import { listCarts, createCart } from './carts';`,
    `const server = Bun.serve({`,
    `  port: 3000,`,
    `  routes: {`,
    `    "/api/status": new Response("ok"),`,
    `    "/api/carts": {`,
    `      GET: listCarts,`,
    `      POST: async (req) => createCart(await req.json()),`,
    `    },`,
    `    '/api/carts/:id': (req) => showCart(req.params.id),`,
    `    "/static/*": Bun.file("./public/index.html"),`,
    `    "/api/ping": Response.json({ ok: true }),`,
    `    "/api/health": healthHandler,`,
    `  },`,
    `  fetch(req) { return new Response("Not found", { status: 404 }); },`,
    `});`,
  ].join('\n');
  assert.deepEqual(routesOf(src, 'server/index.ts'), [
    'ANY /api/status table L5 -',
    'GET /api/carts table L6 listCarts',
    'POST /api/carts table L6 createCart',
    'ANY /api/carts/:id table L10 showCart',
    'ANY /static/* table L11 -',
    'ANY /api/ping table L12 -',
    'ANY /api/health table L13 healthHandler',
  ]);
  // with a type argument for websocket data
  assert.deepEqual(routesOf(src.replace('Bun.serve(', 'Bun.serve<SocketData>('), 'server/index.ts').length, 7);
  // the same object outside a file that starts Bun.serve is just data
  assert.deepEqual(routesOf(src.replace('Bun.serve(', 'configure('), 'server/index.ts'), []);
});

test("a website's list of the requests it makes is not a route table", () => {
  // `action`, `resolve` and `fetch` are as common in an API client's call list as in a server's routes
  const client = [
    `export const CALLS = [`,
    `  { method: "GET", path: "/api/orders", resolve: (res) => res.json() },`,
    `  { method: "POST", path: "/api/orders", action: "createOrder" },`,
    `  { method: "DELETE", path: "/api/orders/:id", fetch: (url) => send(url, { method: "DELETE" }) },`,
    `  { method: "PUT", path: "/api/orders/:id", action: saveOrder },`,
    `];`,
  ].join('\n');
  assert.deepEqual(routesOf(client, 'web/src/calls.ts'), []);
  // a handler that's a string or an object isn't a function, so that object isn't a route either
  assert.deepEqual(routesOf(`export const R = [{ method: "GET", path: "/api/orders", handler: "listOrders" }, { method: "GET", path: "/api/x", handle: { cache: true } }];`), []);
});

test('the same objects are routes in a file that serves, or beside one with a handle', () => {
  const routes = [
    `const ROUTES = [`,
    `  { method: "GET", path: "/api/orders", resolve: (ctx) => listOrders(ctx) },`,
    `  { method: "PUT", path: "/api/orders/:id", action: saveOrder },`,
    `  { method: "DELETE", path: "/api/orders/:id", fetch: (req) => removeOrder(req) },`,
    `];`,
  ];
  const expected = ['GET /api/orders table L2 listOrders', 'PUT /api/orders/:id table L3 saveOrder', 'DELETE /api/orders/:id table L4 removeOrder'];
  assert.deepEqual(routesOf([...routes, `createServer((req, res) => dispatch(ROUTES, req, res)).listen(3000);`].join('\n'), 'server/index.ts'), expected);
  assert.deepEqual(routesOf([...routes, `export default { fetch: (req) => dispatch(ROUTES, req) };`].join('\n'), 'server/index.ts'), expected);
  assert.deepEqual(routesOf([...routes.slice(0, -1), `  { method: "GET", path: "/api/health", handle: health },`, `];`].join('\n'), 'server/routes.ts'),
    [...expected, 'GET /api/health table L5 health']);
  // the route's own path isn't a request this file makes
  assert.deepEqual(extract([...routes, `Bun.serve({ port: 3000, routes: { "/api/carts": { GET: listCarts } }, fetch: (req) => dispatch(ROUTES, req) });`].join('\n'), 'typescript', 'server/index.ts').calls, []);
});

test("a Fastify route object is one endpoint, and hapi's lists of them are read as a table", () => {
  const src = [
    `const app = Fastify();`,
    `app.route({ method: "GET", path: "/api/items", handler: listItems });`,
    `server.route([`,
    `  { method: "POST", path: "/api/items", handler: createItem },`,
    `  { method: "DELETE", path: "/api/items/{id}", handler: (request) => removeItem(request.params.id) },`,
    `]);`,
  ].join('\n');
  assert.deepEqual(extract(src, 'typescript', 'api/src/app.ts').routes.map((r) => `${r.method} ${r.path}`), [
    'GET /api/items', 'POST /api/items', 'DELETE /api/items/{id}',
  ]);
});

test('Health still reads the login check of an Express route in a file that also has a route table', () => {
  const mixed = makeProject({
    'api/package.json': JSON.stringify({ name: 'api', dependencies: { express: '^4' } }),
    'api/routes.js': [
      `import express from 'express';`,
      `const router = express.Router();`,
      `router.get('/api/notes', (req, res) => res.json([]));`,
      `export const ROUTES = [{ method: "GET", path: "/api/catalog", handle: listCatalog }];`,
      `router.get('/api/admin/stats', (req, res) => {`,
      `  if (!req.user) return res.status(401).end();`,
      `  res.json({});`,
      `});`,
      `export default router;`,
    ].join('\n'),
  }, { arch: { project: { name: 'mixed', summary: 'Test fixture.' }, nodes: [{ id: 'api', label: 'API', kind: 'service', summary: 'The API.', paths: ['api/**'] }] } });
  try {
    run('scan.mjs', mixed);
    run('build.mjs', mixed, '--no-claude-md');
    const g = readGraph(mixed);
    assert.deepEqual(routeKeys(g), ['GET /api/admin/stats', 'GET /api/catalog', 'GET /api/notes']);
    assert.deepEqual(openEndpoints(g), ['GET /api/notes']);
  } finally {
    cleanup(mixed);
  }
});

let root, graph;
before(() => {
  root = makeProject({}, { arch: {
    project: { name: 'route-tables', summary: 'Test fixture.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The shop website.', paths: ['web/**'] },
      { id: 'api', label: 'Shop server', kind: 'service', summary: 'The Bun server.', paths: ['server/**'] },
    ],
  } });
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'route-tables'), root, { recursive: true });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test("a shop's route table and Bun.serve routes are on the map, and the website's requests reach them", () => {
  assert.deepEqual(routeKeys(graph), [
    'ANY /api/health', 'ANY /assets/*',
    'DELETE /api/products/:id',
    'GET /api/carts/:cartId', 'GET /api/coupons/:p1', 'GET /api/products', 'GET /api/products/:p1', 'GET /api/products/:p1/content', 'GET /downloads/*',
    'POST /api/carts/:cartId', 'POST /api/coupons/validate', 'POST /api/items/:p1/reviews', 'POST /api/products/:p1/reviews',
    'PUT /api/products/:id',
  ]);
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${[...l.labels].sort().join(', ')}`).sort();
  assert.deepEqual(http, [
    'web/src/api.ts -> server/src/routes/catalog.ts GET /api/products, GET /api/products/:p1, GET /api/products/:p1/content, POST /api/coupons/validate, POST /api/items/:p1/reviews',
    'web/src/api.ts -> server/src/server.ts GET /api/carts/:cartId, POST /api/carts/:cartId',
  ]);
});

test('Health does not call these endpoints open: their login checks live in a dispatcher it cannot see', () => {
  assert.ok(graph.routes.length > 0);
  assert.deepEqual(openEndpoints(graph), []);
});
