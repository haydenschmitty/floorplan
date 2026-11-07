// The Hermes lifecycle, on two disposable HERMES_HOMEs: install and enable touch one profile only, a
// running map server restarts when its profile, Hermes CLI or generated helper revision changes, a stale
// generated server refuses a newer plugin protocol, disable/remove never touch the map or its preserved
// conflict history, and rolling back to the recorded release re-checks identical.
//
// This is the offline lifecycle contract. It models the documented install layout (the plugin under
// `<HERMES_HOME>/plugins/floorplan`, enabled in `<HERMES_HOME>/config.yaml`) and never runs `hermes` against
// a real profile: G3 (a real disposable-profile install) is a live gate, not this test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { REPO, SKILL, shopApp, run, cleanup } from './helpers.mjs';

const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-cli', 'fake-hermes.mjs');
const tmps = [];
const pids = [];
const servers = [];

after(async () => {
  for (const s of servers) if (s.exitCode === null) await new Promise((r) => { s.once('exit', r); s.kill(); });
  for (const pid of pids) { try { process.kill(pid); } catch {} }
  for (const t of tmps) cleanup(t);
});

const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmps.push(d); return d; };
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const walk = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).replace(/\\/g, '/'))
  .sort();
const tree = (dir) => Object.fromEntries(walk(dir).map((f) => [f, sha256(path.join(dir, f))]));

// ---------- a disposable Hermes home ----------
// Hermes keeps a profile's plugins under <HERMES_HOME>/plugins/<name> and its enabled list in
// config.yaml. The test writes the same flat shape; no Hermes source or real profile is involved.
const configFile = (home) => path.join(home, 'config.yaml');
function enabled(home) {
  const text = fs.existsSync(configFile(home)) ? fs.readFileSync(configFile(home), 'utf8') : '';
  const block = /^plugins:\n(?: {2}enabled:\n((?: {4}- .*\n?)*))?/m.exec(text)?.[1] || '';
  return block.split('\n').map((l) => l.replace(/^\s*- /, '').trim()).filter(Boolean);
}
function setEnabled(home, names) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(configFile(home), ['plugins:', '  enabled:', ...names.map((n) => `    - ${n}`), ''].join('\n'));
}
const install = (home, release) => {
  const dest = path.join(home, 'plugins', 'floorplan');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(release, dest, { recursive: true });
  return dest;
};
const removePlugin = (home) => fs.rmSync(path.join(home, 'plugins', 'floorplan'), { recursive: true, force: true });
const enable = (home, name = 'floorplan') => setEnabled(home, [...new Set([...enabled(home), name])]);
const disable = (home, name = 'floorplan') => setEnabled(home, enabled(home).filter((n) => n !== name));

// ---------- a release tree and its own checksum manifest ----------
const RUNTIME = ['plugin.yaml', '__init__.py', 'hermes', 'skills', 'tools', 'CHECKSUMS.txt',
  '.claude-plugin', '.codex-plugin', '.agents', 'package.json'];
function release(tag, mutate) {
  const dir = path.join(tmp('floorplan-release-'), tag);
  fs.mkdirSync(dir, { recursive: true });
  for (const part of RUNTIME) fs.cpSync(path.join(REPO, part), path.join(dir, part), { recursive: true });
  mutate?.(dir);
  execFileSync(process.execPath, [path.join(dir, 'tools', 'checksums.mjs')], { encoding: 'utf8' });
  return dir;
}
function check(releaseDir, installed) {
  try { return { ok: true, out: execFileSync(process.execPath, [path.join(releaseDir, 'tools', 'checksums.mjs'), '--check', installed], { encoding: 'utf8' }) }; }
  catch (e) { return { ok: false, out: String(e.stdout) }; }
}

test('install and enable in one disposable HERMES_HOME leave the other unchanged', () => {
  const a = tmp('hermes-home-a-'), b = tmp('hermes-home-b-');
  setEnabled(b, ['other-plugin']);
  const before = tree(b);
  const rel = release('install');
  install(a, rel);
  enable(a);
  assert.deepEqual(enabled(a), ['floorplan']);
  assert.deepEqual(enabled(b), ['other-plugin'], 'profile B still enables only its own plugin');
  assert.ok(fs.existsSync(path.join(a, 'plugins', 'floorplan', 'plugin.yaml')));
  assert.equal(fs.existsSync(path.join(b, 'plugins', 'floorplan')), false);
  assert.deepEqual(tree(b), before, 'profile B is byte-identical after installing and enabling in A');
});

// ---------- a built map and its server ----------
function shopMap() {
  const root = shopApp();
  tmps.push(root);
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
  return root;
}
function openMap(root, args) {
  execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'open.mjs'), root, '--no-open', ...args], {
    encoding: 'utf8', env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1' }, timeout: 90000,
  });
  const state = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'server.json'), 'utf8'));
  pids.push(state.pid);
  return state;
}
function fakeProbe(file, protocol) {
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "if (process.argv.includes('--version')) { console.log('0.22.9-test'); process.exit(0); }",
    `console.log(JSON.stringify({ plugin: 'floorplan', protocol: ${protocol}, profile: 'test-profile', skill_dir: ${JSON.stringify(SKILL)}, ask: 'ready' }));`,
    '',
  ].join('\n'));
  return file;
}
async function startServer(root, args) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open', ...args], {
    cwd: root, env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  let out = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.stderr.on('data', (d) => { out += d; });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
  });
  const html = await (await fetch(base + '/')).text();
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(html)[1]);
  return { base, token: page.token, page };
}

