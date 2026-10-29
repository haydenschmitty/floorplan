// Claude Code and Codex: the skill notices which one is running it, and the map remembers, so its
// Ask bar and "Fix with …" prompts name the right one. Only Claude Code gets the CLAUDE.local.md note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, shopApp, run, readGraph, readJson, cleanup } from './helpers.mjs';

const { detectAgent } = await lib('agent.mjs');

test('Codex is recognised by the variables it sets for every command', () => {
  assert.equal(detectAgent({}, { CODEX_THREAD_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({}, { CODEX_SESSION_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({}, {}), 'claude');
  assert.equal(detectAgent({}, { CLAUDECODE: '1' }), 'claude');
});

test('OpenCode is recognised by its variable, and Copilot only by name', () => {
  assert.equal(detectAgent({}, { OPENCODE_CLIENT: 'cli' }), 'opencode');
  assert.equal(detectAgent({}, { OPENCODE_CLIENT: 'cli', CODEX_THREAD_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({ agent: 'copilot' }, {}), 'copilot');
  assert.equal(detectAgent({}, { FLOORPLAN_AGENT: 'OpenCode' }), 'opencode');
  assert.equal(detectAgent({}, { TERM_PROGRAM: 'vscode' }), 'claude');
});

test('a map built under OpenCode or Copilot records it, and leaves the project notes alone', () => {
  for (const agent of ['opencode', 'copilot']) {
    const root = shopApp();
    try {
      run('scan.mjs', root);
      const out = run('build.mjs', root, '--agent', agent);
      assert.equal(readGraph(root).meta.agent, agent);
      assert.match(out, /AGENT {2}(OpenCode|GitHub Copilot)/);
      assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.local.md')), 'no CLAUDE.local.md');
    } finally { cleanup(root); }
  }
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

test('a map built under Claude Code records it, and keeps the CLAUDE.local.md note', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--agent', 'claude');
    assert.equal(readGraph(root).meta.agent, 'claude');
    assert.match(fs.readFileSync(path.join(root, 'CLAUDE.local.md'), 'utf8'), /floorplan\/query\.mjs/);
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
