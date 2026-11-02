// Kept boards: answer boards saved from the map's Ask bar. The server half stores them in floorplan/boards.json
// through /api/boards, behind the same token as every other /api route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
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

// ---- page half: keeping, updating, opening and linking boards in the map ----
// These run the page's own functions (cut out of the built index.html) against stand-ins for the browser.
const page = () => fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
/** The source of one top-level function of the built page. */
function pageFn(name) {
  const html = page(), at = html.indexOf(`function ${name}(`);
  assert.ok(at > 0, `the page has ${name}`);
  return html.slice(at, html.indexOf('\n}\n', at) + 2);
}
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const answer = { title: 'How refunds work', question: 'How?', answer: 'Like so.', items: [{ id: 'n:web', note: '' }], steps: [], followups: [] };

/** The answer sheet's body for an answer, with the board it was asked from (if any), in a copy or not. */
function sheetBody({ fromBoard = null, exported = false, a = answer } = {}) {
  let body = '';
  const ctx = {
    sheetShell: (q, b) => { body = b; }, md: (s) => `<p>${h(s)}</p>`, h, iconI: () => '',
    askState: { fromBoard }, EXPORTED: exported ? { at: 0 } : null,
    keptBoard: (id) => (id === 'refunds' ? { id, title: 'Refunds <old>' } : undefined),
    sheet: { querySelector: () => null }, keepAnswer() {}, keepBoard: async () => 'x', go() {}, toast() {},
  };
  vm.runInNewContext(`${pageFn('renderAnswer')}; renderAnswer(a);`, { ...ctx, a });
  return body;
}

test('an answer can be kept, and a question asked on a kept board can update it', () => {
  const plain = sheetBody();
  assert.match(plain, /Keep this board/);
  assert.doesNotMatch(plain, /Update “/);
  const onBoard = sheetBody({ fromBoard: 'refunds' });
  assert.match(onBoard, /Update “Refunds &lt;old&gt;”/);
  assert.match(onBoard, /Keep as new board/);
  for (const b of [sheetBody({ exported: true }), sheetBody({ exported: true, fromBoard: 'refunds' })]) assert.doesNotMatch(b, /Keep|Update “/);
  assert.doesNotMatch(sheetBody({ a: { ...answer, items: [] } }), /Keep/); // nothing to put on a board
  assert.doesNotMatch(sheetBody({ fromBoard: 'refunds', a: { ...answer, keptAs: 'refunds' } }), /Keep|Update “/); // just saved
});

test('boardId makes unique, readable ids', () => {
  const boardId = vm.runInNewContext(`${pageFn('boardId')}; boardId`);
  assert.equal(boardId('Run lifecycle', new Set()), 'run-lifecycle');
  assert.equal(boardId('Run lifecycle', new Set(['run-lifecycle'])), 'run-lifecycle-2');
  assert.equal(boardId('Run lifecycle', new Set(['run-lifecycle', 'run-lifecycle-2'])), 'run-lifecycle-3');
  assert.equal(boardId('</script>', new Set()), 'board');
  assert.equal(boardId('', new Set(['board'])), 'board-2');
  const long = boardId('x'.repeat(80) + ' tail', new Set());
  assert.ok(long.length <= 60 && /^[a-z0-9][a-z0-9-]*$/.test(long));
});

test('#b= opens a kept board, and an unknown board opens the overview', () => {
  const readHash = (hash) => vm.runInNewContext(`${pageFn('readHash')}; readHash()`, {
    location: { hash }, URLSearchParams, parentOf: new Map([['n:web', 'root']]), G: { boards: [{ id: 'flow-a' }] },
  });
  assert.deepEqual({ ...readHash('#b=flow-a') }, { v: 'b:flow-a', s: null });
  assert.equal(readHash('#b=missing').v, 'root');
  assert.equal(readHash('#v=n:web').v, 'n:web'); // the old links still work
});

/** The Flows menu, drawn with these boards, in a copy or not. */
function flowMenu({ boards, exported = false }) {
  const fm = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  vm.runInNewContext(`${pageFn('renderFlowMenu')}; renderFlowMenu();`, { fm, h, iconI: () => '', EXPORTED: exported ? { at: 0 } : null, G: { flows: [], boards } });
  return fm.innerHTML;
}

test('kept boards are listed under Saved boards and can be deleted, except in a copy', () => {
  const boards = [{ id: 'refunds', title: '<b>Refunds</b>', question: 'Q', answer: 'A', items: [{ ref: 'n:web', note: '' }], steps: [] }];
  const menu = flowMenu({ boards });
  assert.match(menu, /Saved boards/);
  assert.match(menu, /data-board="refunds"/);
  assert.match(menu, /&lt;b&gt;Refunds&lt;\/b&gt;/);
  assert.match(menu, /data-delboard="refunds"/);
  const copy = flowMenu({ boards, exported: true });
  assert.match(copy, /Saved boards/);
  assert.match(copy, /data-board="refunds"/);
  assert.doesNotMatch(copy, /data-delboard/);
  assert.doesNotMatch(flowMenu({ boards: [] }), /Saved boards/);
});

