// Hermes building and refreshing the map: the identity survives a code refresh and a blueprint redraw, the
// end-to-end generation fixture (a rename, a deleted route, a changed export, a body-only edit) reconciles
// descriptions the way upstream does, and an export still carries nothing about this computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { REPO, SKILL, shopApp, makeProject, run, readGraph, readJson, writeJson, cleanup } from './helpers.mjs';

const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'blueprint');

test('the shared skill tells Hermes where its folder is, and how to run it', () => {
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(skill, /\*\*In Hermes\*\*/, 'a paragraph for Hermes');
  assert.match(skill, /\/floorplan:floorplan/, 'the slash command Hermes can type');
  assert.match(skill, /--agent hermes/, 'so the map says Hermes, not the detector default');
  assert.match(skill, /node <that folder>\/scripts\//, 'scripts run from the registered skill folder');
  assert.match(skill, /\*\*In Codex\*\*/, 'the Codex paragraph is still there');
});

test('a code refresh keeps the Hermes identity', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    const built = run('build.mjs', root, '--agent', 'hermes');
    assert.match(built, /AGENT {2}Hermes: questions on the map run through Hermes/,
      'the report says where questions actually go: the map server runs Hermes itself');
    assert.equal(readGraph(root).meta.agent, 'hermes');
    fs.appendFileSync(path.join(root, 'shop-api', 'routes', 'notes.js'), '\n// touched\n');
    const out = run('refresh.mjs', root, '--agent', 'hermes');
    assert.equal(readGraph(root).meta.agent, 'hermes', 'the rebuilt map still says Hermes');
    assert.match(out, /AGENT {2}Hermes/);
  } finally { cleanup(root); }
});

test('a blueprint refresh redraws it as Hermes too', () => {
  const root = makeProject({});
  try {
    fs.cpSync(FIXTURE, root, { recursive: true });
    run('plan.mjs', root, '--agent', 'hermes');
    run('build.mjs', root, '--agent', 'hermes');
    assert.equal(readGraph(root).meta.agent, 'hermes');
    const out = run('refresh.mjs', root, '--agent', 'hermes');
    assert.equal(readGraph(root).meta.agent, 'hermes', 'the redrawn blueprint still says Hermes');
    assert.match(out, /AGENT {2}Hermes/);
  } finally { cleanup(root); }
});

test('a Hermes refresh carries, prunes and flags descriptions, and calls body-only edits stale prose', () => {
  const root = shopApp();
  const map = path.join(root, 'floorplan');
  try {
    const arch = readJson(path.join(map, 'architecture.json'));
    writeJson(path.join(map, 'architecture.json'), {
      ...arch,
      annotations: [{ path: 'shop-api/auth.js', note: 'The two sign-in checks live here.' }],
    });
    run('scan.mjs', root);
    run('build.mjs', root, '--agent', 'hermes');
    const built = readGraph(root);
    assert.ok(built.links.some((l) => l.k === 'http' && l.a.startsWith('f:shop-web/') && l.b.startsWith('f:shop-api/')),
      'the website reaches the server across repos');

    // a map whose every file and route is described, like a finished one
    writeJson(path.join(map, 'descriptions', 'shop.json'), {
      files: Object.fromEntries(built.files.map((f) => [f.p, { name: f.name, description: `What ${f.p} is for.` }])),
      routes: Object.fromEntries(built.routes.map((r) => [`${r.m} ${r.p}`, { name: r.name, description: `What ${r.m} ${r.p} does.` }])),
    });
    writeJson(path.join(map, 'custom-flows.json'), {
      flows: [{ id: 'refund', title: 'A refund', description: '', steps: [{ ref: 'n:web', note: 'The website asks.' }, { ref: 'n:api', note: 'The server refunds.' }] }],
    });
    const described = run('build.mjs', root, '--agent', 'hermes');
    assert.match(described, /DESCRIPTIONS {2}files (\d+)\/\1 · routes (\d+)\/\2/);
    assert.match(described, /RECENT WORK/);

    // a health issue the person marked "not a problem"
    const secret = built.health.issues.find((i) => i.kind === 'secret');
    assert.ok(secret, 'the hard-coded password is on the map');
    writeJson(path.join(map, 'health-dismissed.json'), {
      dismissed: [{ id: secret.id, locations: secret.locations.map((l) => `${l.file}:${l.line}`), reason: 'A sample project.' }],
    });
    run('build.mjs', root, '--agent', 'hermes');
    assert.equal(readGraph(root).health.dismissed.length, 1);
    const sentinel = (name) => fs.readFileSync(path.join(map, name), 'utf8');
    const flowsBefore = sentinel('custom-flows.json');
    const dismissedBefore = sentinel('health-dismissed.json');

    // the round of work: a rename with its import, a deleted route, a changed export, a body-only edit
    const api = (...p) => path.join(root, 'shop-api', ...p);
    fs.renameSync(api('routes', 'notes.js'), api('routes', 'memos.js'));
    fs.writeFileSync(api('server.js'), fs.readFileSync(api('server.js'), 'utf8').replace("'./routes/notes.js'", "'./routes/memos.js'"));
    fs.writeFileSync(api('routes', 'admin.js'), fs.readFileSync(api('routes', 'admin.js'), 'utf8')
      .replace("router.delete('/users/:id', async (req, res) => { res.status(204).end(); });\n", ''));
    fs.writeFileSync(api('routes', 'orders.js'), fs.readFileSync(api('routes', 'orders.js'), 'utf8')
      .replace('export default router;', 'export const REFUND_LIMIT = 100;\nexport default router;'));
    fs.writeFileSync(api('auth.js'), fs.readFileSync(api('auth.js'), 'utf8').replace('next(); }', 'next(); }  // called once per request\n'));

    const out = run('refresh.mjs', root, '--agent', 'hermes');
    const after = readGraph(root);
    assert.equal(after.meta.agent, 'hermes');

    const desc = readJson(path.join(map, 'descriptions', 'shop.json'));
    assert.ok(desc.files['shop-api/routes/memos.js'], 'the description moved with the renamed file');
    assert.equal(desc.files['shop-api/routes/notes.js'], undefined, 'the old path is gone');
    assert.equal(desc.files['shop-api/routes/memos.js'].review, undefined, 'an unchanged file is carried without a flag');
    assert.match(desc.files['shop-api/routes/orders.js'].review, /new exports: REFUND_LIMIT/);
    assert.ok(desc.files['shop-api/routes/admin.js'].review, 'a removed route flags its file for review');
    assert.equal(desc.files['shop-api/auth.js'].review, undefined, 'a body-only edit is not flagged');
    assert.equal(desc.routes['DELETE /admin/users/:id'], undefined, 'the deleted route is pruned');
    assert.ok(desc.routes['POST /api/notes'], 'the route that only changed file keeps its description');

    assert.match(out, /descriptions: \d+ carried over, \d+ removed, \d+ flagged for review/);
    assert.match(out, /may now be stale prose/, 'the report says what a body-only edit leaves behind');

    assert.equal(sentinel('custom-flows.json'), flowsBefore, 'custom flows are user content: untouched');
    assert.equal(sentinel('health-dismissed.json'), dismissedBefore, 'dismissals are user content: untouched');
    assert.ok(after.flows.some((f) => f.id === 'refund' && f.custom), 'the custom flow is still on the map');
    assert.ok(after.files.find((f) => f.p === 'shop-api/auth.js').note, 'the note is still pinned to its file');
    assert.equal(after.health.dismissed.length, 1, 'the dismissal survived the refresh');
  } finally { cleanup(root); }
});

