import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { SKILL, shopApp, makeProject, scanAndBuild, writeJson, readJson, cleanup } from './helpers.mjs';
import { registerMap, listMaps } from '../skills/floorplan/scripts/lib/map-library.mjs';

let root, other, dataDir, server, base, token, map;
const cli = path.join(SKILL, 'scripts/home.mjs');
const start = (env, ...args) => {
  const child = spawn(process.execPath, [cli, '--serve', '--no-open', ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`home did not start: ${output}`)); }, 15000);
    child.stdout.on('data', (d) => { output += d; const m = /^FLOORPLAN HOME  (http:\/\/\S+)/m.exec(output); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.stderr.on('data', (d) => { output += d; });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`home exited ${code}: ${output}`)); });
  });
  return { child, ready };
};
const stopChild = async (child) => {
  if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
};
const stopPid = async (pid) => {
  try { process.kill(pid); } catch { return; }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
before(async () => {
  root = shopApp();
  scanAndBuild(root);
  other = makeProject({ 'floorplan/index.html': '<title>Another map</title>', 'floorplan/serve.mjs': '// floorplan/serve.mjs\n' });
  writeJson(path.join(other, 'floorplan/architecture.json'), { project: { name: 'Another app' } });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-home-'));
  map = registerMap(root, { dataDir });
  const run = start({ FLOORPLAN_DATA_DIR: dataDir, FLOORPLAN_NO_PROMPTS: '1' }, '--port', '0');
  server = run.child;
  base = await run.ready;
  const html = await (await fetch(base)).text();
  token = /"token":"([a-f0-9]+)"/.exec(html)?.[1];
});
after(async () => {
  await stopChild(server);
  for (const folder of [root, other]) {
    if (!folder) continue;
    try { await stopPid(readJson(path.join(folder, 'floorplan/.cache/server.json')).pid); } catch {}
  }
  for (const folder of [root, other, dataDir]) if (folder) cleanup(folder);
});
const api = (url, options = {}) => fetch(base + url, {
  ...options, headers: { 'content-type': 'application/json', 'x-floorplan-token': token, ...options.headers },
});

test('the local homepage lists remembered maps without embedding project text as markup', async () => {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(token || '', /^[a-f0-9]{32}$/);
  const page = await fetch(base);
  const html = await page.text();
  assert.match(html, /Your maps/);
  assert.match(html, /data-floorplan-policy="local"/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const response = await api('/api/maps');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).maps[0].name, 'Shop');
  const hostile = '<img src=x onerror="alert(1)">';
  writeJson(path.join(root, 'floorplan/architecture.json'), { project: { name: hostile } });
  assert.equal((await (await api('/api/maps')).json()).maps[0].name, hostile);
  assert.equal((await (await fetch(base)).text()).includes(hostile), false);
});

