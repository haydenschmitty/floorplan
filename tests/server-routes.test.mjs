// SvelteKit `+server.ts` and Nuxt `server/api|routes` endpoints, derived from the file path.
// SvelteKit answers the URL of its folder, one endpoint per exported method; Nuxt answers the
// matching URL, its method from a `.get.` / `.post.` suffix on the file name. Route groups `(…)` and
// parallel slots `@…` are not part of the URL; `[param]` becomes `:param`, `[...rest]` becomes `*`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, run, readGraph, routeKeys, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const kit = (path, body) => extract(body.join('\n'), 'typescript', path);
const routesOf = (r) => r.routes.map((x) => `${x.method} ${x.path}`).sort();

test('SvelteKit: one endpoint per exported method, at the folder URL', () => {
  const r = kit('src/routes/api/items/+server.ts', [
    `export async function GET() { return new Response('[]'); }`,
    `export async function POST() { return new Response('{}'); }`,
    `export async function DELETE() { return new Response(''); }`,
  ]);
  assert.deepEqual(routesOf(r), ['DELETE /api/items', 'GET /api/items', 'POST /api/items']);
  assert.equal(r.routes[0].framework, 'sveltekit');
});

test('SvelteKit: a group is skipped, a rest segment becomes *, an optional one a parameter', () => {
  const r = kit('src/routes/(admin)/settings/+server.ts', [
    `export async function GET() { return new Response('[]'); }`,
  ]);
  assert.deepEqual(routesOf(r), ['GET /settings']);
  const files = kit('src/routes/api/files/[...path]/+server.ts', [
    `export async function GET() { return new Response('[]'); }`,
  ]);
  assert.deepEqual(routesOf(files), ['GET /api/files/*']);
  const opt = kit('src/routes/blog/[[slug]]/+server.ts', [
    `export const GET = () => new Response('[]');`,
  ]);
  assert.deepEqual(routesOf(opt), ['GET /blog/:slug']);
});

test('SvelteKit: a +server with no exported method, or at the root, declares nothing extra', () => {
  const none = kit('src/routes/api/items/+server.ts', [`const helper = () => 1;`]);
  assert.deepEqual(routesOf(none), []);
  const root = kit('src/routes/+server.ts', [
    `export async function GET() { return new Response('[]'); }`,
  ]);
  assert.deepEqual(routesOf(root), ['GET /']);
});

test('Nuxt: the method comes from the file name, index means the folder, [id] a parameter', () => {
  const items = kit('server/api/items.ts', [
    `export default defineEventHandler((event) => { return []; });`,
  ]);
  assert.deepEqual(routesOf(items), ['ANY /api/items']);
  assert.equal(items.routes[0].framework, 'nuxt');
  const one = kit('server/api/items/[id].ts', [
    `export default defineEventHandler((event) => { return {}; });`,
  ]);
  assert.deepEqual(routesOf(one), ['ANY /api/items/:id']);
  const created = kit('server/api/users.post.ts', [
    `export default defineEventHandler((event) => { return {}; });`,
  ]);
  assert.deepEqual(routesOf(created), ['POST /api/users']);
  const index = kit('server/api/index.ts', [
    `export default defineCachedEventHandler((event) => { return []; });`,
  ]);
  assert.deepEqual(routesOf(index), ['ANY /api']);
});

test('Nuxt: server/routes answers the plain URL, and a file without defineEventHandler is left alone', () => {
  const health = kit('server/routes/health.ts', [
    `export default defineEventHandler((event) => { return { ok: true }; });`,
  ]);
  assert.deepEqual(routesOf(health), ['ANY /health']);
  const plain = kit('server/api/notes.ts', [`export const notes = [];`]);
  assert.deepEqual(routesOf(plain), []);
});

let root, graph;
before(() => {
  root = makeProject({
    'kit/package.json': JSON.stringify({ name: 'kit', type: 'module', dependencies: { '@sveltejs/kit': '^2.0.0' } }),
    'kit/src/routes/api/items/+server.ts': [
      `export async function GET() { return new Response('[]'); }`,
      `export async function POST() { return new Response('{}'); }`,
    ].join('\n'),
    'nuxt/package.json': JSON.stringify({ name: 'nuxt', type: 'module', dependencies: { nuxt: '^3.0.0' } }),
    'nuxt/server/api/orders.ts': [
      `export default defineEventHandler((event) => { return []; });`,
    ].join('\n'),
    'web/package.json': JSON.stringify({ name: 'web', type: 'module' }),
    'web/src/api.js': [
      `export const listItems = () => fetch('/api/items').then((r) => r.json());`,
      `export const listOrders = () => fetch('/api/orders').then((r) => r.json());`,
    ].join('\n'),
  }, {
    arch: {
      project: { name: 'Shop', summary: 'A shop with SvelteKit and Nuxt backends.' },
      nodes: [
        { id: 'kit', label: 'SvelteKit', kind: 'service', summary: 'The SvelteKit server.', paths: ['kit/**'] },
        { id: 'nuxt', label: 'Nuxt', kind: 'service', summary: 'The Nuxt server.', paths: ['nuxt/**'] },
        { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      ],
    },
  });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('end to end: both kinds land on the map, and the website reaches them', () => {
  assert.deepEqual(routeKeys(graph), ['ANY /api/orders', 'GET /api/items', 'POST /api/items']);
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`).sort();
  assert.deepEqual(http, [
    'web/src/api.js -> kit/src/routes/api/items/+server.ts GET /api/items',
    'web/src/api.js -> nuxt/server/api/orders.ts ANY /api/orders',
  ]);
});
