// Claude Code, Cursor and Codex: the skill notices which one is running it, and the map remembers, so its
// Ask bar and "Fix with …" prompts name the right one. Only Claude Code gets the CLAUDE.local.md note.
// Cursor can get a personal rule, and only when asked. Codex leaves project notes alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { lib, shopApp, run, readGraph, readJson, cleanup, REPO } from './helpers.mjs';

const { detectAgent } = await lib('agent.mjs');

test('Codex is recognised by the variables it sets for every command', () => {
  assert.equal(detectAgent({}, { CODEX_THREAD_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({}, { CODEX_SESSION_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({}, {}), 'claude');
  assert.equal(detectAgent({}, { CLAUDECODE: '1' }), 'claude');
});

test('Cursor is recognised by the variables its agent sets, and wins over Codex if both are present', () => {
  assert.equal(detectAgent({}, { CURSOR_AGENT: '1' }), 'cursor');
  assert.equal(detectAgent({}, { CURSOR_CONVERSATION_ID: 'abc' }), 'cursor');
  assert.equal(detectAgent({}, { CURSOR_AGENT: '0' }), 'claude');
  assert.equal(detectAgent({}, { CURSOR_AGENT: '1', CODEX_THREAD_ID: 'abc' }), 'cursor');
});

test('--agent and FLOORPLAN_AGENT override the guess, and nonsense is ignored', () => {
  assert.equal(detectAgent({ agent: 'codex' }, {}), 'codex');
  assert.equal(detectAgent({ agent: 'Claude' }, { CODEX_THREAD_ID: 'abc' }), 'claude');
  assert.equal(detectAgent({}, { FLOORPLAN_AGENT: 'codex' }), 'codex');
  assert.equal(detectAgent({ agent: 'gpt' }, { CODEX_THREAD_ID: 'abc' }), 'codex');
});

test('a map built under Codex records it, and leaves the project notes alone', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--agent', 'codex');
    assert.equal(readGraph(root).meta.agent, 'codex');
    assert.match(out, /AGENT {2}Codex/);
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.local.md')), 'no CLAUDE.local.md');
    assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')), 'no AGENTS.md');
  } finally { cleanup(root); }
});

test('a map built under Claude Code records it, and adds the CLAUDE.local.md note only when asked', () => {
  const root = shopApp();
  const notes = path.join(root, 'CLAUDE.local.md');
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--agent', 'claude'), /CLAUDE\.LOCAL\.MD {2}not added/);
    assert.equal(readGraph(root).meta.agent, 'claude');
    assert.ok(!fs.existsSync(notes), 'no CLAUDE.local.md until the user says yes');
    run('build.mjs', root, '--agent', 'claude', '--claude-md');
    assert.match(fs.readFileSync(notes, 'utf8'), /floorplan\/query\.mjs/);
  } finally { cleanup(root); }
});

test('a CLAUDE.local.md note that already exists is kept current, and the opt-out marker still wins', () => {
  const root = shopApp();
  const notes = path.join(root, 'CLAUDE.local.md');
  try {
    run('scan.mjs', root);
    fs.writeFileSync(notes, 'my notes\n\n<!-- floorplan:start -->\nold\n<!-- floorplan:end -->\n');
    run('build.mjs', root, '--agent', 'claude');
    const text = fs.readFileSync(notes, 'utf8');
    assert.match(text, /^my notes/);
    assert.match(text, /floorplan\/query\.mjs/);
    assert.doesNotMatch(text, /\nold\n/);
    fs.writeFileSync(notes, 'my notes\n<!-- floorplan:off -->\n');
    assert.match(run('build.mjs', root, '--agent', 'claude', '--claude-md'), /CLAUDE\.LOCAL\.MD {2}skipped \(opted out\)/);
    assert.equal(fs.readFileSync(notes, 'utf8'), 'my notes\n<!-- floorplan:off -->\n');
  } finally { cleanup(root); }
});

test('the copy for the Claude app always says Claude, whoever built the map', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--agent', 'codex', '--artifact', '--no-claude-md');
    const html = fs.readFileSync(path.join(root, 'floorplan', 'artifact.html'), 'utf8');
    assert.match(html, /"agent":"claude"/);
    assert.equal(readJson(path.join(root, 'floorplan', 'graph.json')).meta.agent, 'codex');
  } finally { cleanup(root); }
});

