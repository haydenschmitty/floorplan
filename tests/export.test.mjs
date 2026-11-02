// Exporting a copy of the map to share: serve.mjs --export and the map's Export button (POST /api/export)
// write the same self-contained page, marked as exported, without this computer's details or the server's
// token, and with only the extras asked for. Health and recent work are left out unless asked for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { shopApp, run, readJson, writeJson, cleanup, FAKE_PASSWORD } from './helpers.mjs';

const TOKEN_IN_REMOTE = 'ghp-not-a-real-token-1234';
let root, server, base, token;
const serveJs = () => path.join(root, 'floorplan', 'serve.mjs');
/** The graph inside an exported page. */
const dataOf = (html) => JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(html)[1]);
/** Runs serve.mjs --export with these arguments; returns the exported page and what it printed. */
function exportCli(...args) {
  const out = execFileSync(process.execPath, [serveJs(), '--export', ...args], { cwd: root, encoding: 'utf8' });
  const file = /Exported the map to (.+)/.exec(out)[1].trim();
  return { out, html: fs.readFileSync(file, 'utf8'), file };
}

before(async () => {
  root = shopApp();
  execFileSync('git', ['-C', path.join(root, 'shop-api'), 'remote', 'add', 'origin', `https://someone:${TOKEN_IN_REMOTE}@example.com/shop-api.git`]);
  const arch = readJson(path.join(root, 'floorplan', 'architecture.json'));
  writeJson(path.join(root, 'floorplan', 'architecture.json'), {
    ...arch,
    nodes: [...arch.nodes, { id: 'api.orders', parent: 'api', label: 'Orders', kind: 'feature', paths: ['shop-api/routes/orders.js'] }], // a part nested inside another
    annotations: [{ path: 'shop-api/config.js', note: 'Moving to the secrets manager next sprint.' }],
    flows: [{ id: 'refund', title: 'Refund', description: 'A customer asks for a refund.', steps: [{ node: 'web', note: 'The website asks.' }, { node: 'api', note: 'The server refunds.' }] }],
  });
  writeJson(path.join(root, 'floorplan', 'boards.json'), { boards: [{ id: 'refund-view', title: 'Refund view', question: 'How do refunds work?', answer: 'Through the API.', items: [{ ref: 'f:shop-api/routes/orders.js', note: 'The route.' }], steps: [], createdAt: 'x', updatedAt: 'x' }] });
  writeJson(path.join(root, 'floorplan', 'recent-work.json'), { tasks: [{ title: 'Refunds', summary: 'Added refunds.', items: [{ ref: 'shop-api/routes/orders.js', change: 'changed', note: 'Refund endpoint.' }] }] });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');

  const port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, [serveJs(), '--port', String(port), '--no-open'], {
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

test('the map has health, recent work, a note, a flow and a remote to leave out', () => {
  const g = dataOf(fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'));
  assert.ok(g.health.issues.length > 0);
  assert.equal(g.recent.items.length, 1);
  assert.ok(g.files.some((f) => f.note));
  assert.equal(g.flows.length, 1);
  assert.ok(g.meta.root);
});

test('by default the export keeps flows, kept boards and notes, and leaves out health, recent work and this computer', () => {
  const { html, file, out } = exportCli();
  assert.equal(path.basename(file), 'shop-map.html');
  assert.equal(path.dirname(file), path.join(fs.realpathSync(root), 'floorplan'));
  const g = dataOf(html);
  assert.match(g.meta.exported.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(g.meta.exported.include, ['flows', 'boards', 'notes']);
  assert.equal(g.health, undefined);
  assert.equal(g.recent, undefined);
  assert.equal(g.flows.length, 1);
  assert.ok(g.files.some((f) => f.note));
  assert.equal(g.meta.root, null);
  assert.ok(g.meta.repos.every((r) => !('remote' in r)));
  assert.ok(!html.includes(TOKEN_IN_REMOTE), 'no sign-in token from a git remote');
  const here = readJson(path.join(root, 'floorplan', 'graph.json')).meta.root;
  assert.ok(here && !html.includes(here), 'no folder path from this computer');
  assert.ok(!html.includes('FLOORPLAN_SERVER='), 'no server details');
  assert.match(out, /no Ask bar/);
  assert.doesNotMatch(out, /Share it only with people you trust/);
});

test('health and recent work go in only when asked for, with a warning about health', () => {
  const { html, out } = exportCli(path.join(root, 'all.html'), '--include', 'flows,notes,recent,health');
  const g = dataOf(html);
  assert.deepEqual(g.meta.exported.include, ['flows', 'notes', 'recent', 'health']);
  assert.ok(g.health.issues.length > 0);
  assert.equal(g.recent.items.length, 1);
  assert.match(out, /Share it only with people you trust/);
  // where a secret sits, never the secret itself
  assert.ok(!html.includes(FAKE_PASSWORD));
});

test('flows, the tour and notes can be left out too', () => {
  const { html } = exportCli(path.join(root, 'bare.html'), '--include', 'none');
  const g = dataOf(html);
  assert.deepEqual(g.meta.exported.include, []);
  assert.deepEqual(g.flows, []);
  assert.deepEqual(g.tour, []);
  assert.ok(g.files.every((f) => !('note' in f)));
});

test('the exported page is still the whole map, ready to open', () => {
  const { html } = exportCli(path.join(root, 'page.html'));
  const g = dataOf(html);
  const built = readJson(path.join(root, 'floorplan', 'graph.json'));
  assert.equal(g.files.length, built.files.length);
  assert.equal(g.routes.length, built.routes.length);
  assert.equal(g.links.length, built.links.length);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /ui\/60-export\.js/);
});

const api = (body, headers = {}) => fetch(base + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the Export button needs the map page’s token', async () => {
  assert.equal((await api({ include: ['flows'] })).status, 403);
  assert.equal((await api({ include: ['flows'] }, { 'x-floorplan-token': 'wrong' })).status, 403);
});

test('the Export button downloads the copy, with flows requested since the last build', async () => {
  const extra = { id: 'custom-1', title: 'Admin deletes a user', description: '', steps: [{ ref: 'web', note: 'First.' }, { ref: 'api', note: 'Then.' }] };
  const r = await api({ include: ['flows', 'health'], flows: [extra, { id: 'bad', steps: 'nope' }] }, { 'x-floorplan-token': token });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="shop-map.html"');
  const g = dataOf(await r.text());
  assert.deepEqual(g.meta.exported.include, ['flows', 'health']);
  assert.deepEqual(g.flows.map((f) => f.id), ['refund', 'custom-1']);
  assert.equal(g.flows[1].custom, true);
  assert.ok(g.files.every((f) => !('note' in f)), 'notes weren’t ticked');
  assert.equal(g.recent, undefined);
  assert.ok(g.health);
});

test('the Export button can make a docs copy that opens on one part and shows the description', async () => {
  const r = await api({ include: ['flows'], embed: true, startView: 'n:api', showDescription: true }, { 'x-floorplan-token': token });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /^<!doctype html>\s*<html data-embed lang="en">/i);
  const g = dataOf(html);
  assert.equal(g.meta.exported.embed, true);
  assert.equal(g.meta.exported.startView, 'n:api');
  assert.equal(g.meta.exported.showDescription, true);
});

test('a docs copy starts on the overview with the description hidden unless told otherwise', async () => {
  const g = dataOf(await (await api({ include: ['flows'], embed: true }, { 'x-floorplan-token': token })).text());
  assert.equal(g.meta.exported.startView, 'root');
  assert.equal(g.meta.exported.showDescription, false);
});

test('a docs copy only opens on a part that exists, nested ones included', async () => {
  const nested = readJson(path.join(root, 'floorplan', 'graph.json')).nodes.find((n) => n.id === 'api.orders');
  assert.equal(nested?.parent, 'api', 'the fixture has a part nested inside another');
  const r = await api({ embed: true, startView: 'n:api.orders' }, { 'x-floorplan-token': token });
  assert.equal(r.status, 200);
  assert.equal(dataOf(await r.text()).meta.exported.startView, 'n:api.orders');
  for (const bad of [{ startView: 'n:nope' }, { startView: 'f:web/app.js' }, { startView: 'api' }, { startView: 7 }, { showDescription: 'yes' }, { showDescription: 1 }]) {
    const r = await api({ embed: true, ...bad }, { 'x-floorplan-token': token });
    assert.equal(r.status, 400, JSON.stringify(bad));
    const { error } = await r.json();
    assert.match(error, /^[A-Z].*[.]$/);
    assert.doesNotMatch(error, /undefined|\bat \w+\.mjs/);
  }
});

test('the docs-copy settings are ignored without embed, and an ordinary export is unchanged', async () => {
  const r = await api({ include: ['flows'], startView: 'n:api', showDescription: true }, { 'x-floorplan-token': token });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.doesNotMatch(html, /^<!doctype html>\s*<html data-embed/i);
  const g = dataOf(html);
  assert.equal(g.meta.exported.embed, undefined);
  assert.equal(g.meta.exported.startView, undefined);
  assert.equal(g.meta.exported.showDescription, undefined);
  assert.equal((await api({ startView: 'n:nope', showDescription: 'x' }, { 'x-floorplan-token': token })).status, 200);
});

// ---- the Export dialog (assets/ui/60-export.js) run against a pretend page ----
const EXPORT_UI = fs.readFileSync(new URL('../skills/floorplan/assets/ui/60-export.js', import.meta.url), 'utf8');
const escapeHtml = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Loads the dialog script into a pretend page showing this graph; returns what it did. */
function pretendPage(graph) {
  const sent = [];
  const modals = [];
  const buttons = [];
  const toasts = [];
  const win = { FLOORPLAN_SERVER: { token: 'tok' } };
  win.Floorplan = {
    graph, h: escapeHtml, children: (id) => (graph.nodes.some((n) => 'n:' + n.id === id && n.kind === 'external') ? [] : [...graph.nodes.filter((n) => n.parent && 'n:' + n.parent === id).map((n) => 'n:' + n.id), ...(id === 'n:empty' ? [] : ['f:x'])]), icons: {}, copy() {}, toast: (t) => toasts.push(t),
    addHeaderButton: (b) => buttons.push(b),
    modal(opts) {
      // the controls the script looks up, found in the html it gave the dialog
      const stub = (checked) => ({ checked, hidden: false, value: 'root', listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } });
      const docs = stub(false), desc = stub(false), start = stub(false), opts2 = stub(false), err = stub(false);
      opts2.hidden = /data-xp-docs-opts[^>]*hidden/.test(opts.html);
      err.hidden = true;
      const content = [...opts.html.matchAll(/<input type="checkbox" data-xp="(\w+)"( checked)?>/g)].map((x) => ({ ...stub(!!x[2]), dataset: { xp: x[1] } }));
      // a control exists only if the dialog's html really has it, so renaming an attribute breaks the test
      const by = Object.fromEntries(Object.entries({ '[data-xp-docs]': docs, '[data-xp-start]': start, '[data-xp-desc]': desc, '[data-xp-docs-opts]': opts2, '.xp-err': err })
        .filter(([sel]) => sel === '.xp-err' || opts.html.includes(sel.slice(1, -1))));
      const el = {
        querySelector: (sel) => by[sel] || null,
        querySelectorAll: (sel) => (sel === '[data-xp]' ? content : []),
        addEventListener: () => {},
      };
      const m = { el, opts, docs, desc, start, docsOpts: opts2, err, content };
      modals.push(m);
      return m;
    },
  };
  const doc = {
    head: { appendChild() {} }, body: { appendChild() {} },
    createElement: () => ({ click() {}, remove() {} }),
  };
  const ctx = {
    window: win, document: doc, location: { protocol: 'http:' }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, setTimeout() {},
    fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { status: 200, ok: true, headers: { get: () => 'attachment; filename="x.html"' }, blob: async () => ({}) }; },
  };
  vm.runInNewContext(EXPORT_UI, ctx);
  const open = () => { buttons[0].onClick(); return modals[modals.length - 1]; };
  /** ticking a box in the dialog, as a click would */
  const tick = (box, on) => { box.checked = on; (box.listeners.change || []).forEach((f) => f({ target: box })); };
  const download = async (m) => { await m.opts.actions[0].onClick(() => {}); await new Promise((r) => setImmediate(r)); return sent[sent.length - 1].body; };
  return { open, tick, download, sent, graph };
}
const shopGraph = () => ({
  meta: {}, project: { name: 'Shop' }, files: [], flows: [{ id: 'f1', title: 'Flow', steps: [] }], tour: [],
  nodes: [
    { id: 'web', parent: null, label: 'Website' },
    { id: 'api', parent: null, label: 'Server' },
    { id: 'api.orders', parent: 'api', label: 'Orders' },
    { id: 'api.orders.refunds', parent: 'api.orders', label: 'Refunds' },
    { id: 'api.x', parent: 'api', label: 'A <b>&"quoted"' },
    { id: 'jobs', parent: null, label: 'Orders' },
    { id: 'pay', parent: null, label: 'Payments', kind: 'external' },
    { id: 'empty', parent: null, label: 'Empty part' },
    { id: 'pay.hook', parent: 'pay', label: 'Hook' },
  ],
});
const options = (html) => [...html.matchAll(/<option value="([^"]*)"( selected)?>(.*?)<\/option>/g)].map((x) => ({ value: x[1], selected: !!x[2], label: x[3] }));

