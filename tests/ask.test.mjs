// Asking questions on the map: serve.mjs runs the Claude Code CLI or Codex on the person's own sign-in,
// read-only, and turns their event stream into progress lines and an answer board. Stand-in CLIs
// (fixtures/fake-cli) record what they were given, so these run without either one installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, shopApp, run, cleanup } from './helpers.mjs';

const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-cli');
let root;
const servers = [];

// Keep the machine's own ACP agents and ~/.floorplan/settings.json out of these tests.
const ACP_OFF = {
  FLOORPLAN_ACP: '', FLOORPLAN_ACP_GEMINI: '', FLOORPLAN_ACP_OPENCODE: '', FLOORPLAN_ACP_DEVIN: '',
  FLOORPLAN_ACP_CLAUDE_CODE_ACP: '', FLOORPLAN_ACP_CLAUDE_AGENT_ACP: '', FLOORPLAN_ACP_CODEX_ACP: '',
};
/** Starts the map's server with these environment overrides; returns { base, token, page, log }. */
async function serve(env = {}) {
  const log = path.join(root, `fake-${servers.length}.log`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const home = env.HOME || path.join(root, `home-${servers.length}`);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, ...ACP_OFF, HOME: home, USERPROFILE: env.USERPROFILE || home, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || path.join(home, '.config'), FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: '', FAKE_LOG: log, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  const html = await (await fetch(base + '/')).text();
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(html)[1]);
  return { base, token: page.token, page, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

/** Asks one question and returns its server-sent events as [{ event, data }]. */
async function ask(s, question, session) {
  const r = await fetch(s.base + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': s.token }, body: JSON.stringify({ question, session }) });
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

const acpEnv = (extra = {}) => ({
  FLOORPLAN_ENGINE: 'acp',
  FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'),
  FLOORPLAN_CODEX: path.join(root, 'no-such-cli'),
  ...extra,
});

test('an ACP agent answers over the protocol, kept to the codebase, and never has its sign-in methods tried', async () => {
  const s = await serve(acpEnv({ FLOORPLAN_ACP: path.join(FAKE, 'fake-acp.mjs') }));
  assert.equal(s.page.engine, 'acp');
  assert.equal(s.page.cli, true);
  assert.equal(s.page.change, false);
  const events = await ask(s, 'How do refunds work?');
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Searching the map for "refund"']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Refunds');
  assert.deepEqual(answer.items.map((i) => i.id), ['f:shop-api/routes/orders.js']);
  assert.match(answer.session, /^[0-9a-f]{16}$/);

  const calls = s.calls();
  assert.equal(calls.some((c) => c.method === 'authenticate'), false);
  const init = calls.find((c) => c.method === 'initialize');
  assert.equal(init.params.protocolVersion, 1);
  assert.equal(init.params.clientCapabilities.fs.writeTextFile, false);
  const session = calls.find((c) => c.method === 'session/new');
  assert.equal(fs.realpathSync(session.params.cwd), fs.realpathSync(root));
  const prompt = calls.find((c) => c.method === 'session/prompt');
  assert.match(prompt.params.prompt[0].text, /How do refunds work\?/);
  assert.equal(calls.some((c) => c.method === 'session/set_mode'), false); // a custom command has no known read-only mode

  const { probes } = calls.find((c) => c.probes);
  assert.equal(probes.readInside.ok, true);
  assert.equal(probes.readOutside.ok, false);
  assert.equal(probes.write.ok, false);
  assert.equal(probes.dangerous.ok, false);
  assert.equal(probes.terminal.exit.exitCode, 0);
  assert.ok(probes.terminal.out > 0);
  assert.equal(probes.permission.result.outcome.optionId, 'r');
  assert.equal(probes.fetch.result.outcome.optionId, 'r');
  assert.equal(probes.readKind.result.outcome.optionId, 'r');
  assert.equal(probes.queryPermit.result.outcome.optionId, 'a');
});

test('a follow-up ACP question carries the conversation so far', async () => {
  const s = await serve(acpEnv({ FLOORPLAN_ACP: path.join(FAKE, 'fake-acp.mjs') }));
  const [first] = pick(await ask(s, 'How do refunds work?'), 'answer');
  const [second] = pick(await ask(s, 'Who can ask for one?', first.session), 'answer');
  assert.equal(second.session, first.session);
  const prompts = s.calls().filter((c) => c.method === 'session/prompt').map((c) => c.params.prompt[0].text);
  assert.doesNotMatch(prompts[0], /Earlier in this conversation/);
  assert.match(prompts[1], /Earlier in this conversation:\nQ: How do refunds work\?\nA: Refunds go through/);
});

test('a signed-out ACP agent is told what is missing, without a sign-in method being tried', async () => {
  const s = await serve(acpEnv({ FLOORPLAN_ACP: 'gemini', FLOORPLAN_ACP_GEMINI: path.join(FAKE, 'fake-acp.mjs') }));
  const [failure] = pick(await ask(s, 'SIGNED-OUT question'), 'failure');
  assert.equal(failure.code, 'not_logged_in');
  assert.match(failure.message, /isn't signed in/);
  assert.match(failure.message, /Log in with Google/);
  assert.match(failure.message, /API key/);
  assert.match(failure.message, /Run `gemini`/);
  assert.equal(s.calls().some((c) => c.method === 'authenticate'), false);
});

test('a known ACP agent is launched in its own read-only mode, and a saved command is never run', async () => {
  const home = path.join(root, 'saved-home');
  fs.mkdirSync(path.join(home, '.floorplan'), { recursive: true });
  fs.writeFileSync(path.join(home, '.floorplan', 'settings.json'), JSON.stringify({ agent: { engine: 'acp', acp: 'rm -rf / --danger' } }));
  const ignored = await serve(acpEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') }));
  assert.equal(ignored.page.cli, false);
  assert.equal(ignored.page.want, 'acp');
  const [missing] = pick(await ask(ignored, 'Anything?'), 'failure');
  assert.equal(missing.code, 'cli_missing');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.floorplan', 'settings.json'), 'utf8')).agent.acp, 'rm -rf / --danger');

  const gemini = await serve(acpEnv({ FLOORPLAN_ACP: 'gemini', FLOORPLAN_ACP_GEMINI: path.join(FAKE, 'fake-acp.mjs'), FLOORPLAN_MODEL: 'opus' }));
  assert.equal(gemini.page.name, 'Gemini (ACP)');
  assert.equal(gemini.page.change, false);
  await ask(gemini, 'How do refunds work?');
  const geminiLog = gemini.calls();
  assert.deepEqual(geminiLog[0].argv, ['--approval-mode=plan', '--acp']);
  assert.equal(geminiLog.find((c) => c.method === 'session/set_mode').params.modeId, 'plan');

  const devin = await serve(acpEnv({ FLOORPLAN_ACP: 'devin', FLOORPLAN_ACP_DEVIN: path.join(FAKE, 'fake-acp.mjs'), FLOORPLAN_MODEL: 'opus' }));
  await ask(devin, 'How do refunds work?');
  assert.deepEqual(devin.calls()[0].argv, ['acp', '--model', 'opus']);

  const codex = await serve(acpEnv({ FLOORPLAN_ACP: 'codex-acp', FLOORPLAN_ACP_CODEX_ACP: path.join(FAKE, 'fake-acp.mjs') }));
  await ask(codex, 'How do refunds work?');
  assert.equal(codex.calls()[0].readOnlyMode, 'read-only');
  assert.equal(codex.calls().find((c) => c.method === 'session/set_mode').params.modeId, 'read-only');

  const refused = await fetch(gemini.base + '/api/engine', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': gemini.token }, body: JSON.stringify({ engine: 'acp', acp: 'rm -rf /', persist: true }) });
  assert.equal(refused.status, 404);
});

test('an agent configured in Zed can be selected by name', async () => {
  const home = path.join(root, 'zed-home');
  const zed = path.join(home, '.config', 'zed');
  fs.mkdirSync(zed, { recursive: true });
  fs.writeFileSync(path.join(zed, 'settings.json'), `{
    // a local agent
    "agent_servers": { "Local": { "command": ${JSON.stringify(path.join(FAKE, 'fake-acp.mjs'))}, "args": [] } }
  }`);
  const s = await serve(acpEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), FLOORPLAN_ACP: 'zed:Local' }));
  assert.equal(s.page.name, 'Local (ACP)');
  const listed = await (await fetch(s.base + '/api/agents', { headers: { 'x-floorplan-token': s.token } })).json();
  assert.ok(listed.agents.some((a) => a.id === 'zed:Local' && a.name === 'zed:Local' && a.acp === 'zed:Local'));
  const [answer] = pick(await ask(s, 'How do refunds work?'), 'answer');
  assert.equal(answer.title, 'Refunds');
  assert.equal(s.calls().some((c) => c.method === 'session/set_mode'), false);
});

test('the Ask bar switches a known agent, remembers that name, and a startup flag still wins', async () => {
  const home = path.join(root, 'picker-home');
  const settings = path.join(home, '.floorplan', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const baseEnv = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    FLOORPLAN_ENGINE: '', FLOORPLAN_ACP: '',
    FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'),
    FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs'),
    FLOORPLAN_ACP_GEMINI: path.join(FAKE, 'fake-acp.mjs'),
    FLOORPLAN_ACP_OPENCODE: path.join(FAKE, 'fake-acp.mjs'),
    FLOORPLAN_ACP_DEVIN: '',
  };
  // a command string in settings is not an agent: it is never run, and the file is not rewritten.
  // the engine id is still acp, so the server uses the first known agent it can find
  fs.writeFileSync(settings, JSON.stringify({ cloud: { status: 'joined' }, agent: { engine: 'acp', acp: 'rm -rf / --danger' } }));
  const ignored = await serve(baseEnv);
  assert.equal(ignored.page.engine, 'acp');
  assert.equal(ignored.page.name, 'Gemini (ACP)');
  assert.equal(ignored.page.change, false);
  await ask(ignored, 'How do refunds work?');
  assert.deepEqual(ignored.calls()[0].argv, ['--approval-mode=plan', '--acp']);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { cloud: { status: 'joined' }, agent: { engine: 'acp', acp: 'rm -rf / --danger' } });

  fs.writeFileSync(settings, JSON.stringify({ cloud: { status: 'never' }, agent: { engine: 'acp', acp: 'opencode' } }, null, 2) + '\n');
  const s = await serve(baseEnv);
  assert.equal(s.page.engine, 'acp');
  assert.equal(s.page.name, 'OpenCode (ACP)');
  assert.equal(s.page.change, false);
  const list = await (await fetch(s.base + '/api/agents', { headers: { 'x-floorplan-token': s.token } })).json();
  const ids = list.agents.map((a) => a.id);
  assert.deepEqual(ids.filter((id) => id === 'claude' || id === 'codex'), ['claude', 'codex']);
  assert.ok(ids.indexOf('codex') < ids.indexOf('acp:opencode'));
  assert.ok(ids.includes('acp:gemini') && ids.includes('acp:opencode'));
  assert.equal(list.agents.some((a) => /rm\s/.test(JSON.stringify(a))), false);
  assert.deepEqual(list.default, { engine: 'acp', acp: 'opencode' });

  const headers = { 'content-type': 'application/json', 'x-floorplan-token': s.token };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  const stream = await fetch(s.base + '/api/events?token=' + encodeURIComponent(s.token), { signal: ac.signal });
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const waited = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('events ended before the engine change');
      buf += dec.decode(value);
      const m = /event: engine\ndata: (.*)\n/.exec(buf);
      if (m) return JSON.parse(m[1]);
    }
  })();
  const switched = await (await fetch(s.base + '/api/engine', { method: 'POST', headers, body: JSON.stringify({ engine: 'claude' }) })).json();
  assert.equal(switched.engine, 'claude');
  assert.equal(switched.change, true);
  assert.equal(switched.name, 'Claude Code CLI');
  const ev = await waited;
  clearTimeout(timer);
  ac.abort();
  assert.equal(ev.engine, 'claude');
  assert.equal(ev.change, true);
  const html = await (await fetch(s.base + '/')).text();
  const again = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(html)[1]);
  assert.equal(again.engine, 'claude');
  assert.equal(again.change, true);
  await ask(s, 'How do refunds work?');
  assert.ok(s.calls().some((c) => c.args?.includes('-p')));

  const star = await fetch(s.base + '/api/engine', { method: 'POST', headers, body: JSON.stringify({ engine: 'acp', acp: 'gemini', switch: false, persist: true }) });
  assert.equal(star.status, 200);
  const remembered = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(remembered.cloud.status, 'never');
  assert.deepEqual(remembered.agent, { engine: 'acp', acp: 'gemini' });
  const still = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(s.base + '/')).text())[1]);
  assert.equal(still.engine, 'claude');

  const refused = await fetch(s.base + '/api/engine', { method: 'POST', headers, body: JSON.stringify({ engine: 'acp', acp: 'rm -rf /', persist: true }) });
  assert.equal(refused.status, 404);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).agent, { engine: 'acp', acp: 'gemini' });

  const flagged = await serve({ ...baseEnv, FLOORPLAN_ENGINE: 'acp', FLOORPLAN_ACP: 'devin', FLOORPLAN_ACP_DEVIN: path.join(FAKE, 'fake-acp.mjs') });
  assert.equal(flagged.page.name, 'Devin (ACP)');
  assert.equal(flagged.page.change, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).agent, { engine: 'acp', acp: 'gemini' });
});
