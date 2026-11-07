// Hermes Ask, end to end through a real built map and a stand-in `hermes` CLI: source-grounded answers,
// a worker that cannot read what it should not, request-scoped Stop, and the failure codes the page shows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { REPO, SKILL, shopApp, run, cleanup } from './helpers.mjs';
import { FAILURE_CODES } from '../skills/floorplan/assets/hermes-boundary.mjs';

const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-cli', 'fake-hermes.mjs');
const FAKE_CLAUDE = path.join(REPO, 'tests', 'fixtures', 'fake-cli', 'fake-claude.mjs');
// Windows-native Hermes Ask is unsupported: process-group Stop does not exist there.
const t = process.platform === 'win32' ? test.skip : test;
const roots = [];
const servers = [];
const CANARY = 'refunds settle in three days';

after(async () => {
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((r) => { s.once('exit', r); s.kill(); })));
  for (const r of roots) cleanup(r);
});

/** A built shop map, plus any extra source files, built the way the skill does it. */
function shop(extra = {}) {
  const root = shopApp();
  for (const [p, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
  roots.push(root);
  return root;
}

async function serve(root, env = {}) {
  const log = path.join(root, `fake-hermes-${servers.length}.log`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root,
    env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: 'hermes', FLOORPLAN_HERMES: FAKE,
      FLOORPLAN_PROFILE: 'test-profile', FAKE_HERMES_LOG: log, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  let out = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => {
      out += d;
      const m = /Floorplan: (http:\/\/\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    server.stderr.on('data', (d) => { out += d; });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
  });
  const html = await (await fetch(base + '/')).text();
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(html)[1]);
  return { base, token: page.token, page, log, server, output: () => out, calls: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } } };
}

