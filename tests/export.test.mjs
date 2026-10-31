// Exporting a copy of the map to share: serve.mjs --export and the map's Export button (POST /api/export)
// write the same self-contained page, marked as exported, without this computer's details or the server's
// token, and with only the extras asked for. Health and recent work are left out unless asked for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { shopApp, run, readJson, writeJson, cleanup, FAKE_PASSWORD, openPrivateMap } from './helpers.mjs';

const TOKEN_IN_REMOTE = 'ghp-not-a-real-token-1234';
let root, server, base, token, cookie;
const serveJs = () => path.join(root, 'floorplan', 'serve.mjs');
/** The graph inside an exported page. */
const dataOf = (html) => JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(html)[1]);
/** Runs serve.mjs --export with these arguments; returns the exported page and what it printed. */
function exportCli(...args) {
  const out = execFileSync(process.execPath, [serveJs(), '--export', ...args], { cwd: root, encoding: 'utf8' });
  const file = /Exported the map to (.+)/.exec(out)[1].trim();
  return { out, html: fs.readFileSync(file, 'utf8'), file };
}

before(async () => {
  root = shopApp();
  execFileSync('git', ['-C', path.join(root, 'shop-api'), 'remote', 'add', 'origin', `https://someone:${TOKEN_IN_REMOTE}@example.com/shop-api.git`]);
  const arch = readJson(path.join(root, 'floorplan', 'architecture.json'));
  writeJson(path.join(root, 'floorplan', 'architecture.json'), {
    ...arch,
    annotations: [{ path: 'shop-api/config.js', note: 'Moving to the secrets manager next sprint.' }],
    flows: [{ id: 'refund', title: 'Refund', description: 'A customer asks for a refund.', steps: [{ node: 'web', note: 'The website asks.' }, { node: 'api', note: 'The server refunds.' }] }],
  });
  writeJson(path.join(root, 'floorplan', 'recent-work.json'), { tasks: [{ title: 'Refunds', summary: 'Added refunds.', items: [{ ref: 'shop-api/routes/orders.js', change: 'changed', note: 'Refund endpoint.' }] }] });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');

  const port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, [serveJs(), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_NO_PROMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  ({ base, token, cookie } = await openPrivateMap(base));
});
after(async () => {
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  cleanup(root);
});

test('the map has health, recent work, a note, a flow and a remote to leave out', () => {
  const g = dataOf(fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'));
  assert.ok(g.health.issues.length > 0);
  assert.equal(g.recent.items.length, 1);
  assert.ok(g.files.some((f) => f.note));
  assert.equal(g.flows.length, 1);
  assert.ok(g.meta.root);
});

test('by default the export keeps flows and notes, and leaves out health, recent work and this computer', () => {
  const { html, file, out } = exportCli();
  assert.equal(path.basename(file), 'shop-map.html');
  assert.equal(path.dirname(file), path.join(fs.realpathSync(root), 'floorplan'));
  const g = dataOf(html);
  assert.match(g.meta.exported.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(g.meta.exported.include, ['flows', 'notes']);
  assert.equal(g.health, undefined);
  assert.equal(g.recent, undefined);
  assert.equal(g.flows.length, 1);
  assert.ok(g.files.some((f) => f.note));
  assert.equal(g.meta.root, null);
  assert.ok(g.meta.repos.every((r) => !('remote' in r)));
  assert.ok(!html.includes(TOKEN_IN_REMOTE), 'no sign-in token from a git remote');
  const here = readJson(path.join(root, 'floorplan', 'graph.json')).meta.root;
  assert.ok(here && !html.includes(here), 'no folder path from this computer');
  assert.ok(!html.includes('FLOORPLAN_SERVER='), 'no server details');
  assert.match(out, /no Ask bar/);
  assert.doesNotMatch(out, /Share it only with people you trust/);
});

test('health and recent work go in only when asked for, with a warning about health', () => {
  const { html, out } = exportCli(path.join(root, 'all.html'), '--include', 'flows,notes,recent,health');
  const g = dataOf(html);
  assert.deepEqual(g.meta.exported.include, ['flows', 'notes', 'recent', 'health']);
  assert.ok(g.health.issues.length > 0);
  assert.equal(g.recent.items.length, 1);
  assert.match(out, /Share it only with people you trust/);
  // where a secret sits, never the secret itself
  assert.ok(!html.includes(FAKE_PASSWORD));
});

test('flows, the tour and notes can be left out too', () => {
  const { html } = exportCli(path.join(root, 'bare.html'), '--include', 'none');
  const g = dataOf(html);
  assert.deepEqual(g.meta.exported.include, []);
  assert.deepEqual(g.flows, []);
  assert.deepEqual(g.tour, []);
  assert.ok(g.files.every((f) => !('note' in f)));
});

test('the exported page is still the whole map, ready to open', () => {
  const { html } = exportCli(path.join(root, 'page.html'));
  const g = dataOf(html);
  const built = readJson(path.join(root, 'floorplan', 'graph.json'));
  assert.equal(g.files.length, built.files.length);
  assert.equal(g.routes.length, built.routes.length);
  assert.equal(g.links.length, built.links.length);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /ui\/60-export\.js/);
});

const api = (body, headers = {}) => fetch(base + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body) });

test('the Export button needs the map page’s token', async () => {
  assert.equal((await api({ include: ['flows'] })).status, 403);
  assert.equal((await api({ include: ['flows'] }, { 'x-floorplan-token': 'wrong' })).status, 403);
});

test('the Export button downloads the copy, with flows requested since the last build', async () => {
  const extra = { id: 'custom-1', title: 'Admin deletes a user', description: '', steps: [{ ref: 'web', note: 'First.' }, { ref: 'api', note: 'Then.' }] };
  const r = await api({ include: ['flows', 'health'], flows: [extra, { id: 'bad', steps: 'nope' }] }, { 'x-floorplan-token': token });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="shop-map.html"');
  const g = dataOf(await r.text());
  assert.deepEqual(g.meta.exported.include, ['flows', 'health']);
  assert.deepEqual(g.flows.map((f) => f.id), ['refund', 'custom-1']);
  assert.equal(g.flows[1].custom, true);
  assert.ok(g.files.every((f) => !('note' in f)), 'notes weren’t ticked');
  assert.equal(g.recent, undefined);
  assert.ok(g.health);
});
