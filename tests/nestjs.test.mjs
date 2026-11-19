// NestJS: endpoints come from @Controller prefixes and @Get/@Post/... decorators, and Health reads a
// global APP_GUARD, @Public() openings and @UseGuards, so a Nest API isn't an empty board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, scanAndBuild, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const ORDERS = `import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { verifyOrderToken } from './order-token';

@Controller('api/orders')
export class OrdersController {
  @Get()
  list() { return []; }

  @Get(':id')
  get(@Param('id') id: string) { return { id }; }

  @Post(':id/refund')
  async refund(@Param('id') id: string) { return { id }; }

  @Get(':id/receipt')
  @Public()
  @UseGuards(RateLimitGuard)
  receipt(@Param('id') id: string, token: string) {
    if (!verifyOrderToken(token, id)) throw new Error('401');
    return { id };
  }

  @Public()
  @Get(':id/details')
  details(@Param('id') id: string) { return { id, total: 45 }; }

  @Public()
  @Post('feedback')
  @UseGuards(RateLimitGuard)
  feedback() { return { ok: true }; }
}
`;

const HEALTH = `import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator';

@Controller()
export class AppController {
  @Get('health')
  @Public()
  health() { return { status: 'ok' }; }
}
`;

const MODULE = `import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { QuotaGuard } from './auth/quota.guard';

@Module({
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: QuotaGuard },
  ],
})
export class AppModule {}
`;

const WEB = `const API = import.meta.env.VITE_API_URL;
export const listOrders = () => fetch(\`\${API}/api/orders\`);
export const refund = (id) => fetch(\`\${API}/api/orders/\${id}/refund\`, { method: 'POST' });
`;

const ARCH = { project: { name: 'nest-app', summary: 'Test fixture.' }, nodes: [
  { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
  { id: 'api', label: 'Server', kind: 'service', summary: 'The Nest server.', paths: ['api/**'] },
] };

let root, graph;
before(() => {
  root = makeProject({
    'api/package.json': '{"name":"api","dependencies":{"@nestjs/common":"^11.0.0"}}',
    'api/src/orders/orders.controller.ts': ORDERS,
    'api/src/app.controller.ts': HEALTH,
    'api/src/app.module.ts': MODULE,
    'web/package.json': '{"name":"web"}',
    'web/src/api.ts': WEB,
  }, { repos: ['api', 'web'], arch: ARCH });
  scanAndBuild(root);
  graph = readGraph(root);
});
after(() => cleanup(root));

test('controller prefixes and method decorators become endpoints, with their handlers', () => {
  const r = extract(ORDERS, 'typescript', 'api/src/orders/orders.controller.ts');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path} ${x.handler}`), [
    'GET /api/orders list', 'GET /api/orders/:id get', 'POST /api/orders/:id/refund refund',
    'GET /api/orders/:id/receipt receipt', 'GET /api/orders/:id/details details', 'POST /api/orders/feedback feedback',
  ]);
  assert.deepEqual(extract(HEALTH, 'typescript', 'api/src/app.controller.ts').routes.map((x) => `${x.method} ${x.path}`), ['GET /health']);
});

test('a @Get in a file that does not use @nestjs/common is not an endpoint', () => {
  const other = `import { Get, Controller } from 'some-other-lib';\n@Controller('x')\nclass A { @Get('y') y() {} }\n`;
  assert.deepEqual(extract(other, 'typescript', 'a.ts').routes, []);
});

test('the endpoints are on the map and the website reaches them', () => {
  assert.deepEqual(routeKeys(graph), [
    'GET /api/orders', 'GET /api/orders/:id', 'GET /api/orders/:id/details', 'GET /api/orders/:id/receipt', 'GET /health', 'POST /api/orders/:id/refund', 'POST /api/orders/feedback',
  ]);
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`);
  assert.deepEqual(http, ['web/src/api.ts -> api/src/orders/orders.controller.ts GET /api/orders, POST /api/orders/:id/refund']);
});

test('Health: a global APP_GUARD protects every route; @Public() opens one unless it checks the caller itself', () => {
  // receipt is public but checks a token; health is public by path; a rate-limit guard is not a sign-in check
  assert.deepEqual(openEndpoints(graph), ['GET /api/orders/:id/details', 'POST /api/orders/feedback']);
});

// ---------- several controllers in one file (sample in fixtures/nestjs-app) ----------

