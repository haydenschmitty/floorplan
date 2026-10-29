// The map's local server: it listens only on this machine, and its API answers only the map page it
// served (a per-start token, from the same origin), so other websites can't use it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

let root, server, base, token;
before(async () => {
  root = shopApp();
  scanAndBuild(root);
  const port = 20000 + Math.floor(Math.random() * 20000);
  // no Claude Code or Codex CLI and no waitlist card: this only exercises the server itself
  server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_NO_PROMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  token = /"token":"([0-9a-f]+)"/.exec(await (await fetch(base + '/')).text())?.[1];
});
after(async () => {
  // wait for the server to exit first: on Windows its working folder can't be removed while it runs
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  cleanup(root);
});

const api = (p, { headers = {}, ...opts } = {}) => fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...headers } });

test('it listens on 127.0.0.1 only', () => {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('the page it serves carries a fresh token', () => {
  assert.match(token || '', /^[0-9a-f]{32}$/);
});

test('API calls without the token are refused', async () => {
  assert.equal((await api('/api/flows')).status, 403);
  assert.equal((await api('/api/ask', { method: 'POST', body: '{"question":"hi"}' })).status, 403);
  assert.equal((await api('/api/flows', { headers: { 'x-floorplan-token': 'wrong' } })).status, 403);
});

test('API calls with the token from another website are refused', async () => {
  const r = await api('/api/flows', { headers: { 'x-floorplan-token': token, origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('API calls with the token from the map itself work', async () => {
  const r = await api('/api/flows', { headers: { 'x-floorplan-token': token } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { flows: [] });
});

test('files outside the map folder are never served', async () => {
  // including a neighbouring folder whose name starts with "floorplan"
  fs.mkdirSync(path.join(root, 'floorplan-old'));
  fs.writeFileSync(path.join(root, 'floorplan-old', 'notes.txt'), 'private notes');
  for (const p of ['/../shop-api/config.js', '/%2e%2e/shop-api/config.js', '/..%2fshop-api%2fconfig.js', '/..%2ffloorplan-old%2fnotes.txt']) {
    const r = await fetch(base + p);
    const body = await r.text();
    assert.ok(!body.includes('DB_PASSWORD') && !body.includes('private notes'), `${p} -> ${r.status}`);
  }
});

test('a malformed address gets an error, and the server keeps running', async () => {
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
  assert.equal((await fetch(base + '/')).status, 200);
});