/** Starts one ask and collects its server-sent events as they arrive. */
function open(s, question, session) {
  const events = [];
  const headers = { 'content-type': 'application/json', 'x-floorplan-token': s.token };
  const done = fetch(s.base + '/api/ask', { method: 'POST', headers, body: JSON.stringify({ question, session }) })
    .then(async (r) => {
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          events.push({ event: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null') });
        }
      }
      return events;
    })
    .catch(() => events);
  const waitFor = async (name, ms = 15000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = events.find((e) => e.event === name);
      if (hit) return hit.data;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`no ${name} event; got ${events.map((e) => e.event).join(',') || 'nothing'}`);
  };
  return { events, done, waitFor, cancel: () => fetch(s.base + '/api/cancel', { method: 'POST', headers, body: JSON.stringify({ id: events.find((e) => e.event === 'start')?.data.id }) }) };
}
const ask = async (s, question, session) => {
  const o = open(s, question, session);
  return Promise.race([o.done, new Promise((_, reject) => setTimeout(() => reject(new Error(`ask timed out: ${question}`)), 20000))]);
};
const pick = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);
const gone = (p) => {
  try { process.kill(p.pid, 0); } catch { return true; }
  try { return fs.readFileSync(`/proc/${p.pid}/stat`, 'utf8').split(' ')[21] !== String(p.start); } catch { return true; }
};
const waitGone = async (pids, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (gone(pids.main) && gone(pids.child)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

t('a source-only fact reaches the answer, and the page names Hermes, the profile and the provider', async () => {
  const root = shop({ 'shop-api/canary.js': `export const CANARY_FACT = '${CANARY}';\n` });
  const s = await serve(root, { FAKE_HERMES_READ: 'shop-api/canary.js' });
  assert.equal(s.page.engine, 'hermes');
  assert.equal(s.page.profile, 'test-profile');
  assert.equal(s.page.cli, true);
  assert.match(s.page.version, /0\.22\.5-test/);

  const events = await ask(s, 'What does CANARY_FACT say?');
  const [answer] = pick(events, 'answer');
  assert.ok(answer, 'an answer arrived');
  assert.match(answer.answer, new RegExp(CANARY));
  assert.match(answer.answer, /\[\[f:shop-api\/canary\.js\]\]/);
  assert.equal(answer.engine, 'hermes');
  assert.equal(answer.profile, 'test-profile');
  assert.equal(answer.provider, 'fake-provider');
  assert.equal(answer.model, 'fake-model-1');
  assert.match(answer.session, /^[0-9a-f]{16}$/);
  assert.ok(answer.items.some((i) => i.id === 'f:shop-api/canary.js'));
});

t('the worker is never handed personal, instruction or outside-root context', async () => {
  const root = shop({
    'AGENTS.md': 'AGENTS_CANARY: never send this\n',
    'SOUL.md': 'SOUL_CANARY: never send this\n',
    'CLAUDE.local.md': 'CLAUDE_CANARY: never send this\n',
    '.env': 'ENV_CANARY=never-send-this\n',
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-outside-'));
  fs.writeFileSync(path.join(outside, 'private.txt'), 'OUTSIDE_CANARY: never send this\n');
  roots.push(outside);
  const s = await serve(root, { FAKE_HERMES_READ: 'shop-api/routes/orders.js' });
  const events = await ask(s, 'How do refunds work?');
  assert.ok(pick(events, 'answer').length, 'an answer arrived');
  const seen = JSON.stringify(s.calls());
  for (const canary of ['AGENTS_CANARY', 'SOUL_CANARY', 'CLAUDE_CANARY', 'ENV_CANARY', 'OUTSIDE_CANARY']) {
    assert.ok(!seen.includes(canary), `${canary} reached the worker`);
    assert.ok(!JSON.stringify(events).includes(canary), `${canary} reached the page`);
  }
  // the source it did read is there, and it is the only file the worker asked for
  assert.match(seen, /shop-api\/routes\/orders\.js/);
  assert.equal(s.calls().filter((f) => f.type === 'classify_read').length, 1);
});

t('two maps and two profiles never share a conversation handle', async () => {
  const rootA = shop();
  const rootB = shop();
  const a = await serve(rootA, { FLOORPLAN_PROFILE: 'profile-a' });
  const b = await serve(rootB, { FLOORPLAN_PROFILE: 'profile-b' });
  const c = await serve(rootA, { FLOORPLAN_PROFILE: 'profile-b' });

  const [first] = pick(await ask(a, 'What is this?'), 'answer');
  const followUp = pick(await ask(a, 'And then?', first.session), 'answer');
  assert.equal(followUp[0].session, first.session, 'the same map and profile keeps the thread');

  for (const [name, s] of [['another map', b], ['another profile', c]]) {
    const events = await ask(s, 'And then?', first.session);
    assert.equal(pick(events, 'failure')[0]?.code, 'session_expired', `${name} refuses the handle`);
    assert.equal(pick(events, 'answer').length, 0, `${name} answers nothing`);
  }
});

t('a rebuild resets follow-ups, and the page says so', async () => {
  const root = shop();
  const s = await serve(root);
  const [first] = pick(await ask(s, 'What is this?'), 'answer');
  run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
  // the handle must die with the build itself, not with the reload watcher's next tick
  const events = await ask(s, 'And then?', first.session);
  assert.equal(pick(events, 'failure')[0]?.code, 'session_expired');
});

t('Stop kills that request’s process group, and another request keeps running', async () => {
  const root = shop();
  const pidsFile = path.join(root, 'pids.json');
  const s = await serve(root, { FAKE_HERMES_PIDS: pidsFile });

  const a = open(s, 'HANG on this one');
  const started = await a.waitFor('start');
  assert.ok(started.id);
  let pids = null;
  for (let i = 0; i < 100 && !pids; i++) { try { pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 50)); } }
  assert.ok(pids?.main.pid && pids?.child.pid, 'the worker and its child are running');

  const b = await ask(s, 'What is this?');
  assert.ok(pick(b, 'answer').length, 'the other request answered while A hung');

  await a.cancel();
  assert.ok(await waitGone(pids, 5000), 'the whole group is gone within 5 s');
  assert.equal(pick(a.events, 'answer').length, 0);
});

t('a Stop with no id, or with an id this server never issued, stops nothing', async () => {
  const root = shop();
  const pidsFile = path.join(root, 'pids.json');
  const s = await serve(root, { FAKE_HERMES_PIDS: pidsFile });

  const a = open(s, 'HANG until a stop that names it');
  const started = await a.waitFor('start');
  let pids = null;
  for (let i = 0; i < 100 && !pids; i++) { try { pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 50)); } }
  assert.ok(pids?.main.pid, 'the worker is running');

  // the page sends {} for a Stop pressed before the start event, and can name a request that already ended
  const headers = { 'content-type': 'application/json', 'x-floorplan-token': s.token };
  for (const body of ['{}', JSON.stringify({ id: 'not-a-request' })]) {
    assert.equal((await fetch(s.base + '/api/cancel', { method: 'POST', headers, body })).status, 204, body);
  }
  // this worker ignores SIGTERM, so a stop that had reached it would have killed the group 2 s later
  await new Promise((r) => setTimeout(r, 3000));
  let alive = false;
  try { process.kill(pids.main.pid, 0); alive = true; } catch {}
  assert.ok(alive, 'a stop that named no running request killed another tab’s request');
  assert.equal(pick(a.events, 'answer').length, 0);
  assert.ok(started.id, 'the request kept its own id');
});

