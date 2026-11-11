// SHA-256 fingerprints of every file the plugin runs from, so anyone can check that an installed copy is
// exactly a release. Each release commits CHECKSUMS.txt; --check compares a folder with it.
// usage: node tools/checksums.mjs                    write CHECKSUMS.txt for this checkout
//        node tools/checksums.mjs --check <folder>   compare an installed copy with CHECKSUMS.txt
// --list <file> reads or writes another list instead of CHECKSUMS.txt (the tests use it).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// what the plugin runs from: the skill, the native Hermes runtime, the plugin manifests and the marketplaces that point at them
const PARTS = ['plugin.yaml', '__init__.py', 'hermes', 'skills', '.claude-plugin', '.codex-plugin', '.agents', 'package.json'];
const li = process.argv.indexOf('--list');
const OUT = li > 0 ? path.resolve(process.argv[li + 1]) : path.join(REPO, 'CHECKSUMS.txt');

function list(root) {
  const out = [];
  for (const part of PARTS) {
    const p = path.join(root, part);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isFile()) { out.push(part); continue; }
    for (const e of fs.readdirSync(p, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const f = path.relative(root, path.join(e.parentPath ?? e.path, e.name)).replace(/\\/g, '/');
      // imported Python bytecode is a local artefact, never a release file
      if (/(^|\/)__pycache__(\/|$)/.test(f) || f.endsWith('.pyc')) continue;
      out.push(f);
    }
  }
  return out.sort();
}
const hash = (root, f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');

const at = process.argv.indexOf('--check');
if (at < 0) {
  const version = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const lines = list(REPO).map((f) => `${hash(REPO, f)}  ${f}`);
  fs.writeFileSync(OUT, [
    `# Floorplan ${version}: SHA-256 of every file the plugin runs from.`,
    `# Check an installed copy: clone this release, then run node tools/checksums.mjs --check <installed folder>.`,
    ...lines, '',
  ].join('\n'));
  console.log(`✓ wrote ${path.basename(OUT)} for Floorplan ${version} (${lines.length} files)`);
  process.exit(0);
}

const dir = process.argv[at + 1];
if (!dir || !fs.existsSync(dir)) { console.error('usage: node tools/checksums.mjs --check <installed plugin folder>'); process.exit(1); }
const text = fs.readFileSync(OUT, 'utf8');
const version = /^# Floorplan (\S+):/m.exec(text)?.[1] || '?';
const want = new Map(text.split('\n').filter((l) => /^[0-9a-f]{64}  /.test(l)).map((l) => [l.slice(66), l.slice(0, 64)]));
const have = list(dir);
const changed = have.filter((f) => want.has(f) && want.get(f) !== hash(dir, f));
const extra = have.filter((f) => !want.has(f));
const missing = [...want.keys()].filter((f) => !have.includes(f));
if (!changed.length && !extra.length && !missing.length) {
  console.log(`✓ ${dir} matches Floorplan ${version}: all ${want.size} files are identical.`);
  process.exit(0);
}
console.log(`✗ ${dir} doesn't match Floorplan ${version}.`);
for (const [label, files] of [['Changed', changed], ['Not in the release', extra], ['Missing', missing]]) {
  if (files.length) console.log(`${label}:\n${files.map((f) => `  ${f}`).join('\n')}`);
}
process.exit(1);
