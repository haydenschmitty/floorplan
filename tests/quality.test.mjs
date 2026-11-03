// Code-quality scores: a tangled, oversized, unused file scores worse than a small tidy one,
// scores roll up into modules, and a blueprint (no code) gets none.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, scanAndBuild, readGraph, cleanup, lib } from './helpers.mjs';

// one huge, deeply nested function with many decision points and no comments
const tangled = `export function route(a, b) {\n${Array.from({ length: 120 }, (_, i) => `  if (a === ${i} && b > ${i} || a < ${i}) {\n    for (const x of b) {\n      if (x) { while (x.y) { if (x.z) { a += ${i}; } } }\n    }\n  }`).join('\n')}\n  return a;\n}\n`;
const tidy = `// Adds two numbers.\nexport const add = (a, b) => a + b;\n`;

let root, graph;
before(() => {
  root = makeProject({
    'app/main.js': `import { add } from './tidy.js';\nimport { route } from './tangled.js';\nconsole.log(add(1, 2), route(1, []));\n`,
    'app/tidy.js': tidy,
    'app/tangled.js': tangled,
    'app/leftover.js': `export const old = () => 1;\n`,
    'tests/tangled.test.js': tangled,
  }, { arch: { project: { name: 'Sample', summary: 'A sample.' }, nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'The app.', paths: ['app/**'] }] } });
  scanAndBuild(root);
  graph = readGraph(root);
});
after(() => cleanup(root));

test('a tangled file scores worse than a tidy one', () => {
  const q = graph.quality.files;
  assert.ok(q['app/tangled.js'].s > 66, `tangled scored ${q['app/tangled.js'].s}`);
  assert.ok(q['app/tidy.js'].s < 33, `tidy scored ${q['app/tidy.js'].s}`);
  assert.ok(q['app/tangled.js'].why.some((w) => /functions? (is|are) over 80 lines/.test(w)));
});

test('a file nothing uses is marked as a dead end', () => {
  assert.equal(graph.quality.files['app/leftover.js'].m.deadEnd, 100);
  assert.equal(graph.quality.files['app/tidy.js'].m.deadEnd, 0);
});

test('tests are not scored', () => {
  assert.equal(graph.quality.files['tests/tangled.test.js'], undefined);
});

test('a module takes its worst file into account and names it', () => {
  const n = graph.quality.nodes.app;
  assert.equal(n.worst, 'app/tangled.js');
  assert.ok(n.s > graph.quality.files['app/tidy.js'].s);
});

test('files that cannot be measured are left out, not scored zero', async () => {
  const { fileMetrics } = await lib('quality.mjs');
  assert.equal(fileMetrics('x', { path: 'a/notes.md', lang: 'markdown' }), null);
});

// ---------- copied code and careless code ----------
const copied = Array.from({ length: 14 }, (_, i) => `  const total${i} = items.filter((x) => x.price > ${i}).map((x) => x.price * x.quantity).reduce((a, b) => a + b, 0);`).join('\n');
const twin = (name) => `export function ${name}(items) {\n${copied}\n  return total0;\n}\n`;
const careless = `// get the data\nconst data = getData();\n// TODO implement\n// const old = compute(x);\n// old.run();\n// old.stop();\nexport function handleData(x) { try { x.go(); } catch (e) {} try { x.stop(); } catch (e) {} throw new Error('not implemented'); }\n`;

test('copy-pasted code is flagged on both copies and names the other file', async () => {
  const r2 = makeProject({
    'app/a.js': twin('totalsA'), 'app/b.js': twin('totalsB'), 'app/c.js': `export const c = (n) => n * 2;\n`,
    'app/main.js': `import './a.js';\nimport './b.js';\nimport './c.js';\n`,
  }, { arch: { project: { name: 'S', summary: 's' }, nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'x', paths: ['app/**'] }] } });
  try {
    scanAndBuild(r2);
    const q = readGraph(r2).quality.files;
    assert.ok(q['app/a.js'].m.duplication > 60, `a: ${q['app/a.js'].m.duplication}`);
    assert.match(q['app/a.js'].why.join(' '), /copied in app\/b\.js/);
    assert.match(q['app/b.js'].why.join(' '), /copied in app\/a\.js/);
    assert.equal(q['app/c.js'].m.duplication, 0);
  } finally { cleanup(r2); }
});

test('careless code is flagged with plain reasons; tidy code is not', async () => {
  const { fileMetrics } = await lib('quality.mjs');
  const bad = fileMetrics(careless, { path: 'app/x.js', lang: 'javascript', loc: 8 });
  assert.ok(bad.sl > 60, `slop ${bad.sl}`);
  const text = bad.why.join(' | ');
  assert.match(text, /silently ignored/);
  assert.match(text, /left commented out/);
  assert.match(text, /unfinished/);
  assert.equal(fileMetrics(tidy, { path: 'app/t.js', lang: 'javascript', loc: 2 }).sl, 0);
});