test('each endpoint belongs to the controller above it, and keeps its method name when another class follows', () => {
  const r = extract([
    `import { Controller, Get, Post, Delete, Body, Param, UseGuards } from '@nestjs/common';`,
    ``,
    `@Controller('orders')`,
    `export class OrdersController {`,
    `  /** Every order. */`,
    `  @Get()`,
    `  findAll() {}`,
    ``,
    `  @Post(':id/ship')`,
    `  @UseGuards(AuthGuard('jwt'))`,
    `  public async ship(@Param('id') id: string, @Body() body: ShipDto) {}`,
    `}`,
    ``,
    `export class ShipDto {`,
    `  carrier: string;`,
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
  assert.equal(r.routes[0].doc, 'Every order.');
  // the decorators' own arguments aren't requests the server makes
  assert.deepEqual(r.calls, []);
});

test('the sample app: controller prefixes, handlers, and the website reaching the right controller', () => {
  const root = makeProject({}, { arch: {
    project: { name: 'nestjs-app', summary: 'Test fixture.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      { id: 'api', label: 'Server', kind: 'service', summary: 'The NestJS server.', paths: ['api/**'] },
    ],
  } });
  try {
    fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'nestjs-app'), root, { recursive: true });
    scanAndBuild(root);
    const g = readGraph(root);
    assert.deepEqual(routeKeys(g), [
      'DELETE /catalog/coupons/expired', 'GET /catalog/coupons', 'GET /catalog/products/featured', 'GET /health', 'GET /orders', 'GET /orders/:id',
      'PATCH /orders/:id/ship', 'POST /orders',
    ]);
    // ProductsController.featured is followed by the CouponsController class: it's still named after featured()
    assert.equal(g.routes.find((r) => r.p === '/catalog/products/featured').h, 'featured');
    const http = g.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`).sort();
    assert.deepEqual(http, [
      'web/src/api.ts -> api/src/catalog/catalog.controller.ts GET /catalog/products/featured, DELETE /catalog/coupons/expired',
      'web/src/api.ts -> api/src/orders/orders.controller.ts GET /orders, GET /orders/:id, POST /orders, PATCH /orders/:id/ship',
    ]);
    // no app-wide guard in this sample: only the route with @UseGuards(AuthGuard('jwt')) is checked
    assert.deepEqual(openEndpoints(g), [
      'DELETE /catalog/coupons/expired', 'GET /catalog/coupons', 'GET /catalog/products/featured', 'GET /orders', 'GET /orders/:id', 'PATCH /orders/:id/ship',
    ]);
  } finally { cleanup(root); }
});

// ---------- app-wide guards ----------

const NEST_ARCH = { project: { name: 'nest-guards', summary: 'Test fixture.' }, nodes: [
  { id: 'api', label: 'Server', kind: 'service', summary: 'The server.', paths: ['api/**'] },
] };
const REPORTS = `import { Controller, Post } from '@nestjs/common';

@Controller('api/reports')
export class ReportsController {
  @Post('export')
  exportAll() { return []; }
}
`;
function openIn(files) {
  const root = makeProject({ 'api/package.json': '{"name":"api"}', ...files }, { repos: ['api'], arch: NEST_ARCH });
  try { scanAndBuild(root); return openEndpoints(readGraph(root)); } finally { cleanup(root); }
}

test("a guard on the next controller's class doesn't protect the method before it", () => {
  const file = `import { Controller, Get, UseGuards } from '@nestjs/common';

@Controller('api/products')
export class ProductsController {
  @Get('featured')
  featured() { return []; }
}

@UseGuards(AdminAuthGuard)
@Controller('api/admin')
export class AdminController {
  @Get('stats')
  stats() { return {}; }
}
`;
  assert.deepEqual(openIn({ 'api/src/catalog.controller.ts': file }), ['GET /api/products/featured']);
});

test("Nest's app-wide guard protects Nest routes only, not an Express server in the same repo", () => {
  const MODULE = `import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
@Module({ providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }] })
export class AppModule {}
`;
  const LEGACY = `const express = require('express');
const app = express();
app.post('/legacy/import', (req, res) => res.json({ ok: true }));
app.listen(4000);
`;
  assert.deepEqual(openIn({ 'api/src/app.module.ts': MODULE, 'api/src/reports.controller.ts': REPORTS, 'api/legacy/server.js': LEGACY }), ['POST /legacy/import']);
});

test('app.useGlobalGuards() with a sign-in guard protects every Nest route', () => {
  const MAIN = `import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalGuards(new ThrottlerGuard(), new JwtAuthGuard(app.get(Reflector)));
  await app.listen(3000);
}
bootstrap();
`;
  assert.deepEqual(openIn({ 'api/src/main.ts': MAIN, 'api/src/reports.controller.ts': REPORTS }), []);
});

test("app.useGlobalGuards() with guards that don't check who is calling protects nothing", () => {
  // a rate limit, a guard whose name says nothing about the caller (a word in its string doesn't count),
  // and a line that's commented out
  const MAIN = `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalGuards(new ThrottlerGuard(), new MaintenanceGuard('auth-token'));
  // app.useGlobalGuards(new JwtAuthGuard());
  await app.listen(3000);
}
bootstrap();
`;
  assert.deepEqual(openIn({ 'api/src/main.ts': MAIN, 'api/src/reports.controller.ts': REPORTS }), ['POST /api/reports/export']);
});