test('opening a kept board updates the address in place inside a docs page', () => {
  const calls = [];
  const setHash = (embed, container) => vm.runInNewContext(`${pageFn('setHash')}; setHash(c)`, {
    c: container, EMBED: embed, URLSearchParams, location: { hash: '', pathname: '/', search: '' },
    history: { replaceState: (...a) => calls.push(['replace', a[2]]), pushState: (...a) => calls.push(['push', a[2]]) },
  });
  setHash(true, 'b:flow-a');
  setHash(false, 'b:flow-a');
  setHash(false, 'q:answer'); // the answer you just got is not linkable
  assert.deepEqual(calls, [['replace', '#b=flow-a'], ['push', '#b=flow-a']]);
});

/** The page's board-saving code, run with a pretend browser, server (or none) and the map's refs. */
function boardCode({ server = null, built = [], saved = {} } = {}) {
  const html = page(), at = html.indexOf('const BOARDS_KEY');
  const end = html.indexOf('\n}\n', html.indexOf('async function loadKeptBoards(')) + 2;
  const local = new Map(Object.entries(saved)), sent = [], went = [];
  const routes = { 'r:3': 'route:POST /refund' };
  const ctx = {
    G: { project: { name: 'shop' }, boards: built.map((b) => ({ ...b })) },
    window: server ? { FLOORPLAN_SERVER: { token: 't' } } : {},
    store: { get: (k, d) => local.get(k) ?? d, set: (k, v) => local.set(k, v) },
    stableRef: (id) => routes[id] || id, liveRef: (ref) => Object.keys(routes).find((k) => routes[k] === ref) || (ref === 'f:gone.js' ? null : ref),
    fetch: async (url, { method, body }) => { body = body && JSON.parse(body); sent.push({ method, body, url }); return { json: async () => server(method, body) }; },
    renderFlowMenu() {}, keptBoard: (id) => ctx.G.boards.find((b) => b.id === id),
    askState: { fromBoard: null }, state: { container: 'root' }, go: (c) => went.push(c),
  };
  vm.runInNewContext(html.slice(at, end) + '; Object.assign(this, { keepBoard, deleteBoard, loadKeptBoards, addBoard, keptLocally: () => keptLocally });', ctx);
  return { ctx, local, sent, went };
}
const plain = (x) => JSON.parse(JSON.stringify(x)); // values made inside vm have another realm's prototypes
const refundAnswer = { title: 'How refunds work', question: 'How?', answer: 'Like so.', items: [{ id: 'r:3', note: 'here' }, { id: 'n:web', note: '' }], steps: [{ id: 'r:3', note: 'here' }] };

test('without the map server, a kept board is saved in this browser with stable refs, and comes back as kept', async () => {
  const { ctx, local } = boardCode();
  assert.equal(await ctx.keepBoard(refundAnswer), 'how-refunds-work');
  const [stored] = local.get('boards:shop');
  assert.deepEqual(plain(stored.items), [{ ref: 'route:POST /refund', note: 'here' }, { ref: 'n:web', note: '' }]);
  assert.equal(ctx.G.boards[0].items[0].ref, 'r:3'); // the page keeps live refs
  assert.equal(ctx.G.boards[0].kept, true);
  assert.equal(await ctx.keepBoard(refundAnswer), 'how-refunds-work-2'); // Keep as new board
  assert.equal(await ctx.keepBoard({ ...refundAnswer, title: 'Other', answer: 'Changed.' }, { replaceId: 'how-refunds-work' }), 'how-refunds-work');
  assert.equal(ctx.G.boards.length, 2);
  assert.equal(ctx.G.boards[0].title, 'How refunds work'); // Update keeps the name
  assert.equal(ctx.G.boards[0].answer, 'Changed.');

  const again = boardCode({ saved: { 'boards:shop': local.get('boards:shop') } });
  await again.ctx.loadKeptBoards();
  assert.deepEqual(plain(again.ctx.G.boards.map((b) => [b.id, b.kept, b.items[0].ref])), [['how-refunds-work', true, 'r:3'], ['how-refunds-work-2', true, 'r:3']]);

  await ctx.deleteBoard('how-refunds-work');
  assert.deepEqual(plain(ctx.G.boards.map((b) => b.id)), ['how-refunds-work-2']);
  assert.deepEqual(plain(local.get('boards:shop').map((b) => b.id)), ['how-refunds-work-2']);
});

