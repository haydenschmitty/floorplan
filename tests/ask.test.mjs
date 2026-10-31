// Asking questions on the map: serve.mjs runs the Claude Code CLI or Codex on the person's own sign-in,
// read-only, and turns their event stream into progress lines and an answer board. Stand-in CLIs
// (fixtures/fake-cli) record what they were given, so these run without either one installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, shopApp, run, cleanup, openPrivateMap } from './helpers.mjs';

const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-cli');
let root;
const servers = [];

/** Starts the map's server with these environment overrides; returns { base, token, page, log }. */
async function serve(env) {
  const log = path.join(root, `fake-${servers.length}.log`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: '', FAKE_LOG: log, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  const auth = await openPrivateMap(base);
  return { ...auth, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

/** Asks one question and returns its server-sent events as [{ event, data }]. */
async function ask(s, question, session) {
  const r = await fetch(s.base + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': s.token, cookie: s.cookie }, body: JSON.stringify({ question, session }) });
  return (await r.text()).split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (\w+)/.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
}
const pick = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);

// built "by Claude Code" whichever agent runs the tests, so the engine order below is predictable
before(() => { root = shopApp(); run('scan.mjs', root); run('build.mjs', root, '--no-claude-md', '--agent', 'claude'); });
after(async () => {
  // wait for the servers to exit first: on Windows their working folder can't be removed while they run
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((resolve) => { s.once('exit', resolve); s.kill(); })));
  cleanup(root);
});

test('with only Codex installed, questions run through Codex, read-only and out of its history', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  assert.equal(s.page.engine, 'codex');
  assert.equal(s.page.cli, true);

  const events = await ask(s, 'How do refunds work?');
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Searching the map for "refund"', 'Reading shop-api/routes/orders.js']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Refunds');
  assert.deepEqual(answer.items.map((i) => i.id), ['f:shop-api/routes/orders.js']);
  assert.match(answer.session, /^[0-9a-f]{16}$/);

  const [call] = s.calls();
  const flag = (name) => call.args[call.args.indexOf(name) + 1];
  assert.equal(call.args[0], 'exec');
  assert.equal(flag('--sandbox'), 'read-only');
  assert.ok(call.args.includes('--ephemeral'), 'nothing is saved to the Codex history');
  // Node runs serve.mjs from its real path, and on macOS the temp folder /var/… is really /private/var/…
  assert.equal(fs.realpathSync(flag('-C')), fs.realpathSync(root));
  assert.match(call.input, /How do refunds work\?/);
  assert.match(call.input, /node floorplan\/query\.mjs/);
});

test('Codex gets an answer schema it accepts: every property required, nothing extra', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  await ask(s, 'What is this?');
  const { schema } = s.calls()[0];
  const check = (node, where) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, where);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), where);
      for (const [k, v] of Object.entries(node.properties)) check(v, `${where}.${k}`);
    }
    if (node.type === 'array') check(node.items, `${where}[]`);
  };
  check(schema, 'answer');
  assert.ok(schema.required.includes('steps') && schema.required.includes('followups'));
});

test('a Codex follow-up carries the conversation so far', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  const [first] = pick(await ask(s, 'How do refunds work?'), 'answer');
  const [second] = pick(await ask(s, 'Who can ask for one?', first.session), 'answer');
  assert.equal(second.session, first.session);
  const calls = s.calls();
  assert.doesNotMatch(calls[0].input, /Earlier in this conversation/);
  assert.match(calls[1].input, /Earlier in this conversation:\nQ: How do refunds work\?\nA: Refunds go through/);
  // an unknown session starts a fresh conversation
  const [other] = pick(await ask(s, 'Start over', 'not-a-session'), 'answer');
  assert.notEqual(other.session, first.session);
  assert.doesNotMatch(s.calls()[2].input, /Earlier in this conversation/);
});

test('a signed-out Codex says so, so the map can tell the person to sign in', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  const [failure] = pick(await ask(s, 'SIGNED-OUT question'), 'failure');
  assert.equal(failure.code, 'not_logged_in');
  assert.equal(pick(await ask(s, 'SIGNED-OUT again'), 'answer').length, 0);
});

test('the Claude Code CLI comes first for a map Claude built, with read-only tools, and follow-ups resume', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  assert.equal(s.page.engine, 'claude');
  const events = await ask(s, 'How do refunds work?');
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Reading the map overview', 'Reading shop-api/routes/orders.js']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.session, 'test-session');
  await ask(s, 'And then?', answer.session);
  const [first, second] = s.calls();
  assert.ok(first.args.includes('-p'));
  assert.deepEqual(first.args.slice(first.args.indexOf('--allowedTools') + 1), ['Bash(node floorplan/query.mjs:*)', 'Read', 'Grep', 'Glob']);
  assert.equal(first.input, 'How do refunds work?');
  assert.equal(second.args[second.args.indexOf('--resume') + 1], 'test-session');
});

test('--engine picks one CLI and never falls back to the other', async () => {
  const s = await serve({ FLOORPLAN_ENGINE: 'codex', FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli') });
  assert.equal(s.page.cli, false);
  assert.equal(s.page.want, 'codex');
  const [failure] = pick(await ask(s, 'Anything?'), 'failure');
  assert.equal(failure.code, 'cli_missing');
  assert.match(failure.message, /Codex not found/);
});

// Windows: a newer npm install of Claude Code has the real program at <npm>/node_modules/@anthropic-ai/claude-code/bin/claude.exe, no cli.js, and only
// shell shims beside it (the extensionless "claude" that `where claude` lists first, and claude.cmd), which can't be spawned. The server must use the real program.
test('on Windows, a Claude Code npm install with only bin/claude.exe is found and run (not the shell shim)', { skip: process.platform !== 'win32' }, async () => {
  const npm = path.join(root, 'fake-npm');
  const pkg = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(npm, 'claude'), '#!/bin/sh\n'); // the shim: a text file that can't be run
  const fakeExe = path.join(pkg, 'claude.exe');
  fs.copyFileSync(process.execPath, fakeExe); // a program that answers --version (a copy, not a link: a link can't be removed afterwards on some Windows runners)
  fs.chmodSync(fakeExe, 0o666); // the copy keeps Node's read-only flag, which stops the folder being cleaned up
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(npm, 'claude'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli') });
  assert.equal(s.page.engine, 'claude');
  assert.equal(s.page.version, process.version);
});