test('a map built under Cursor records it, leaves Claude and Codex notes alone, and adds a rule only when asked', () => {
  const root = shopApp();
  const rule = path.join(root, '.cursor', 'rules', 'floorplan.mdc');
  try {
    execFileSync('git', ['init', '-q', root]);
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--agent', 'cursor');
    assert.equal(readGraph(root).meta.agent, 'cursor');
    assert.match(out, /AGENT {2}Cursor/);
    assert.match(out, /CURSOR RULE {2}not added/);
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.local.md')), 'no CLAUDE.local.md');
    assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')), 'no AGENTS.md');
    assert.ok(!fs.existsSync(rule), 'no Cursor rule until the user says yes');
    const added = run('build.mjs', root, '--agent', 'cursor', '--cursor-rules');
    assert.match(added, /CURSOR RULE {2}created \.cursor\/rules\/floorplan\.mdc/);
    assert.match(added, /ignored locally via \.git\/info\/exclude/);
    const text = fs.readFileSync(rule, 'utf8');
    assert.match(text, /alwaysApply: true/);
    assert.match(text, /floorplan\/query\.mjs/);
    const exclude = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
    assert.match(fs.readFileSync(path.resolve(root, exclude), 'utf8'), /\/\.cursor\/rules\/floorplan\.mdc/);
    fs.writeFileSync(rule, 'my notes\n\n<!-- floorplan:start -->\nold\n<!-- floorplan:end -->\n');
    run('build.mjs', root, '--agent', 'cursor');
    const kept = fs.readFileSync(rule, 'utf8');
    assert.match(kept, /^my notes/);
    assert.match(kept, /floorplan\/query\.mjs/);
    assert.doesNotMatch(kept, /\nold\n/);
    fs.writeFileSync(rule, 'my notes\n<!-- floorplan:off -->\n');
    assert.match(run('build.mjs', root, '--agent', 'cursor', '--cursor-rules'), /CURSOR RULE {2}skipped \(opted out\)/);
    assert.equal(fs.readFileSync(rule, 'utf8'), 'my notes\n<!-- floorplan:off -->\n');
  } finally { cleanup(root); }
});

test('a map built in Cursor waits for the Cursor chat, unless --engine names Claude or Codex', async () => {
  const root = shopApp();
  const servers = [];
  const fake = path.join(REPO, 'tests', 'fixtures', 'fake-cli', 'fake-codex.mjs');
  const start = (env) => new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
      cwd: root, env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    servers.push(server);
    const buf = { out: '' };
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${buf.out}`)), 20000);
    server.stdout.on('data', (d) => {
      buf.out += d;
      const m = /Floorplan: (http:\/\/\S+)/.exec(buf.out);
      if (m && !buf.ready) { buf.ready = true; clearTimeout(timer); resolve({ base: m[1], buf }); }
    });
    server.on('exit', (code) => { if (!buf.ready) reject(new Error(`server exited (${code}): ${buf.out}`)); });
  });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--agent', 'cursor', '--no-cursor-rules');
    const missing = path.join(root, 'no-such-cli');
    const alone = await start({ FLOORPLAN_CLAUDE: missing, FLOORPLAN_CODEX: missing });
    const alonePage = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(alone.base + '/')).text())[1]);
    assert.match(alone.buf.out, /asking through the Cursor chat/);
    assert.equal(alonePage.cli, false);
    assert.equal(alonePage.want, 'cursor');
    assert.equal(alonePage.engine, null);
    assert.equal(alonePage.cursor, true);
    assert.equal(alonePage.change, false);
    const headers = { 'content-type': 'application/json', 'x-floorplan-token': alonePage.token };
    const asked = fetch(alone.base + '/api/ask', { method: 'POST', headers, body: JSON.stringify({ question: 'Where is checkout?' }) });
    const polled = await fetch(alone.base + '/api/cursor-ask?timeout=5000', { headers });
    const pending = await polled.json();
    assert.equal(pending.question.question, 'Where is checkout?');
    assert.equal(pending.question.mode, 'ask');
    const replied = await fetch(alone.base + '/api/cursor-ask', {
      method: 'POST', headers,
      body: JSON.stringify({ id: pending.question.id, answer: { title: 'Checkout', answer: 'It lives in orders.', items: [], followups: ['What does an order store?'] } }),
    });
    assert.equal(replied.status, 200);
    const stream = await (await asked).text();
    assert.match(stream, /event: answer/);
    assert.match(stream, /It lives in orders/);
    const refused = await fetch(alone.base + '/api/cursor-ask', {
      method: 'POST', headers,
      body: JSON.stringify({ id: pending.question.id, answer: { title: 'Again', answer: 'no' } }),
    });
    assert.equal(refused.status, 404);
    const withCodex = await start({ FLOORPLAN_CLAUDE: missing, FLOORPLAN_CODEX: fake });
    const stillCursor = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(withCodex.base + '/')).text())[1]);
    assert.equal(stillCursor.cursor, true);
    assert.equal(stillCursor.cli, false);
    const named = await start({ FLOORPLAN_ENGINE: 'codex', FLOORPLAN_CLAUDE: missing, FLOORPLAN_CODEX: fake });
    const codexPage = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(named.base + '/')).text())[1]);
    assert.equal(codexPage.cli, true);
    assert.equal(codexPage.engine, 'codex');
    assert.equal(codexPage.want, 'codex');
    assert.equal(codexPage.cursor, false);
  } finally {
    await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((resolve) => { s.once('exit', resolve); s.kill(); })));
    cleanup(root);
  }
});
