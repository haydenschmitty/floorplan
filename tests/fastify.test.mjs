// Fastify: plugins mounted with app.register(plugin, { prefix }) put their routes under that prefix,
// nested registers compose, and the website's requests reach the right plugin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readGraph, routeKeys, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

let root, graph;
before(() => {
  root = makeProject({}, { arch: {
    project: { name: 'fastify-app', summary: 'Test fixture.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      { id: 'api', label: 'Server', kind: 'service', summary: 'The Fastify server.', paths: ['api/**'] },
    ],
  } });
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'fastify-app'), root, { recursive: true });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('register(plugin, { prefix }) is a mount: imported by name, by import() or by require()', () => {
  const r = extract([
    `import ticketRoutes from './routes/tickets.js';`,
    `import { inviteRoutes as invites } from './routes/invites.js';`,
    `const legacy = require('./routes/legacy');`,
    `async function local(app) { app.get('/x', h) }`,
    `await app.register(ticketRoutes, { prefix: '/api/tickets' });`,
    `await app.register(invites, {`,
    `  prefix: '/api/invites',`,
    `});`,
    `app.register(import('./routes/health.js'), { prefix: '/health' });`,
    `app.register(require('./routes/legacy'), { prefix: '/legacy' });`,
    `app.register(ticketRoutes);`,
    `app.register(local, { prefix: '/local' });`,
    `app.register(cors, { origin: true });`,
    'app.register(ticketRoutes, { prefix: `/v${n}` });',
  ].join('\n'), 'typescript', 'api/app.ts');
  // a plugin with no prefix sits under its parent's (an empty mount); a plugin defined in the same
  // file, a register without a plugin of ours (cors) and a prefix built at run time are left alone
  assert.deepEqual(r.mounts.map((m) => `${m.prefix} ${m.var || m.spec}`), [
    '/api/tickets ticketRoutes', '/api/invites invites', '/health ./routes/health.js', '/legacy ./routes/legacy', ' ticketRoutes',
  ]);
  // and a prefix isn't mistaken for a request the file makes
  assert.deepEqual(r.calls, []);
});

test('endpoints get the prefix their plugin is registered under, through nested registers with or without a prefix', () => {
  assert.deepEqual(routeKeys(graph), [
    'GET /api/v1/buildings', 'GET /api/v1/buildings/:buildingId/faq', 'GET /api/v1/buildings/:buildingId/notes', 'GET /api/v1/invites', 'GET /api/v1/tickets',
    'GET /api/v1/tickets/:id', 'GET /health', 'POST /api/v1/invites/accept', 'POST /api/v1/tickets/:id/accept',
  ]);
});

test("the website's requests reach the plugin that answers them", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`).sort();
  assert.deepEqual(http, [
    'web/src/api.ts -> api/src/routes/buildings/faq.ts GET /api/v1/buildings/:buildingId/faq',
    'web/src/api.ts -> api/src/routes/invites.ts POST /api/v1/invites/accept',
    'web/src/api.ts -> api/src/routes/tickets.ts GET /api/v1/tickets, POST /api/v1/tickets/:id/accept',
  ]);
});
