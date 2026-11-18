// Express's chained route: `app.route('/orders').get(listOrders).post(createOrder)` declares two
// endpoints on one statement, and the methods carry no path of their own. Hono's two-argument
// `app.route('/api', api)` still mounts a router, and a `route()` with nothing chained after it
// declares nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, run, readGraph, routeKeys, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const js = (body) => extract([
  `import express from 'express';`,
  `const app = express();`,
  ...body,
  `app.listen(3000);`,
].join('\n'), 'typescript', 'api/server.js');
const routesOf = (r) => r.routes.map((x) => `${x.method} ${x.path}`).sort();

test('a chained route declares one endpoint per method, on the same path', () => {
  const r = js([`app.route('/orders').get(listOrders).post(createOrder);`]);
  assert.deepEqual(routesOf(r), ['GET /orders', 'POST /orders']);
  assert.deepEqual(r.routes.map((x) => x.line), [3, 3]);
});

test('middleware in the chain, every method, and a chain over several lines', () => {
  const r = js([
    `app.route('/orders/:id')`,
    `  .get(requireAuth, getOrder)`,
    `  .put(requireAuth, updateOrder)`,
    `  .patch(updateOrder)`,
    `  .delete(deleteOrder)`,
    `  .all(anyOrder)`,
    `  .options(checkOrder)`,
    `  .head(checkOrder);`,
  ]);
  assert.deepEqual(routesOf(r), [
    'ALL /orders/:id', 'DELETE /orders/:id', 'GET /orders/:id', 'HEAD /orders/:id',
    'OPTIONS /orders/:id', 'PATCH /orders/:id', 'PUT /orders/:id',
  ]);
  assert.deepEqual(r.routes.map((x) => x.line), [4, 5, 6, 7, 8, 9, 10]);
});

test('a chained route on a router the file made, under its mount', () => {
  const r = extract([
    `import { Router } from 'express';`,
    `const router = Router();`,
    `router.route('/orders').get(listOrders).post(createOrder);`,
    `export default router;`,
  ].join('\n'), 'typescript', 'api/routes/orders.js');
  assert.deepEqual(routesOf(r), ['GET /orders', 'POST /orders']);
  assert.equal(r.routes[0].var, 'router');
});

test("look-alikes left alone: Hono's two-argument route, a route with nothing chained, a non-router", () => {
  const r = js([
    `app.route('/api', api);`,
    `app.route('/nothing');`,
    `something.route('/elsewhere').get(handler);`,
    `app.get('/plain', plain);`,
  ]);
  // the Hono mount is a mount, not endpoints; the bare route and the non-router declare nothing
  assert.deepEqual(routesOf(r), ['GET /plain']);
  assert.deepEqual(r.mounts.map((m) => `${m.prefix} ${m.var}`), ['/api api']);
});

let root, graph;
before(() => {
  root = makeProject({
    'api/package.json': JSON.stringify({ name: 'api', type: 'module', dependencies: { express: '^4.19.0' } }),
    'api/server.js': [
      `import express from 'express';`,
      `import orders from './routes/orders.js';`,
      `const app = express();`,
      `app.use('/api', orders);`,
      `app.listen(3000);`,
    ].join('\n'),
    'api/routes/orders.js': [
      `import { Router } from 'express';`,
      `const router = Router();`,
      `router.route('/orders').get(listOrders).post(createOrder);`,
      `router.route('/orders/:id').get(getOrder).delete(deleteOrder);`,
      `export default router;`,
    ].join('\n'),
    'web/package.json': JSON.stringify({ name: 'web', type: 'module' }),
    'web/src/api.js': [
      `export const listOrders = () => fetch('/api/orders').then((r) => r.json());`,
      `export const removeOrder = () => fetch('/api/orders/42', { method: 'DELETE' });`,
    ].join('\n'),
  }, {
    arch: {
      project: { name: 'Shop', summary: 'A shop with chained Express routes.' },
      nodes: [
        { id: 'api', label: 'Server', kind: 'service', summary: 'The Express server.', paths: ['api/**'] },
        { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      ],
    },
  });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('end to end: chained routes land under their mount, and the website reaches them', () => {
  assert.deepEqual(routeKeys(graph), [
    'DELETE /api/orders/:id', 'GET /api/orders', 'GET /api/orders/:id', 'POST /api/orders',
  ]);
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`).sort();
  assert.deepEqual(http, ['web/src/api.js -> api/routes/orders.js GET /api/orders, DELETE /api/orders/:id']);
});
