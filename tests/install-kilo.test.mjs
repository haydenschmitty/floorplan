// tools/install-kilo.mjs: puts the skill and a /floorplan command where Kilo Code looks for them,
// in a throwaway target dir, and takes them back out. The same checks hold for the real global
// and project targets; a temp dir keeps the test off the person's own setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const run = (args) => execFileSync(process.execPath, [path.join(REPO, 'tools', 'install-kilo.mjs'), ...args], { encoding: 'utf8' });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-install-'));

test('copies the skill and adds the /floorplan command; --uninstall takes both back', () => {
  const t = dir();
  try {
    const out = run(['--target-dir', t]);
    assert.match(out, /Copied the skill/);
    assert.ok(fs.existsSync(path.join(t, 'skills', 'floorplan', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(t, 'skills', 'floorplan', 'scripts', 'build.mjs')));
    const cmd = fs.readFileSync(path.join(t, 'command', 'floorplan.md'), 'utf8');
    assert.match(cmd, /^---\ndescription: .+\n---\n/);
    assert.match(cmd, /floorplan skill/);
    assert.match(run(['--target-dir', t, '--uninstall']), /Removed/);
    assert.ok(!fs.existsSync(path.join(t, 'skills', 'floorplan')));
    assert.ok(!fs.existsSync(path.join(t, 'command', 'floorplan.md')));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('--symlink links the checkout instead of copying it', () => {
  const t = dir();
  try {
    assert.match(run(['--target-dir', t, '--symlink']), /Linked/);
    assert.equal(fs.realpathSync(path.join(t, 'skills', 'floorplan')), fs.realpathSync(path.join(REPO, 'skills', 'floorplan')));
    assert.match(run(['--target-dir', t, '--uninstall']), /Removed/);
    assert.ok(!fs.existsSync(path.join(t, 'skills', 'floorplan')));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('--uninstall refuses to remove a skill that is no longer this checkout\'s', () => {
  const t = dir();
  try {
    run(['--target-dir', t]);
    fs.writeFileSync(path.join(t, 'skills', 'floorplan', 'SKILL.md'), 'made their own\n');
    assert.throws(() => run(['--target-dir', t, '--uninstall']), /leaving it alone/);
    assert.ok(fs.existsSync(path.join(t, 'skills', 'floorplan', 'SKILL.md')), 'the edited skill stays');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('a second install replaces the first instead of failing', () => {
  const t = dir();
  try {
    run(['--target-dir', t]);
    fs.rmSync(path.join(t, 'skills', 'floorplan', 'scripts', 'scan.mjs'));
    run(['--target-dir', t]);
    assert.ok(fs.existsSync(path.join(t, 'skills', 'floorplan', 'scripts', 'scan.mjs')));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
