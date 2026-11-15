// Fastify's object-form route declarations, including nested schema objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lib, makeProject, run, readJson, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

test('Fastify object-form routes handle nested schema and method arrays', () => {
  const src = [
    "fastify.route({",
    "  method: ['GET', 'HEAD'],",
    "  url: '/api/widgets/:id',",
    "  schema: { response: { 200: { type: 'object', properties: { method: 'POST', url: '/wrong' } } } },",
    "  handler: async (req) => ({ ok: true }),",
    "});",
    "app.route({ method: 'POST', path: '/api/widgets', handler });",
    "app.route({ method: mode, url: '/dynamic-method', handler });",
    "app.route({ method: 'GET', url: '/v$version', handler });",
    "app.route({ method: 'GET', schema: { url: '/nested-only' }, handler });",
  ].join('\n');
  const r = extract(src, 'typescript', 'api/src/app.ts');
  assert.deepEqual(r.routes.map((x) => [x.method, x.path]), [
    ['GET', '/api/widgets/:id'], ['HEAD', '/api/widgets/:id'], ['POST', '/api/widgets'],
  ]);
  assert.equal(r.routes[0].line, 1);
});

test('Fastify object-form endpoints match real website calls through scan', () => {
  const root = makeProject({
    'api/src/app.ts': [
      "const app = Fastify();",
      "app.route({ method: 'POST', url: '/api/v1/invites/accept',",
      "  schema: { body: { type: 'object' } },",
      "  handler: acceptInvite });",
      "app.route({ method: 'GET', url: '/api/v1/invites', handler: listInvites });",
    ].join('\n'),
    'web/src/api.ts': "export const accept = () => fetch('/api/v1/invites/accept', { method: 'POST' });",
  });
  try {
    run('scan.mjs', root);
    const scan = readJson(path.join(root, 'floorplan/.cache/scan.json'));
    assert.ok(scan.routes.some((x) => x.path === '/api/v1/invites/accept' && x.method === 'POST'));
    assert.ok(scan.http.some((x) => x.from === 'web/src/api.ts' && x.to === 'api/src/app.ts'));
  } finally { cleanup(root); }
});
