// Changing a blueprint from the map: the Ask bar's Change mode sends a request to the agent (a stand-in
// here, fixtures/fake-cli), which replies with the whole updated plan. serve.mjs checks it with plan.mjs and
// build.mjs, saves it, redraws the map with the changes highlighted, and can undo it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, makeProject, shopApp, run, readGraph, readJson, writeJson, routeKeys, cleanup } from './helpers.mjs';

const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'blueprint');
const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-cli', 'fake-claude.mjs');
const servers = [], roots = [];
after(async () => {
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((resolve) => { s.once('exit', resolve); s.kill(); })));
  for (const r of roots) cleanup(r);
});

/** The sample blueprint, drawn, with its map server answering through the stand-in agent's `replies`. */
async function served(replies, root) {
  if (!root) {
    root = makeProject({});
    fs.cpSync(FIXTURE, root, { recursive: true });
    run('plan.mjs', root);
    run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  }
  roots.push(root);
  const changes = path.join(root, 'replies.json');
  writeJson(changes, replies);
  const log = path.join(root, 'fake.log');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const home = path.join(root, 'home');
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: {
      ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: '', FLOORPLAN_ACP: '',
      FLOORPLAN_ACP_GEMINI: '', FLOORPLAN_ACP_OPENCODE: '', FLOORPLAN_ACP_DEVIN: '',
      FLOORPLAN_ACP_CLAUDE_CODE_ACP: '', FLOORPLAN_ACP_CLAUDE_AGENT_ACP: '', FLOORPLAN_ACP_CODEX_ACP: '',
      FLOORPLAN_CLAUDE: FAKE, FAKE_LOG: log, FAKE_CHANGES: changes,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(base + '/')).text())[1]);
  const token = page.token;
  // the stand-in is Claude Code, which holds its answers to a schema, so the map offers Change
  assert.equal(page.change, true);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': token }, body: JSON.stringify(body || {}) });
  return {
    root,
    async change(question) {
      const text = await (await post('/api/ask', { question, mode: 'change' })).text();
      return text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (\w+)/.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
    },
    undo: async () => (await post('/api/plan/undo')).json(),
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
  };
}
const pick = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);

/** The sample plan with refunds added: a new endpoint file, its endpoint, and the "My walks" page calling it. */
function withRefunds(change = (p) => p) {
  const plan = readJson(path.join(FIXTURE, 'floorplan', 'plan.json'));
  plan.files.push({ path: 'api/src/routes/refunds.ts', name: 'Refund endpoints', description: 'Refunds a cancelled walk to the owner’s card.', uses: ['api/src/services/payments.ts', 'api/src/db/bookings.ts'] });
  plan.files.find((f) => f.path === 'web/app/bookings/page.tsx').calls.push('POST /api/refunds');
  plan.endpoints.push({ method: 'POST', path: '/api/refunds', file: 'api/src/routes/refunds.ts', name: 'Refund a walk', description: 'Sends the money back for a cancelled walk.', access: 'signed-in', who: 'the owner who booked it' });
  change(plan);
  return {
    title: 'Planned out refunds',
    summary: 'Added a **refund** endpoint that the My walks page calls when a walk is cancelled.',
    plan: JSON.stringify(plan),
    architecture: fs.readFileSync(path.join(FIXTURE, 'floorplan', 'architecture.json'), 'utf8'),
    changes: [
      { ref: 'api/src/routes/refunds.ts', change: 'new', note: 'Where refunds are handled.' },
      { ref: 'POST /api/refunds', change: 'new', note: 'The request that refunds a walk.' },
      { ref: 'web/app/bookings/page.tsx', change: 'changed', note: 'Now asks for a refund when a walk is cancelled.' },
    ],
    followups: ['Email the owner when the refund goes through'],
  };
}

