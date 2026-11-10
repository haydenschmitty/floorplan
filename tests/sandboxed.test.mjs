// When the browser says no: a map embedded in a sandboxed frame, opened in a private window or under strict settings
// may get no storage, no clipboard and no new windows. The built page's own code is run here against a pretend browser
// that refuses each of them (and one that allows them, to show nothing changes there). These are checks of the page's
// code, not of a real sandboxed frame.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'); });
after(() => cleanup(root));

const START = 'const h = (s) =>';
const END = '// ---------- end: when the browser says no ----------';
/** The page's helpers for storage, copying and new windows (and `h`, which they use), as written into the built map. */
function helpersSource() {
  const a = html.indexOf(START), b = html.indexOf(END);
  assert.ok(a > 0 && b > a, 'the built page has its "when the browser says no" helpers between the expected markers');
  return html.slice(a, b);
}
/** One piece of the page's script, from `from` up to and including the next line that is exactly `end`. */
function piece(from, end = '}') {
  const a = html.indexOf(from);
  assert.ok(a > 0, `the built page contains: ${from}`);
  const b = html.indexOf('\n' + end + '\n', a);
  return html.slice(a, b + end.length + 1);
}

/**
 * Runs the helpers in a pretend browser.
 * storage: 'ok' | 'blocked' (every access throws, as in a sandboxed frame) | 'full' (reads work, writes throw)
 * clipboard: 'ok' | 'refused' | 'missing'; execCopy: what the older copy command returns; popups: whether new windows open.
 */
