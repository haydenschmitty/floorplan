// The map shows only the kinds of file architecture.json's "include" names (code alone by default). On a big
// project the rest (docs, config, images) can be most of the folder, and a board that looks too small reads as a
// scan that failed. The scan and the build say what was left out, by kind, and how to add it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, run, readJson, writeJson, cleanup } from './helpers.mjs';

const arch = (extra = {}) => ({
  project: { name: 'Notes app' },
  nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'Keeps notes.', paths: ['**'] }],
  ...extra,
});
const files = {
  'src/server.js': 'export function start() {}\n',
  'src/notes.js': 'export const list = () => [];\n',
  'src/legacy/old.js': 'export const old = 1;\n',
  'README.md': '# Notes\n',
  'docs/guide.md': 'How to use it.\n',
  'docs/setup.md': 'How to set it up.\n',
  'package.json': '{ "name": "notes" }\n',
  'public/logo.png': 'not really a picture\n',
  'public/icon.png': 'not really a picture\n',
};
const line = (out) => out.split('\n').find((l) => l.startsWith('NOT MAPPED'));

test('by default the build and the scan say which kinds of file aren\'t on the map, and how to add them', () => {
  const root = makeProject(files, { arch: arch() });
  try {
    const scanOut = run('scan.mjs', root);
    assert.equal(line(scanOut), 'NOT MAPPED  3 docs · 2 asset · 1 config (the map shows code files; to add a kind, list it in "include" in architecture.json, e.g. "include": ["code", "docs"])');
    const scanJson = JSON.parse(run('scan.mjs', root, '--json'));
    assert.deepEqual(scanJson.counts.notMapped, { docs: 3, asset: 2, config: 1 });
    assert.match(scanJson.summary, /^NOT MAPPED {2}3 docs/m);

    const out = run('build.mjs', root, '--no-claude-md');
    assert.equal(line(out), line(scanOut));
    const json = JSON.parse(run('build.mjs', root, '--no-claude-md', '--json'));
    assert.deepEqual(json.notMapped, { byCategory: { docs: 3, asset: 2, config: 1 }, ignored: 0 });
    assert.match(json.report, /^NOT MAPPED/m);
  } finally { cleanup(root); }
});

test('an "include" and an "ignore" change what is said: included kinds drop out, ignored files are counted', () => {
  const root = makeProject(files, { arch: arch({ include: ['code', 'docs'], ignore: ['src/legacy/**', 'docs/setup.md'] }) });
  try {
    // the scan follows the include once architecture.json is written
    assert.equal(line(run('scan.mjs', root)), 'NOT MAPPED  2 asset · 1 config (the map shows code + docs files; to add a kind, list it in "include" in architecture.json, e.g. "include": ["code", "docs", "config"])');
    const json = JSON.parse(run('build.mjs', root, '--no-claude-md', '--json'));
    assert.deepEqual(json.notMapped, { byCategory: { asset: 2, config: 1 }, ignored: 2 });
    assert.match(json.report, /^NOT MAPPED {2}2 asset · 1 config · 2 left out by "ignore" \(/m);
    assert.equal(json.files.total, 4, 'two code files and two docs are mapped');
  } finally { cleanup(root); }
});

test('near miss: when every file is on the map, nothing is said', () => {
  const root = makeProject({ 'src/server.js': 'export function start() {}\n', 'src/notes.js': 'export const list = () => [];\n' }, { arch: arch() });
  try {
    assert.equal(line(run('scan.mjs', root)), undefined);
    const json = JSON.parse(run('build.mjs', root, '--no-claude-md', '--json'));
    assert.deepEqual(json.notMapped, { byCategory: {}, ignored: 0 });
    assert.doesNotMatch(json.report, /NOT MAPPED/);
    // and an architecture.json the scan can't read yet (it's being written) falls back to code only
    fs.writeFileSync(path.join(root, 'floorplan', 'architecture.json'), '{ "include": ');
    fs.writeFileSync(path.join(root, 'README.md'), '# Notes\n');
    assert.match(line(run('scan.mjs', root)), /^NOT MAPPED {2}1 docs \(the map shows code files;/);
    writeJson(path.join(root, 'floorplan', 'architecture.json'), arch({ include: ['code', 'docs'] }));
    assert.equal(line(run('scan.mjs', root)), undefined);
    assert.equal(readJson(path.join(root, 'floorplan', '.cache', 'scan.json')).files.length, 3);
  } finally { cleanup(root); }
});
