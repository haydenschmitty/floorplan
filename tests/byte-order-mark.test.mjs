// JSON files written on Windows: PowerShell's Set-Content and Out-File (5.1), and some editors, start a UTF-8 file
// with a byte order mark, which JSON.parse rejects. Every file a person or an agent writes for Floorplan
// (architecture.json, descriptions, recent-work.json, plan.json, flows and Health dismissals) reads the same with one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, shopApp, makeProject, run, readGraph, readJson, cleanup } from './helpers.mjs';

// built at runtime, so no editor or tool along the way can drop or add it
const BOM = String.fromCharCode(0xfeff);
const withBom = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, BOM + JSON.stringify(data, null, 2)); };
const addBom = (file) => fs.writeFileSync(file, BOM + fs.readFileSync(file, 'utf8'));
const fails = (fn) => { try { fn(); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } assert.fail('expected the script to fail'); };

test('a map builds and updates from files that start with a byte order mark', () => {
  const root = shopApp();
  const map = (f) => path.join(root, 'floorplan', f);
  try {
    addBom(map('architecture.json'));
    run('scan.mjs', root);
    withBom(map('descriptions/api.json'), { files: { 'shop-api/server.js': { name: 'Shop server', description: 'Starts the shop server.' } } });
    withBom(map('recent-work.json'), { tasks: [{ title: 'Refunds', items: [{ ref: 'shop-api/routes/orders.js', change: 'changed', note: 'Added refunds.' }] }] });
    withBom(map('custom-flows.json'), { flows: [{ id: 'refund', title: 'A refund', steps: [{ ref: 'f:shop-web/src/api.js', note: 'asks' }, { ref: 'f:shop-api/routes/orders.js', note: 'refunds' }] }] });
    const out = run('build.mjs', root, '--no-claude-md');
    assert.doesNotMatch(out, /not valid JSON/);
    const g = readGraph(root);
    assert.equal(g.files.find((f) => f.p === 'shop-api/server.js').name, 'Shop server');
    assert.equal(g.recent.items.length, 1);
    assert.ok(g.flows.some((f) => f.id === 'refund'), 'the flow saved from the map');

    const issue = g.health.issues[0];
    withBom(map('health-dismissed.json'), { dismissed: [{ id: issue.id, locations: issue.locations || [], reason: 'fine' }] });
    run('build.mjs', root, '--no-claude-md');
    assert.equal(readGraph(root).health.dismissed.length, 1, 'the dismissal is read');

    // the other scripts read the same files
    assert.match(run('recent.mjs', root), /Current recent-work.json: 1 task/);
    assert.match(run('status.mjs', root), /\S/);
    run('describe.mjs', root);
    fs.appendFileSync(path.join(root, 'shop-api', 'auth.js'), '\nexport const later = 1;\n');
    assert.doesNotMatch(run('refresh.mjs', root), /not valid JSON|SyntaxError/);
    assert.equal(readGraph(root).files.find((f) => f.p === 'shop-api/server.js').name, 'Shop server');

    // the map's own server, as an export reads them: flows and dismissals
    const exported = map('copy.html');
    execFileSync(process.execPath, [map('serve.mjs'), '--export', exported, '--include', 'flows,health'], { encoding: 'utf8' });
    const page = fs.readFileSync(exported, 'utf8');
    assert.match(page, /"id":"refund"/);
    assert.match(page, /"dismissed":\[\{/);
  } finally { cleanup(root); }
});

test('a blueprint\'s plan.json with a byte order mark is planned and drawn', () => {
  const root = makeProject({});
  try {
    fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'blueprint'), root, { recursive: true });
    addBom(path.join(root, 'floorplan', 'plan.json'));
    addBom(path.join(root, 'floorplan', 'architecture.json'));
    assert.match(run('plan.mjs', root), /BLUEPRINT/);
    run('build.mjs', root, '--no-claude-md');
    assert.equal(readGraph(root).files.length, 21);
  } finally { cleanup(root); }
});

test('near miss: a file that isn\'t JSON after the mark is still an error naming it, and a mark inside text is kept', () => {
  const root = shopApp();
  const archFile = path.join(root, 'floorplan', 'architecture.json');
  try {
    run('scan.mjs', root);
    const arch = readJson(archFile);
    fs.writeFileSync(archFile, BOM + '{ "project": ');
    assert.match(fails(() => run('build.mjs', root, '--no-claude-md')), /architecture\.json is not valid JSON/);
    // only one mark, at the very start, is skipped: a second one is not JSON either
    fs.writeFileSync(archFile, BOM + BOM + JSON.stringify(arch));
    assert.match(fails(() => run('build.mjs', root, '--no-claude-md')), /architecture\.json is not valid JSON/);
    // text that holds the character keeps it (the map shows it as a marker, see hostile-content.test.mjs)
    withBom(archFile, { ...arch, project: { ...arch.project, summary: `A sample${BOM} shop.` } });
    run('build.mjs', root, '--no-claude-md');
    assert.equal(readGraph(root).project.summary, `A sample${BOM} shop.`);
  } finally { cleanup(root); }
});
