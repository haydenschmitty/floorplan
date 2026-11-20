import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const caller = 'web/src/inventory.ts';
const proxy = 'web/src/pages/api/relay/[...path].ts';
const handler = 'api/src/inventory.ts';
const outgoing = 'GET /inventory/availability';
const browser = 'GET /api/relay/inventory/availability';
const getLinks = (graph, from, label) => graph.links
  .filter((link) => link.k === 'http' && link.a === 'f:' + from && link.labels.includes(label));

function fixture(t, extraFiles = {}) {
  const root = makeProject({
    'web/package.json': JSON.stringify({ dependencies: { next: '^14.0.0' } }),
    'web/src/pages/inventory.tsx': `import { useRouter } from 'next/router';
      import { getAvailability } from '../inventory';
      export default function Inventory() { getAvailability(); return null; }`,
    [caller]: `import { webHttp as client } from './lib';
      export const getAvailability = () => client.get<Availability>(
        '/inventory/availability'
      );`,
    'web/src/lib/index.ts': "export * from './client';",
    'web/src/lib/client.ts': `import axios from 'axios';
      const origin = process.env.NEXT_PUBLIC_ORIGIN || '';
      export const webHttp = axios.create({ baseURL: \`\${origin}/api/relay\` });`,
    [proxy]: `import { backHttp } from '../../../lib/backend';
      export default function handler(req, res) {
        const { path: parts, ...params } = req.query;
        let url;
        if (typeof parts === 'string') url = parts;
        else if (Array.isArray(parts)) url = parts.filter(Boolean).join('/');
        return backHttp({ method: req.method, url: url, params });
      }`,
    'web/src/lib/backend.ts': `import axios from 'axios';
      import { config } from './config';
      export const backHttp = axios.create(config);`,
    'web/src/lib/config.ts': 'export const config = { baseURL: process.env.BACKEND_URL };',
    [handler]: `import { Controller, Get } from '@nestjs/common';
      @Controller('inventory')
      export class InventoryController {
        @Get('availability')
        getAvailability() { return true; }
      }`,
    ...extraFiles,
  }, { repos: ['web', 'api', ...new Set(Object.keys(extraFiles).map((file) => file.split('/')[0]).filter((repo) => repo !== 'web' && repo !== 'api'))], arch: {
    project: { name: 'Inventory', summary: 'A site with inventory.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', paths: ['web/**'] },
      { id: 'api', label: 'Server', kind: 'service', paths: ['api/**'] },
    ],
  } });
  t.after(() => cleanup(root));
  scanAndBuild(root);
  return readGraph(root);
}

test('an Axios request is linked through a Next.js catch-all to the uniquely matching backend', (t) => {
  const graph = fixture(t);
  const [first] = getLinks(graph, caller, browser);
  const [second] = getLinks(graph, proxy, outgoing);
  assert.equal(first?.b, 'f:' + proxy);
  assert.equal(second?.b, 'f:' + handler);
  assert.ok(first.inferred && second.inferred);
  assert.equal(graph.routes[first.calls[0][0]].f, proxy);
  assert.equal(graph.routes[first.calls[0][2]].f, handler);
  assert.equal(graph.routes[second.calls[0][0]].f, handler);
  assert.deepEqual(getLinks(graph, caller, outgoing), []);
  const inventory = graph.screens.find((screen) => screen.url === '/inventory');
  const request = inventory.behind.find((item) => item.kind === 'request');
  assert.equal(request?.via, 'f:' + proxy);
  assert.equal(graph.routes[Number(request.id.slice(2))].h, 'getAvailability');
  assert.ok(inventory.behind.some((item) => item.id === 'f:' + handler && item.kind === 'server'));
});

test('a proxy with an environment-based destination remains unresolved if two repos serve the endpoint', (t) => {
  const graph = fixture(t, {
    'second-api/src/server.js': `import express from 'express';
      const app = express();
      app.get('/inventory/availability', serveOtherInventory);`,
  });
  assert.deepEqual(getLinks(graph, proxy, outgoing), []);
});

test('a more specific Next.js route prevents a guess through the catch-all', (t) => {
  const graph = fixture(t, {
    'web/src/pages/api/relay/inventory/availability.ts': 'export default function handler(req, res) { return res.json({}); }',
  });
  assert.deepEqual(getLinks(graph, proxy, outgoing), []);
});

test('a catch-all with a longer dynamic prefix takes precedence over the relay', (t) => {
  const graph = fixture(t, {
    'web/src/pages/api/relay/[category]/[...parts].ts': 'export default function handler(req, res) { return res.json({}); }',
  });
  assert.deepEqual(getLinks(graph, proxy, outgoing), []);
});

test('a parameterized backend route can make the forwarding destination ambiguous', (t) => {
  const graph = fixture(t, {
    'second-api/src/server.js': `import express from 'express';
      const app = express();
      app.get('/inventory/:item', serveItem);`,
  });
  assert.deepEqual(getLinks(graph, proxy, outgoing), []);
});

test('direct and proxied calls to the same destination keep separate links', (t) => {
  const graph = fixture(t, {
    [caller]: `import { webHttp as client } from './lib';
      export const getDirect = () => fetch('/inventory/availability');
      export const getAvailability = () => client.get('/inventory/availability');`,
  });
  assert.equal(getLinks(graph, caller, outgoing)[0]?.b, 'f:' + handler);
  assert.equal(getLinks(graph, caller, browser)[0]?.b, 'f:' + proxy);
});

test('a URL with a dynamic origin or a per-call base override is not attributed to the relay', (t) => {
  const graph = fixture(t, {
    [caller]: `import { webHttp as client } from './lib';
      export const getAvailability = () => client.get(
        \`\${externalOrigin}/inventory/availability\`
      );
      export const getOverride = () => client.get('/inventory/availability', { baseURL: '/other' });`,
  });
  assert.deepEqual(getLinks(graph, caller, browser), []);
  assert.deepEqual(getLinks(graph, proxy, outgoing), []);
});
