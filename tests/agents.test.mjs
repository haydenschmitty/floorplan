// Claude Code and Codex: the skill notices which one is running it, and the map remembers, so its
// Ask bar and "Fix with …" prompts name the right one. Only Claude Code gets the CLAUDE.local.md note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, shopApp, run, readGraph, readJson, cleanup } from './helpers.mjs';

const { detectAgent } = await lib('agent.mjs');

test('Codex and GitHub Copilot are recognised by the variables they set for every command', () => {
  assert.equal(detectAgent({}, { CODEX_THREAD_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({}, { CODEX_SESSION_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({}, { COPILOT_CLI: '1' }), 'copilot');
  assert.equal(detectAgent({}, { COPILOT_AGENT_SESSION_ID: 'abc' }), 'copilot');
  assert.equal(detectAgent({}, {}), 'claude');
  assert.equal(detectAgent({}, { CLAUDECODE: '1' }), 'claude');
});

test('--agent and FLOORPLAN_AGENT override the guess, and nonsense is ignored', () => {
  assert.equal(detectAgent({ agent: 'codex' }, {}), 'codex');
  assert.equal(detectAgent({ agent: 'Claude' }, { CODEX_THREAD_ID: 'abc' }), 'claude');
  assert.equal(detectAgent({ agent: 'copilot' }, {}), 'copilot');
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

test('a map built under GitHub Copilot records it, labels it, and leaves Claude notes alone', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--agent', 'copilot');
    assert.equal(readGraph(root).meta.agent, 'copilot');
    assert.match(out, /AGENT {2}GitHub Copilot/);
    assert.doesNotMatch(out, /CLAUDE\.LOCAL\.MD/);
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.local.md')), 'no Claude notes');
    assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')), 'no shared notes');
    assert.match(fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'), /GitHub Copilot/);
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