test('the served map names the engine that answers, and an exported map names its builder', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--agent', 'hermes');
    const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
    const at = html.indexOf('const G = window.FLOORPLAN;');
    const end = html.indexOf('\n', html.indexOf('const AGENT = ', at));
    assert.ok(at > 0 && end > at, 'the viewer picks the agent that answers');
    const source = html.slice(at, end) + '\nglobalThis.picked = AGENT;';
    const picked = (graph, server) => {
      const win = { FLOORPLAN: graph, FLOORPLAN_SERVER: server };
      win.window = win;
      vm.runInNewContext(source, win);
      return win.picked;
    };
    assert.equal(picked({ meta: { agent: 'hermes' } }, { engine: 'claude', want: 'claude' }).name, 'Claude',
      'the CLI the server answers with beats the agent that built the map');
    assert.equal(picked({ meta: { agent: 'hermes' } }, { engine: null, want: 'claude' }).name, 'Claude',
      'no CLI installed: name the one serve.mjs would run, not the builder');
    assert.equal(picked({ meta: { agent: 'hermes' } }, null).name, 'Hermes', 'an exported map still names its builder');
    assert.equal(picked({ meta: {} }, { engine: 'codex', want: 'codex' }).name, 'Codex');
  } finally { cleanup(root); }
});

test('an exported Hermes map carries no folder, no remotes and no Ask bar', () => {
  const root = shopApp();
  try {
    execFileSync('git', ['-C', path.join(root, 'shop-api'), 'remote', 'add', 'origin', 'https://someone:not-a-real-token@example.com/shop-api.git']);
    run('scan.mjs', root);
    run('build.mjs', root, '--agent', 'hermes');
    const out = execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export'], { cwd: root, encoding: 'utf8' });
    const file = /Exported the map to (.+)/.exec(out)[1].trim();
    const html = fs.readFileSync(file, 'utf8');
    const g = JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(html)[1]);
    assert.equal(g.meta.root, null, 'no folder path from this computer');
    assert.ok(g.meta.repos.every((r) => !('remote' in r)), 'no git remotes');
    assert.ok(!html.includes('not-a-real-token'), 'no sign-in token from a remote');
    assert.ok(!html.includes('FLOORPLAN_SERVER='), 'no server details, so no Ask bar');
    assert.match(out, /no Ask bar/);
  } finally { cleanup(root); }
});
