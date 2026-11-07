// Hermes Change on a blueprint, end to end through a real built map and a stand-in `hermes` CLI: a
// candidate plan is validated in a disposable stage, published preserve-first (move the live entry into
// history, then link the new one only into an empty path), and Undo uses the same rule. Every exact
// publication gap below is injected deterministically through FLOORPLAN_CHANGE_HOOK, never a sleep.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { REPO, SKILL, makeProject, shopApp, scanAndBuild, run, readJson, readGraph, writeJson, routeKeys, cleanup } from './helpers.mjs';
import { Boundary } from '../skills/floorplan/assets/hermes-boundary.mjs';

const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'blueprint');
const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-cli', 'fake-hermes.mjs');
const FAKE_CLAUDE = path.join(REPO, 'tests', 'fixtures', 'fake-cli', 'fake-claude.mjs');
const REAL_PLAN = path.join(SKILL, 'scripts', 'plan.mjs');
const REAL_BUILD = path.join(SKILL, 'scripts', 'build.mjs');
const health = await import(new URL('../skills/floorplan/scripts/lib/health.mjs', import.meta.url));
const t = process.platform === 'win32' ? test.skip : test;
const servers = [], roots = [];
after(async () => {
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((r) => { s.once('exit', r); s.kill(); })));
  for (const r of roots) cleanup(r);
});

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);
async function waitFile(p, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fs.existsSync(p)) return; await sleep(25); }
  throw new Error(`no ${p}`);
}

/** The sample blueprint, drawn by Hermes, in a fresh project folder. */
function blueprintRoot() {
  const root = makeProject({});
  fs.cpSync(FIXTURE, root, { recursive: true });
  run('plan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
  roots.push(root);
  return root;
}

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

/** A skill folder whose validators can be slowed, so Stop and a concurrent hand edit have a real window. */
function installSlowValidators(root) {
  const dir = path.join(root, 'fake-skill');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const [name, real] of [['plan.mjs', REAL_PLAN], ['build.mjs', REAL_BUILD]]) {
    fs.writeFileSync(path.join(dir, 'scripts', name), `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
if (process.env.FAKE_VALIDATOR_MARKER) { try { fs.writeFileSync(process.env.FAKE_VALIDATOR_MARKER, '1'); } catch {} }
const ms = Number(process.env.FAKE_VALIDATOR_SLEEP || 0);
if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
execFileSync(process.execPath, [${JSON.stringify(real)}, ...process.argv.slice(2)], { stdio: 'inherit' });
`);
  }
  writeJson(path.join(root, 'floorplan', '.cache', 'skill.json'), { dir });
}

/** Every live write-set member's bytes, or `absent`. */
function liveHashes(root) {
  const out = {};
  for (const rel of ['plan.json', 'architecture.json', 'recent-work.json', '.cache/scan.json', 'graph.json', 'query.mjs', 'serve.mjs', 'hermes-boundary.mjs', '.cache/skill.json', '.gitignore', 'index.html']) {
    const p = path.join(root, 'floorplan', rel);
    out[rel] = fs.existsSync(p) ? sha(p) : 'absent';
  }
  return out;
}

