// Light and dark: the built map carries both themes, picks one before anything is drawn, and has one Theme button.
// The boot script is run here against a pretend browser, so the choice logic is checked without a real one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'); });
after(() => cleanup(root));

const bootScript = () => {
  const at = html.indexOf('/* Theme: runs before');
  return html.slice(html.lastIndexOf('<script>', at) + '<script>'.length, html.indexOf('</script>', at));
};

/** Runs the boot script with a pretend device and returns what it did to the page. */
function boot({ saved, deviceLight = false, storageThrows = false } = {}) {
  const attrs = {}, classes = new Set(), store = new Map(saved ? [['floorplan-theme', saved]] : []);
  const listeners = {}, events = [];
  const mq = { matches: deviceLight, addEventListener: (_, f) => { mq.change = f; } };
  const win = {
    document: { documentElement: { hasAttribute: () => false, setAttribute: (k, v) => { attrs[k] = v; }, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } } },
    matchMedia: () => mq,
    localStorage: { getItem: (k) => { if (storageThrows) throw new Error('blocked'); return store.get(k) ?? null; }, setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); store.set(k, v); } },
    addEventListener: (t, f) => { listeners[t] = f; },
    dispatchEvent: (e) => { events.push(e.type); },
    Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: (f) => f(),
  };
  win.window = win;
  vm.runInNewContext(bootScript(), Object.assign(win, { Event: win.Event }));
  return { attrs, store, mq, events, theme: win.floorplanTheme, classes };
}

test('the page has a dark and a light set of colours, and dark stays the default', () => {
  assert.match(html, /:root \{[^}]*--bg: #0f0f0f;/);
  assert.match(html, /:root\[data-theme="light"\] \{[^}]*--bg: #f3f3f1;/);
  assert.match(html, /:root\[data-theme="light"\] \{[^}]*color-scheme: light;/);
  // every colour variable dark defines is also given a light value
  const vars = (block) => new Set([...block.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const dark = vars(html.match(/\n:root \{([\s\S]*?)\n\}/)[1]);
  const light = vars(html.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)[1]);
  const sameInBoth = new Set(['--sans', '--mono', '--r-card', '--r-panel', '--r-ctl', '--ease', '--ease-io', '--panel-w', '--pw', '--gutter', '--m-ANY', '--focus']);
  for (const v of dark) assert.ok(light.has(v) || sameInBoth.has(v), `${v} has no light value`);
});

test('the page no longer paints with fixed white tints that would vanish on light', () => {
  // the light block itself may use white (white boxes); everywhere else tints go through --ink
  const outsideLight = html.replace(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/, '');
  const left = outsideLight.match(/rgba\(255, 255, 255, [.\d]+\)/g) || [];
  assert.equal(left.length, 0, `fixed white tints left: ${left.join(' ')}`);
});

test('the boot script is in the head, before the page is drawn', () => {
  assert.ok(html.indexOf('Theme: runs before') < html.indexOf('<style>'), 'script comes before the styles');
  assert.ok(html.indexOf('Theme: runs before') < html.indexOf('<body>'));
});

test('Auto follows the device, live', () => {
  const dark = boot({ deviceLight: false });
  assert.equal(dark.attrs['data-theme'], 'dark');
  const light = boot({ deviceLight: true });
  assert.equal(light.attrs['data-theme'], 'light');
  dark.mq.matches = true; dark.mq.change();
  assert.equal(dark.attrs['data-theme'], 'light');
});

test('a saved choice wins over the device, and a new choice is saved', () => {
  assert.equal(boot({ saved: 'dark', deviceLight: true }).attrs['data-theme'], 'dark');
  assert.equal(boot({ saved: 'light', deviceLight: false }).attrs['data-theme'], 'light');
  const b = boot({ deviceLight: false });
  b.theme.set('light');
  assert.equal(b.store.get('floorplan-theme'), 'light');
  assert.equal(b.attrs['data-theme'], 'light');
  assert.equal(b.theme.get(), 'light');
  assert.ok(b.events.length >= 2, 'the button is told');
});

test('an unknown saved value is ignored, and blocked storage still works for this visit', () => {
  assert.equal(boot({ saved: 'purple', deviceLight: false }).attrs['data-theme'], 'dark');
  const b = boot({ storageThrows: true, deviceLight: false });
  b.theme.set('light');
  assert.equal(b.attrs['data-theme'], 'light');
  assert.equal(b.theme.get(), 'light');
});

test('the Theme button is in the built page with a plain label, a 44 px target and a visible focus ring', () => {
  assert.match(html, /\/\* ui\/05-theme\.js \*\//);
  assert.ok(html.includes('Theme: ${NAME[c]}. Press for ${WORD[NEXT[c]]}.'));
  assert.ok(html.includes("auto: 'Auto (follows your device)'"));
  assert.match(html, /#theme-toggle \{[^}]*width: 44px; height: 44px;/);
  assert.match(html, /#theme-toggle:focus-visible \{ outline: 2px solid/);
  assert.match(html, /prefers-reduced-motion: reduce\) \{ #theme-toggle/);
});

test('in Light, text on the red and amber Health chip is readable (4.5:1 or better)', () => {
  const light = html.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)[1];
  const get = (name) => light.match(new RegExp(`${name}: (#[0-9a-f]{3,6})`, 'i'))[1].replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3');
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  for (const chip of ['--sev-high', '--sev-medium']) assert.ok(ratio(get('--on-sev-text'), get(chip)) >= 4.5, `${chip} chip is too faint`);
  assert.ok(ratio(get('--text-3'), get('--raise')) >= 4.5, 'the search box text is too faint');
});

test("the search box gives up the Theme button's room so the project name and buttons fit as before", () => {
  assert.match(html, /@media \(min-width: 701px\) \{ #search-btn \{ width: min\(460px, max\(calc\(36vw - 48px\), 250px\)\); \} \}/);
});
