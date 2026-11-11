// A skill installed read-only: some package managers, system-wide installs and locked-down machines install
// files nobody may write to. The build puts two of the skill's own files next to the map, and those have to stay
// replaceable, or the build after it fails. If this fails, anyone with a read-only install can build a map once
// and never again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILL, makeProject, cleanup } from './helpers.mjs';

// the skill's files the build puts in the map folder
const PLACED = ['serve.mjs', 'page-safety.mjs'];
const filesIn = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
const canWrite = (file) => { try { fs.closeSync(fs.openSync(file, 'r+')); return true; } catch { return false; } };
const readOnly = (file) => fs.chmodSync(file, 0o444);
const writable = (file) => fs.chmodSync(file, 0o644);

/** Whether marking a file read-only stops this user writing to it (it doesn't for root, or on some file systems). */
function readOnlyMeansSomething() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-readonly-'));
  const probe = path.join(dir, 'probe.txt');
  try {
    fs.writeFileSync(probe, 'x');
    readOnly(probe);
    return !canWrite(probe);
  } catch { return false; } finally {
    try { writable(probe); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a skill installed read-only builds again and again, and what it puts next to the map stays writable', (t) => {
  if (!readOnlyMeansSomething()) return t.skip('this user can write to read-only files here, so there is nothing to check');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-readonly-'));
  const skill = path.join(tmp, 'skill');
  const root = makeProject({ 'api/server.js': 'export const port = 3000;\n', 'web/app.js': `import { port } from '../api/server.js';\nexport default port;\n` }, {
    arch: { project: { name: 'Shop', summary: 'A sample shop.' }, nodes: [
      { id: 'api', label: 'Server', kind: 'service', summary: 'The shop server.', paths: ['api/**'] },
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The shop website.', paths: ['web/**'] },
    ] },
  });
  const placed = PLACED.map((name) => path.join(root, 'floorplan', name));
  const script = (name, ...args) => execFileSync(process.execPath, [path.join(skill, 'scripts', name), root, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const build = (when) => {
    let out;
    try { out = script('build.mjs', '--no-claude-md', '--json'); } catch (e) { assert.fail(`${when} failed (exit ${e.status}):\n${e.stdout}\n${e.stderr}`); }
    assert.equal(JSON.parse(out).ok, true, when);
    for (const file of placed) {
      const name = path.basename(file);
      assert.ok(fs.statSync(file).mode & 0o200, `${when}: floorplan/${name} is writable`);
      assert.ok(canWrite(file), `${when}: floorplan/${name} can be written to`);
      assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(skill, 'assets', name)), `${when}: floorplan/${name} is the skill's own file`);
    }
  };
  try {
    fs.cpSync(SKILL, skill, { recursive: true });
    filesIn(skill).forEach(readOnly);
    script('scan.mjs');
    build('the first build');
    build('the second build');
    // a map made by an earlier version has read-only copies in it: the next build replaces them
    placed.forEach(readOnly);
    build('a build over read-only copies');
  } finally {
    // give write permission back, so the temp folders can be removed everywhere
    for (const file of [...(fs.existsSync(skill) ? filesIn(skill) : []), ...placed]) { try { writable(file); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
    cleanup(root);
  }
});