test('requests from another website or under another host cannot use the home', async () => {
  assert.equal((await fetch(base + '/api/maps')).status, 403);
  assert.equal((await api('/api/maps', { headers: { 'x-floorplan-token': 'wrong' } })).status, 403);
  assert.equal((await api('/api/maps', { headers: { origin: 'https://other.example' } })).status, 403);
  const u = new URL(base);
  const status = await new Promise((resolve, reject) => {
    http.get({ hostname: u.hostname, port: u.port, path: '/', headers: { host: 'other.example:' + u.port } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await api('/api/maps', { headers: { origin: base } })).status, 200);
});

test('older maps can be added and forgotten, leaving the map files intact', async () => {
  const added = await api('/api/maps', { method: 'POST', body: JSON.stringify({ root: other }) });
  assert.equal(added.status, 200);
  const { id } = await added.json();
  assert.equal((await (await api('/api/maps')).json()).maps.length, 2);
  assert.equal((await api('/api/maps/' + id, { method: 'DELETE' })).status, 200);
  assert.equal((await (await api('/api/maps')).json()).maps.length, 1);
  assert.equal(fs.existsSync(path.join(other, 'floorplan/index.html')), true);
});

test('invalid inputs, oversized requests and unknown IDs do not stop the home', async () => {
  assert.equal((await api('/api/maps', { method: 'POST', body: '{not json' })).status, 400);
  assert.equal((await api('/api/maps', { method: 'POST', body: JSON.stringify({ root: dataDir }) })).status, 400);
  assert.equal((await api('/api/maps', { method: 'POST', body: JSON.stringify({ root: 'x'.repeat(20000) }) })).status, 413);
  assert.equal((await api('/api/maps/' + 'f'.repeat(24) + '/open', { method: 'POST', body: '{}' })).status, 404);
  const response = await fetch(base + '/..%2fsettings.json');
  assert.equal(response.status, 404);
  assert.equal((await api('/api/maps')).status, 200);
});

test('opening a stopped map starts its server, and repeated or concurrent opens reuse it', async () => {
  const url = '/api/maps/' + map.id + '/open';
  const open = async () => {
    const response = await api(url, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).url;
  };
  const [first, second] = await Promise.all([open(), open()]);
  assert.equal(first, second);
  assert.match(first, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(await (await fetch(first)).text(), /window\.FLOORPLAN/);
  assert.equal(await open(), first);
});

test('starting the home again reuses the running homepage', async () => {
  const output = execFileSync(process.execPath, [cli, '--no-open'], { encoding: 'utf8', env: { ...process.env, FLOORPLAN_DATA_DIR: dataDir }, timeout: 10000 });
  assert.ok(output.includes('FLOORPLAN HOME  ' + base));
  assert.equal(readJson(path.join(dataDir, 'home-server.json')).pid, server.pid);
});

test('unattended mode neither registers maps nor starts a homepage', () => {
  const isolated = path.join(dataDir, 'unattended');
  execFileSync(process.execPath, [cli, '--add', other], { env: { ...process.env, FLOORPLAN_UNATTENDED: '1', FLOORPLAN_DATA_DIR: isolated } });
  execFileSync(process.execPath, [path.join(SKILL, 'scripts/open.mjs'), other], { env: { ...process.env, FLOORPLAN_UNATTENDED: '1', FLOORPLAN_DATA_DIR: isolated } });
  assert.equal(fs.existsSync(isolated), false);
});

test('interactive map opens register the map even without using the homepage', async () => {
  const dir = path.join(dataDir, 'opened');
  execFileSync(process.execPath, [path.join(SKILL, 'scripts/open.mjs'), root, '--no-open'], { encoding: 'utf8', env: { ...process.env, FLOORPLAN_DATA_DIR: dir }, timeout: 30000 });
  assert.equal(listMaps({ dataDir: dir })[0]?.root, fs.realpathSync(root));
});

test('a failed registration does not prevent an existing map from opening', () => {
  const file = path.join(dataDir, 'not-a-folder');
  fs.writeFileSync(file, 'keep this file');
  const output = execFileSync(process.execPath, [path.join(SKILL, 'scripts/open.mjs'), root, '--no-open'], { encoding: 'utf8', env: { ...process.env, FLOORPLAN_DATA_DIR: file }, timeout: 30000, stdio: 'pipe' });
  assert.match(output, /^FLOORPLAN  http:\/\/127\.0\.0\.1:/m);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep this file');
});

test('the normal homepage command returns while its background server stays usable', async (t) => {
  const dir = path.join(dataDir, 'background');
  const env = { ...process.env, FLOORPLAN_DATA_DIR: dir };
  t.after(async () => { try { await stopPid(readJson(path.join(dir, 'home-server.json')).pid); } catch {} });
  const output = execFileSync(process.execPath, [cli, '--no-open', '--port', '0'], { encoding: 'utf8', env, timeout: 3000 });
  const url = /^FLOORPLAN HOME  (http:\/\/\S+)/m.exec(output)?.[1];
  assert.match(url || '', /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(url)).status, 200);
  assert.match(execFileSync(process.execPath, [cli, '--stop'], { encoding: 'utf8', env, timeout: 3000 }), /Stopped/);
});
