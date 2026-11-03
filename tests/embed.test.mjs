// A copy of the map made to sit in an iframe in someone's docs (serve.mjs --export --embed): marked before anything
// is drawn, it starts with the details closed, leaves the docs page's back button and scroll wheel alone, and takes
// its colours from the address or the page around it without saving them. Checks on the built page and its start-up
// scripts run against a pretend browser, not a real one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { shopApp, scanAndBuild, cleanup, writeJson } from './helpers.mjs';

let root, embedded, plain, printed;
const dataOf = (html) => JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(html)[1]);
function exportCli(...args) {
  const out = execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', ...args], { cwd: root, encoding: 'utf8' });
  return { out, html: fs.readFileSync(/Exported the map to (.+)/.exec(out)[1].trim(), 'utf8') };
}
before(() => {
  root = shopApp();
  writeJson(path.join(root, 'floorplan', 'boards.json'), { boards: [{ id: 'evil', title: '</script><b>x', question: 'Q', answer: '</SCRIPT>', items: [{ ref: 'n:api', note: '</script>' }], steps: [] }] });
  scanAndBuild(root);
  ({ html: embedded, out: printed } = exportCli(path.join(root, 'docs', '_static', 'docs-map.html'), '--embed')); // a folder that doesn't exist yet
  ({ html: plain } = exportCli(path.join(root, 'plain.html')));
});
after(() => cleanup(root));

