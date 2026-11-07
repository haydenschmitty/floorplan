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
const versionPattern = plugin.version.replaceAll('.', '[.]');

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

test('the Codex marketplace lists this plugin, from this repo', () => {
  const codexMarket = readJson(path.join(REPO, '.agents', 'plugins', 'marketplace.json'));
  const entry = codexMarket.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `.agents/plugins/marketplace.json lists ${plugin.name}`);
  assert.deepEqual(entry.source, { source: 'local', path: './' });
});

test('the README version badge matches plugin.json', () => {
  assert.match(read('README.md'), new RegExp(`badge/version-${versionPattern}-`));
});

test('the changelog has an entry for this version', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${versionPattern} `, 'm'));
});

test('the skill has a name and description, and every file it points to exists', () => {
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: floorplan\ndescription: .{50,}/);
  for (const [, ref] of skill.matchAll(/\]\((references\/[\w.-]+\.md)/g)) assert.ok(fs.existsSync(path.join(SKILL, ref)), ref);
  for (const [, script] of skill.matchAll(/scripts\/(\w+\.mjs)/g)) assert.ok(fs.existsSync(path.join(SKILL, 'scripts', script)), script);
});

test('CHECKSUMS.txt is for this version, so each release ships its fingerprints', () => {
  assert.match(read('CHECKSUMS.txt'), new RegExp(`^# Floorplan ${versionPattern}:`), 'run node tools/checksums.mjs when bumping the version');
});

test('the Hermes manifest ships the same version as the Claude and Codex manifests', () => {
  const yaml = read('plugin.yaml');
  const field = (key) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(yaml)?.[1].trim();
  assert.equal(field('name'), plugin.name);
  assert.equal(field('version'), plugin.version, 'plugin.yaml version');
  assert.equal(readJson(path.join(REPO, '.codex-plugin', 'plugin.json')).version, plugin.version);
});

test('the safety page names every Hermes runtime file and the hermes program', () => {
  const page = read('docs/is-it-safe.md');
  for (const file of ['plugin.yaml', '__init__.py', 'hermes/runner.py']) assert.ok(page.includes(file), `docs/is-it-safe.md lists ${file}`);
  assert.match(page, /\|\s*`hermes`\s*\|[^\n]*probe[^\n]*ask/, 'the hermes row names probe and ask');
});

test('the privacy page states the Hermes read and write limits exactly', () => {
  const page = read('docs/privacy-and-security.md');
  assert.match(page, /\|\s*Asking questions \(Hermes\)\s*\|/, 'a Hermes row in what runs where');
  // the three explicit blueprint inputs, and nothing else outside the scanned code
  for (const file of ['floorplan/plan.json', 'floorplan/architecture.json', '`source`']) assert.ok(page.includes(file), `the blueprint exception names ${file}`);
  assert.match(page, /exactly three files/);
  assert.match(page, /findIssues/, 'fresh classification of the exact bytes');
  assert.match(page, /single-use ticket/, 'a ticket bound to the classified bytes');
  assert.match(page, /SHA-256/);
  assert.match(page, /200-line window passes/);
  assert.match(page, /201 fails/);
  assert.match(page, /\.cache\/history\//);
  assert.match(page, /manifest\.json/);
  assert.match(page, /held\//);
  assert.match(page, /displaced\//);
  assert.match(page, /never pruned/);
  assert.match(page, /no atomic compare-and-swap/);
  assert.match(page, /open descriptor/);
});

test('the Hermes guide documents install, use, limits and the support matrix', () => {
  assert.ok(fs.existsSync(path.join(REPO, 'docs', 'hermes.md')), 'docs/hermes.md');
  const page = read('docs/hermes.md');
  for (const needle of ['--ref', '--no-enable', 'plugins doctor', '/floorplan:floorplan', '--profile', '--model',
    '--engine hermes', 'protocol_mismatch', 'unsupported_runtime', 'ssh -N -L', '300', 'checksums.mjs --check',
    'exactly three files', '200-line window passes', '201 fails', 'no atomic compare-and-swap', 'open descriptor',
    'never pruned']) assert.ok(page.includes(needle), `docs/hermes.md mentions ${needle}`);
  assert.match(read('docs/README.md'), /\[Floorplan in Hermes\]\(hermes\.md\)/);
});

test('Hermes is never offered the Claude email button', () => {
  const ui = read('skills/floorplan/assets/ui/50-cloud.js');
  const line = ui.split('\n').find((l) => l.includes('data-claude>')) || '';
  const expr = /\$\{([^}]+data-claude[^}]+)\}/.exec(line)?.[1];
  assert.ok(expr, 'the email view still has one conditional Claude-email button');
  const render = new Function('S', `return ${expr};`);
  const button = '<button class="btn soft" data-claude>Use my Claude email</button>';
  assert.equal(render({ cli: true, engine: 'hermes' }), '', 'Hermes gets no Claude email button');
  assert.equal(render({ cli: true, engine: 'codex' }), '', 'Codex keeps its manual email entry');
  assert.equal(render({ cli: true, engine: 'claude' }), button, 'Claude keeps the button');
  assert.equal(render({ cli: false, engine: 'claude' }), '', 'no CLI, no button');
});
