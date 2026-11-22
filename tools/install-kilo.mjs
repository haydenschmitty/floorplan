#!/usr/bin/env node
// Installs Floorplan's skill (and a /floorplan command) where Kilo Code looks for it: globally in
// ~/.config/kilo (the default), or in a project's .kilo/. --symlink links instead of copying, so a
// checkout of this repo stays live; --uninstall takes it back out (and refuses to remove a skill
// that no longer matches this checkout, in case someone made it their own).
// usage: node tools/install-kilo.mjs [--global] [--project [root]] [--target-dir <dir>] [--symlink] [--uninstall]
// Plain Node 18+; nothing to install. Kilo Code itself is the CLI on PATH or the VS Code extension.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const has = (name) => argv.includes('--' + name);
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(REPO, 'skills', 'floorplan');
const SKILL_MD = path.join(SKILL, 'SKILL.md');
if (!fs.existsSync(SKILL_MD)) { console.error(`✗ No skill at ${SKILL}. Run this from a checkout of the Floorplan repo.`); process.exit(1); }
const skillHash = crypto.createHash('sha256').update(fs.readFileSync(SKILL_MD)).digest('hex');

const home = process.env.HOME || process.env.USERPROFILE || '';
let target;
if (has('target-dir')) target = path.resolve(opt('target-dir') || '.');
else if (has('project')) target = path.join(path.resolve(opt('project') || '.'), '.kilo');
else target = path.join(home, '.config', 'kilo'); // --global, the default

const skillDir = path.join(target, 'skills', 'floorplan');
const commandDir = path.join(target, 'command');
const commandFile = path.join(commandDir, 'floorplan.md');
const COMMAND = `---
description: Draw or update an interactive floorplan map of this codebase
---
Use the floorplan skill to make or update a floorplan of this codebase. $ARGUMENTS
`;

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const installedByUs = () => {
  if (real(skillDir) && real(skillDir) === real(SKILL)) return true; // a symlink to this checkout
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(skillDir, 'SKILL.md'))).digest('hex') === skillHash; } catch { return false; }
};

if (has('uninstall')) {
  const gone = [];
  if (there(skillDir)) {
    if (!installedByUs()) { console.error(`✗ ${skillDir} exists but doesn't match this checkout; leaving it alone.`); process.exit(1); }
    fs.rmSync(skillDir, { recursive: true, force: true }); gone.push(skillDir);
  }
  if (there(commandFile)) { fs.rmSync(commandFile, { force: true }); gone.push(commandFile); }
  console.log(gone.length ? `✓ Removed ${gone.join(', ')}` : 'Nothing installed here.');
  process.exit(0);
}

fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
if (has('symlink')) {
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.symlinkSync(SKILL, skillDir, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`✓ Linked ${skillDir} → ${SKILL}`);
} else {
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.cpSync(SKILL, skillDir, { recursive: true });
  console.log(`✓ Copied the skill to ${skillDir}`);
}
fs.mkdirSync(commandDir, { recursive: true });
fs.writeFileSync(commandFile, COMMAND);
console.log(`✓ Added the /floorplan command (${commandFile})`);
console.log(`Start a new Kilo Code session in your project (the CLI, or the VS Code extension) and ask for a floorplan, or type /floorplan. To undo: node tools/install-kilo.mjs --uninstall${has('project') ? ' --project' : ''}${has('target-dir') ? ` --target-dir "${target}"` : ''}`);