test('--embed marks the copy, before anything is drawn, and keeps what an export leaves out', () => {
  assert.match(embedded, /^<!doctype html>\s*<html data-embed lang="en">/i);
  assert.doesNotMatch(plain, /data-embed(?!'\))/, 'an ordinary export is not marked');
  const g = dataOf(embedded);
  assert.equal(g.meta.exported.embed, true);
  assert.deepEqual(g.meta.exported.include, ['flows', 'boards', 'notes']);
  assert.equal(g.health, undefined);
  assert.equal(g.recent, undefined);
  assert.equal(g.meta.root, null);
  assert.equal(dataOf(plain).meta.exported.embed, undefined);
});

test('--embed says how to put it in a docs page', () => {
  assert.match(printed, /<iframe src="docs-map\.html"[^>]*title="Architecture map" loading="lazy" allowfullscreen><\/iframe>/);
  assert.match(printed, /#v=<part id>/);
  assert.match(printed, /#b=<board id>/);
  assert.match(printed, /\?theme=light or dark/);
});

/** Runs the start-up script under <body> against a pretend browser. */
function startUp({ marked, inFrame, hash = '', phone = false }) {
  const classes = new Set();
  const script = embedded.match(/<body>\s*<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    matchMedia: (q) => ({ matches: phone && q.includes('max-width: 700px') }),
    location: { hash },
    window: { self: 1, top: inFrame ? 2 : 1 },
    document: { documentElement: { hasAttribute: (a) => a === 'data-embed' && marked }, body: { classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) } } },
  });
  return classes;
}

test('inside a docs page the map starts with the details closed, unless the link points at a box', () => {
  const c = startUp({ marked: true, inFrame: true });
  assert.ok(c.has('embedded') && c.has('no-panel'));
  const linked = startUp({ marked: true, inFrame: true, hash: '#v=api&s=n:api' });
  assert.ok(linked.has('embedded') && !linked.has('no-panel'));
});

test('opened on its own (Open full screen) it is an ordinary exported copy, and an ordinary map in a frame is unchanged', () => {
  assert.equal(startUp({ marked: true, inFrame: false }).size, 0);
  assert.equal(startUp({ marked: false, inFrame: true }).size, 0);
});

test('clicks update the address in place instead of filling the docs page’s back button', () => {
  assert.match(embedded, /history\[EMBED \? 'replaceState' : 'pushState'\]\(/);
  assert.doesNotMatch(embedded, /history\.pushState\(/);
});

test('the scroll wheel scrolls the docs page until the map is clicked, or Ctrl/⌘ is held', () => {
  const wheel = embedded.slice(embedded.indexOf("svg.addEventListener('wheel'"));
  const pass = wheel.indexOf('if (!mapActive && !ev.ctrlKey && !ev.metaKey)');
  assert.ok(pass > 0 && pass < wheel.indexOf('ev.preventDefault()'), 'the check comes before the page scroll is stopped');
  assert.match(embedded, /let mapActive = !EMBED/);
  assert.match(embedded, /document\.documentElement\.addEventListener\('mouseleave', \(\) => activateMap\(false\)\)/);
  // one finger scrolls the docs page until the map is tapped; a touch doesn't activate it on pointerdown
  assert.match(embedded, /body\.embedded:not\(\.map-active\) #svg \{ touch-action: pan-x pan-y; \}/);
  assert.match(embedded, /if \(ev\.pointerType !== 'touch'\) activateMap\(true\)/);
});

test('clicking a box opens its details', () => {
  assert.match(embedded, /else if \(sel && EMBED && document\.body\.classList\.contains\('no-panel'\)\) setPanel\(true\);/);
});

test('full screen fills the screen with this same page, the same button leaves it, and the scroll wheel zooms while it lasts', () => {
  const at = embedded.indexOf("id: 'btn-full'");
  assert.ok(at > 0);
  const code = embedded.slice(at - 1500, at + 1500);
  assert.match(code, /if \(isFull\(\)\) \{ \(document\.exitFullscreen \|\| document\.webkitExitFullscreen\)\.call\(document\); return; \}/);
  assert.match(code, /el\.requestFullscreen \|\| el\.webkitRequestFullscreen/);
  assert.match(code, /btn\.title = on \? 'Exit full screen \(Esc\)' : 'Full screen';/);
  assert.match(code, /activateMap\(on\);/);
  assert.match(code, /document\.addEventListener\('fullscreenchange', onFull\)/);
});

test('where full screen is not allowed, the copy opens in its own tab in the same colours', () => {
  const at = embedded.indexOf('const openTab = () => {');
  const code = embedded.slice(at, at + 300);
  assert.match(code, /u\.searchParams\.set\('theme', window\.floorplanTheme\?\.get\(\) \|\| 'auto'\);/);
  assert.match(embedded, /Promise\.resolve\(enter\.call\(el\)\)\.catch\(openTab\)/);
});

/** Runs the theme script in the head with a pretend browser. */
function theme({ search = '', saved, inFrame = false, marked = false, lightDevice = false } = {}) {
  const attrs = {}, store = new Map(saved ? [['floorplan-theme', saved]] : []), listeners = {};
  const parent = {};
  const win = {
    document: { documentElement: { hasAttribute: (a) => a === 'data-embed' && marked, setAttribute: (k, v) => { attrs[k] = v; }, classList: { add() {}, remove() {} } } },
    location: { search },
    matchMedia: () => ({ matches: lightDevice, addEventListener() {} }),
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    addEventListener: (t, f) => { listeners[t] = f; },
    dispatchEvent() {},
    Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: (f) => f(),
    URLSearchParams,
    parent,
  };
  win.window = win;
  win.self = win; win.top = inFrame ? parent : win;
  const at = embedded.indexOf('/* Theme: runs before');
  vm.runInNewContext(embedded.slice(embedded.lastIndexOf('<script>', at) + 8, embedded.indexOf('</script>', at)), win);
  return { attrs, store, listeners, parent, win, api: win.floorplanTheme };
}

test('?theme= in the address wins over the saved choice, and is never saved', () => {
  const t = theme({ search: '?theme=light', saved: 'dark' });
  assert.equal(t.attrs['data-theme'], 'light');
  t.api.set('dark');
  assert.equal(t.attrs['data-theme'], 'dark');
  assert.equal(t.store.get('floorplan-theme'), 'dark', 'the saved choice is untouched');
  t.api.set('light');
  assert.equal(t.store.get('floorplan-theme'), 'dark');
  // nonsense is ignored
  assert.equal(theme({ search: '?theme=purple', saved: 'light' }).attrs['data-theme'], 'light');
});

test('the docs page around the map can switch its colours live, and nobody else can', () => {
  const t = theme({ saved: 'dark' });
  t.listeners.message({ source: t.parent, data: { floorplan: 'theme', theme: 'light' } });
  assert.equal(t.attrs['data-theme'], 'light');
  assert.equal(t.store.get('floorplan-theme'), 'dark', 'not saved');
  t.listeners.message({ source: {}, data: { floorplan: 'theme', theme: 'dark' } });
  assert.equal(t.attrs['data-theme'], 'light', 'a message from another window is ignored');
  t.listeners.message({ source: t.parent, data: { floorplan: 'theme', theme: 'purple' } });
  assert.equal(t.attrs['data-theme'], 'light');
});

test('an embedded map uses its own unsaved theme by default', () => {
  const t = theme({ marked: true, inFrame: true, saved: 'dark', lightDevice: true });
  assert.equal(t.attrs['data-theme'], 'light');
  t.api.set('dark');
  t.api.set('light');
  assert.equal(t.store.get('floorplan-theme'), 'dark');
  assert.equal(t.api.get(), 'light');
});

test('a marked export opened on its own still saves its theme', () => {
  const t = theme({ marked: true, saved: 'dark' });
  assert.equal(t.attrs['data-theme'], 'dark');
  t.api.set('light');
  assert.equal(t.store.get('floorplan-theme'), 'light');
});


test('an embed hides the overview description unless requested, while other descriptions remain', () => {
  const start = embedded.indexOf('function renderContext() {');
  const end = embedded.indexOf('/** On a phone the description', start);
  function context({ embed, search = '', container = 'root', exported = null }) {
    const element = {};
    const state = { container, view: {} };
    const code = embedded.slice(start, end) + '\nrenderContext();';
    vm.runInNewContext(code, { state, EMBED: embed, EXPORTED: exported, location: { search }, URLSearchParams,
      $: () => element, info: () => ({ name: 'Example', desc: 'Description', type: 'node', kind: 'service' }),
      h: (s) => s, isBoard: () => false, colorOf: () => '', icon: () => '', iconKey: () => '', foldContext: () => {} });
    return element.innerHTML;
  }
  assert.doesNotMatch(context({ embed: true }), /Description/);
  assert.match(context({ embed: true, search: '?description=show' }), /Description/);
  assert.match(context({ embed: true, container: 'api' }), /Description/);
  assert.match(context({ embed: false }), /Description/);
});

test('#v= opens the part named by its id as written, with or without the n: prefix', () => {
  const start = embedded.indexOf('function readHash() {');
  const end = embedded.indexOf('window.addEventListener', start);
  const file = dataOf(embedded).files[0].p;
  const read = (hash) => {
    const parentOf = new Map([['n:api', 'root'], ['n:web', 'root'], ['f:' + file, 'n:api']]);
    return vm.runInNewContext(embedded.slice(start, end) + '\nreadHash();', { location: { hash }, URLSearchParams, parentOf, drillable: () => true, EMBED: false, EXPORTED: null });
  };
  assert.equal(read('#v=api').v, 'n:api');
  assert.equal(read('#v=n:api').v, 'n:api');
  assert.equal(read('#v=nope').v, 'root');
  assert.equal(read('').v, 'root');
  assert.equal(read('#v=' + file).v, 'root', 'a bare file path is not a part');
  assert.equal(read('#v=api&s=n:web').s, 'n:web');
});

test('the description setting chosen at export decides whether the overview shows it', () => {
  const start = embedded.indexOf('function renderContext() {');
  const end = embedded.indexOf('/** On a phone the description', start);
  const context = ({ embed, exported, search = '' }) => {
    const element = {};
    vm.runInNewContext(embedded.slice(start, end) + '\nrenderContext();', { state: { container: 'root', view: {} }, EMBED: embed, EXPORTED: exported, location: { search }, URLSearchParams,
      $: () => element, info: () => ({ name: 'Example', desc: 'Description', type: 'node', kind: 'service' }),
      h: (s) => s, isBoard: () => false, colorOf: () => '', icon: () => '', iconKey: () => '', foldContext: () => {} });
    return element.innerHTML;
  };
  assert.doesNotMatch(context({ embed: true, exported: { embed: true, showDescription: false } }), /Description/, 'off by default');
  assert.match(context({ embed: true, exported: { embed: true, showDescription: true } }), /Description/);
  assert.match(context({ embed: true, exported: { embed: true, showDescription: false }, search: '?description=show' }), /Description/);
  assert.match(context({ embed: false, exported: { embed: true, showDescription: false } }), /Description/, 'outside a frame it is an ordinary export');
});

test('a docs copy opens on the part chosen at export unless the address says otherwise', () => {
  const start = embedded.indexOf('function readHash() {');
  const end = embedded.indexOf('window.addEventListener', start);
  const read = (hash, { embed = true, startView } = {}) => {
    const parentOf = new Map([['n:api', 'root'], ['n:web', 'root']]);
    const exported = startView === undefined ? { embed: true } : { embed: true, startView };
    return vm.runInNewContext(embedded.slice(start, end) + '\nreadHash();', { location: { hash }, URLSearchParams, parentOf, drillable: () => true, EMBED: embed, EXPORTED: exported }).v;
  };
  assert.equal(read('', { startView: 'n:api' }), 'n:api', 'no v: the saved part');
  assert.equal(read('#s=n:web', { startView: 'n:api' }), 'n:api');
  assert.equal(read('#v=web', { startView: 'n:api' }), 'n:web', 'an explicit bare id wins');
  assert.equal(read('#v=n:web', { startView: 'n:api' }), 'n:web');
  assert.equal(read('#v=nope', { startView: 'n:api' }), 'root', 'an invalid explicit v opens the overview');
  assert.equal(read('', { startView: 'n:gone' }), 'root', 'a saved part that no longer exists');
  assert.equal(read('', { startView: 'root' }), 'root');
  assert.equal(read('', {}), 'root');
  assert.equal(read('', { embed: false, startView: 'n:api' }), 'root', 'outside a frame it is an ordinary export');
});

test('the CLI docs copy records the defaults', () => {
  const g = dataOf(embedded);
  assert.equal(g.meta.exported.startView, 'root');
  assert.equal(g.meta.exported.showDescription, false);
  assert.equal(dataOf(plain).meta.exported.startView, undefined);
});

test('the overview of a docs copy with a saved start view is written as v=root, so a reload stays there', () => {
  const start = embedded.indexOf('function setHash(container, sel) {');
  const end = embedded.indexOf('function readHash() {', start);
  const rstart = end, rend = embedded.indexOf('window.addEventListener', rstart);
  const written = (container, { embed = true, startView } = {}) => {
    const calls = [];
    const exported = startView === undefined ? { embed: true } : { embed: true, startView };
    const ctx = { location: { hash: '#v=zzz', pathname: '/p', search: '' }, URLSearchParams, EMBED: embed, EXPORTED: exported,
      history: { replaceState: (a, b, u) => calls.push(u), pushState: (a, b, u) => calls.push(u) }, parentOf: new Map([['n:api', 'root']]) };
    vm.runInNewContext(embedded.slice(start, end) + `\nsetHash(${JSON.stringify(container)});`, ctx);
    return calls[0];
  };
  const back = written('root', { startView: 'n:api' });
  assert.equal(back, '#v=root');
  const read = (hash) => vm.runInNewContext(embedded.slice(rstart, rend) + '\nreadHash();', { location: { hash }, URLSearchParams, parentOf: new Map([['n:api', 'root']]), drillable: () => true, EMBED: true, EXPORTED: { embed: true, startView: 'n:api' } }).v;
  assert.equal(read(back), 'root');
  assert.equal(written('n:api', { startView: 'n:api' }), '#v=n%3Aapi');
  assert.equal(written('root', {}), '/p', 'no saved start view: unchanged');
  assert.equal(written('root', { startView: 'root' }), '/p');
  assert.equal(written('root', { embed: false, startView: 'n:api' }), '/p', 'ordinary page: unchanged');
});

test('inside a docs page the saved panel preference does not reopen the details', () => {
  const start = embedded.indexOf("\ndocument.body.classList.toggle('no-panel', ") + 1;
  const end = embedded.indexOf('\n', start);
  const panelClosed = ({ embed, closedEarly, saved }) => {
    const classes = new Set(closedEarly ? ['no-panel'] : []);
    const body = { classList: { contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } };
    vm.runInNewContext(embedded.slice(start, end), { document: { body }, EMBED: embed, isPhone: () => false, store: { get: (k, d) => saved } });
    return classes.has('no-panel');
  };
  assert.equal(panelClosed({ embed: true, closedEarly: true, saved: true }), true, 'embed, no s=: stays closed');
  assert.equal(panelClosed({ embed: true, closedEarly: false, saved: true }), false, 'embed with s=: open');
  assert.equal(panelClosed({ embed: false, closedEarly: false, saved: true }), false, 'ordinary page: saved open');
  assert.equal(panelClosed({ embed: false, closedEarly: false, saved: false }), true, 'ordinary page: saved closed');
});

// ---- final review fixes ----
const tourSrc = fs.readFileSync(fileURLToPath(new URL('../skills/floorplan/assets/ui/40-tour.js', import.meta.url)), 'utf8');

test('the first-visit tour does not start on its own inside a docs page, but does on an ordinary page', () => {
  const code = tourSrc.slice(tourSrc.indexOf('let auto = false;'), tourSrc.indexOf('window.FloorplanTour'));
  const run = (embedded) => {
    let started = 0, timers = 0;
    const ctx = {
      SC: { store: { get: () => false, set() {} }, state: { layout: {}, container: 'root', flow: null }, on() {} },
      SEEN: 'k', location: { hash: '' }, active: () => false, start: () => { started++; },
      document: { body: { classList: { contains: (c) => embedded && c === 'embedded' } } },
      setTimeout: (f) => { timers++; f(); },
    };
    vm.runInNewContext(code, ctx);
    return started;
  };
  assert.equal(run(false), 1, 'an ordinary page still starts the tour');
  assert.equal(run(true), 0, 'a docs page does not');
});

test('the Start here button still starts the tour in a docs page', () => {
  assert.match(tourSrc, /onClick: \(\) => \(active\(\) \? end\(\) : start\(\)\)/);
});

test('a saved start view that cannot be opened falls back to the overview, but an explicit #v= keeps its behaviour', () => {
  const start = embedded.indexOf('function readHash() {');
  const end = embedded.indexOf('window.addEventListener', start);
  const read = (hash) => {
    const parentOf = new Map([['n:api', 'root'], ['n:svc', 'root']]);
    const drillable = (id) => id === 'n:api';
    return vm.runInNewContext(embedded.slice(start, end) + '\nreadHash();', { location: { hash }, URLSearchParams, parentOf, drillable, EMBED: true, EXPORTED: { embed: true, startView: 'n:svc' } }).v;
  };
  assert.equal(read(''), 'root', 'a saved external service or empty part opens the overview');
  assert.equal(read('#v=svc'), 'n:svc', 'an explicit address is left alone');
  const ok = vm.runInNewContext(embedded.slice(start, end) + '\nreadHash();', { location: { hash: '' }, URLSearchParams, parentOf: new Map([['n:api', 'root']]), drillable: () => true, EMBED: true, EXPORTED: { embed: true, startView: 'n:api' } }).v;
  assert.equal(ok, 'n:api');
});

test('the full-screen new-tab fallback keeps the current view and selection', () => {
  const at = embedded.indexOf('const openTab = () => {');
  const code = embedded.slice(at, embedded.indexOf('\n  };', at) + 5);
  const opened = (state) => {
    let url;
    vm.runInNewContext(code + '\nopenTab();', { state, URL, URLSearchParams, location: { href: 'https://docs.example/map.html' }, window: { floorplanTheme: { get: () => 'dark' }, open: (u) => { url = new URL(u); } } });
    return url;
  };
  const a = opened({ container: 'n:api', selected: 'n:api.orders' });
  assert.equal(new URLSearchParams(a.hash.slice(1)).get('v'), 'n:api');
  assert.equal(new URLSearchParams(a.hash.slice(1)).get('s'), 'n:api.orders');
  assert.equal(a.searchParams.get('theme'), 'dark');
  const b = opened({ container: 'root', selected: null });
  assert.equal(new URLSearchParams(b.hash.slice(1)).get('v'), 'root', 'v is always written, the new tab is not an embed');
  assert.equal(new URLSearchParams(b.hash.slice(1)).get('s'), null);
  const c = opened({ container: 'q:answer', selected: null });
  assert.equal(new URLSearchParams(c.hash.slice(1)).get('v'), 'root', 'a transient answer view is not carried over');
  const d = new URLSearchParams(opened({ container: 'b:one', selected: null }).hash.slice(1));
  assert.equal(d.get('b'), 'one', 'a kept board is written as b=, which the viewer reads');
  assert.equal(d.get('v'), null);
});

test('inside a docs page the panel preference is not written to the docs site storage', () => {
  const start = embedded.indexOf('const setPanel = (on) => {');
  const end = embedded.indexOf('\n};', start) + 3;
  const writes = (embed, phone) => {
    const set = [];
    const el = { setAttribute() {} };
    const ctx = { document: { body: { classList: { contains: () => false, toggle() {} } } }, $: () => el, isPhone: () => phone, store: { set: (k, v) => set.push(k) },
      fit() {}, keyboardUser: false, sheetReturn: null, panel: { focus() {}, contains: () => false }, EMBED: embed };
    vm.runInNewContext(embedded.slice(start, end) + '\nsetPanel(true);', ctx);
    return set;
  };
  assert.deepEqual(writes(true, false), []);
  assert.deepEqual(writes(false, false), ['panel']);
  assert.deepEqual(writes(false, true), []);
});

test('the CLI hint says the overview description is hidden and how to show it, with a lazy iframe', () => {
  assert.match(printed, /loading="lazy"/);
  assert.match(printed, /\?description=show/);
  assert.match(printed, /description.*hidden|hidden.*description/i);
});

test('a board title with </script> still leaves a page that parses', () => {
  const scripts = [...embedded.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2);
  for (const code of scripts) assert.doesNotThrow(() => new Function(code));
  assert.equal(dataOf(embedded).boards[0].title, '</script><b>x');
});

test('an answer with <!-- <script> can’t blank the page: the data script holds no < at all', () => {
  const r = shopApp();
  try {
    const answer = 'Look: <!-- <script> and </script> -->';
    writeJson(path.join(r, 'floorplan', 'boards.json'), { boards: [{ id: 'html-ish', title: '<!--', question: 'Q', answer, items: [{ ref: 'n:api', note: '<script>' }], steps: [] }] });
    scanAndBuild(r);
    const out = execFileSync(process.execPath, [path.join(r, 'floorplan', 'serve.mjs'), '--export', path.join(r, 'copy.html')], { cwd: r, encoding: 'utf8' });
    const served = fs.readFileSync(path.join(r, 'floorplan', 'index.html'), 'utf8');
    const exported = fs.readFileSync(/Exported the map to (.+)/.exec(out)[1].trim(), 'utf8');
    for (const html of [served, exported]) {
      const at = html.indexOf('<script>window.FLOORPLAN = ');
      const data = html.slice(at + 8, html.indexOf(';</script>', at));
      assert.doesNotMatch(data, /<!--|<script/i);
      assert.ok(!data.includes('<'), 'every < in the data is written as \\u003c');
      for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]));
      const b = dataOf(html).boards[0];
      assert.equal(b.answer, answer);
      assert.equal(b.title, '<!--');
      assert.equal(b.items[0].note, '<script>');
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(r, 'floorplan', 'graph.json'), 'utf8')).boards[0].answer, answer);
  } finally { cleanup(r); }
});

