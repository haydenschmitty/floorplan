// Web requests whose URL is built by a method of the same class (Angular services and the like), and
// calls whose URL wraps onto the line below the call: both now reach the endpoint that answers them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const SERVICE = [
  `import { HttpClient } from '@angular/common/http';`,
  ``,
  `export class OrdersService {`,
  `  private readonly base = environment.apiUrl;`,
  `  constructor(private readonly http: HttpClient) {}`,
  ``,
  `  private url(id: string, suffix = ''): string {`,
  '    return `${this.base}/orders/${encodeURIComponent(id)}${suffix}`;',
  `  }`,
  ``,
  `  private itemUrl(id: string, itemId: string, suffix = ''): string {`,
  '    return this.url(id, `/items/${encodeURIComponent(itemId)}${suffix}`);',
  `  }`,
  ``,
  `  get(id: string) {`,
  `    return this.http.get<Order>(this.url(id));`,
  `  }`,
  ``,
  `  ship(id: string) {`,
  `    return this.http.post<Order>(this.url(id, '/ship'), {});`,
  `  }`,
  ``,
  `  setQuantity(id: string, itemId: string, quantity: number) {`,
  `    return this.http.put<Order>(`,
  `      this.itemUrl(id, itemId),`,
  `      { quantity },`,
  `    );`,
  `  }`,
  ``,
  `  removeItem(id: string, itemId: string) {`,
  `    return this.http.delete<{ ok: boolean }>(this.itemUrl(id, itemId, '/remove'));`,
  `  }`,
  ``,
  `  rename(id: string, name: string) {`,
  `    return this.http.patch<{ ok: boolean }>(`,
  '      `${this.base}/orders/${encodeURIComponent(id)}`,',
  `      { name },`,
  `    );`,
  `  }`,
  ``,
  `  invoiceLink(id: string): string {`,
  `    const link = this.url(id, '/invoice.pdf');`,
  `    return link;`,
  `  }`,
  `}`,
].join('\n');

test('a URL built by a method of the class, directly or through another builder, is the request it makes', () => {
  const r = extract(SERVICE, 'typescript', 'web/src/orders.service.ts');
  assert.deepEqual(r.calls.map((c) => `${c.line} ${c.method} ${c.path}`).sort((a, b) => parseInt(a) - parseInt(b)), [
    '16 GET /orders/${x}',
    '20 POST /orders/${x}/ship',
    '25 PUT /orders/${x}/items/${x}',
    '31 DELETE /orders/${x}/items/${x}/remove',
    '36 PATCH /orders/${x}',
  ]);
});

test("a builder's own template, and a URL built but not requested (a link), are not requests", () => {
  const r = extract(SERVICE, 'typescript', 'web/src/orders.service.ts');
  // lines 8 and 12 are the builders, line 42 keeps a link to a file
  assert.ok(!r.calls.some((c) => [8, 12, 42].includes(c.line)), JSON.stringify(r.calls));
});

let root, graph;
before(() => {
  root = makeProject({
    'web/src/orders.service.ts': SERVICE,
    'api/server.js': [
      `const express = require('express');`,
      `const app = express();`,
      `app.get('/api/orders/:id', (req, res) => res.json({}));`,
      `app.post('/api/orders/:id/ship', (req, res) => res.json({}));`,
      `app.put('/api/orders/:id/items/:itemId', (req, res) => res.json({}));`,
      `app.delete('/api/orders/:id/items/:itemId/remove', (req, res) => res.json({}));`,
      `app.patch('/api/orders/:id', (req, res) => res.json({}));`,
      `app.listen(3000);`,
    ].join('\n'),
  }, { arch: {
    project: { name: 'url-builders', summary: 'Test fixture.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      { id: 'api', label: 'Server', kind: 'service', summary: 'The server.', paths: ['api/**'] },
    ],
  } });
  scanAndBuild(root);
  graph = readGraph(root);
});
after(() => cleanup(root));

test("the service's requests reach the endpoints that answer them", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)}`);
  assert.deepEqual(http, ['web/src/orders.service.ts -> api/server.js']);
  const labels = graph.links.find((l) => l.k === 'http').labels.slice().sort();
  assert.deepEqual(labels, [
    'DELETE /api/orders/:id/items/:itemId/remove', 'GET /api/orders/:id', 'PATCH /api/orders/:id', 'POST /api/orders/:id/ship', 'PUT /api/orders/:id/items/:itemId',
  ]);
});