test('with the map server, boards go through /api/boards, and its list wins over the built one', async () => {
  let onServer = [];
  const server = (method, body) => {
    if (method === 'POST') onServer = [...onServer.filter((b) => b.id !== body.board.id), body.board];
    if (method === 'DELETE') onServer = onServer.filter((b) => b.id !== body.id);
    return { boards: onServer };
  };
  const { ctx, local, sent, went } = boardCode({ server });
  await ctx.keepBoard(refundAnswer);
  assert.equal(sent[0].url, '/api/boards');
  assert.equal(onServer[0].items[0].ref, 'route:POST /refund');
  assert.equal(local.size, 0); // not in the browser too
  ctx.state.container = 'b:how-refunds-work';
  await ctx.deleteBoard('how-refunds-work');
  assert.deepEqual(plain(onServer), []);
  assert.deepEqual(plain(went), ['root']); // the board you were on is gone

  // after a rebuild: one built board was deleted since, one updated since, one unchanged
  const unchanged = { id: 'same', title: 'Same', question: '', answer: 'A', items: [{ ref: 'n:web', note: '' }], steps: [] };
  onServer = [{ ...unchanged }, { ...unchanged, id: 'upd', answer: 'New', items: [{ ref: 'route:POST /refund', note: '' }, { ref: 'f:gone.js', note: '' }] }];
  const later = boardCode({ server, built: [unchanged, { ...unchanged, id: 'upd' }, { ...unchanged, id: 'deleted' }] });
  await later.ctx.loadKeptBoards();
  assert.deepEqual(plain(later.ctx.G.boards.map((b) => [b.id, !!b.kept])), [['same', false], ['upd', true]]);
  assert.deepEqual(plain(later.ctx.G.boards[1].items), [{ ref: 'r:3', note: '' }]); // live refs, cards for gone code dropped
});

test('a failed save to the map server keeps the board in this browser, and says so', async () => {
  const { ctx, local } = boardCode({ server: () => { throw new Error('down'); } });
  assert.equal(await ctx.keepBoard(refundAnswer), 'how-refunds-work');
  assert.equal(local.get('boards:shop').length, 1);
  assert.equal(ctx.keptLocally(), true);
  assert.match(pageFn('keepAnswer'), /toast\(keptLocally \? 'Saved in this browser only' :/);
  const fine = boardCode({ server: () => ({ boards: [] }) });
  await fine.ctx.keepBoard(refundAnswer);
  assert.equal(fine.ctx.keptLocally(), false);
});

// ---- a #b= link to a board deleted since the last build, on a served map ----
const gone = { id: 'gone', title: 'Gone', question: '', answer: '', items: [{ ref: 'n:web', note: '' }], steps: [] };
/** The page's board helpers (isBoard, keptBoard, boardOf...), as one piece of source. */
function boardHelpers() {
  const html = page(), at = html.indexOf('const isBoard = ');
  return html.slice(at, html.indexOf('\n', html.indexOf('const boardOf = ', at)) + 1);
}

test('the first render re-reads the address once boards are in, so a board deleted since the build opens the overview', async () => {
  const html = page(), at = html.indexOf('const init = readHash();');
  const boot = html.slice(at, html.indexOf('\n});\n', html.indexOf('Promise.all([fontsReady, boardsLoaded])', at)) + 5);
  const G = { boards: [{ ...gone }] };
  const rendered = [];
  let drop;
  const ctx = {
    G, location: { hash: '#b=gone' }, URLSearchParams, parentOf: new Map(), state: { container: 'root', selected: null },
    isPhone: () => false, document: {}, $: () => ({ setAttribute() {} }), setTimeout, PLAN: false, window: {},
    boardsLoaded: new Promise((ok) => { drop = () => { G.boards = []; ok(); }; }), // loadKeptBoards: not on the server any more
    render: () => rendered.push(ctx.state.container), renderPanel() {}, emit() {},
  };
  vm.runInNewContext(`${pageFn('readHash')}\n${boot}`, ctx);
  assert.equal(ctx.state.container, 'b:gone'); // still in the built list when the address is first read
  drop();
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(rendered, ['root']);
});

test('a board that is gone can never be drawn: render opens the overview instead of throwing', async () => {
  const drawn = [];
  const ctx = {
    G: { boards: [] }, state: { container: 'b:gone', answer: null }, renderToken: 0, console: { error() {} },
    buildView: (c) => { drawn.push(c); return {}; }, layout: async () => { throw new Error('stop here'); },
    setTimeout, clearTimeout, $: () => ({ classList: { add() {}, remove() {} } }),
  };
  vm.runInNewContext(`${boardHelpers()}\nasync ${pageFn('render')}\nthis.render = render;`, ctx);
  await ctx.render();
  ctx.state.container = 'q:answer'; // and the answer board with no answer
  await ctx.render();
  assert.deepEqual(drawn, ['root', 'root']);
});

test('a board on screen that loading finds deleted sends you to the overview', async () => {
  const { ctx, went } = boardCode({ server: () => ({ boards: [] }), built: [gone] });
  ctx.state.container = 'b:gone'; ctx.state.layout = {}; // already drawn: loading lost the 1.5 s race
  await ctx.loadKeptBoards();
  assert.deepEqual(plain(went), ['root']);
  const early = boardCode({ server: () => ({ boards: [] }), built: [gone] });
  early.ctx.state.container = 'b:gone'; // not drawn yet: the boot reads the address again instead
  await early.ctx.loadKeptBoards();
  assert.deepEqual(plain(early.went), []);
});
