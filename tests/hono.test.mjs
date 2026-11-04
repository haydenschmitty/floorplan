// Hono: routers made by a call and mounted with app.route(path, createRoutes(...)), checks put in front
// of a path with app.use('/api/admin/*', gate), token middleware, c.req.header reads, named handlers,
// and Stripe event handlers kept apart from the webhook that checks the signature (sample in fixtures/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { findIssues } = await lib('health.mjs');

const ARCH = { arch: {
  project: { name: 'hono-app', summary: 'Test fixture.' },
  nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The Hono server.', paths: ['api/**'] }],
} };

/** Health's reading of each route in one file: [method, how it is checked, the check's name]. */
function routeChecks(src, file = 'api/src/routes.ts') {
  const f = { path: file, category: 'code', lang: 'typescript', ...extract(src, 'typescript', file) };
  return findIssues(src, f).filter((x) => x.k === 'route').map((x) => [x.method, x.via || null, x.guard || null]);
}

let root, graph;
before(() => {
  root = makeProject({}, ARCH);
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'hono-app'), root, { recursive: true });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('a router made by a call is a mount, also when the call wraps onto the next lines; Express mounts read as before', () => {
  const r = extract([
    `import { createAdminCatalogRoutes } from './admin-catalog.js';`,
    `import { createChatRoutes } from './chat.js';`,
    `import orders from './orders.js';`,
    `app.route('/api/admin/catalog', createAdminCatalogRoutes(secret));`,
    `app.route(`,
    `  "/api/chat",`,
    `  createChatRoutes(token, liveDeps(platform)),`,
    `);`,
    `app.use('/admin', requireStaff, orders);`,
    `app.use('/legacy', require('./legacy'));`,
    `app.use('/files', express.static('public'));`,
    `app.use('/ping', auth, (req, res) => res.send('ok'));`,
  ].join('\n'), 'typescript', 'api/app.ts');
  assert.deepEqual(r.mounts.map((m) => [m.prefix, m.var || m.spec, !!m.call, m.mw || []]), [
    ['/api/admin/catalog', 'createAdminCatalogRoutes', true, []],
    ['/api/chat', 'createChatRoutes', true, []],
    ['/admin', 'orders', false, ['requireStaff']],
    ['/legacy', './legacy', false, []],
    ['/files', 'express.static', true, []],
  ]);
  // none of these is a request the server makes, not even a path on a line of its own
  assert.deepEqual(r.calls, []);
});

test("a use() whose path ends in * is a check in front of the later mounts and routes under that path, not a mount", () => {
  const r = extract([
    `app.route('/api/admin/early', early());`,
    `app.use('/api/admin/*', adminGate(secret, options));`,
    `app.route('/api/admin/catalog', createCatalog(secret));`,
    `app.route('/api/shop', createShop());`,
    `app.get('/api/admin/stats', (c) => c.json({}));`,
    `app.get('/api/public', (c) => c.json({}));`,
    `router.use('*', requireServiceKey(token));`,
    `router.post('/resolve', (c) => c.json({}));`,
  ].join('\n'), 'typescript', 'api/app.ts');
  assert.deepEqual(r.mounts.map((m) => [m.prefix, m.mw || []]), [
    ['/api/admin/early', []], ['/api/admin/catalog', ['adminGate']], ['/api/shop', []],
  ]);
  assert.deepEqual(r.routes.map((x) => [x.path, x.mw || []]), [
    ['/api/admin/stats', ['adminGate']], ['/api/public', []], ['/resolve', ['requireServiceKey']],
  ]);
});

test('Hono header reads, constant-time compares, named handlers and token middleware count as checks', () => {
  assert.deepEqual(routeChecks([
    `async function postNewsletter(c, deps) {`,
    `  const session = await deps.auth.getSession(c.req.raw.headers);`,
    `  return c.json(session);`,
    `}`,
    `const handleRefund = async (c) => {`,
    `  await verifyToken(c);`,
    `};`,
    `function saveThing(c) {`,
    `  return db.insert(c.req.header('content-type'));`,
    `}`,
    ``,
    `app.post('/a', async (c) => { if (!safeEqual(c.req.header('Authorization') ?? '', secret)) return c.text('no', 401); });`,
    `app.post('/b', async (c) => { const sig = c.req.header('X-Shop-Signature'); return c.json(await save(sig)); });`,
    `app.post('/c', async (c) => { if (!constantTimeEqual(a, b)) return c.text('no'); });`,
    `app.post('/d', bodyLimit, (c) => postNewsletter(c, deps));`,
    `app.post('/e', handleRefund);`,
    `app.post('/f', requireServiceKey(token), (c) => c.json({}));`,
    `app.post('/g', rateLimit(limits), (c) => saveThing(c));`,
  ].join('\n')), [
    ['POST', 'inline', null], ['POST', 'inline', null], ['POST', 'inline', null], ['POST', 'inline', null], ['POST', 'inline', null],
    ['POST', 'middleware', 'requireServiceKey'],
    // a middleware handed nothing secret, and a handler that checks nothing, stay open
    ['POST', null, null],
  ]);
});

test('routes get the full address of every mount above them', () => {
  assert.deepEqual(routeKeys(graph), [
    'DELETE /api/admin/products/:id', 'GET /api/admin/orders', 'GET /api/admin/products', 'GET /health',
    'POST /api/admin/products', 'POST /api/newsletter', 'POST /api/reviews', 'POST /internal/stock/release',
    'POST /internal/stock/reserve', 'POST /webhooks/inventory', 'POST /webhooks/payments', 'PUT /api/admin/orders/:id/refund',
  ]);
});

test('the server mounting its routers is not a request to them', () => {
  assert.deepEqual(graph.links.filter((l) => l.k === 'http'), []);
});

test('Health reports only the endpoint that really checks nothing', () => {
  assert.deepEqual(openEndpoints(graph), ['POST /api/reviews']);
  assert.deepEqual(graph.health.issues.filter((i) => i.kind === 'stripe-webhook'), []);
});

test('Stripe event handlers still count as unchecked when a file that imports them skips the signature', () => {
  const near = makeProject({}, ARCH);
  try {
    fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'hono-app'), near, { recursive: true });
    fs.writeFileSync(path.join(near, 'api/src/webhooks/replay.ts'), [
      `// Replays a payment event by hand.`,
      `import { handlePaymentEvent } from './payment-events.js';`,
      `export const replay = (event) => handlePaymentEvent(event);`,
    ].join('\n'));
    run('scan.mjs', near);
    run('build.mjs', near, '--no-claude-md');
    assert.deepEqual(readGraph(near).health.issues.filter((i) => i.kind === 'stripe-webhook').map((i) => i.locations[0].file), ['api/src/webhooks/payment-events.ts']);
  } finally { cleanup(near); }
});
