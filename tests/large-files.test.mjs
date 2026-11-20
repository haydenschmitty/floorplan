// Files over the scan's size limit aren't read, but they stay on the map with their line count, and the
// scan, Health and the map say they weren't checked (#16). The limit is lowered here to keep the sample small.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, run, readGraph, readJson, cleanup } from './helpers.mjs';

const BIG_LINES = 1500;
let root, scanOut, graph;
before(() => {
  const big = Array.from({ length: BIG_LINES }, (_, i) => `def step_${i}(x):\n    return x + ${i}\n`).join('').split('\n').slice(0, BIG_LINES).join('\n') + '\n';
  root = makeProject({
    'app/main.py': 'from app import rules\n\nprint(rules.step_1(1))\n',
    'app/rules.py': big,
  }, { arch: { project: { name: 'Sample', summary: 'A small sample.' }, nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'The app.', paths: ['app/**'] }] } });
  scanOut = run('scan.mjs', root, '--max-file-kb', '8');
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('a file over the limit stays on the map with its line count', () => {
  const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  const f = scan.files.find((x) => x.path === 'app/rules.py');
  assert.equal(f.tooLarge, true);
  assert.equal(f.loc, BIG_LINES);
  const g = graph.files.find((x) => x.p === 'app/rules.py');
  assert.equal(g.tooLarge, true);
  assert.equal(g.loc, BIG_LINES);
  assert.equal(graph.files.find((x) => x.p === 'app/main.py').tooLarge, undefined);
});

test('the scan says which files it did not read and how to include them', () => {
  assert.match(scanOut, /NOT READ {2}1 file\(s\) over 8 KB/);
  assert.match(scanOut, /--max-file-kb/);
  assert.match(scanOut, /KB {2}app\/rules\.py/);
});

test('Health lists it as a large file and says it was not checked', () => {
  const big = graph.health.issues.find((i) => i.id === 'large-files');
  assert.ok(big, 'expected a large-files item');
  assert.match(big.notes['f:app/rules.py'], /^1,500 lines: too big for Floorplan to read/);
});

test('a refresh scans with the limit it is given, not the default', () => {
  // A refresh that dropped --max-file-kb scanned at the 2 MB default, so a file a map was built to read with a
  // bigger limit lost its imports and endpoints again. Here the limit is smaller, so the default would read it.
  run('refresh.mjs', root, '--max-file-kb', '8');
  assert.equal(readJson(path.join(root, 'floorplan', '.cache', 'scan.json')).files.find((x) => x.path === 'app/rules.py').tooLarge, true);
  assert.equal(readGraph(root).files.find((x) => x.p === 'app/rules.py').tooLarge, true);
});

test('the default limit reads a file over the old 512 KB limit', () => {
  const r = makeProject({ 'app/main.py': 'x = 1\n'.repeat(110000) });
  try {
    assert.ok(fs.statSync(path.join(r, 'app', 'main.py')).size > 512 * 1024);
    run('scan.mjs', r);
    const f = readJson(path.join(r, 'floorplan', '.cache', 'scan.json')).files.find((x) => x.path === 'app/main.py');
    assert.equal(f.tooLarge, undefined);
    assert.equal(f.loc, 110000);
  } finally { cleanup(r); }
});