test('the dialog hides the docs controls until “For a docs page” is ticked', () => {
  const p = pretendPage(shopGraph());
  const m = p.open();
  assert.match(m.opts.html, /For a docs page/);
  assert.match(m.opts.html, /Show project description/);
  assert.match(m.opts.html, /data-xp-docs-opts[^>]*hidden/);
  assert.equal(m.docs.checked, false);
  assert.equal(m.desc.checked, false);
  p.tick(m.docs, true);
  assert.equal(m.docsOpts.hidden, false);
  p.tick(m.docs, false);
  assert.equal(m.docsOpts.hidden, true);
  assert.doesNotMatch(m.opts.html, /data-xp="docs"/, 'the docs box isn’t one of the content choices');
});

test('the starting-view list is Overview, then every part that opens, in tree order, labelled with where it sits and escaped', () => {
  const m = pretendPage(shopGraph()).open();
  assert.deepEqual(options(m.opts.html), [
    { value: 'root', selected: true, label: 'Overview' },
    { value: 'n:web', selected: false, label: 'Website' },
    { value: 'n:api', selected: false, label: 'Server' },
    { value: 'n:api.orders', selected: false, label: 'Server › Orders' },
    { value: 'n:api.orders.refunds', selected: false, label: 'Server › Orders › Refunds' },
    { value: 'n:api.x', selected: false, label: 'Server › A &lt;b&gt;&amp;&quot;quoted&quot;' },
    { value: 'n:jobs', selected: false, label: 'Orders' },
    { value: 'n:pay.hook', selected: false, label: 'Payments › Hook' }, // Payments itself is an outside service and Empty part has nothing in it: neither is offered
  ]);
  assert.doesNotMatch(m.opts.html, /<b>&"/);
});

test('a docs copy sends the docs settings along with the content choices', async () => {
  const p = pretendPage(shopGraph());
  const m = p.open();
  p.tick(m.docs, true);
  m.start.value = 'n:api.orders';
  p.tick(m.desc, true);
  const body = await p.download(m);
  assert.deepEqual(body, { include: ['flows'], flows: [], embed: true, startView: 'n:api.orders', showDescription: true });
});

test('a docs copy starts on the overview with the description hidden by default', async () => {
  const p = pretendPage(shopGraph());
  const m = p.open();
  p.tick(m.docs, true);
  const body = await p.download(m);
  assert.deepEqual(body, { include: ['flows'], flows: [], embed: true, startView: 'root', showDescription: false });
});

test('unticking “For a docs page” sends an ordinary export', async () => {
  const p = pretendPage(shopGraph());
  const m = p.open();
  p.tick(m.docs, true);
  m.start.value = 'n:api';
  p.tick(m.desc, true);
  p.tick(m.docs, false);
  assert.deepEqual(await p.download(m), { include: ['flows'], flows: [] });
});

test('an ordinary export is exactly what it was', async () => {
  const p = pretendPage(shopGraph());
  assert.deepEqual(await p.download(p.open()), { include: ['flows'], flows: [] });
});

test('the dialog lists what the page has when it opens, so parts and flows added later appear', () => {
  const g = shopGraph();
  g.flows = [];
  const p = pretendPage(g);
  assert.doesNotMatch(p.open().opts.html, /Flows and the tour/);
  g.nodes.push({ id: 'late', parent: 'web', label: 'Late part' });
  g.flows.push({ id: 'f2', title: 'New', steps: [], custom: true });
  const html = p.open().opts.html;
  assert.match(html, /Flows and the tour/);
  assert.ok(options(html).some((o) => o.value === 'n:late' && o.label === 'Website › Late part'));
});

test('kept boards go in by default and can be left out; the command line exports the built ones', () => {
  assert.deepEqual(dataOf(exportCli().html).boards.map((b) => b.id), ['refund-view']);
  assert.deepEqual(dataOf(exportCli(path.join(root, 'noboards.html'), '--include', 'flows,notes').html).boards, []);
});

const asBuilt = (b) => ({ id: b.id, title: b.title, question: b.question, answer: b.answer, items: b.items, steps: b.steps });
const exportWith = async (boards, more = {}) => {
  const r = await api({ include: ['boards'], boards, ...more }, { 'x-floorplan-token': token });
  assert.equal(r.status, 200);
  const html = await r.text();
  return { html, g: dataOf(html) };
};

test('the Export button sends the page’s boards, which go into a docs copy too', async () => {
  const built = dataOf(exportCli().html).boards[0];
  const added = { id: 'new-view', title: 'New view', question: 'Q?', answer: 'A.', kept: true, junk: 1, items: [{ ref: 'n:api', note: 'x' }], steps: [] };
  const { html, g } = await exportWith([asBuilt(built), added, { id: 'Bad Id', items: [] }], { embed: true });
  assert.equal(g.meta.exported.embed, true);
  assert.match(html, /^<!doctype html>\s*<html data-embed/i);
  assert.deepEqual(g.boards.map((b) => b.id), ['refund-view', 'new-view']);
  assert.deepEqual(Object.keys(g.boards[1]).sort(), ['answer', 'id', 'items', 'question', 'steps', 'title']);
});

test('a board updated on the page since the build is exported in its new form', async () => {
  const built = dataOf(exportCli().html).boards[0];
  const { g } = await exportWith([{ ...asBuilt(built), title: 'Renamed', answer: 'Changed.' }]);
  assert.equal(g.boards.length, 1);
  assert.equal(g.boards[0].title, 'Renamed');
  assert.equal(g.boards[0].answer, 'Changed.');
});

test('a board deleted on the page since the build is absent from the export', async () => {
  assert.deepEqual((await exportWith([])).g.boards, []);
});

test('with no boards in the request, the built ones are exported', async () => {
  const r = await api({ include: ['boards'] }, { 'x-floorplan-token': token });
  assert.deepEqual(dataOf(await r.text()).boards.map((b) => b.id), ['refund-view']);
});

test('--export warns when boards or flows were saved after the last build', () => {
  const f = path.join(root, 'floorplan', 'boards.json');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(f, later, later);
  try {
    const { out } = exportCli(path.join(root, 'warn.html'));
    assert.match(out, /run build\.mjs, then export again/);
  } finally { const now = new Date(Date.now() - 120000); fs.utimesSync(f, now, now); }
});

/** Runs the Export button's extension (ui/60-export.js) against a pretend page; returns the graph and the dialog opener. */
test('the Export dialog sends boards only when Kept boards is ticked', async () => {
  const g = shopGraph();
  g.boards = [{ id: 'one', title: 'One', question: '', answer: 'x'.repeat(8000), items: [{ ref: 'n:api', note: '' }], steps: [] }];
  const p = pretendPage(g);
  assert.equal((await p.download(p.open())).boards.length, 1);
  const m = p.open();
  m.content.find((c) => c.dataset.xp === 'boards').checked = false;
  assert.equal((await p.download(m)).boards, undefined, 'not sent when unticked');
});

test('kept boards added after the page loaded are offered when the dialog opens', () => {
  const g = shopGraph();
  g.boards = [];
  const p = pretendPage(g);
  assert.doesNotMatch(p.open().opts.html, /data-xp="boards"/, 'nothing to list yet');
  g.boards.push({ id: 'kept-later', title: 'Kept later', items: [{ ref: 'n:api', note: '' }], steps: [] });
  assert.match(p.open().opts.html, /data-xp="boards" checked/);
});

test('the Export button’s request keeps a character split across two pieces whole', async () => {
  const { request } = await import('node:http');
  const answer = 'Remboursé: été ✓';
  const bytes = Buffer.from(JSON.stringify({ include: ['boards'], boards: [{ id: 'accents', title: 'T', question: 'Q', answer, items: [{ ref: 'n:api', note: '' }], steps: [] }] }));
  const cut = bytes.indexOf(Buffer.from('é')) + 1;
  const html = await new Promise((resolve, reject) => {
    const req = request(base + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': token, 'content-length': bytes.length } }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (d) => { s += d; }); res.on('end', () => resolve(s));
    });
    req.on('error', reject);
    req.write(bytes.subarray(0, cut));
    setTimeout(() => req.end(bytes.subarray(cut)), 50);
  });
  assert.equal(dataOf(html).boards[0].answer, answer);
});
