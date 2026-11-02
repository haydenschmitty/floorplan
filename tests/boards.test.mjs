// Kept boards: answer boards saved from the map's Ask bar. The server half stores them in floorplan/boards.json
// through /api/boards, behind the same token as every other /api route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shopApp, run, cleanup, scanAndBuild, readGraph, writeJson } from './helpers.mjs';

let root, server, base, token;
const boardsFile = () => path.join(root, 'floorplan', 'boards.json');
const onDisk = () => JSON.parse(fs.readFileSync(boardsFile(), 'utf8')).boards;
const call = (method, body, tok = token, raw) => fetch(base + '/api/boards', {
  method, headers: { 'Content-Type': 'application/json', ...(tok ? { 'x-floorplan-token': tok } : {}) },
  body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
});
const sample = (over = {}) => ({
  id: 'how-refunds-work', title: 'How refunds work', question: 'How do refunds work?', answer: 'The site asks, the server refunds.',
  items: [{ ref: 'shop-api/routes/orders.js', note: 'Refund endpoint.' }, { ref: 'web', note: '' }], steps: [], ...over,
});

before(async () => {
  root = shopApp();
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_NO_PROMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  token = /"token":"([0-9a-f]+)"/.exec(await (await fetch(base + '/')).text())[1];
});
after(async () => {
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  cleanup(root);
});

test('the map keeps a board, replaces it by id, and deletes it', async () => {
  let r = await call('POST', { board: sample() });
  assert.equal(r.status, 200);
  const first = (await r.json()).boards;
  assert.equal(first.length, 1);
  assert.equal(first[0].items.length, 2);
  assert.ok(first[0].createdAt && first[0].updatedAt);
  assert.deepEqual(onDisk(), first);
  assert.deepEqual((await (await call('GET')).json()).boards, first);

  r = await call('POST', { board: sample({ title: 'Refunds, revised' }) });
  const second = (await r.json()).boards;
  assert.equal(second.length, 1);
  assert.equal(second[0].title, 'Refunds, revised');
  assert.equal(second[0].createdAt, first[0].createdAt);
  assert.deepEqual(onDisk(), second);

  r = await call('DELETE', { id: 'how-refunds-work' });
  assert.deepEqual((await r.json()).boards, []);
  assert.deepEqual(onDisk(), []);
});

test("boards need the map page's token", async () => {
  assert.equal((await call('POST', { board: sample() }, null)).status, 403);
  assert.equal((await call('POST', { board: sample() }, 'wrong')).status, 403);
  assert.equal((await call('GET', undefined, 'wrong')).status, 403);
});

test('a bad board changes nothing', async () => {
  await call('POST', { board: sample() });
  const before = fs.readFileSync(boardsFile(), 'utf8');
  for (const r of [
    await call('POST', undefined, token, '{ not json'),
    await call('POST', { board: sample({ id: undefined }) }),
    await call('POST', { board: sample({ id: '../x' }) }),
    await call('POST', { board: sample({ items: 'nope' }) }),
  ]) assert.equal(r.status, 400);
  assert.equal(fs.readFileSync(boardsFile(), 'utf8'), before);
  await call('DELETE', { id: 'how-refunds-work' });
});

test("a board's text is trimmed to size, kept as written", async () => {
  const r = await call('POST', { board: sample({ id: 'long', answer: 'a'.repeat(20000), title: '</script><b>x' }) });
  const [b] = (await r.json()).boards;
  assert.equal(b.answer.length, 8000);
  assert.equal(b.title, '</script><b>x');
  await call('DELETE', { id: 'long' });
});

// ---- build half: boards.json is folded into graph.json ----
const buildBoards = (boards) => {
  const r = shopApp();
  scanAndBuild(r);
  if (boards) writeJson(path.join(r, 'floorplan', 'boards.json'), { boards });
  const out = run('build.mjs', r, '--no-claude-md');
  return { r, out: String(out?.stdout ?? out ?? ''), graph: readGraph(r) };
};
const board = (over = {}) => ({ id: 'b1', title: 'T', question: 'Q?', answer: 'A.', items: [], steps: [], createdAt: 1, updatedAt: 1, ...over });

test('kept boards are built into the map with live refs', () => {
  const refund = 'POST /api/orders/:id/refund';
  const { r, graph } = buildBoards([board({ items: [
    { ref: 'f:shop-api/routes/orders.js', note: 'a' }, { ref: 'n:api', note: 'b' }, { ref: `route:${refund}`, note: 'c' }] })]);
  try {
    const i = graph.routes.findIndex((x) => `${x.m} ${x.p}` === refund);
    assert.ok(i >= 0);
    assert.deepEqual(graph.boards[0].items.map((x) => x.ref), ['f:shop-api/routes/orders.js', 'n:api', `r:${i}`]);
    assert.equal(graph.boards[0].items[2].note, 'c');
    assert.deepEqual(Object.keys(graph.boards[0]).sort(), ['answer', 'id', 'items', 'question', 'steps', 'title']);
  } finally { cleanup(r); }
});

test('cards for code that is gone are dropped with a warning, and an empty board is dropped', () => {
  const { r, out, graph } = buildBoards([
    board({ id: 'a', items: [{ ref: 'f:shop-api/routes/orders.js', note: '' }, { ref: 'f:gone.js', note: '' }] }),
    board({ id: 'b', items: [{ ref: 'f:gone.js', note: '' }] }),
  ]);
  try {
    assert.equal(graph.boards.length, 1);
    assert.equal(graph.boards[0].items.length, 1);
    assert.match(out, /point at code that no longer exists/);
  } finally { cleanup(r); }
});

test('a map with no kept boards has an empty list', () => {
  const { r, graph } = buildBoards(null);
  try { assert.deepEqual(graph.boards, []); } finally { cleanup(r); }
});
