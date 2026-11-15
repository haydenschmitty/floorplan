// An app-wide app.use(...) guard turns off the open-endpoint check for every route behind it, so
// only middleware that really reads as a login check may do that (#72). The same goes for a check
// on a path (app.use('/api/*', auth)) and on a router, which cover the routers mounted after them (#98).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, scanAndBuild, readGraph, cleanup, openEndpoints } from './helpers.mjs';

const arch = {
  project: { name: 'shop', summary: 'Test fixture.' },
  nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['**'] }],
};

/** Maps a one-repo Express app whose server/index.ts has `middleware` before the admin routes (and `after` after them). */
function mapWith(middleware, after = '') {
  const root = makeProject({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '^4.0.0' } }),
    'server/admin.routes.ts': [
      `import { Router } from 'express';`,
      `const router = Router();`,
      `router.delete('/users/:id', (req, res) => res.status(204).end());`,
      `export default router;`,
    ].join('\n'),
    'server/index.ts': [
      `import express from 'express';`,
      `import adminRoutes from './admin.routes.js';`,
      ``,
      `const app = express();`,
      middleware,
      `app.use('/api/admin', adminRoutes);`,
      after,
      `app.listen(3000);`,
    ].join('\n'),
  }, { repos: ['.'], arch });
  try {
    scanAndBuild(root);
    return readGraph(root);
  } finally {
    cleanup(root);
  }
}

const OPEN = ['DELETE /api/admin/users/:id'];

test('Express: a word inside a string in app.use(...) is not a login check (#72)', () => {
  assert.deepEqual(openEndpoints(mapWith(`app.use(cors({ origin: true, exposedHeaders: ['X-Request-Id'] }));`)), OPEN);
  assert.deepEqual(openEndpoints(mapWith(`app.use(cors({ origin: true, exposedHeaders: ['X-Refreshed-Token'] }));`)), OPEN);
  assert.deepEqual(openEndpoints(mapWith(`app.use(express.json({ type: 'application/vnd.session+json' }));`)), OPEN);
});

test('Express: middleware that never checks the caller is not a login check (#72)', () => {
  // express-session and passport.session() load a session; they don't turn anyone away
  assert.deepEqual(openEndpoints(mapWith(`app.use(session({ name: 'sid', resave: false }));`)), OPEN);
  assert.deepEqual(openEndpoints(mapWith(`app.use(passport.session());`)), OPEN);
  assert.deepEqual(openEndpoints(mapWith(`app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));`)), OPEN);
});

test('Express: "guard" alone in an app-wide middleware name is not a login check (#72)', () => {
  assert.deepEqual(openEndpoints(mapWith(`app.use(createShutdownGuard());`)), OPEN);
});

test('Express: app-wide login checks still protect the routes behind them', () => {
  for (const line of [
    `app.use(requireAuth);`,
    `app.use(authGuard);`,
    `app.use(verifyToken());`,
    `app.use(jwt({ secret: process.env.JWT_SECRET, algorithms: ['HS256'] }));`,
    `app.use(cors(), requireUser);`,
  ]) assert.deepEqual(openEndpoints(mapWith(line)), [], line);
});

test('Health names no repo "." when the project is a single repo at the root (#72)', () => {
  const issue = mapWith(`app.use(cors());`).health.issues.find((i) => i.id.startsWith('no-auth:'));
  assert.ok(issue, 'expected the no-login-check issue');
  assert.equal(issue.title, 'None of your endpoints check who is calling');
  assert.doesNotMatch(issue.fix, /in \.\s/);
});

test('Express: option names, routers and middleware that only loads someone are not login checks (#72)', () => {
  for (const line of [
    `app.use(rateLimiter({ tokenStore, keyPrefix: 'rl' }));`, // an option named like a check
    `app.use(authRoutes);`, // the sign-in routes, not a check
    `app.use(sessionMiddleware);`,
    `app.use(optionalAuth);`,
    `app.use(loadUser);`,
    `app.use(auth.optional);`,
    `// app.use(requireAuth);`,
  ]) assert.deepEqual(openEndpoints(mapWith(line)), OPEN, line);
});

test('Express: a check for a path covers the routers mounted under it after it (#98)', () => {
  for (const line of [
    `app.use(passport.authenticate('jwt', { session: false }));`,
    `app.use(authenticate);`,
    `app.use(auth.required);`,
    `app.use('/api', authenticate);`,
    `app.use('/api/*', requireAuth);`,
    `app.use('/api/admin', requireRole('admin'));`,
  ]) assert.deepEqual(openEndpoints(mapWith(line)), [], line);
  // near misses: another path, middleware that checks no one, and a check added after the router
  assert.deepEqual(openEndpoints(mapWith(`app.use('/web', requireAuth);`)), OPEN);
  assert.deepEqual(openEndpoints(mapWith(`app.use('/api', cors());`)), OPEN);
  assert.deepEqual(openEndpoints(mapWith('', `app.use('/api', requireAuth);`)), OPEN);
});

/** Maps a project made of `files` and returns the endpoints Health reports as open. */
function openIn(files) {
  const root = makeProject(files, { arch });
  try {
    scanAndBuild(root);
    return openEndpoints(readGraph(root));
  } finally {
    cleanup(root);
  }
}

test('Express: router.use(requireAuth) covers the routers that router mounts after it', () => {
  const app = (adminBody) => ({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '^4.0.0' } }),
    'server/index.js': `import express from 'express';\nimport admin from './admin.js';\nconst app = express();\napp.use('/api/admin', admin);\n`,
    'server/admin.js': [`import { Router } from 'express';`, `import users from './users.js';`, `const router = Router();`, ...adminBody, `export default router;`].join('\n'),
    'server/users.js': `import { Router } from 'express';\nconst router = Router();\nrouter.delete('/:id', (req, res) => res.status(204).end());\nexport default router;\n`,
  });
  assert.deepEqual(openIn(app([`router.use(requireAuth);`, `router.use('/users', users);`])), []);
  assert.deepEqual(openIn(app([`router.use('/users', users);`, `router.use(requireAuth);`])), ['DELETE /api/admin/users/:id']);
});

test('Hono: app.use("/api/*", auth) covers the sub-apps routed under /api (#98)', () => {
  const app = (path) => ({
    'package.json': JSON.stringify({ name: 'notes', type: 'module', dependencies: { hono: '^4.0.0' } }),
    'src/index.ts': [
      `import { Hono } from 'hono';`,
      `import { bearerAuth } from 'hono/bearer-auth';`,
      `import { notas } from './notas.js';`,
      `const app = new Hono<{ Bindings: Env }>();`,
      `app.use('${path}', bearerAuth({ token: env.API_TOKEN }));`,
      `app.route('/api/notas', notas);`,
      `export default app;`,
    ].join('\n'),
    'src/notas.ts': `import { Hono } from 'hono';\nexport const notas = new Hono();\nnotas.post('/', (c) => c.json({}));\nnotas.delete('/:id', (c) => c.body(null, 204));\n`,
  });
  assert.deepEqual(openIn(app('/api/*')), []);
  assert.deepEqual(openIn(app('/admin/*')), ['DELETE /api/notas/:id', 'POST /api/notas']);
});

test('Health names the app-wide check that alone protects endpoints (#72)', () => {
  const graph = mapWith(`app.use(requireAuth);`);
  assert.deepEqual(graph.health.appWide, [{ name: 'requireAuth', file: 'server/index.ts', line: 5, endpoints: 1 }]);
  assert.equal(mapWith(`app.use(cors());`).health.appWide, undefined);
});