test('a docs copy opens on the kept board chosen at export, or the overview if it is gone; an explicit address wins', () => {
  const start = embedded.indexOf('function readHash() {');
  const end = embedded.indexOf('window.addEventListener', start);
  const read = (hash, { embed = true, boards = ['one'], startView = 'b:one' } = {}) => {
    const parentOf = new Map([['n:api', 'root']]);
    return vm.runInNewContext(embedded.slice(start, end) + '\nreadHash();', { location: { hash }, URLSearchParams, parentOf, drillable: () => true, G: { boards: boards.map((id) => ({ id })) }, EMBED: embed, EXPORTED: { embed: true, startView } }).v;
  };
  assert.equal(read(''), 'b:one');
  assert.equal(read('#s=n:api'), 'b:one');
  assert.equal(read('', { boards: [] }), 'root', 'the board is gone');
  assert.equal(read('', { boards: ['two'] }), 'root');
  assert.equal(read('#b=two', { boards: ['one', 'two'] }), 'b:two', 'an explicit board wins');
  assert.equal(read('#v=n:api'), 'n:api', 'an explicit part wins');
  assert.equal(read('#v=root'), 'root', 'an explicit overview wins');
  assert.equal(read('', { embed: false }), 'root', 'outside a frame it is an ordinary export');
});