test('open restarts a running server when the profile, the Hermes CLI or the helper revision changes', () => {
  const root = shopMap();
  const otherFake = path.join(tmp('fake-hermes-2-'), 'fake-hermes.mjs');
  fs.copyFileSync(FAKE, otherFake);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const flags = (extra) => ['--port', String(port), '--engine', 'hermes', ...extra];
  const first = openMap(root, flags(['--hermes', FAKE, '--profile', 'profile-a']));
  assert.equal(first.opts.profile, 'profile-a');
  assert.equal(first.opts.hermes, FAKE);
  const reused = openMap(root, flags(['--hermes', FAKE, '--profile', 'profile-a']));
  assert.equal(reused.pid, first.pid, 'the same options reuse the running server');
  const profileB = openMap(root, flags(['--hermes', FAKE, '--profile', 'profile-b']));
  assert.notEqual(profileB.pid, first.pid, 'a new --profile restarts');
  assert.equal(profileB.opts.profile, 'profile-b');
  const otherCli = openMap(root, flags(['--hermes', otherFake, '--profile', 'profile-b']));
  assert.notEqual(otherCli.pid, profileB.pid, 'a new --hermes path restarts');
  assert.equal(otherCli.opts.hermes, otherFake);
  fs.appendFileSync(path.join(root, 'floorplan', 'hermes-boundary.mjs'), '\n// a newer helper revision\n');
  const helper = openMap(root, flags(['--hermes', otherFake, '--profile', 'profile-b']));
  assert.notEqual(helper.pid, otherCli.pid, 'a newer generated helper restarts');
});

test('a stale generated server reports protocol_mismatch for a newer plugin protocol', async () => {
  const root = shopMap();
  const fake = fakeProbe(path.join(tmp('fake-newer-'), 'fake-hermes.mjs'), 2);
  const s = await startServer(root, ['--engine', 'hermes', '--hermes', fake, '--profile', 'test-profile']);
  const health = await (await fetch(s.base + '/api/health', { headers: { 'x-floorplan-token': s.token } })).json();
  assert.equal(health.error, 'protocol_mismatch');
  assert.equal(health.cli, false);
  assert.equal(health.engine, null);
  assert.equal(health.want, 'hermes');
  assert.equal(s.page.error, 'protocol_mismatch', 'the page can explain it before asking');
});

test('disable and remove leave the map and every held or displaced history inode untouched', () => {
  const home = tmp('hermes-home-lifecycle-');
  install(home, release('lifecycle'));
  enable(home);
  const root = shopMap();
  const map = path.join(root, 'floorplan');
  fs.writeFileSync(path.join(map, 'custom-flows.json'), JSON.stringify([{ id: 'f1', title: 'Refund', steps: [{ ref: 'f:a', note: '' }, { ref: 'f:b', note: '' }] }]));
  fs.writeFileSync(path.join(map, 'health-dismissed.json'), JSON.stringify({ dismissed: [{ id: 'x', at: '2026-01-01T00:00:00Z' }] }));
  const H = path.join(map, '.cache', 'history', 'preserved-1');
  fs.mkdirSync(path.join(H, 'held'), { recursive: true });
  fs.mkdirSync(path.join(H, 'displaced'), { recursive: true });
  fs.writeFileSync(path.join(H, 'manifest.json'), '{"preservation":true,"kind":"change"}\n');
  fs.writeFileSync(path.join(H, 'held', '01-plan.json'), '{"held":true}\n');
  fs.writeFileSync(path.join(H, 'displaced', '01-architecture.json'), '{"displaced":true}\n');
  const before = new Map(walk(map).map((f) => [f, { hash: sha256(path.join(map, f)), ino: fs.statSync(path.join(map, f)).ino }]));
  disable(home);
  assert.deepEqual(enabled(home), [], 'disabled in this profile');
  removePlugin(home);
  assert.equal(fs.existsSync(path.join(home, 'plugins', 'floorplan')), false);
  for (const [f, want] of before) {
    const p = path.join(map, f);
    assert.ok(fs.existsSync(p), `${f} survived uninstall`);
    assert.equal(sha256(p), want.hash, `${f} bytes`);
    assert.equal(fs.statSync(p).ino, want.ino, `${f} inode`);
  }
  assert.match(fs.readFileSync(path.join(map, 'index.html'), 'utf8'), /<html/i, 'the map still opens offline');
});

test('rollback to the recorded release re-checks every fingerprint', () => {
  const home = tmp('hermes-home-rollback-');
  const previous = release('previous');
  const next = release('next', (dir) => fs.appendFileSync(path.join(dir, 'hermes', 'runner.py'), '\n# next release\n'));
  const installed = install(home, previous);
  const first = check(previous, installed);
  assert.ok(first.ok, first.out);
  assert.match(first.out, /all \d+ files are identical/);
  install(home, next);
  assert.ok(check(next, installed).ok, 'the upgraded release matches its own manifest');
  assert.equal(check(previous, installed).ok, false, 'the previous manifest sees the upgrade');
  install(home, previous);
  const back = check(previous, installed);
  assert.ok(back.ok, back.out);
  assert.match(back.out, /all \d+ files are identical/);
});
