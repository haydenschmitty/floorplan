// Express and Hono: routers under any name, mounts followed through barrels, factories and namespace imports,
// routers nested in one file, and names handed to app.use() that aren't routers (#71, #98).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, scanAndBuild, readGraph, routeKeys, cleanup, openEndpoints } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const arch = {
  project: { name: 'shop', summary: 'Test fixture.' },
  nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['**'] }],
};

/** Maps a one-repo project made of `files` (over a copy of a fixture, if given) and returns the built graph. */
function mapOf(files, fixture) {
  const root = makeProject({}, { arch });
  try {
    if (fixture) fs.cpSync(path.join(REPO, 'tests', 'fixtures', fixture), root, { recursive: true });
    for (const [p, src] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), src); }
    scanAndBuild(root);
    return readGraph(root);
  } finally {
    cleanup(root);
  }
}
const withFiles = (graph) => graph.routes.map((r) => `${r.m} ${r.p} <- ${r.f}`).sort();

const EXPRESS = JSON.stringify({ name: 'shop', type: 'module', dependencies: { express: '^4.19.0' } });
const router = (...routes) => [`import { Router } from 'express';`, `const router = Router();`, ...routes, `export default router;`].join('\n');

test('Express: the sample from #71 comes out with the right paths, each once', () => {
  assert.deepEqual(withFiles(mapOf({}, 'express-mounts')), [
    'GET /api/orders <- server/orders.routes.ts',
    'GET /api/profile/me <- server/profile.routes.ts',
    'GET /health <- server/index.ts',
    'POST /api/auth/login <- server/auth/auth.routes.ts',
    'POST /api/billing/refund <- server/billing.routes.ts',
  ]);
});

test('Express: a check where a router is mounted lands on that router, so Health judges the right endpoints (#71)', () => {
  // the variant in #71: requireLogin on the orders and billing mounts, an admin router with no check at all
  const graph = mapOf({
    'server/index.ts': [
      `import express from 'express';`,
      `import orderRoutes from './orders.routes.js';`,
      `import adminRoutes from './admin.routes.js';`,
      `import { createBillingRoutes } from './billing.routes.js';`,
      `import { profileRoutes } from './profile.routes.js';`,
      `import { requireLogin } from './auth.js';`,
      `const app = express();`,
      `const billingRoutes = createBillingRoutes();`,
      `app.use('/api/orders', requireLogin, orderRoutes);`,
      `app.use('/api/billing', requireLogin, billingRoutes);`,
      `app.use('/api/profile', requireLogin, profileRoutes);`,
      `app.use('/api/admin', adminRoutes);`,
    ].join('\n'),
    'server/auth.ts': `export function requireLogin(req, res, next) { if (!req.headers.authorization) return res.status(401).end(); next(); }\n`,
    'server/admin.routes.ts': router(`router.delete('/users/:id', (req, res) => res.status(204).end());`),
  }, 'express-mounts');
  assert.deepEqual(openEndpoints(graph), ['DELETE /api/admin/users/:id']);
});

test('Express: a factory called inline, export * barrels, require() and namespace imports are followed', () => {
  const graph = mapOf({
    'package.json': EXPRESS,
    'server/index.js': [
      `import express from 'express';`,
      `import * as routes from './routes/index.js';`,
      `import { createBillingRoutes } from './routes/index.js';`,
      `const legacy = require('./legacy.js');`,
      `const app = express();`,
      `app.use('/api/billing', createBillingRoutes());`,
      `app.use('/api/admin', routes.adminRoutes);`,
      `app.use('/legacy', legacy);`,
      `app.use(`,
      `  '/api/notes',`,
      `  routes.notesRouter,`,
      `);`,
      `app.get('/health', (req, res) => res.json({ ok: true }));`,
    ].join('\n'),
    'server/routes/index.js': `export * from './billing.js';\nexport * from './admin.js';\nexport { default as notesRouter } from './notes.js';\n`,
    'server/routes/billing.js': `import { Router } from 'express';\nexport function createBillingRoutes() {\n  const r = Router();\n  r.post('/refund', (req, res) => res.json({}));\n  return r;\n}\n`,
    'server/routes/admin.js': `import express from 'express';\nexport const adminRoutes = express.Router();\nadminRoutes.delete('/users/:id', (req, res) => res.end());\n`,
    'server/routes/notes.js': router(`router.get('/', (req, res) => res.json([]));`),
    'server/legacy.js': `const express = require('express');\nconst router = express.Router();\nrouter.get('/ping', (req, res) => res.send('pong'));\nmodule.exports = router;\n`,
  });
  assert.deepEqual(routeKeys(graph), ['DELETE /api/admin/users/:id', 'GET /api/notes', 'GET /health', 'GET /legacy/ping', 'POST /api/billing/refund']);
});

