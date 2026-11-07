// Live acceptance for a real Hermes install. It is opt-in: with FLOORPLAN_LIVE unset this file is inert
// (one named skip), so `npm test` never makes a model call. With FLOORPLAN_LIVE=1 it fails - it does not
// skip - when any prerequisite is missing, and it records the candidate SHA, the runtime version, the
// installed public-file hashes, the profile and the provider/model the host actually returned.
//
//   FLOORPLAN_LIVE=1 FLOORPLAN_HERMES_PROFILE=<disposable profile> node --test tests/hermes-live.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { REPO, shopApp, run, cleanup } from './helpers.mjs';

const LIVE = process.env.FLOORPLAN_LIVE === '1';
const PROFILE = process.env.FLOORPLAN_HERMES_PROFILE || '';
const HERMES = process.env.FLOORPLAN_HERMES || 'hermes';
const PUBLIC_FILES = ['plugin.yaml', '__init__.py', 'hermes/runner.py', 'skills/floorplan/SKILL.md'];
const tmp = [];
const servers = [];
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

after(async () => {
  for (const s of servers) if (s.exitCode === null) await new Promise((r) => { s.once('exit', r); s.kill(); });
  for (const t of tmp) cleanup(t);
});

if (!LIVE) {
  test('the live acceptance is opt-in', { skip: 'set FLOORPLAN_LIVE=1 and FLOORPLAN_HERMES_PROFILE to run it' }, () => {});
} else {
  test('a real Hermes profile answers source-aware Ask, and the receipt names the exact install', { timeout: 240000 }, async () => {
    assert.ok(PROFILE, 'FLOORPLAN_LIVE=1 needs FLOORPLAN_HERMES_PROFILE naming a disposable profile');
    let version;
    try { version = execFileSync(HERMES, ['--version'], { encoding: 'utf8' }).trim(); }
    catch (e) { assert.fail(`FLOORPLAN_LIVE=1 but \`${HERMES} --version\` failed: ${e.message}`); }
    let probe;
    try { probe = JSON.parse(execFileSync(HERMES, ['--profile', PROFILE, 'floorplan', 'probe'], { encoding: 'utf8' })); }
    catch (e) { assert.fail(`FLOORPLAN_LIVE=1 but \`${HERMES} --profile ${PROFILE} floorplan probe\` failed: ${e.message}`); }
    assert.equal(probe.plugin, 'floorplan', 'the profile has this plugin');
    assert.equal(probe.protocol, 1, 'the installed plugin speaks the generated server protocol');
    assert.equal(probe.ask, 'ready', 'the installed runtime supports the confined worker');
    const installed = path.resolve(probe.skill_dir, '..');
    const hashes = Object.fromEntries(PUBLIC_FILES.map((f) => {
      const p = path.join(installed, f);
      assert.ok(fs.existsSync(p), `the installed plugin has ${f}`);
      return [f, sha256(p)];
    }));
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();

    const root = shopApp();
    tmp.push(root);
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const args = [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open', '--engine', 'hermes', '--profile', PROFILE];
    if (process.env.FLOORPLAN_HERMES) args.push('--hermes', process.env.FLOORPLAN_HERMES);
    const server = spawn(process.execPath, args, {
      cwd: root, env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: 'hermes' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    servers.push(server);
    let out = '';
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 30000);
      server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
      server.stderr.on('data', (d) => { out += d; });
      server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
    });
    const html = await (await fetch(base + '/')).text();
    const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(html)[1]);
    assert.equal(page.engine, 'hermes', 'the map runs the Hermes worker');
    assert.equal(page.source, true, 'source-aware reads are available');

    const r = await fetch(base + '/api/ask', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': page.token },
      body: JSON.stringify({ question: 'What does this app do? Answer from the map.' }),
    });
    assert.equal(r.status, 200);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', answer = null, failure = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null');
        if (event === 'answer') answer = data;
        if (event === 'failure') failure = data;
      }
    }
    assert.equal(failure, null, `the host returned a failure: ${JSON.stringify(failure)}`);
    assert.ok(answer, 'the host returned an answer');
    assert.ok(answer.provider, 'the answer names the provider the host actually used');
    assert.ok(answer.model, 'the answer names the model the host actually used');
    console.log(`FLOORPLAN_LIVE_RECEIPT ${JSON.stringify({ candidate, version, profile: PROFILE, hashes, provider: answer.provider, model: answer.model })}`);
  });
}
