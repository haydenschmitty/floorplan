// A copy of the map made to sit in an iframe in someone's docs (serve.mjs --export --embed): marked before anything
// is drawn, it starts with the details closed, leaves the docs page's back button and scroll wheel alone, and takes
// its colours from the address or the page around it without saving them. Checks on the built page and its start-up
// scripts run against a pretend browser, not a real one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

let root, embedded, plain, printed;
const dataOf = (html) => JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(html)[1]);
function exportCli(...args) {
  const out = execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', ...args], { cwd: root, encoding: 'utf8' });
  return { out, html: fs.readFileSync(/Exported the map to (.+)/.exec(out)[1].trim(), 'utf8') };
}
before(() => {
  root = shopApp();
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
  assert.deepEqual(g.meta.exported.include, ['flows', 'notes']);
  assert.equal(g.health, undefined);
  assert.equal(g.recent, undefined);
  assert.equal(g.meta.root, null);
  assert.equal(dataOf(plain).meta.exported.embed, undefined);
});

test('--embed says how to put it in a docs page', () => {
  assert.match(printed, /<iframe src="docs-map\.html"[^>]*title="Architecture map" allowfullscreen><\/iframe>/);
  assert.match(printed, /#v=<part id>/);
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
function theme({ search = '', saved } = {}) {
  const attrs = {}, store = new Map(saved ? [['floorplan-theme', saved]] : []), listeners = {};
  const parent = {};
  const win = {
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add() {}, remove() {} } } },
    location: { search },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    addEventListener: (t, f) => { listeners[t] = f; },
    dispatchEvent() {},
    Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: (f) => f(),
    URLSearchParams,
    parent,
  };
  win.window = win;
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