test('Express: a name app.use() is handed that is not a router puts no prefix on anything', () => {
  const graph = mapOf({
    'package.json': EXPRESS,
    'server/index.js': [
      `import express from 'express';`,
      `import rateLimit from 'express-rate-limit';`,
      `import { authenticate, authRoutes } from './auth.js';`,
      `const app = express();`,
      `const limiter = rateLimit({ windowMs: 60000 });`,
      `app.use('/api', limiter);`,
      `app.use('/api', authenticate);`,
      `app.use('/api', express.static('public'));`,
      `app.use('/auth', authRoutes);`,
      `app.get('/health', (req, res) => res.json({ ok: true }));`,
    ].join('\n'),
    // a file with both a middleware function and a router: only the router is mounted
    'server/auth.js': [
      `import { Router } from 'express';`,
      `export function authenticate(req, res, next) { if (!req.headers.authorization) return res.status(401).end(); next(); }`,
      `export const authRoutes = Router();`,
      `authRoutes.post('/login', (req, res) => res.json({}));`,
    ].join('\n'),
  });
  assert.deepEqual(withFiles(graph), ['GET /health <- server/index.js', 'POST /auth/login <- server/auth.js']);
});

test('Hono: routers under any name, nested in one file, compose under their mounts (#98)', () => {
  assert.deepEqual(withFiles(mapOf({}, 'hono-named-routers')), [
    'DELETE /api/frentes/vieja <- src/routes.ts',
    'GET /api/croquis/mapa <- src/routes.ts',
    'GET /api/frentes/lista <- src/routes.ts',
    'GET /health <- src/index.ts',
    'POST /api/frentes/nueva <- src/routes.ts',
  ]);
});

test('routers made in a file are found whatever they are called, and their routes are not web requests', () => {
  const r = extract([
    `import { Hono } from 'hono';`,
    `import { Router } from 'express';`,
    `export const frentes = new Hono<{ Bindings: Env }>();`,
    `const app: Express = express();`,
    `export const profileRoutes = Router();`,
    `const billingRoutes = createBillingRoutes();`,
    `const cache = new Map();`,
    `frentes.get('/lista', (c) => c.json([]));`,
    `profileRoutes.get('/me', (req, res) => res.json({}));`,
    `app.get('/health', ok);`,
    `cache.get('/not-a-route');`,
    `app.route('/api/frentes', frentes);`,
    `app.use('/api/billing', requireRole('admin'), billingRoutes);`,
    `app.use('/api/*', cors({ exposedHeaders: ['X-Refreshed-Token'] }));`,
    `app.use(requireAuth);`,
  ].join('\n'), 'typescript', 'server/index.ts');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path} ${x.var}`), ['GET /lista frentes', 'GET /me profileRoutes', 'GET /health app']);
  assert.deepEqual(r.calls.filter((c) => c.path === '/lista' || c.path === '/me'), []);
  assert.deepEqual(r.mounts.map(({ line, ...m }) => m), [
    { prefix: '/api/frentes', on: 'app', var: 'frentes' },
    { prefix: '/api/billing', on: 'app', mw: ['requireRole'], var: 'billingRoutes', via: 'createBillingRoutes' },
    { prefix: '/api', on: 'app', var: 'cors', call: true },
    { prefix: '', on: 'app', var: 'requireAuth' },
  ]);
});
