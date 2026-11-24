// A team that wants to share its map commits what people and agents write in floorplan/ (architecture.json,
// descriptions, recent work, requested flows) and rebuilds the rest. "git": "inputs" in architecture.json makes the
// folder's .gitignore leave those inputs to git and ignore only the files every build writes again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeProject, run, scanAndBuild, writeJson, cleanup } from './helpers.mjs';

const arch = (extra = {}) => ({
  project: { name: 'Notes app' },
  nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'Keeps notes.', paths: ['src/**'] }],
  ...extra,
});
const files = { 'src/server.js': 'export function start() {}\n' };
const git = (root, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, encoding: 'utf8' });
const untracked = (root) => git(root, 'status', '--porcelain', '--untracked-files=all', '--', 'floorplan').split('\n').filter(Boolean).map((l) => l.slice(3)).sort();
const gitignore = (root) => fs.readFileSync(path.join(root, 'floorplan', '.gitignore'), 'utf8');

test('by default the map folder ignores itself, and a committed map gets the advice to untrack it', () => {
  const root = makeProject(files, { repos: ['.'], arch: arch() });
  try {
    scanAndBuild(root);
    assert.match(gitignore(root), /^\*$/m);
    assert.deepEqual(untracked(root), []);
    git(root, 'add', '--force', 'floorplan/architecture.json');
    const json = JSON.parse(run('build.mjs', root, '--no-claude-md', '--json'));
    assert.match(json.notes.git, /git rm -r --cached floorplan/);
  } finally { cleanup(root); }
});

test('"git": "inputs" leaves the inputs to git and ignores only what every build writes again', () => {
  const root = makeProject(files, { repos: ['.'], arch: arch({ git: 'inputs' }) });
  try {
    writeJson(path.join(root, 'floorplan', 'recent-work.json'), { tasks: [] });
    writeJson(path.join(root, 'floorplan', 'custom-flows.json'), { flows: [] });
    const out = scanAndBuild(root);
    assert.doesNotMatch(gitignore(root), /^\*$/m);
    assert.deepEqual(untracked(root), [
      'floorplan/.gitignore',
      'floorplan/architecture.json',
      'floorplan/custom-flows.json',
      'floorplan/recent-work.json',
    ]);
    assert.ok(fs.existsSync(path.join(root, 'floorplan', 'graph.json')) && fs.existsSync(path.join(root, 'floorplan', 'index.html')));
    assert.match(out, /^GIT {2}floorplan\/ commits its inputs/m);

    // once committed, a build neither advises untracking the inputs nor changes them
    git(root, 'add', '--', 'floorplan');
    git(root, 'commit', '-q', '-m', 'map');
    const json = JSON.parse(run('build.mjs', root, '--no-claude-md', '--json'));
    assert.equal(json.notes.git, null);
    assert.deepEqual(untracked(root), []);
  } finally { cleanup(root); }
});

test('the scan keeps a map that commits its inputs that way, and an unknown "git" value is a named error', () => {
  const root = makeProject(files, { repos: ['.'], arch: arch({ git: 'inputs' }) });
  try {
    run('scan.mjs', root);
    assert.match(gitignore(root), /^\/graph\.json$/m);

    writeJson(path.join(root, 'floorplan', 'architecture.json'), arch({ git: 'yes' }));
    assert.throws(() => run('build.mjs', root, '--no-claude-md'), (e) => /git "yes" must be one of none, inputs/.test(String(e.stdout) + String(e.stderr)));
  } finally { cleanup(root); }
});