/** A built Hermes blueprint map with a server answering through the stand-in CLI. */
async function serve({ root, replies = [], slow = 0, hook = null, env = {} } = {}) {
  if (!root) root = blueprintRoot();
  const changes = path.join(root, 'replies.json');
  writeJson(changes, replies);
  fs.rmSync(`${changes}.used`, { force: true });
  if (slow) installSlowValidators(root);
  const hookFile = path.join(root, 'change-hook.json');
  if (hook) writeJson(hookFile, hook);
  const hookOn = fs.existsSync(hookFile);
  const log = path.join(root, `fake-hermes-${servers.length}.log`);
  const marker = slow ? path.join(root, 'validator-started') : null;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root,
    env: {
      ...process.env, FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: 'hermes', FLOORPLAN_HERMES: FAKE,
      FLOORPLAN_PROFILE: 'test-profile', FAKE_HERMES_LOG: log, FAKE_HERMES_CHANGES: changes,
      ...(hookOn ? { FLOORPLAN_CHANGE_HOOK: hookFile } : {}),
      ...(marker ? { FAKE_VALIDATOR_MARKER: marker } : {}),
      ...(slow ? { FAKE_VALIDATOR_SLEEP: String(slow) } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  let out = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.stderr.on('data', (d) => { out += d; });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
  });
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(base + '/')).text())[1]);
  const reloads = [];
  const ac = new AbortController();
  fetch(`${base}/api/events?token=${page.token}`, { signal: ac.signal }).then(async (r) => {
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^event: reload$/m.test(block)) reloads.push(Date.now());
      }
    }
  }).catch(() => {});
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': page.token }, body: JSON.stringify(body || {}) });
  const ask = async (body) => {
    const text = await (await post('/api/ask', body)).text();
    return text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (\w+)/.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
  };
  return {
    root, base, page, log, marker, reloads,
    change: (q) => ask({ question: q, mode: 'change' }),
    undo: async () => (await post('/api/plan/undo')).json(),
    cancelAll: () => post('/api/cancel', { all: true }),
    calls: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
  };
}
const historyDir = (root) => path.join(root, 'floorplan', '.cache', 'history');
const stageDirs = (root) => { try { return fs.readdirSync(path.join(root, 'floorplan', '.cache')).filter((n) => n.startsWith('change-')); } catch { return []; } };
const historyOf = (root, message) => path.join(historyDir(root), /history\/([^/]+)\//.exec(message)[1]);

t('a Hermes change publishes once, redraws and keeps every replaced inode in history', async () => {
  const s = await serve({ replies: [withRefunds()] });
  const base = liveHashes(s.root);
  const events = await s.change('also plan out refunds');
  assert.deepEqual(pick(events, 'failure'), []);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Planned out refunds');
  assert.equal(answer.changes, 3);
  assert.deepEqual(answer.followups, ['Email the owner when the refund goes through']);
  assert.match(answer.undo, /^[0-9a-z]+-[0-9a-f]+$/);
  await sleep(1600);
  assert.equal(s.reloads.length, 1, 'exactly one reload on success');

  const g = readGraph(s.root);
  assert.ok(routeKeys(g).includes('POST /api/refunds'));
  assert.ok(g.links.some((l) => l.a === 'f:web/app/bookings/page.tsx' && l.b === 'f:api/src/routes/refunds.ts' && l.labels.includes('POST /api/refunds')));
  assert.equal(g.recent.tasks[0].title, 'Planned out refunds');
  assert.equal(g.recent.tasks[0].request, 'also plan out refunds');
  assert.equal(readJson(path.join(s.root, 'floorplan', 'plan.json')).endpoints.at(-1).who, 'the owner who booked it');
  assert.notEqual(liveHashes(s.root)['index.html'], base['index.html']);

  const H = path.join(historyDir(s.root), answer.undo);
  const manifest = readJson(path.join(H, 'manifest.json'));
  assert.equal(manifest.status, 'ok');
  assert.equal(manifest.preservation, true);
  assert.equal(Object.keys(manifest.published).at(-1), 'index.html', 'index.html is published last');
  assert.equal(fs.readdirSync(path.join(H, 'held')).length, 10, 'every live entry the change replaced is retained');
  assert.ok(!fs.existsSync(path.join(H, 'held', '03-recent-work.json')), 'the change created recent-work.json; nothing was there to hold');
  assert.ok(fs.existsSync(path.join(H, 'held', '01-plan.json')));
  assert.deepEqual(stageDirs(s.root), [], 'the stage is gone');
});

t('resolving a design-review question removes it from the plan', async () => {
  const reply = withRefunds((p) => {
    const q = p.questions.shift();
    p.assumptions.push(`Cancelling is free up to 24 hours before the walk (${q.question})`);
  });
  const s = await serve({ replies: [reply] });
  const events = await s.change('owners cancel for free up to 24 hours before');
  assert.equal(pick(events, 'failure').length, 0);
  assert.deepEqual(readJson(path.join(s.root, 'floorplan', 'plan.json')).questions, []);
  const kinds = readGraph(s.root).health.issues.map((i) => i.kind);
  assert.ok(!kinds.includes('question'), kinds.join(','));
});

t('an invalid plan is sent back once with the problems, then succeeds', async () => {
  const broken = withRefunds((p) => { p.endpoints.at(-1).file = 'api/src/routes/refund.ts'; });
  const s = await serve({ replies: [broken, withRefunds()] });
  const events = await s.change('also plan out refunds');
  assert.equal(pick(events, 'answer')[0].title, 'Planned out refunds');
  const starts = s.calls().filter((f) => f.type === 'start');
  assert.equal(starts.length, 2, 'two worker runs');
  assert.match(starts[1].question, /didn't pass the checks/);
  assert.match(starts[1].question, /"api\/src\/routes\/refund\.ts" is not one of the planned files/);
});

t('two invalid plans change nothing and leave no stage behind', async () => {
  const broken = withRefunds((p) => { p.endpoints.at(-1).access = 'owners'; });
  const s = await serve({ replies: [broken, broken] });
  const before = liveHashes(s.root);
  const events = await s.change('also plan out refunds');
  const [failure] = pick(events, 'failure');
  assert.equal(failure.code, 'change_invalid');
  assert.match(failure.message, /access "owners" must be one of/);
  assert.deepEqual(liveHashes(s.root), before);
  assert.deepEqual(stageDirs(s.root), []);
  await sleep(1500);
  assert.equal(s.reloads.length, 0);
});

t('a new file outside every part is sent back once so the agent adds a glob', async () => {
  const arch = readJson(path.join(FIXTURE, 'floorplan', 'architecture.json'));
  arch.nodes.push({ id: 'admin', label: 'Admin page', kind: 'ui', summary: 'Our own admin page.', paths: ['admin/**'] });
  const stray = withRefunds((p) => { p.files.push({ path: 'admin/app/page.tsx', name: 'Admin home', description: 'Our own admin page.' }); });
  const fixed = { ...stray, architecture: JSON.stringify(arch) };
  const s = await serve({ replies: [stray, fixed] });
  const events = await s.change('add an admin page');
  assert.equal(pick(events, 'answer').length, 1);
  assert.match(s.calls().filter((f) => f.type === 'start')[1].question, /1 planned file\(s\) fall under no node's paths/);
  assert.equal(readGraph(s.root).files.filter((f) => f.n === 'unassigned').length, 0);
});

t('a second change while one is running is busy', async () => {
  const s = await serve({ replies: [withRefunds(), withRefunds()], slow: 1200 });
  const running = s.change('also plan out refunds');
  await waitFile(s.marker);
  const busy = await s.change('add something else');
  assert.equal(pick(busy, 'failure')[0].code, 'busy');
  assert.equal(pick(busy, 'answer').length, 0);
  await s.cancelAll();
  await running;
});

t('Stop during the staged validator kills it, writes nothing and sends no reload', async () => {
  const s = await serve({ replies: [withRefunds()], slow: 5000 });
  const before = liveHashes(s.root);
  const running = s.change('also plan out refunds');
  await waitFile(s.marker);
  await s.cancelAll();
  const events = await running;
  assert.equal(pick(events, 'answer').length, 0);
  assert.equal(pick(events, 'failure').length, 0, 'a stopped request ends silently');
  assert.deepEqual(liveHashes(s.root), before);
  assert.deepEqual(stageDirs(s.root), []);
  await sleep(1500);
  assert.equal(s.reloads.length, 0);
});

t('a hand edit during validation wins: conflict, nothing published, no reload', async () => {
  const s = await serve({ replies: [withRefunds()], slow: 1500 });
  const before = liveHashes(s.root);
  const running = s.change('also plan out refunds');
  await waitFile(s.marker);
  const handEdit = '{\n  "hand": "edit"\n}\n';
  fs.writeFileSync(path.join(s.root, 'floorplan', 'plan.json'), handEdit);
  const events = await running;
  const [failure] = pick(events, 'failure');
  assert.equal(failure.code, 'conflict');
  assert.equal(pick(events, 'answer').length, 0);
  assert.equal(fs.readFileSync(path.join(s.root, 'floorplan', 'plan.json'), 'utf8'), handEdit);
  assert.equal(liveHashes(s.root)['graph.json'], before['graph.json']);
  assert.equal(liveHashes(s.root)['index.html'], before['index.html']);
  assert.deepEqual(stageDirs(s.root), []);
  await sleep(1500);
  assert.equal(s.reloads.length, 0);
});

t('a foreign file created at an absent baseline path survives, and the map is restored', async () => {
  const root = blueprintRoot();
  const foreign = path.join(root, 'floorplan', 'recent-work.json');
  assert.ok(!fs.existsSync(foreign));
  writeJson(path.join(root, 'change-hook.json'), { beforeMove: { name: 'floorplan/recent-work.json', once: 1, write: { path: foreign, text: '{"foreign":true}' } } });
  const s = await serve({ root, replies: [withRefunds()] });
  const beforePlan = fs.readFileSync(path.join(root, 'floorplan', 'plan.json'));
  const events = await s.change('also plan out refunds');
  const [failure] = pick(events, 'failure');
  assert.equal(failure.code, 'conflict');
  assert.equal(fs.readFileSync(foreign, 'utf8'), '{"foreign":true}');
  assert.deepEqual(fs.readFileSync(path.join(root, 'floorplan', 'plan.json')), beforePlan);
  await sleep(1500);
  assert.equal(s.reloads.length, 0);
});

t('gap (i): a replacement after the preflight is preserved, never replaced by the candidate', async () => {
  const root = blueprintRoot();
  const planPath = path.join(root, 'floorplan', 'plan.json');
  const sentinel = 'FOREIGN-AFTER-PREFLIGHT';
  writeJson(path.join(root, 'change-hook.json'), { beforeMove: { name: 'floorplan/plan.json', once: 1, write: { path: planPath, text: sentinel } } });
  const s = await serve({ root, replies: [withRefunds()] });
  const events = await s.change('also plan out refunds');
  const [failure] = pick(events, 'failure');
  assert.equal(failure.code, 'conflict');
  assert.equal(fs.readFileSync(planPath, 'utf8'), sentinel);
  assert.match(failure.message, /floorplan\/\.cache\/history\//);
  await sleep(1500);
  assert.equal(s.reloads.length, 0);
});

t('gap (ii): a file created after the held entry is verified survives EEXIST', async () => {
  const root = blueprintRoot();
  const planPath = path.join(root, 'floorplan', 'plan.json');
  const sentinel = 'FOREIGN-BEFORE-LINK';
  writeJson(path.join(root, 'change-hook.json'), { beforeLink: { name: 'floorplan/plan.json', once: 1, write: { path: planPath, text: sentinel } } });
  const s = await serve({ root, replies: [withRefunds()] });
  const events = await s.change('also plan out refunds');
  const [failure] = pick(events, 'failure');
  assert.equal(failure.code, 'conflict');
  assert.equal(fs.readFileSync(planPath, 'utf8'), sentinel);
  const held = fs.readFileSync(path.join(historyOf(root, failure.message), 'held', '01-plan.json'), 'utf8');
  assert.match(held, /"source": "docs\/prd\.md"/, 'the baseline held entry is retained');
  await sleep(1500);
  assert.equal(s.reloads.length, 0);
});

t('a conflict at index.html rolls back preserve-first and keeps both foreign bytes and displaced entries', async () => {
  const root = blueprintRoot();
  const planPath = path.join(root, 'floorplan', 'plan.json');
  const indexSentinel = 'FOREIGN-INDEX-AT-THE-END';
  const rollbackSentinel = 'FOREIGN-DURING-ROLLBACK';
  writeJson(path.join(root, 'change-hook.json'), {
    beforeLink: { name: 'floorplan/index.html', once: 1, write: { path: path.join(root, 'floorplan', 'index.html'), text: indexSentinel } },
    rollbackAfterMove: { name: 'floorplan/plan.json', once: 1, write: { path: planPath, text: rollbackSentinel } },
  });
  const s = await serve({ root, replies: [withRefunds()] });
  const events = await s.change('also plan out refunds');
  const [failure] = pick(events, 'failure');
  assert.equal(failure.code, 'conflict');
  assert.match(failure.message, /conflict\.json/);
  assert.equal(fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'), indexSentinel);
  assert.equal(fs.readFileSync(planPath, 'utf8'), rollbackSentinel);
  const H = historyOf(root, failure.message);
  const displaced = fs.readdirSync(path.join(H, 'displaced'));
  assert.ok(displaced.some((n) => n.endsWith('plan.json')), 'the candidate plan this request installed is retained');
  assert.ok(fs.readFileSync(path.join(H, 'held', '01-plan.json'), 'utf8').length > 0);
  const conflict = readJson(path.join(H, 'conflict.json'));
  assert.equal(conflict.conflict, true);
  await sleep(1500);
  assert.equal(s.reloads.length, 0);
});

t('a write through an open descriptor after publication lands in the retained history inode', async () => {
  const root = blueprintRoot();
  const planPath = path.join(root, 'floorplan', 'plan.json');
  const fd = fs.openSync(planPath, 'r+');
  const ino = fs.fstatSync(fd).ino;
  const s = await serve({ root, replies: [withRefunds(), withRefunds()] });
  const events = await s.change('also plan out refunds');
  const [answer] = pick(events, 'answer');
  const H = path.join(historyDir(root), answer.undo);
  const heldName = fs.readdirSync(path.join(H, 'held')).find((n) => n.endsWith('plan.json'));
  const heldPath = path.join(H, 'held', heldName);
  assert.equal(fs.statSync(heldPath).ino, ino, 'the live inode was moved into history, not copied');
  fs.writeSync(fd, 'AFTER_PUBLICATION_SENTINEL');
  fs.closeSync(fd);
  assert.match(fs.readFileSync(heldPath, 'utf8'), /AFTER_PUBLICATION_SENTINEL/);

  // a second change creates another preservation entry; the first one is never pruned automatically
  const again = await s.change('also plan out refunds');
  assert.equal(pick(again, 'answer').length, 1);
  assert.ok(fs.existsSync(heldPath), 'the held inode survives a later change');
  assert.match(fs.readFileSync(heldPath, 'utf8'), /AFTER_PUBLICATION_SENTINEL/);
});

t('Undo restores the original plan, architecture and recent work, with one reload', async () => {
  const s = await serve({ replies: [withRefunds()] });
  const before = liveHashes(s.root);
  const events = await s.change('also plan out refunds');
  const [answer] = pick(events, 'answer');
  assert.ok(routeKeys(readGraph(s.root)).includes('POST /api/refunds'));
  const r = await s.undo();
  assert.deepEqual(r, { ok: true, left: 0 });
  await sleep(1600);
  assert.equal(s.reloads.length, 2, 'one reload for the change, one for the undo');
  const after = liveHashes(s.root);
  assert.equal(after['plan.json'], before['plan.json']);
  assert.equal(after['architecture.json'], before['architecture.json']);
  assert.equal(after['recent-work.json'], before['recent-work.json']);
  assert.ok(!routeKeys(readGraph(s.root)).includes('POST /api/refunds'));
  assert.equal(readJson(path.join(historyDir(s.root), answer.undo, 'manifest.json')).undone, true);
  assert.deepEqual(await s.undo(), { ok: false, error: 'Nothing to undo.' });
});

t('Undo is refused when the live plan changed after the change', async () => {
  const s = await serve({ replies: [withRefunds()] });
  await s.change('also plan out refunds');
  await sleep(1500);
  const edited = '{\n  "edited": "by hand"\n}\n';
  fs.writeFileSync(path.join(s.root, 'floorplan', 'plan.json'), edited);
  const before = s.reloads.length;
  const r = await s.undo();
  assert.equal(r.ok, false);
  assert.match(r.error, /changed while this undo was being prepared/);
  assert.equal(fs.readFileSync(path.join(s.root, 'floorplan', 'plan.json'), 'utf8'), edited);
  await sleep(1500);
  assert.equal(s.reloads.length, before);
});

t('Undo gap (i): a replacement after its preflight is preserved, not lost', async () => {
  const root = blueprintRoot();
  const planPath = path.join(root, 'floorplan', 'plan.json');
  const sentinel = 'UNDO-FOREIGN-AFTER-PREFLIGHT';
  writeJson(path.join(root, 'change-hook.json'), { beforeMove: { kind: 'undo', name: 'floorplan/plan.json', once: 1, write: { path: planPath, text: sentinel } } });
  const s = await serve({ root, replies: [withRefunds()] });
  await s.change('also plan out refunds');
  const r = await s.undo();
  assert.equal(r.ok, false);
  assert.match(r.error, /conflict|overwritten/);
  assert.equal(fs.readFileSync(planPath, 'utf8'), sentinel);
  await sleep(1500);
  assert.equal(s.reloads.length, 1, 'the undo published nothing');
});

t('Undo gap (ii): a file created before the exclusive link survives EEXIST', async () => {
  const root = blueprintRoot();
  const planPath = path.join(root, 'floorplan', 'plan.json');
  const sentinel = 'UNDO-FOREIGN-BEFORE-LINK';
  writeJson(path.join(root, 'change-hook.json'), { beforeLink: { kind: 'undo', name: 'floorplan/plan.json', once: 1, write: { path: planPath, text: sentinel } } });
  const s = await serve({ root, replies: [withRefunds()] });
  await s.change('also plan out refunds');
  const r = await s.undo();
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(planPath, 'utf8'), sentinel);
  await sleep(1500);
  assert.equal(s.reloads.length, 1);
});

t('Undo refuses a retained history input that changed while it was staging', async () => {
  const root = blueprintRoot();
  writeJson(path.join(root, 'change-hook.json'), { undoSourcesCopied: { overwriteHeld: ['plan.json', '{"corrupt":true}'] } });
  const s = await serve({ root, replies: [withRefunds()] });
  await s.change('also plan out refunds');
  const live = liveHashes(root);
  const r = await s.undo();
  assert.equal(r.ok, false);
  assert.match(r.error, /changed while it was being checked/);
  assert.equal(liveHashes(root)['plan.json'], live['plan.json']);
  await sleep(1500);
  assert.equal(s.reloads.length, 1);
});

t('a conflict entry is never chosen by Undo: the last committed change is', async () => {
  const root = blueprintRoot();
  const planPath = path.join(root, 'floorplan', 'plan.json');
  const original = sha(planPath);
  const s = await serve({ root, replies: [withRefunds()] });
  assert.equal(pick(await s.change('also plan out refunds'), 'answer').length, 1);
  // a newer, non-committed entry (a real conflict writes exactly this shape)
  const conflictDir = path.join(historyDir(root), 'zzzz-conflict');
  fs.mkdirSync(conflictDir, { recursive: true });
  writeJson(path.join(conflictDir, 'manifest.json'), { preservation: true, kind: 'change', ok: false, conflict: true, published: {} });
  const undone = await s.undo();
  assert.deepEqual(undone, { ok: true, left: 0 });
  assert.equal(sha(planPath), original, 'Undo restored the committed change’s baseline, not the conflict entry');
  assert.ok(fs.existsSync(conflictDir), 'a conflict entry is retained');
});

t('legacy snapshot pruning never removes a Hermes preservation entry', async () => {
  const root = blueprintRoot();
  const herm = await serve({ root, replies: [withRefunds()] });
  const [answer] = pick(await herm.change('also plan out refunds'), 'answer');
  const H = path.join(historyDir(root), answer.undo);
  const held = path.join(H, 'held', '01-plan.json');
  const before = sha(held);
  // 25 legacy-shaped snapshots, so the legacy last-20 policy has work to do on the next Claude/Codex change
  for (let i = 0; i < 25; i++) {
    const dir = path.join(historyDir(root), `zz-legacy-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(root, 'floorplan', 'plan.json'), path.join(dir, 'plan.json'));
  }
  const claude = await serve({
    root, replies: [withRefunds()],
    env: { FLOORPLAN_ENGINE: 'claude', FLOORPLAN_CLAUDE: FAKE_CLAUDE, FLOORPLAN_HERMES: path.join(root, 'no-such-hermes'),
      FAKE_CHANGES: path.join(root, 'replies.json'), FAKE_LOG: path.join(root, 'fake-claude.log') },
  });
  assert.equal(claude.page.engine, 'claude');
  assert.equal(pick(await claude.change('also plan out refunds'), 'answer').length, 1);
  const legacy = fs.readdirSync(historyDir(root)).filter((n) => !fs.existsSync(path.join(historyDir(root), n, 'manifest.json')));
  assert.equal(legacy.length, 20, 'ordinary snapshots keep their last-20 policy');
  assert.ok(fs.existsSync(H), 'the preservation entry survives');
  assert.equal(sha(held), before, 'its held bytes are untouched');
});

t('a blueprint Change reads exactly the plan, the architecture and the PRD', async () => {
  const reply = { ...withRefunds(), reads: ['floorplan/plan.json', 'floorplan/architecture.json', 'docs/prd.md'] };
  const s = await serve({ replies: [reply] });
  const events = await s.change('also plan out refunds');
  assert.equal(pick(events, 'failure').length, 0);
  const reads = s.calls().filter((f) => f.type === 'classify_read').map((f) => f.path);
  for (const p of ['floorplan/plan.json', 'floorplan/architecture.json', 'docs/prd.md']) assert.ok(reads.includes(p), `${p} was read: ${reads.join(', ')}`);
});

t('blueprint inputs classify through the real scanner; unscanned, symlinked and swapped inputs are denied', async () => {
  const dir = fs.mkdtempSync(path.join(REPO, 'tests', '.tmp-hermes-bp-'));
  roots.push(dir);
  const plan = '{\n "source": "docs/prd.md",\n "stack": ["AKIAABCDEFGHIJKLMNOP"]\n}';
  const prd = '# PRD\nRefunds are instant.\n';
  fs.mkdirSync(path.join(dir, 'floorplan'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'floorplan', 'plan.json'), plan);
  fs.writeFileSync(path.join(dir, 'floorplan', 'architecture.json'), '{"nodes":[]}');
  fs.writeFileSync(path.join(dir, 'docs', 'prd.md'), prd);
  fs.writeFileSync(path.join(dir, 'docs', 'other.md'), '# other\n');
  const graph = { project: { name: 'P' }, nodes: [], files: [], routes: [], links: [] };
  const query = { overview: () => ({}), find: () => [], show: () => ({}), path: () => ({}), exists: () => false };
  const worker = {
    read: async (rel) => { const bytes = fs.readFileSync(path.join(dir, rel)); return { ok: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes_base64: bytes.toString('base64') }; },
    ticket: async (tk) => {
      let bytes;
      try { bytes = fs.readFileSync(path.join(dir, tk.path)); } catch { return { ok: false, reason: 'not_found' }; }
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (tk.sha256 !== hash) return { ok: false, reason: 'changed' };
      const lines = bytes.toString('utf8').split('\n');
      for (const n of tk.redactLines || []) lines[n - 1] = '[redacted: known secret]';
      return { ok: true, sha256: hash, text: lines.slice(tk.start - 1, tk.end).join('\n') };
    },
  };
  const b = new Boundary({ root: dir, graph, blueprint: { source: 'docs/prd.md' }, query, fingerprints: new Map(), findIssues: health.findIssues, read: worker.read, ticket: worker.ticket });
  const planRead = await b.lookup('read', { path: 'floorplan/plan.json', start: 1, end: 3 }, 'L1');
  assert.equal(planRead.ok, true);
  assert.doesNotMatch(planRead.data.text, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(planRead.data.text, /\[redacted: known secret\]/);

  const prdRead = await b.lookup('read', { path: 'docs/prd.md', start: 1, end: 2 }, 'L2');
  assert.equal(prdRead.ok, true);
  assert.match(prdRead.data.text, /Refunds are instant/);
  assert.equal((await b.lookup('read', { path: 'docs/other.md', start: 1, end: 1 }, 'L3')).reason, 'not_in_graph');
  assert.equal((await b.lookup('read', { path: 'floorplan/serve.mjs', start: 1, end: 1 }, 'L4')).reason, 'denied_directory');
  assert.equal((await b.lookup('read', { path: '../outside.md', start: 1, end: 1 }, 'L5')).reason, 'invalid_path');
  assert.equal((await b.lookup('read', { path: 'floorplan/plan.json', start: 1, end: 201 }, 'L6')).reason, 'bad_range');

  fs.rmSync(path.join(dir, 'docs', 'prd.md'));
  fs.symlinkSync(path.join(dir, 'floorplan', 'plan.json'), path.join(dir, 'docs', 'prd.md'));
  assert.equal((await b.lookup('read', { path: 'docs/prd.md', start: 1, end: 1 }, 'L7')).reason, 'symlink');

  // a regular-file swap between the ticket and the reopen is caught by the hash binding
  fs.rmSync(path.join(dir, 'docs', 'prd.md'));
  fs.writeFileSync(path.join(dir, 'docs', 'prd.md'), prd);
  let swapped = false;
  const swap = new Boundary({ root: dir, graph, blueprint: { source: 'docs/prd.md' }, query, fingerprints: new Map(), findIssues: health.findIssues,
    read: async (rel) => { const bytes = fs.readFileSync(path.join(dir, rel)); return { ok: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes_base64: bytes.toString('base64') }; },
    ticket: async (tk) => {
      if (!swapped) { swapped = true; fs.writeFileSync(path.join(dir, 'docs', 'prd.md'), 'CANARY_SWAPPED_AFTER_TICKET\n'); }
      const bytes = fs.readFileSync(path.join(dir, tk.path));
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      return hash === tk.sha256 ? { ok: true, sha256: hash, text: '' } : { ok: false, reason: 'changed' };
    } });
  const swappedRead = await swap.lookup('read', { path: 'docs/prd.md', start: 1, end: 2 }, 'L1');
  assert.equal(swappedRead.ok, false);
  assert.equal(swappedRead.reason, 'changed');
  assert.doesNotMatch(JSON.stringify(swappedRead), /CANARY_SWAPPED_AFTER_TICKET/);
});

t('a code map refuses Change', async () => {
  const root = shopApp();
  scanAndBuild(root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
  const s = await serve({ root, replies: [withRefunds()] });
  const events = await s.change('add refunds');
  assert.match(pick(events, 'failure')[0].message, /Only a blueprint can be changed from the map/);
});

t('refresh --from-code keeps plan.json and the Hermes identity', async () => {
  const root = blueprintRoot();
  fs.mkdirSync(path.join(root, 'api', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'api', 'src', 'server.ts'), "import express from 'express';\nconst app = express();\napp.get('/api/health', (req, res) => res.send('ok'));\napp.listen(3000);\n");
  writeJson(path.join(root, 'floorplan', 'architecture.json'), { project: { name: 'Pawprint', summary: 'Being built.' }, nodes: [{ id: 'api', label: 'Main server', kind: 'service', summary: 'The server.', paths: ['api/**'] }] });
  run('refresh.mjs', root, '--from-code', '--no-claude-md', '--agent', 'hermes');
  const g = readGraph(root);
  assert.equal(g.meta.blueprint, undefined);
  assert.equal(g.meta.agent, 'hermes');
  assert.ok(fs.existsSync(path.join(root, 'floorplan', 'plan.json')));
});

t('unavailable hard links refuse a change before any model call', async () => {
  const s = await serve({ replies: [withRefunds()], env: { FLOORPLAN_CHANGE_TEST_NO_LINKS: '1' } });
  const before = liveHashes(s.root);
  const events = await s.change('also plan out refunds');
  assert.equal(pick(events, 'failure')[0].code, 'unsupported_runtime');
  assert.deepEqual(liveHashes(s.root), before);
  assert.equal(s.calls().length, 0, 'no worker ran');
});
