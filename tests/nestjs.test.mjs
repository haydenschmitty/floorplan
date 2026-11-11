// NestJS: endpoints come from @Controller prefixes and @Get/@Post/... decorators, and Health reads a
// global APP_GUARD, @Public() openings and @UseGuards, so a Nest API isn't an empty board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

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
