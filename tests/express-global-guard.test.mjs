// An app-wide app.use(...) guard turns off the open-endpoint check for every route behind it, so
// only middleware that really reads as a login check may do that (#72).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, scanAndBuild, readGraph, cleanup, openEndpoints } from './helpers.mjs';

const arch = {
  project: { name: 'shop', summary: 'Test fixture.' },
  nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['**'] }],
};

/** Maps a one-repo Express app whose server/index.ts has `middleware` before the admin routes. */
function mapWith(middleware) {
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
