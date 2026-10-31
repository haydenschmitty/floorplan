// The map's local server: it listens only on this machine, and its API answers only the map page it
// served (a per-start token, from the same origin), so other websites can't use it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shopApp, scanAndBuild, cleanup, openPrivateMap, run } from './helpers.mjs';

let root, server, base, token, cookie, ticket, privateUrl;
before(async () => {
  root = shopApp();
  scanAndBuild(root);
  const port = 20000 + Math.floor(Math.random() * 20000);
  // no Claude Code or Codex CLI and no waitlist card: this only exercises the server itself
  server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_NO_PROMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  privateUrl = base;
  ({ base, token, cookie, ticket } = await openPrivateMap(privateUrl));
});
after(async () => {
  // wait for the server to exit first: on Windows its working folder can't be removed while it runs
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  cleanup(root);
});

const api = (p, { headers = {}, ...opts } = {}) => fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', cookie, ...headers } });

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

/** A request to the server under another host name, as a site that rebinds its domain to 127.0.0.1 would send. */
const asHost = (host, p) => new Promise((resolve, reject) => {
  const u = new URL(base + p);
  http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host, cookie, 'x-floorplan-token': token } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
});

test('requests under any other host name are refused, page included (DNS rebinding)', async () => {
  const port = new URL(base).port;
  assert.equal(await asHost(`evil.example:${port}`, '/'), 403);
  assert.equal(await asHost(`evil.example:${port}`, '/api/flows'), 403);
  assert.equal(await asHost('127.0.0.1:1', '/'), 403);
  assert.equal(await asHost(`localhost:${port}`, '/'), 200);
  assert.equal(await asHost(`127.0.0.1:${port}`, '/api/flows'), 200);
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
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
});


test('unauthenticated clients cannot obtain the map, token, or static files', async () => {
  const r = await fetch(base + '/');
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.doesNotMatch(html, /window\.FLOORPLAN_SERVER|window\.FLOORPLAN =/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(html, /history\.replaceState/);
  for (const p of ['/graph.json', '/.cache/server.json', '/serve.mjs', '/index.html/other']) assert.equal((await fetch(base + p)).status, 404);
  assert.equal((await fetch(base + '/api/flows', { headers: { 'x-floorplan-token': token } })).status, 403);
});

test('bootstrap ticket is one use and cannot be exchanged cross-origin', async () => {
  const post = (t, origin) => fetch(base + '/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ ticket: t }) });
  assert.equal((await post(ticket)).status, 403);
  const link = /FLOORPLAN\s+(http:\/\/\S+)/.exec(run('open.mjs', root, '--no-open'))[1];
  const fresh = new URL(link).hash.slice(1);
  assert.equal((await post(fresh, 'https://evil.example')).status, 403);
  assert.equal((await post(fresh, base)).status, 204);
  const r = await fetch(base + '/', { headers: { cookie } });
  assert.match(await r.text(), /window\.FLOORPLAN_SERVER=/);
});

test('even authenticated clients cannot fetch a symlink or service files', async (t) => {
  const target = path.join(root, 'outside-private.txt');
  fs.writeFileSync(target, 'synthetic private content');
  try { fs.symlinkSync(target, path.join(root, 'floorplan', 'leak.txt')); }
  catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('symlink creation unavailable'); throw e; }
  for (const p of ['/leak.txt', '/graph.json', '/.cache/server.json', '/serve.mjs']) {
    const r = await fetch(base + p, { headers: { cookie } });
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /synthetic private content/);
  }
});

test('state file and directory restrict access on POSIX', () => {
  if (process.platform === 'win32') return;
  const state = path.join(root, 'floorplan', '.cache', 'server.json');
  assert.equal(fs.statSync(state).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(state)).mode & 0o777, 0o700);
});


test('open reuses the server and issues distinct single-use links', async () => {
  const one = /FLOORPLAN\s+(http:\/\/\S+)/.exec(run('open.mjs', root, '--no-open'))?.[1];
  const two = /FLOORPLAN\s+(http:\/\/\S+)/.exec(run('open.mjs', root, '--no-open'))?.[1];
  assert.ok(one && two);
  assert.notEqual(one, two);
  const first = await openPrivateMap(one);
  const second = await openPrivateMap(two);
  assert.equal(first.base, base);
  assert.equal(second.base, base);
  assert.equal(first.token, second.token);
  assert.equal((await fetch(base + '/control/status')).status, 404);
  assert.equal((await fetch(base + '/control/bootstrap', { method: 'POST' })).status, 404);
});


test('authenticated bootstrap handler preserves viewer deep links and consumes only ticket fragments', async () => {
  const html = await (await fetch(base + '/', { headers: { cookie } })).text();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(code => code.includes('window.FLOORPLAN_SERVER='));
  assert.ok(script);
  const execute = (hash) => {
    const events = [];
    const location = { hash, pathname: '/', search: '' };
    const history = { replaceState: (...args) => events.push(['replace', ...args]) };
    const fetch = (...args) => { events.push(['fetch', ...args]); return Promise.resolve({ ok: true }); };
    runInNewContext(script, { location, history, fetch, window: {} });
    return events;
  };
  assert.deepEqual(execute('#v=web&s=f%3Ashop-web%2Fsrc%2FApp.jsx'), []);
  assert.deepEqual(execute('#' + 'a'.repeat(63)), []);
  const events = execute('#' + 'a'.repeat(64));
  assert.deepEqual(events.map(e => e[0]), ['replace', 'fetch']);
  assert.equal(events[1][1], '/bootstrap');
  assert.equal(JSON.parse(events[1][2].body).ticket, 'a'.repeat(64));
});
