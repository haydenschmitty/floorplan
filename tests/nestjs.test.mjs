// NestJS: endpoints declared with decorators (@Controller('orders') on the class, @Get(':id') on a method)
// get their full path and their method's name, and the website's requests reach the controller that answers them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

let root, graph;
before(() => {
  root = makeProject({}, { arch: {
    project: { name: 'nestjs-app', summary: 'Test fixture.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      { id: 'api', label: 'Server', kind: 'service', summary: 'The NestJS server.', paths: ['api/**'] },
    ],
  } });
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'nestjs-app'), root, { recursive: true });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('a controller prefix joins each route decorator, and the handler is the method under the decorators', () => {
  const r = extract([
    `import { Controller, Get, Post, Delete, UseGuards } from '@nestjs/common';`,
    ``,
    `@Controller('orders')`,
    `export class OrdersController {`,
    `  /** Every order. */`,
    `  @Get()`,
    `  findAll() {}`,
    ``,
    `  @Post(':id/ship')`,
    `  @UseGuards(AuthGuard('jwt'))`,
    `  public async ship(@Param('id') id: string) {}`,
    `}`,
    ``,
    `@Controller({ path: '/catalog/coupons', version: '1' })`,
    `export class CouponsController {`,
    `  @Delete('expired')`,
    `  clearExpired() {}`,
    `}`,
    ``,
    `@Controller()`,
    `export class HealthController {`,
    `  @Get('health') check() {}`,
    `}`,
  ].join('\n'), 'typescript', 'api/src/orders.controller.ts');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path} ${x.handler}`), [
    'GET /orders findAll', 'POST /orders/:id/ship ship', 'DELETE /catalog/coupons/expired clearExpired', 'GET /health check',
  ]);
  assert.ok(r.routes.every((x) => x.framework === 'nest'));
  // the decorators' own arguments aren't requests the server makes
  assert.deepEqual(r.calls, []);
});

test('route decorators outside a NestJS file are left alone', () => {
  const r = extract([
    `import { Get } from './my-decorators';`,
    `class Thing { @Get('x') run() {} }`,
  ].join('\n'), 'typescript', 'src/thing.ts');
  assert.deepEqual(r.routes, []);
});

test('endpoints get the controller prefix, and the file-level handler is not swapped for the next class', () => {
  assert.deepEqual(routeKeys(graph), [
    'DELETE /catalog/coupons/expired', 'GET /catalog/coupons', 'GET /catalog/products/featured', 'GET /health', 'GET /orders', 'GET /orders/:id',
    'PATCH /orders/:id/ship', 'POST /orders',
  ]);
  // ProductsController.featured is followed by the CouponsController class: the endpoint is still named after featured()
  const featured = graph.routes.find((r) => r.p === '/catalog/products/featured');
  assert.equal(featured.h, 'featured');
});

test("the website's requests reach the controller that answers them", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`).sort();
  assert.deepEqual(http, [
    'web/src/api.ts -> api/src/catalog/catalog.controller.ts GET /catalog/products/featured, DELETE /catalog/coupons/expired',
    'web/src/api.ts -> api/src/orders/orders.controller.ts GET /orders, GET /orders/:id, POST /orders, PATCH /orders/:id/ship',
  ]);
});

test('Health does not call NestJS endpoints open to anyone: guards are often registered app-wide', () => {
  assert.deepEqual(openEndpoints(graph), []);
});
