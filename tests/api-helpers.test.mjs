// Requests made through an app's own helpers (apiGet('/tasks'), apiSend('PATCH', …)), and a client's base
// address: when a client's calls that only one endpoint could answer all go under one base (its base URL holds
// /api/v2), a shorter address elsewhere that looks closer doesn't win, even in the same server file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

let root, graph;
before(() => {
  root = makeProject({
    'server/package.json': JSON.stringify({ name: 'server', type: 'module', dependencies: { express: '^4.19.0' } }),
    'server/app.js': [
      `import express from 'express';`,
      `const app = express();`,
      `// the website's own page for a task, and the API the phone app uses`,
      `app.get('/tasks/:id', (req, res) => res.send('<html></html>'));`,
      `app.get('/api/v2/tasks/:id', (req, res) => res.json({}));`,
      `app.patch('/api/v2/tasks/:id', (req, res) => res.json({}));`,
      `app.get('/api/v2/me', (req, res) => res.json({}));`,
      `app.listen(3000);`,
    ].join('\n'),
    'phone/package.json': JSON.stringify({ name: 'phone', dependencies: { expo: '^52.0.0' } }),
    'phone/src/client.ts': [
      `// the base URL ends in /api/v2`,
      `const BASE = process.env.EXPO_PUBLIC_API_URL;`,
      `export async function apiGet<T>(path: string): Promise<T> { return (await fetch(BASE + path)).json(); }`,
      `export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> { return (await fetch(BASE + path, { method, body: JSON.stringify(body) })).json(); }`,
    ].join('\n'),
    // the ambiguous calls come first: the base is learned from /me, which only the API answers
    'phone/src/tasks.ts': [
      `import { apiGet, apiSend } from './client';`,
      'export const task = (id: number) => apiGet<{ id: number }>(`/tasks/${id}`);',
      'export const rename = (id: number, name: string) => apiSend<{ id: number }>(\'PATCH\', `/tasks/${id}`, { name });',
      `export const me = () => apiGet<{ name: string }>('/me');`,
    ].join('\n'),
  }, { arch: {
    project: { name: 'tasks', summary: 'Test fixture.' },
    nodes: [
      { id: 'server', label: 'Server', kind: 'service', summary: 'The server.', paths: ['server/**'] },
      { id: 'phone', label: 'Phone app', kind: 'ui', summary: 'The phone app.', paths: ['phone/**'] },
    ],
  } });
  scanAndBuild(root);
  graph = readGraph(root);
});
after(() => cleanup(root));

test("a phone app's helper calls reach the API under its base, not the website's closer-looking page", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${[...l.labels].sort().join(', ')}`);
  assert.deepEqual(http, ['phone/src/tasks.ts -> server/app.js GET /api/v2/me, GET /api/v2/tasks/:id, PATCH /api/v2/tasks/:id']);
});

// A base learned in one client is shared with that client's other files (the nearest folder with a package.json,
// or its repo), never with another client beside it in the same folder (apps/ in a monorepo).
test("a client's base reaches its other files, but not another client in the same folder", async () => {
  const { matchCalls } = await lib('routes.mjs');
  const routes = [
    { file: 'server/app.js', method: 'GET', path: '/tasks/:id/comments', line: 1 },
    { file: 'server/app.js', method: 'GET', path: '/api/v2/tasks/:id/comments', line: 2 },
    { file: 'server/app.js', method: 'GET', path: '/api/v2/me', line: 3 },
  ];
  const where = (files) => matchCalls(files, routes).map((h) => `${h.from} -> ${h.path}`).sort();
  const comments = { path: '/tasks/${x}/comments', method: 'GET', line: 1 };
  const me = { path: '/me', method: 'GET', line: 1 };
  // a monorepo: each app has its own package.json
  assert.deepEqual(where([
    { path: 'package.json' }, { path: 'apps/phone/package.json' }, { path: 'apps/web/package.json' }, { path: 'server/package.json' },
    { path: 'apps/phone/src/api/me.ts', calls: [me] },
    { path: 'apps/phone/src/screens/comments.ts', calls: [comments] },
    { path: 'apps/web/src/pages/comments.ts', calls: [comments] },
  ]), [
    'apps/phone/src/api/me.ts -> /api/v2/me',
    'apps/phone/src/screens/comments.ts -> /api/v2/tasks/:id/comments',
    'apps/web/src/pages/comments.ts -> /tasks/:id/comments',
  ]);
  // repos side by side in one folder, with no package.json to go by
  assert.deepEqual(where([
    { path: 'clients/phone/src/api/me.ts', repo: 'clients/phone', calls: [me] },
    { path: 'clients/phone/src/screens/comments.ts', repo: 'clients/phone', calls: [comments] },
    { path: 'clients/web/src/pages/comments.ts', repo: 'clients/web', calls: [comments] },
  ]), [
    'clients/phone/src/api/me.ts -> /api/v2/me',
    'clients/phone/src/screens/comments.ts -> /api/v2/tasks/:id/comments',
    'clients/web/src/pages/comments.ts -> /tasks/:id/comments',
  ]);
});
