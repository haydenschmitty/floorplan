import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeProject, run, readGraph, writeJson, cleanup } from './helpers.mjs';

const arch = { project: { name: 'Example' }, nodes: [{ id: 'core', kind: 'service', label: 'Core', summary: 'Does the work.', paths: ['src/**'] }] };
test('Windows BOM works in architecture, descriptions, recent work and refresh', () => {
  const root = makeProject({ 'src/server.js': "export function handle() {}\n", 'README.md': 'guide\n' }, { arch });
  const dir = path.join(root, 'floorplan');
  try {
    const ap = path.join(dir, 'architecture.json');
    fs.writeFileSync(ap, '\uFEFF' + fs.readFileSync(ap, 'utf8'));
    run('scan.mjs', root);
    const first = run('build.mjs', root, '--no-claude-md');
    assert.match(first, /EXCLUDED/);
    writeJson(path.join(dir, 'descriptions', 'core.json'), { files: { 'src/server.js': { name: 'Server', description: 'Serves users.' } } });
    const dp = path.join(dir, 'descriptions', 'core.json');
    fs.writeFileSync(dp, '\uFEFF' + fs.readFileSync(dp, 'utf8'));
    fs.writeFileSync(path.join(dir, 'recent-work.json'), '\uFEFF' + JSON.stringify({ tasks: [{ title: 'Fix', items: [{ ref: 'src/server.js', change: 'changed', note: 'Done.' }] }] }));
    run('build.mjs', root, '--no-claude-md');
    assert.equal(readGraph(root).files.find((f) => f.p === 'src/server.js').d, 'Serves users.');
    assert.match(run('recent.mjs', root), /Current recent-work.json: 1 task/);
    fs.appendFileSync(path.join(root, 'src', 'server.js'), 'export const updated = true;\n');
    assert.match(run('refresh.mjs', root), /edited|modified|change/i);
  } finally { cleanup(root); }
});

test('lite produces labeled placeholders without replacing human descriptions', () => {
  const root = makeProject({ 'src/main.js': "export function createWidget() {}\n", 'src/routes.js': "import express from 'express';\nconst app = express();\napp.get('/widgets', () => {});\n" }, { arch });
  try {
    run('scan.mjs', root);
    const log = run('build.mjs', root, '--lite', '--no-claude-md');
    assert.match(log, /Lite mode/);
    const g = readGraph(root);
    assert.equal(g.meta.lite, true);
    assert.equal(g.files.find((f) => f.p === 'src/main.js').name, 'main.js');
    assert.match(g.files.find((f) => f.p === 'src/main.js').d, /createWidget/);
    assert.equal(g.files.find((f) => f.p === 'src/main.js').auto, true);
    assert.ok(g.routes.some((r) => r.auto && /Handles GET/.test(r.d)));
    writeJson(path.join(root, 'floorplan', 'descriptions', 'core.json'), { files: { 'src/main.js': { name: 'Widgets', description: 'Creates widgets.' } } });
    run('build.mjs', root, '--lite', '--no-claude-md');
    const f = readGraph(root).files.find((x) => x.p === 'src/main.js');
    assert.equal(f.d, 'Creates widgets.');
    assert.equal(f.auto, undefined);
  } finally { cleanup(root); }
});

test('ignored generated directories are excluded even if git tracks them', () => {
  const root = makeProject({ 'src/main.js': 'export const live = 1;', 'dist/bundle.js': 'export const dist = 1;', 'build/app.js': 'export const build = 1;', 'prisma/generated/client.js': 'export const client = 1;', 'src/generated/helper.js': 'export const helper = 1;' }, { repos: ['.'], arch });
  try {
    execFileSync('git', ['-C', root, 'add', '-f', '--', 'src/main.js', 'src/generated/helper.js', 'dist/bundle.js', 'build/app.js', 'prisma/generated/client.js']);
    const staged = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' });
    for (const name of ['dist/bundle.js', 'build/app.js', 'prisma/generated/client.js']) assert.ok(staged.split('\n').includes(name), name + ' is tracked');
    run('scan.mjs', root);
    const files = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8')).files.map((f) => f.path);
    assert.ok(files.includes('src/main.js'));
    assert.ok(files.includes('src/generated/helper.js'), 'hand-written generated-named folder is not automatically excluded');
    for (const p of ['dist/bundle.js', 'build/app.js', 'prisma/generated/client.js']) assert.ok(!files.includes(p), p);
  } finally { cleanup(root); }
});

test('build reports exclusions and unlinked files, with conservative runtime-call hints', () => {
  const root = makeProject({ 'src/main.js': "export const load = (url) => fetch(url);\n", 'guide.md': 'Hello\n', 'logo.png': 'fake png\n', 'package.json': '{}' }, { arch });
  try {
    run('scan.mjs', root);
    const log = run('build.mjs', root, '--no-claude-md');
    assert.match(log, /EXCLUDED.*docs/);
    assert.match(log, /EXCLUDED.*asset/);
    assert.match(log, /UNLINKED.*without detected static connections/);
    assert.match(log, /DYNAMIC URL HINTS/);
    assert.equal(readGraph(root).files.find((f) => f.p === 'src/main.js').possibleDynamicCalls, 1);
    assert.doesNotMatch(JSON.stringify(readGraph(root)), /\bfetch\(url\)/);
  } finally { cleanup(root); }
});

test('non-git recent work is labeled as mtime hints rather than invented commits', () => {
  const root = makeProject({ 'src/main.js': 'export const ready = true;' }, { arch });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md');
    const out = run('recent.mjs', root);
    assert.match(out, /NO GIT REPOSITORIES/);
    assert.match(out, /mtime hints, not a diff/);
    assert.doesNotMatch(out, /commits since/);
  } finally { cleanup(root); }
});

test('lite mode survives a refresh and original-name skeletons are optional', () => {
  const root = makeProject({ 'src/paramètres.js': 'export const state = 1;\n' }, { arch });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--lite', '--no-claude-md');
    run('describe.mjs', root, '--keep-names');
    const skeleton = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', 'descriptions', 'core.json'), 'utf8'));
    assert.equal(skeleton.files['src/paramètres.js'].name, 'paramètres.js');
    fs.appendFileSync(path.join(root, 'src', 'paramètres.js'), 'export const count = 2;\n');
    run('refresh.mjs', root);
    assert.equal(readGraph(root).meta.lite, true);
    assert.ok(readGraph(root).files.find((f) => f.p === 'src/paramètres.js').d);
  } finally { cleanup(root); }
});
