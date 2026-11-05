// Release hygiene: the plugin manifests, the README badge and the changelog agree on the version,
// so a release never ships half-bumped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, SKILL, readJson } from './helpers.mjs';

const plugin = readJson(path.join(REPO, '.claude-plugin', 'plugin.json'));
const marketplace = readJson(path.join(REPO, '.claude-plugin', 'marketplace.json'));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

test('the plugin version is a semantic version', () => {
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
});

test('the marketplace lists this plugin, from this repo', () => {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `marketplace.json lists ${plugin.name}`);
  assert.equal(entry.source, './');
});

test('the Codex plugin matches the Claude Code plugin and points at the same skill', () => {
  const codex = readJson(path.join(REPO, '.codex-plugin', 'plugin.json'));
  assert.equal(codex.name, plugin.name);
  assert.equal(codex.version, plugin.version, '.codex-plugin/plugin.json version');
  assert.equal(codex.skills, './skills/');
  assert.ok(fs.existsSync(path.join(REPO, 'skills', plugin.name, 'SKILL.md')));
  for (const k of ['composerIcon', 'logo']) assert.ok(fs.existsSync(path.join(REPO, codex.interface[k])), `${k}: ${codex.interface[k]}`);
});

test('the Codex and GitHub Copilot marketplace lists this plugin, from this repo', () => {
  const codexMarket = readJson(path.join(REPO, '.agents', 'plugins', 'marketplace.json'));
  const entry = codexMarket.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `.agents/plugins/marketplace.json lists ${plugin.name}`);
  assert.deepEqual(entry.source, { source: 'local', path: './' });
});

test('the README version badge matches plugin.json', () => {
  assert.match(read('README.md'), new RegExp(`badge/version-${plugin.version.replaceAll('.', '\\.')}-`));
});

test('the changelog has an entry for this version', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${plugin.version.replaceAll('.', '\\.')} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm'));
});

test('the skill has a name and description, and every file it points to exists', () => {
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: floorplan\ndescription: .{50,}/);
  for (const [, ref] of skill.matchAll(/\]\((references\/[\w.-]+\.md)/g)) assert.ok(fs.existsSync(path.join(SKILL, ref)), ref);
  for (const [, script] of skill.matchAll(/scripts\/(\w+\.mjs)/g)) assert.ok(fs.existsSync(path.join(SKILL, 'scripts', script)), script);
});

test('CHECKSUMS.txt is for this version, so each release ships its fingerprints', () => {
  assert.match(read('CHECKSUMS.txt'), new RegExp(`^# Floorplan ${plugin.version.replaceAll('.', '\\.')}:`), 'run node tools/checksums.mjs when bumping the version');
});