test('a change is checked, saved and drawn, with what changed highlighted', async () => {
  const s = await served([withRefunds()]);
  const events = await s.change('also plan out refunds');
  assert.deepEqual(pick(events, 'failure'), []);
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Reading floorplan/plan.json', 'Checking the updated plan']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Planned out refunds');
  assert.equal(answer.changes, 3);
  assert.deepEqual(answer.followups, ['Email the owner when the refund goes through']);
  assert.match(answer.undo, /^[0-9a-z]+$/);

  const g = readGraph(s.root);
  assert.ok(routeKeys(g).includes('POST /api/refunds'));
  assert.ok(g.links.some((l) => l.a === 'f:web/app/bookings/page.tsx' && l.b === 'f:api/src/routes/refunds.ts' && l.labels.includes('POST /api/refunds')));
  assert.equal(g.recent.tasks[0].title, 'Planned out refunds');
  assert.equal(g.recent.tasks[0].request, 'also plan out refunds');
  assert.deepEqual(g.recent.items.map((x) => `${x.change} ${x.id}`).sort(), ['changed f:web/app/bookings/page.tsx', 'new f:api/src/routes/refunds.ts', `new r:${g.routes.findIndex((r) => r.p === '/api/refunds')}`].sort());
  assert.equal(readJson(path.join(s.root, 'floorplan', 'plan.json')).endpoints.at(-1).who, 'the owner who booked it');

  // the agent only read: no editing tools, and it was asked for the change schema
  const [call] = s.calls();
  assert.ok(!call.args.join(' ').match(/\b(Edit|Write)\b/), 'the agent gets no editing tools');
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /You change a blueprint/);
  assert.equal(call.input, 'also plan out refunds');

  // undo puts the plan and the map back
  assert.deepEqual(await s.undo(), { ok: true, left: 0 });
  assert.ok(!routeKeys(readGraph(s.root)).includes('POST /api/refunds'));
  assert.deepEqual(await s.undo(), { ok: false, error: 'Nothing to undo.' });
});

test('a plan that fails the checks goes back to the agent once, with the problems', async () => {
  const broken = withRefunds((p) => { p.endpoints.at(-1).file = 'api/src/routes/refund.ts'; });
  const s = await served([broken, withRefunds()]);
  const events = await s.change('also plan out refunds');
  assert.ok(pick(events, 'progress').some((p) => p.text === 'Fixing a problem the checks found'));
  assert.equal(pick(events, 'answer')[0].title, 'Planned out refunds');
  const [, retry] = s.calls();
  assert.match(retry.input, /didn't pass the checks/);
  assert.match(retry.input, /"api\/src\/routes\/refund\.ts" is not one of the planned files/);
  assert.equal(retry.args[retry.args.indexOf('--resume') + 1], 'test-session');
});

test('new files outside every part are sent back once, so the agent adds a glob', async () => {
  const stray = withRefunds((p) => { p.files.push({ path: 'admin/app/page.tsx', name: 'Admin home', description: 'Our own admin page.' }); });
  const fixed = { ...stray, architecture: JSON.stringify({ ...readJson(path.join(FIXTURE, 'floorplan', 'architecture.json')), nodes: [...readJson(path.join(FIXTURE, 'floorplan', 'architecture.json')).nodes, { id: 'admin', label: 'Admin page', kind: 'ui', summary: 'Our own admin page.', paths: ['admin/**'] }] }) };
  const s = await served([stray, fixed]);
  const events = await s.change('add an admin page');
  assert.match(s.calls()[1].input, /1 planned file\(s\) fall under no node's paths/);
  assert.equal(pick(events, 'answer').length, 1);
  assert.equal(readGraph(s.root).files.filter((f) => f.n === 'unassigned').length, 0);
});

test('when the second try fails too, nothing changes', async () => {
  const broken = withRefunds((p) => { p.endpoints.at(-1).access = 'owners'; });
  const s = await served([broken]);
  const before = fs.readFileSync(path.join(s.root, 'floorplan', 'plan.json'), 'utf8');
  const events = await s.change('also plan out refunds');
  const [failure] = pick(events, 'failure');
  assert.equal(failure.code, 'change_invalid');
  assert.match(failure.message, /access "owners" must be one of/);
  assert.equal(fs.readFileSync(path.join(s.root, 'floorplan', 'plan.json'), 'utf8'), before);
  assert.ok(!routeKeys(readGraph(s.root)).includes('POST /api/refunds'));
  assert.equal(s.calls().length, 2);
});

test('a map of real code cannot be changed this way', async () => {
  const root = shopApp();
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  const s = await served([withRefunds()], root);
  const [failure] = pick(await s.change('add refunds'), 'failure');
  assert.match(failure.message, /Only a blueprint can be changed from the map/);
});
