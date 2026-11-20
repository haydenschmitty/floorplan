// Linked repositories stay out of a Floorplan map, but the scan must tell the agent why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanup, makeProject, readJson, run, writeJson } from './helpers.mjs';

function linkedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-linked-repo-'));
  fs.writeFileSync(path.join(dir, 'server.js'), 'export const answer = 42;\n');
  runGit(dir, ['init', '-q']);
  return dir;
}

function runGit(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('scan warns about linked Git repositories but ignores irrelevant symlinks', async () => {
  const root = makeProject({ 'app.js': 'export const app = true;\n', 'plain.txt': 'plain\n' });
  const target = linkedRepo();
  try {
    fs.symlinkSync(target, path.join(root, 'linked-api'));
    fs.symlinkSync(path.join(root, 'plain.txt'), path.join(root, 'linked-file'));

    const result = JSON.parse(run('scan.mjs', root, '--json'));
    assert.deepEqual(result.skipped.filter((item) => item.reason.includes('symlinked git repository')).map((item) => item.path), ['linked-api']);
    assert.match(result.summary, /LINKED REPOSITORIES \(1\) were not scanned: linked-api/);
    assert.match(result.summary, /does not follow symlinks/);
    assert.match(result.warnings.join('\n'), /linked-api: symlinked git repository/);

    const scan = readJson(path.join(root, 'floorplan/.cache/scan.json'));
    assert.ok(!scan.files.some((file) => file.path.startsWith('linked-api/')));
  } finally {
    cleanup(root);
    cleanup(target);
  }
});

test('refresh repeats the linked-repository warning for the agent', async () => {
  const root = makeProject({ 'app.js': 'export const app = true;\n' }, {
    arch: {
      project: { name: 'Test app', summary: 'A small test app.' },
      nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'The test app.', paths: ['app.js'] }],
    },
  });
  const target = linkedRepo();
  try {
    run('scan.mjs', root);
    // The first build writes graph.json but reports missing descriptions; describe.mjs needs that graph.
    try { run('build.mjs', root); } catch {}
    run('describe.mjs', root);
    const descriptions = path.join(root, 'floorplan/descriptions');
    for (const name of fs.readdirSync(descriptions).filter((entry) => entry.endsWith('.json'))) {
      const description = readJson(path.join(descriptions, name));
      for (const entries of [description.files, description.routes]) {
        for (const entry of Object.values(entries || {})) Object.assign(entry, { name: 'Test item', description: 'A test item.' });
      }
      writeJson(path.join(descriptions, name), description);
    }
    run('build.mjs', root);

    fs.symlinkSync(target, path.join(root, 'linked-api'));
    const refreshed = run('refresh.mjs', root);
    assert.match(refreshed, /linked-api: symlinked git repository \(not scanned\)/);
    assert.match(refreshed, /common folder with real repository directories/);
  } finally {
    cleanup(root);
    cleanup(target);
  }
});
