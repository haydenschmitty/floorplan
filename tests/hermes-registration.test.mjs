// Hermes' native packaging: one manifest at the repo root, the shared skill registered straight from
// skills/floorplan/SKILL.md, one `floorplan` CLI command, and nothing that runs on its own (no hooks,
// no MCP server, no tools, no dependencies). The Python half is tests/hermes_runner_test.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, SKILL, readJson } from './helpers.mjs';

const UPDATE = 'If this is intentional, update plugin.yaml and tests/hermes-registration.test.mjs together.';
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const manifest = read('plugin.yaml');
/** A top-level scalar field of plugin.yaml (the file is a flat, hand-written manifest, not YAML we parse). */
const field = (key) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(manifest)?.[1].trim();
const plugin = readJson(path.join(REPO, '.claude-plugin', 'plugin.json'));

test('the Hermes manifest names this plugin, and ships the same version as the other two', () => {
  assert.equal(field('name'), 'floorplan');
  assert.equal(field('version'), plugin.version, `Hermes manifest version. ${UPDATE}`);
  assert.equal(field('kind'), 'standalone', `Hermes manifest kind. ${UPDATE}`);
  assert.ok(field('description'), 'a description, so `hermes plugins list` says what it is');
});

test('the plugin is only a skill and a command: no hooks, MCP servers, tools or dependencies', () => {
  assert.deepEqual(field('provides_hooks'), '[]', `provides_hooks. ${UPDATE}`);
  const running = ['hooks', 'tools', 'provides_tools', 'pip_dependencies', 'python_dependencies', 'mcp', 'requires_env'];
  assert.deepEqual(running.filter((key) => field(key) !== undefined), [], `manifest fields that would run or install something. ${UPDATE}`);
  const init = read('__init__.py');
  assert.doesNotMatch(init, /register_hook|register_tool|register_mcp|hooks\.json/, 'nothing registers a hook, tool or MCP server');
});

test('register() adds exactly one skill and one CLI command', () => {
  const init = read('__init__.py');
  assert.match(init, /register_skill\(\s*"floorplan"/, `registered skill name. ${UPDATE}`);
  assert.match(init, /register_cli_command\(\s*"floorplan"/, `registered CLI command. ${UPDATE}`);
  assert.match(init, /["']skills["']\s*\/\s*["']floorplan["']\s*\/\s*["']SKILL\.md["']/, `the registered path is built from this repo. ${UPDATE}`);
  assert.doesNotMatch(init, /["']\/(home|Users|opt)\//, 'no path from one machine');
});

test('the registered skill is the shared SKILL.md, and the probe lives in hermes/runner.py', () => {
  assert.ok(fs.existsSync(path.join(SKILL, 'SKILL.md')), 'skills/floorplan/SKILL.md');
  assert.ok(fs.existsSync(path.join(REPO, 'hermes', 'runner.py')), 'hermes/runner.py');
  assert.ok(fs.existsSync(path.join(REPO, 'hermes', '__init__.py')), 'hermes/ is a package, so the plugin can import its runner');
  assert.match(read(path.join('hermes', 'runner.py')), /def probe_payload/, 'the model-free probe');
});