const shutdownDuring = async (question) => {
  const root = shop();
  const pidsFile = path.join(root, 'pids.json');
  const s = await serve(root, { FAKE_HERMES_PIDS: pidsFile });

  const a = open(s, question);
  await a.waitFor('start');
  let pids = null;
  for (let i = 0; i < 100 && !pids; i++) { try { pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 50)); } }
  assert.ok(pids?.main.pid && pids?.child.pid, 'the worker and its child are running');

  // `serve.mjs --stop` sends the server SIGTERM; Ctrl-C and a closed terminal deliver SIGINT/SIGHUP
  const exited = new Promise((r) => s.server.once('exit', r));
  const at = Date.now();
  s.server.kill('SIGTERM');
  assert.ok(await waitGone(pids, 5000), 'the worker and its child are gone within 5 s');
  await exited;
  assert.ok(Date.now() - at < 5000, 'the server exited within 5 s');
  assert.equal(pick(a.events, 'answer').length, 0);
};

t('a server SIGTERM stops the running Ask worker group within 5 s', () => shutdownDuring('HANG until the server stops'));

// a worker can die on SIGTERM while a descendant it started ignores it: the whole group must be waited on
t('a shutdown takes a TERM-ignoring descendant down after its worker exits', () => shutdownDuring('HANG2 with a stubborn child'));

