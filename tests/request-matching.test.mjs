// Matching a website's requests to endpoints when an address has a part filled in at run time:
// `/api/users/${user.id}` is the endpoint with a parameter there ([userId]), not a fixed sibling
// (/api/users/stripe), even when the caller's other requests have taught Floorplan its base address;
// and the method written in the options a line or two below the address counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

let root, graph;
before(() => {
  root = makeProject({
    'package.json': JSON.stringify({ name: 'site', dependencies: { next: '^14.0.0' } }),
    'app/api/users/[userId]/route.ts': [
      `export async function GET(req: Request) { return Response.json({}); }`,
      `export async function PATCH(req: Request) { return Response.json({}); }`,
      `export async function DELETE(req: Request) { return Response.json({}); }`,
    ].join('\n'),
    'app/api/users/stripe/route.ts': `export async function GET(req: Request) { return Response.json({}); }`,
    'app/api/posts/route.ts': [
      `export async function GET(req: Request) { return Response.json([]); }`,
      `export async function POST(req: Request) { return Response.json({}); }`,
    ].join('\n'),
    'app/api/posts/[postId]/route.ts': `export async function DELETE(req: Request) { return Response.json({}); }`,
    // calls only one endpoint answers: they teach the components their base address ('')
    'components/post-create-button.tsx': [
      `export async function create() {`,
      `  const response = await fetch("/api/posts", {`,
      `    method: "POST",`,
      `    headers: { "Content-Type": "application/json" },`,
      `  })`,
      `  return response.json()`,
      `}`,
    ].join('\n'),
    'components/post-operations.tsx': [
      `export async function remove(postId: string) {`,
      '  return fetch(`/api/posts/${postId}`, {',
      `    method: "DELETE",`,
      `  })`,
      `}`,
    ].join('\n'),
    'components/user-name-form.tsx': [
      `export async function save(user: { id: string }, name: string) {`,
      '  const response = await fetch(`/api/users/${user.id}`, {',
      `    method: "PATCH",`,
      `    headers: {`,
      `      "Content-Type": "application/json",`,
      `    },`,
      `    body: JSON.stringify({ name }),`,
      `  })`,
      `  return response.ok`,
      `}`,
    ].join('\n'),
    // no method written: a read
    'components/user-avatar.tsx': [
      `export async function load(id: string) {`,
      '  return (await fetch(`/api/users/${id}`)).json()',
      `}`,
    ].join('\n'),
    'components/billing-form.tsx': [
      `export async function upgrade() {`,
      `  const response = await fetch("/api/users/stripe")`,
      `  return response.json()`,
      `}`,
    ].join('\n'),
  }, { arch: {
    project: { name: 'site', summary: 'Test fixture.' },
    nodes: [
      { id: 'api', label: 'API', kind: 'service', summary: 'The API.', paths: ['app/**'] },
      { id: 'ui', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['components/**'] },
    ],
  } });
  scanAndBuild(root);
  graph = readGraph(root);
});
after(() => cleanup(root));

const requests = (from) => graph.links.filter((l) => l.k === 'http' && l.a === 'f:' + from).flatMap((l) => [...l.labels]).sort();

test('an address with a part filled in reaches the endpoint with a parameter there, not a fixed sibling', () => {
  assert.deepEqual(requests('components/user-name-form.tsx'), ['PATCH /api/users/[userId]']);
  assert.deepEqual(requests('components/user-avatar.tsx'), ['GET /api/users/[userId]']);
  // the fixed address still reaches the fixed endpoint
  assert.deepEqual(requests('components/billing-form.tsx'), ['GET /api/users/stripe']);
  assert.deepEqual(requests('components/post-operations.tsx'), ['DELETE /api/posts/[postId]']);
  assert.deepEqual(requests('components/post-create-button.tsx'), ['POST /api/posts']);
});

test("the method in a call's options, on the lines below its address, is the request's method", () => {
  const calls = (src) => extract(src, 'typescript', 'src/a.ts').calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(calls('await fetch(`/api/users/${id}`, {\n  headers: { a: "b" },\n  method: "PATCH",\n})\n'), ['PATCH /api/users/${x}']);
  // only while the call is still open, and only an HTTP method
  assert.deepEqual(calls('await fetch("/api/users")\nconst opts = { method: "POST" }\n'), ['null /api/users']);
  assert.deepEqual(calls('await fetch("/api/users", {\n  method: "cors",\n})\n'), ['null /api/users']);
});

test('a screen follows its access hooks to a proxied request and its handler', (t) => {
  const page = 'web/src/pages/inventory/index.tsx';
  const caller = 'web/src/inventory.ts';
  const proxy = 'web/src/pages/api/relay/[...path].ts';
  const server = 'api/src/server.ts';
  const root = makeProject({
    'web/package.json': JSON.stringify({ dependencies: { next: '^14.0.0' } }),
    [page]: `import { useAccess } from '../../components/ui/layout/useAccess';
      import { useRouter } from 'next/router';
      export default function Inventory() { return useAccess() ? <p>Inventory</p> : null; }`,
    'web/src/components/ui/layout/useAccess.ts': `import { useGate } from '../../../hooks/useGate';
      export const useAccess = () => useGate();`,
    'web/src/hooks/useGate/index.ts': `export * from './useGate';`,
    'web/src/hooks/useGate/useGate.ts': `import { useAvailability } from '../useAvailability';
      export const useGate = () => useAvailability();`,
    'web/src/hooks/useAvailability/index.ts': `export * from './useAvailability';`,
    'web/src/hooks/useAvailability/useAvailability.ts': `import { getAvailability } from '../../inventory';
      export const useAvailability = () => getAvailability();`,
    [caller]: `export const getAvailability = () => fetch('/inventory/availability');
      export const getCapacity = () => fetch('/inventory/capacity');`,
    [proxy]: 'export default function handler(req, res) { return forward(req); }',
    [server]: `import express from 'express';
      const app = express();
      app.get('/inventory/availability', (req, res) => res.json(true));
      app.get('/inventory/capacity', (req, res) => res.json(100));`,
  }, { repos: ['web', 'api'], arch: {
    project: { name: 'Inventory', summary: 'A site with inventory.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', paths: ['web/**'] },
      { id: 'api', label: 'Server', kind: 'service', paths: ['api/**'] },
    ],
    edges: [
      { from: caller, to: proxy, kind: 'http', label: 'GET /api/relay/inventory/availability' },
      { from: proxy, to: server, kind: 'http', label: 'GET /inventory/availability' },
    ],
  } });
  t.after(() => cleanup(root));
  scanAndBuild(root);
  const graph = readGraph(root);
  const screen = graph.screens.find((s) => s.url === '/inventory');
  assert.ok(screen, 'the inventory screen is detected');
  const requests = screen.behind.filter((b) => b.kind === 'request');
  assert.deepEqual(requests.map((b) => graph.routes[Number(b.id.slice(2))].p), ['/inventory/availability']);
  assert.equal(requests[0].via, 'f:' + proxy);
  assert.match(requests[0].note, /GET \/api\/relay\/inventory\/availability/);
  assert.ok(screen.behind.some((b) => b.id === 'f:' + proxy && b.kind === 'proxy'));
  assert.ok(screen.behind.some((b) => b.id === 'f:' + server && b.kind === 'server'));
});
