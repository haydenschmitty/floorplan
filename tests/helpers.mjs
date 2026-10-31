// Shared helpers for the tests: build a throwaway project on disk, run the skill's scripts on it,
// and read what they wrote. Every project lives in the OS temp folder and is removed afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = path.join(REPO, 'skills', 'floorplan');
export const lib = (name) => import(new URL(`../skills/floorplan/scripts/lib/${name}`, import.meta.url));

/**
 * Writes `files` ({ 'relative/path': 'contents' }) into a new temp folder. Each folder in `repos`
 * becomes its own git repo, like a frontend and backend side by side. Returns the folder.
 */
export function makeProject(files, { repos = [], arch } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-test-'));
  for (const [p, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), src);
  }
  for (const r of repos) execFileSync('git', ['init', '-q', path.join(root, r)]);
  if (arch) writeJson(path.join(root, 'floorplan', 'architecture.json'), arch);
  return root;
}

/** Runs one of the skill's scripts (scan.mjs, build.mjs, …) on a project and returns what it printed. */
// The scripts guess which agent is running them from the variables it sets, so run them without those:
// the tests give --agent when they care, and pass or fail the same inside Claude Code, Codex or Cursor.
const AGENT_VARS = /^(FLOORPLAN_AGENT|CLAUDECODE|CODEX_THREAD_ID|CODEX_SESSION_ID|CURSOR_AGENT)$/;
export function run(script, root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_VARS.test(k)));
  return execFileSync(process.execPath, [path.join(SKILL, 'scripts', script), root, ...args], { encoding: 'utf8', stdio: 'pipe', env });
}

/** scan + build, the way the skill does a first map (without touching CLAUDE.local.md). */
export function scanAndBuild(root) {
  return run('scan.mjs', root) + run('build.mjs', root, '--no-claude-md');
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
export const readGraph = (root) => readJson(path.join(root, 'floorplan', 'graph.json'));
export const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

/** Every file under a folder, as { path, text }. */
export function allFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => { const p = path.join(e.parentPath ?? e.path, e.name); return { path: p, text: fs.readFileSync(p, 'utf8') }; });
}

/** "METHOD /path" for every endpoint on the map. */
export const routeKeys = (graph) => graph.routes.map((r) => `${r.m} ${r.p}`).sort();

/** "METHOD /path" for every endpoint Health reports as callable by anyone. */
export function openEndpoints(graph) {
  return graph.health.issues
    .filter((i) => i.kind === 'unprotected-endpoint')
    .flatMap((i) => i.items.filter((id) => id.startsWith('r:')).map((id) => graph.routes[+id.slice(2)]))
    .map((r) => `${r.m} ${r.p}`)
    .sort();
}

// A fake password for the sample app. It's assembled at runtime so no secret-looking string is
// ever committed to this repo, and the tests can check it never reaches anything Floorplan writes.
export const FAKE_PASSWORD = ['correct', 'horse', 'battery', 'staple', '42'].join('-');

/**
 * A small shop: an Express API and a web app in two repos. It has endpoints protected three ways
 * (middleware on the route, a check where the router is mounted, none at all), cross-repo web
 * requests, and a hard-coded password.
 */
export function shopApp() {
  const files = {
    'shop-api/package.json': JSON.stringify({ name: 'shop-api', type: 'module', dependencies: { express: '^4.19.0' } }),
    'shop-api/server.js': [
      `import express from 'express';`,
      `import orders from './routes/orders.js';`,
      `import admin from './routes/admin.js';`,
      `import notes from './routes/notes.js';`,
      `import { requireStaff } from './auth.js';`,
      ``,
      `const app = express();`,
      `app.use('/api', orders);`,
      `app.use('/admin', requireStaff, admin);`,
      `app.use('/api', notes);`,
      `app.listen(3000);`,
    ].join('\n'),
    'shop-api/auth.js': [
      `/** Rejects requests without a signed-in customer. */`,
      `export function requireAuth(req, res, next) { if (!req.headers.authorization) return res.status(401).end(); next(); }`,
      `/** Rejects requests that aren't from staff. */`,
      `export function requireStaff(req, res, next) { if (!req.user?.staff) return res.status(403).end(); next(); }`,
    ].join('\n'),
    'shop-api/config.js': `export const DB_PASSWORD = "${FAKE_PASSWORD}";\nexport const PORT = 3000;\n`,
    'shop-api/routes/orders.js': [
      `import { Router } from 'express';`,
      `import { requireAuth } from '../auth.js';`,
      `import { DB_PASSWORD } from '../config.js';`,
      ``,
      `const router = Router();`,
      `/** Every order for the signed-in customer. */`,
      `router.get('/orders', requireAuth, async (req, res) => { res.json([]); });`,
      `router.post('/orders/:id/refund', requireAuth, async (req, res) => { res.json({ ok: !!DB_PASSWORD }); });`,
      `export default router;`,
    ].join('\n'),
    'shop-api/routes/admin.js': [
      `import { Router } from 'express';`,
      `const router = Router();`,
      `router.delete('/users/:id', async (req, res) => { res.status(204).end(); });`,
      `export default router;`,
    ].join('\n'),
    'shop-api/routes/notes.js': [
      `import { Router } from 'express';`,
      `const router = Router();`,
      `router.post('/notes', async (req, res) => { res.json({ saved: true }); });`,
      `export default router;`,
    ].join('\n'),
    'shop-web/package.json': JSON.stringify({ name: 'shop-web', type: 'module', dependencies: { react: '^18.3.0' } }),
    'shop-web/src/api.js': [
      `export const listOrders = () => fetch('/api/orders').then((r) => r.json());`,
      'export const refund = (id) => fetch(`/api/orders/${id}/refund`, { method: \'POST\' });',
    ].join('\n'),
    'shop-web/src/App.jsx': [
      `import { listOrders, refund } from './api.js';`,
      `export default function App() { return <button onClick={() => listOrders().then((o) => refund(o[0].id))}>Refund</button>; }`,
    ].join('\n'),
  };
  const arch = {
    project: { name: 'Shop', summary: 'A sample shop.' },
    nodes: [
      { id: 'api', label: 'Server', kind: 'service', summary: 'The shop server.', paths: ['shop-api/**'] },
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The shop website.', paths: ['shop-web/**'] },
    ],
  };
  return makeProject(files, { repos: ['shop-api', 'shop-web'], arch });
}