// A request can arrive while the server is draining: admission must already be closed, so no worker is left behind.
t('an ask that arrives during the shutdown drain is refused and starts no worker', async () => {
  const root = shop();
  const pidsFile = path.join(root, 'pids.json');
  const s = await serve(root, { FAKE_HERMES_PIDS: pidsFile });
  const readPids = () => { try { return JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { return null; } };

  const a = open(s, 'HANG until the server stops');
  await a.waitFor('start');
  let aPids = null;
  for (let i = 0; i < 100 && !aPids; i++) { aPids = readPids(); if (!aPids) await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(aPids?.main.pid && aPids?.child.pid, 'the worker and its child are running');

  const exited = new Promise((r) => s.server.once('exit', r));
  const at = Date.now();
  s.server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  // a second tab asks during the drain: the listener is closed or the guard answers 503, never an admitted request
  let refused = false;
  try {
    const r = await fetch(s.base + '/api/ask', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': s.token },
      body: JSON.stringify({ question: 'HANG on the second tab' }),
    });
    refused = r.status === 503;
    await r.body?.cancel();
  } catch { refused = true; }
  assert.ok(refused, 'an ask during the drain is refused');

  await exited;
  assert.ok(Date.now() - at < 5000, 'the server exited within 5 s');
  assert.deepEqual(readPids(), aPids, 'the refused ask started no worker');
  assert.ok(await waitGone(aPids, 5000), 'the pre-signal worker group is gone within 5 s');
  assert.equal(pick(a.events, 'answer').length, 0);
});

t('a server started without --profile answers with the profile the probe reports', async () => {
  const root = shop();
  const s = await serve(root, { FLOORPLAN_PROFILE: '' });
  assert.equal(s.page.engine, 'hermes');
  assert.equal(s.page.profile, 'default-profile');

  const events = await ask(s, 'What is this?');
  assert.ok(pick(events, 'answer').length, 'the documented no-flag start answers');
  assert.equal(pick(events, 'failure').length, 0);
  assert.equal(pick(events, 'answer')[0].profile, 'default-profile');
});

t('a crashed worker fails with a fixed message, never its stderr', async () => {
  const root = shop();
  const s = await serve(root);
  const events = await ask(s, 'CRASH on this one');
  const [failure] = pick(events, 'failure');
  assert.equal(failure?.code, 'cli_error');
  assert.equal(failure?.message, 'The ask worker stopped before answering.');
  assert.ok(!JSON.stringify(events).includes('/opt/hermes-install'), 'the traceback stayed in the server log');
  assert.equal(pick(events, 'answer').length, 0);
});

t('a result that arrives after Stop never renders', async () => {
  const root = shop();
  const s = await serve(root);
  const a = open(s, 'SLOW answer, then a late result');
  await a.waitFor('start');
  await a.cancel();
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(pick(a.events, 'answer').length, 0);
  assert.equal(pick(a.events, 'failure').length, 0, 'no failure either: the tab stopped');
});

t('each failure code reaches the page as a typed failure with no answer', async () => {
  const root = shop();
  const s = await serve(root);
  for (const code of ['rate_limited', 'not_logged_in', 'model_override_denied', 'profile_mismatch', 'cli_error']) {
    const events = await ask(s, `FAIL:${code} please`);
    assert.equal(pick(events, 'failure')[0]?.code, code, code);
    assert.equal(pick(events, 'answer').length, 0, code);
  }
});

t('Hermes missing is cli_missing, never Claude or Codex', async () => {
  const root = shop();
  const s = await serve(root, { FLOORPLAN_HERMES: path.join(root, 'no-such-hermes'), FLOORPLAN_CLAUDE: FAKE_CLAUDE, FLOORPLAN_CODEX: path.join(root, 'no-such-codex') });
  assert.equal(s.page.cli, false);
  assert.equal(s.page.engine, null);
  assert.equal(s.page.want, 'hermes');
  const events = await ask(s, 'Anything?');
  assert.equal(pick(events, 'failure')[0]?.code, 'cli_missing');
  assert.equal(pick(events, 'answer').length, 0);
});

t('the page has copy for every typed failure code', () => {
  const viewer = fs.readFileSync(path.join(SKILL, 'assets', 'viewer.html'), 'utf8');
  const block = /const FAILURE_COPY = \{([\s\S]*?)\n\};/.exec(viewer)[1];
  const codes = [...block.matchAll(/^[ ]{2}([a-z_]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(codes, [...FAILURE_CODES].sort());
});

// --- a stored conversation belongs to the build that accepted it ---
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail(`no ${what} within ${ms / 1000} s`);
};
const startFrame = (s, prefix) => s.calls().filter((f) => f.type === 'start' && String(f.question || '').startsWith(prefix)).pop() || null;
const reloaded = async (s, mark, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (s.output().slice(mark).includes('map rebuilt: reloaded open tabs')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`no reload within ${ms / 1000} s after the build; server output: ${s.output().slice(mark)}`);
};
const noWorker = (s, before) => s.calls().slice(before).filter((f) => f.type === 'start').length;

t('a rebuild never re-binds a follow-up answered after it', async () => {
  const root = shop();
  const s = await serve(root);
  const [first] = pick(await ask(s, 'What is this?'), 'answer');
  const [same] = pick(await ask(s, 'And then?', first.session), 'answer');
  assert.equal(same?.session, first.session, 'on one build the handle keeps its thread');

  const held = open(s, 'HOLD until released', first.session);
  await held.waitFor('start');
  const accepted = await until(() => startFrame(s, 'HOLD until released'), 15000, 'the held follow-up reached the worker');
  const mark = s.output().length;
  run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
  await reloaded(s, mark);
  fs.writeFileSync(path.join(root, 'release'), '1');
  const [late] = pick(await held.done, 'answer');
  assert.equal(late?.session, first.session, 'the in-flight answer was delivered');

  const [fresh] = pick(await ask(s, 'A fresh question after the build'), 'answer');
  const built = startFrame(s, 'A fresh question after the build');
  assert.ok(fresh && built, 'a fresh request is answered on the new build');
  assert.notEqual(built.graph_digest, accepted.graph_digest, 'the rebuild changed the graph digest');

  const before = s.calls().length;
  const events = await ask(s, 'And after the rebuild?', first.session);
  assert.equal(pick(events, 'failure')[0]?.code, 'session_expired');
  assert.equal(pick(events, 'answer').length, 0);
  assert.equal(noWorker(s, before), 0, 'the expired handle started no worker');
});

t('a first question answered after a rebuild mints no handle for the new map', async () => {
  const root = shop();
  const s = await serve(root);
  const held = open(s, 'HOLD first question');
  await held.waitFor('start');
  const accepted = await until(() => startFrame(s, 'HOLD first question'), 15000, 'the held first question reached the worker');
  const mark = s.output().length;
  run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
  await reloaded(s, mark);
  fs.writeFileSync(path.join(root, 'release'), '1');
  const [answer] = pick(await held.done, 'answer');
  assert.match(answer?.session || '', /^[0-9a-f]{16}$/, 'the answer minted a handle');

  const [fresh] = pick(await ask(s, 'A fresh question after the build'), 'answer');
  const built = startFrame(s, 'A fresh question after the build');
  assert.ok(fresh && built, 'a fresh request is answered on the new build');
  assert.notEqual(built.graph_digest, accepted.graph_digest, 'the rebuild changed the graph digest');

  const before = s.calls().length;
  const events = await ask(s, 'And after the rebuild?', answer.session);
  assert.equal(pick(events, 'failure')[0]?.code, 'session_expired');
  assert.equal(pick(events, 'answer').length, 0);
  assert.equal(noWorker(s, before), 0, 'the minted handle started no worker');
});

t('a follow-up answered before a rebuild still expires after it', async () => {
  const root = shop();
  const s = await serve(root);
  const [first] = pick(await ask(s, 'What is this?'), 'answer');
  const held = open(s, 'HOLD until released', first.session);
  await held.waitFor('start');
  await until(() => startFrame(s, 'HOLD until released'), 15000, 'the held follow-up reached the worker');
  fs.writeFileSync(path.join(root, 'release'), '1');
  const [answer] = pick(await held.done, 'answer');
  assert.equal(answer?.session, first.session, 'the follow-up was answered before the build');
  const mark = s.output().length;
  run('build.mjs', root, '--no-claude-md', '--agent', 'hermes');
  await reloaded(s, mark);
  const before = s.calls().length;
  const events = await ask(s, 'And after the rebuild?', first.session);
  assert.equal(pick(events, 'failure')[0]?.code, 'session_expired');
  assert.equal(pick(events, 'answer').length, 0);
  assert.equal(noWorker(s, before), 0);
});