function browser({ storage = 'ok', saved = {}, clipboard = 'ok', execCopy = false, popups = true, openThrows = false } = {}) {
  const ls = new Map(Object.entries(saved));
  const seen = { modals: [], toasts: [], selected: [], execCopy: 0, clipboard: [], windows: [] };
  const fakeEl = () => ({ style: {}, setAttribute() {}, select() {}, remove() {}, focus() {}, isConnected: true });
  const ctx = {
    navigator: clipboard === 'missing' ? {} : { clipboard: { writeText: (t) => (clipboard === 'ok' ? (seen.clipboard.push(t), Promise.resolve()) : Promise.reject(Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' }))) } },
    document: {
      createElement: fakeEl, body: { appendChild() {} }, activeElement: null,
      execCommand: (c) => { if (c === 'copy') seen.execCopy++; return execCopy; },
      createRange: () => ({ selectNodeContents(el) { this.el = el; } }),
    },
    getSelection: () => ({ removeAllRanges() {}, addRange(r) { seen.selected.push(r.el); } }),
    open: () => {
      if (openThrows) throw new Error('blocked');
      if (!popups) return null;
      const w = { opener: {}, location: { href: '' } };
      seen.windows.push(w);
      return w;
    },
    toast: (msg) => seen.toasts.push(msg),
    showModal: ({ title, html: body, actions = [] }) => { const pre = { pre: true, isConnected: true }; seen.modals.push({ title, html: body, actions, pre }); return { el: { querySelector: () => pre }, close() {} }; },
  };
  ctx.window = ctx;
  const ls$ = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { if (storage === 'full') throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }); ls.set(k, String(v)); },
    removeItem: (k) => ls.delete(k),
  };
  Object.defineProperty(ctx, 'localStorage', { get() { if (storage === 'blocked') throw Object.assign(new Error('Access is denied for this document.'), { name: 'SecurityError' }); return ls$; } });
  const api = vm.runInNewContext(helpersSource() + '\n;({ store, copy, openWindow, showAddress })', ctx);
  return { ...api, ls, seen };
}

// ---------- remembered settings ----------

test('with storage refused, settings are kept in memory for as long as the page is open', () => {
  const b = browser({ storage: 'blocked' });
  assert.equal(b.store.persistent, false, 'store.persistent says nothing will last beyond this visit');
  assert.equal(b.store.get('panelWidth', 360), 360, 'nothing saved yet: the default');
  b.store.set('panelWidth', 520);
  b.store.set('panel', false);
  b.store.set('kinds', { http: false });
  b.store.set('technical', true);
  assert.equal(b.store.get('panelWidth', 360), 520, 'panel width holds for the visit');
  assert.equal(b.store.get('panel', true), false, 'panel closed holds for the visit (false is a real answer, not "nothing saved")');
  assert.deepEqual({ ...b.store.get('kinds', {}) }, { http: false }, 'connection filters hold for the visit');
  assert.equal(b.store.get('technical', false), true);
  const k = b.store.get('kinds', {}); k.http = true;
  assert.equal(b.store.get('kinds', {}).http, false, 'each read is a fresh copy, as it is from real storage');
});

test('with storage available nothing changes: the same keys are written and read, and memory is never used', () => {
  const b = browser({ storage: 'ok', saved: { 'show-code:technical': 'true' } });
  assert.equal(b.store.persistent, true);
  assert.equal(b.store.get('technical', false), true, 'an older map\'s saved setting is still read');
  b.store.set('panelWidth', 480);
  assert.equal(b.ls.get('floorplan:panelWidth'), '480', 'saved under floorplan:<name> as JSON, as before');
  b.ls.set('floorplan:panelWidth', '400'); // changed in another tab
  assert.equal(b.store.get('panelWidth', 360), 400, 'reads go to storage every time, so another tab\'s change is seen');
  assert.equal(b.store.persistent, true);
});

test('when storage reads but won\'t save (full, or private-mode limits), the setting still holds for the visit', () => {
  const b = browser({ storage: 'full', saved: { 'floorplan:panelWidth': '400' } });
  assert.equal(b.store.persistent, true, 'nothing has failed yet');
  assert.equal(b.store.get('panelWidth', 360), 400);
  b.store.set('panelWidth', 600);
  assert.equal(b.store.get('panelWidth', 360), 600, 'the new value wins over the older saved one');
  assert.equal(b.store.persistent, false, 'after a refused save, store.persistent says so');
});

// ---------- the tour ----------

/** Runs the built page's tour against a pretend viewer with this store and address; returns whether it started on its own, and the Start here button's handler. */
function tourOn({ store, hash = '' }) {
  const a = html.indexOf('/* ui/40-tour.js */');
  assert.ok(a > 0, 'the tour is in the built page');
  const src = html.slice(a, html.indexOf('</script>', a));
  const listeners = {};
  const el = () => ({ style: {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, getBoundingClientRect: () => ({}), offsetHeight: 0, hidden: false, innerHTML: '' });
  let onClick, went = 0, toasts = [];
  const SC = {
    graph: { project: { name: 'Shop' }, nodes: [], flows: [], tour: [{ ref: 'root', title: 'The shop', note: 'One' }, { ref: 'root', title: 'Again', note: 'Two' }] },
    h: (s) => String(s), iconI: () => '', exists: () => false, info: () => ({}), parentOf: () => 'root',
    state: { container: 'root', flow: null, layout: null },
    store, toast: (m) => toasts.push(m), go: () => { went++; }, reveal() {}, fit() {}, select() {}, startFlow() {},
    on: (e, fn) => { (listeners[e] ||= []).push(fn); },
    addHeaderButton: (o) => { onClick = o.onClick; return el(); },
  };
  const ctx = { document: { createElement: el, head: { appendChild() {} }, body: { appendChild() {} }, getElementById: () => null }, location: { hash }, setTimeout: (fn) => fn(), innerHeight: 800, addEventListener() {} };
  ctx.window = Object.assign(ctx, { Floorplan: SC });
  vm.runInNewContext(src, ctx);
  for (const fn of listeners.ready || []) fn({});
  return { autoStarted: ctx.FloorplanTour.active(), press: () => { onClick(); return ctx.FloorplanTour.active(); }, toasts, went };
}

test('with storage available, a first visit still starts the tour on its own, and a later one does not (unchanged)', () => {
  const b = browser({ storage: 'ok' });
  assert.equal(tourOn({ store: b.store }).autoStarted, true, 'first visit: the tour starts on its own');
  assert.equal(tourOn({ store: b.store }).autoStarted, false, 'it was remembered as seen, so the next visit does not');
  assert.equal(tourOn({ store: browser({ storage: 'ok' }).store, hash: '#v=n%3Aapi' }).autoStarted, false, 'a link to somewhere specific does not start it');
});

test('with storage refused, the tour never starts on its own (it can\'t tell a first visit from the hundredth), and Start here still works', () => {
  for (let visit = 1; visit <= 3; visit++) {
    const b = browser({ storage: 'blocked' }); // every load of a sandboxed frame starts with nothing
    const t = tourOn({ store: b.store });
    assert.equal(t.autoStarted, false, `visit ${visit}: the tour must not start on its own when nothing can be remembered`);
    assert.equal(t.press(), true, 'the header\'s Start here button starts it');
  }
});

test('#tour=0 in the address keeps the tour from starting on its own, and is kept as the person moves around the map', () => {
  assert.equal(tourOn({ store: browser({ storage: 'ok' }).store, hash: '#tour=0' }).autoStarted, false, 'an embedding page can say tour=0');
  const run = (hash, container, sel) => {
    const pushed = [];
    const ctx = { location: { hash, pathname: '/floorplan/index.html', search: '' }, history: { pushState: (s, t, u) => pushed.push(u) }, URLSearchParams };
    vm.runInNewContext(piece('function setHash(container, sel) {') + '\nsetHash(c, s);', Object.assign(ctx, { c: container, s: sel }));
    return pushed[0];
  };
  assert.equal(run('#tour=0', 'n:api', 'f:shop-api/server.js'), '#tour=0&v=n%3Aapi&s=f%3Ashop-api%2Fserver.js', 'tour=0 stays when going inside a card');
  assert.equal(run('#tour=0&v=n%3Aapi', 'root', null), '#tour=0', 'and when going back to the overview');
  // without the flag the address is exactly what it always was
  assert.equal(run('', 'n:api', 'f:shop-api/server.js'), '#v=n%3Aapi&s=f%3Ashop-api%2Fserver.js');
  assert.equal(run('#v=n%3Aapi', 'root', null), '/floorplan/index.html');
});

// ---------- copying ----------

test('a copy the browser allows reports success and shows nothing else (unchanged)', async () => {
  const b = browser({ clipboard: 'ok' });
  assert.equal(await b.copy('shop-api/server.js'), true);
  assert.deepEqual(b.seen.clipboard, ['shop-api/server.js']);
  assert.equal(b.seen.execCopy, 0, 'the older copy command is not touched');
  assert.equal(b.seen.modals.length + b.seen.toasts.length, 0);
});

test('a refused copy reports failure and shows the text, selected, to copy by hand; never a false "copied"', async () => {
  const b = browser({ clipboard: 'refused', execCopy: false });
  assert.equal(await b.copy('<b>GET /api/orders</b>'), false, 'copy() must resolve false when nothing was copied');
  assert.equal(b.seen.modals.length, 1, 'with nothing on screen to select, a small window shows the text');
  const m = b.seen.modals[0];
  assert.equal(m.title, 'Copy it yourself');
  assert.ok(m.html.includes('&lt;b&gt;GET /api/orders&lt;/b&gt;'), 'the text is shown, escaped');
  assert.deepEqual(b.seen.selected, [m.pre], 'and selected');
  assert.ok(!b.seen.toasts.some((t) => /copied/i.test(t)), 'no "Copied" message');
});

test('a refused copy of text already on screen selects it there and says so plainly', async () => {
  const b = browser({ clipboard: 'refused', execCopy: false });
  const shown = { isConnected: true };
  assert.equal(await b.copy('node floorplan/serve.mjs', { select: shown }), false);
  assert.deepEqual(b.seen.selected, [shown]);
  assert.equal(b.seen.modals.length, 0);
  assert.match(b.seen.toasts[0], /blocked copying/);
  const quiet = browser({ clipboard: 'refused' });
  assert.equal(await quiet.copy('x', { quiet: true }), false);
  assert.equal(quiet.seen.modals.length + quiet.seen.toasts.length, 0, 'quiet: the caller handles it');
});

test('when the clipboard API is refused or missing, the older copy command is tried, and success is reported only if it worked', async () => {
  const refused = browser({ clipboard: 'refused', execCopy: true });
  assert.equal(await refused.copy('abc'), true);
  assert.equal(refused.seen.execCopy, 1);
  assert.equal(refused.seen.modals.length, 0);
  const missing = browser({ clipboard: 'missing', execCopy: true });
  assert.equal(await missing.copy('abc'), true);
  const neither = browser({ clipboard: 'missing', execCopy: false });
  assert.equal(await neither.copy('abc'), false);
  assert.equal(neither.seen.modals.length, 1);
});

test('every copy in the page goes through copy(), and nothing says "Copied" unless it was', () => {
  const rest = html.replace(helpersSource(), '');
  assert.doesNotMatch(rest, /navigator\.clipboard/, 'use copy() (SC.copy in ui/*.js), which only reports success when the text was really copied');
  assert.doesNotMatch(rest, /SC\.copy\([^;]*\);\s*SC\.toast/, 'show "Copied" only after SC.copy(...) resolves true: SC.copy(x).then((ok) => { if (ok) SC.toast(...) })');
  assert.match(rest, /copy\(a\.dataset\.copy, \{ select: a\.previousElementSibling \}\)\.then\(\(ok\) => \{ if \(ok\) a\.textContent = '✓'; \}\)/, 'the panel\'s copy button shows its tick only after a real copy');
  assert.match(rest, /copy\('node floorplan\/serve\.mjs', \{ select: warn\.querySelector\('code'\) \}\)\.then\(\(ok\) => \{ if \(ok\) b\.textContent = 'Copied'; \}\)/);
});

// ---------- new windows ----------

test('a new window that opens is cut off from the map, as before', () => {
  const b = browser({ popups: true });
  assert.equal(b.openWindow('https://example.com/docs'), true);
  assert.equal(b.seen.windows[0].opener, null, 'the new page can\'t reach back into the map');
  assert.equal(b.seen.windows[0].location.href, 'https://example.com/docs');
  assert.equal(b.seen.modals.length, 0);
});

test('a blocked new window shows the address, selected, with a Copy button, instead of doing nothing', () => {
  for (const blocked of [{ popups: false }, { openThrows: true }]) {
    const b = browser(blocked);
    assert.equal(b.openWindow('https://example.com/new?title=a&body=b'), false, 'openWindow() must say the window did not open');
    const m = b.seen.modals[0];
    assert.ok(m, 'the address is shown');
    assert.equal(m.title, 'Open this address');
    assert.ok(m.html.includes('https://example.com/new?title=a&amp;body=b'));
    assert.deepEqual(b.seen.selected, [m.pre]);
    assert.equal(m.actions[0].label, 'Copy address');
  }
  const quiet = browser({ popups: false });
  assert.equal(quiet.openWindow('https://example.com', { quiet: true }), false);
  assert.equal(quiet.seen.modals.length, 0);
});

test('links that open a new window are left to the browser where storage works, and go through openWindow where it does not', () => {
  const src = piece("document.addEventListener('click', (ev) => {\n  if (store.persistent) return;", '});');
  const click = ({ persistent, ...ev }) => {
    let handler; const opened = [];
    vm.runInNewContext(src, { document: { addEventListener: (t, f) => { handler = f; } }, store: { persistent }, openWindow: (u) => opened.push(u) });
    const a = { href: 'https://example.com/' };
    const e = { button: 0, target: { closest: (sel) => (sel === 'a[target="_blank"][href]' ? a : null) }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev };
    handler(e);
    return { prevented: e.defaultPrevented, opened };
  };
  assert.deepEqual(click({ persistent: true }), { prevented: false, opened: [] }, 'with storage, the link works exactly as before');
  assert.deepEqual(click({ persistent: false }), { prevented: true, opened: ['https://example.com/'] }, 'without storage, openWindow can notice a blocked window');
  assert.deepEqual(click({ persistent: false, ctrlKey: true }), { prevented: false, opened: [] }, 'a Ctrl-click is the browser\'s');
  assert.deepEqual(click({ persistent: false, button: 1 }), { prevented: false, opened: [] }, 'a middle-click is the browser\'s');
});

test('every new window in the page goes through openWindow, except the Health report where storage works, which is unchanged', () => {
  const rest = html.replace(helpersSource(), '');
  const opens = [...rest.matchAll(/window\.open\([^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(opens, ["window.open(url, '_blank', 'noopener')"], 'open new windows with openWindow() (SC.openWindow in ui/*.js), which shows the address when the browser blocks the window');
  assert.match(rest, /if \(SC\.store\.persistent === false && SC\.openWindow\) opened = SC\.openWindow\(url, \{ quiet: true \}\);/);
  assert.match(rest, /if \(report && !opened\) SC\.showAddress\(url\);/, 'a blocked report shows its address once the dismissal is saved');
});
