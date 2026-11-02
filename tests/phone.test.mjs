// Phone layout: the built map has a top bar that wraps instead of running off the screen, icon-only buttons that keep
// a name, 44 px touch targets, and a details sheet that opens when a box is tapped. These are checks on the built page
// (the rules and the code are there, and the start-up line is run against a pretend browser), not on a real screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'); });
after(() => cleanup(root));

/** The CSS inside every @media block of the page with this exact condition, joined (a page can have several with the same condition). */
function media(condition) {
  let out = '', from = 0, found = 0;
  for (;;) {
    const start = html.indexOf(`@media ${condition} {`, from);
    if (start < 0) break;
    let depth = 0, i = html.indexOf('{', start);
    const open = i + 1;
    for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
    out += html.slice(open, i) + '\n'; found++; from = i;
  }
  assert.ok(found > 0, `the page has a rule block for ${condition}`);
  return out;
}

test('on phones and tablets the top bar wraps onto a second row, so nothing can run off the screen', () => {
  const css = media('(max-width: 999px), (max-width: 1279px) and (pointer: coarse)');
  assert.match(css, /header \{[^}]*display: flex; flex-wrap: wrap;/);
  assert.match(css, /\.hr \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.hr \.btn \.bl \{ display: none; \}/);
});

test('a mouse at 1000 px and wider keeps exactly the old top bar: every change to the bar sits inside a phone/tablet rule', () => {
  assert.match(html, /header \{ position: fixed; inset: 0 0 auto 0; height: 64px; display: grid; grid-template-columns: 1fr auto 1fr;/);
  const outside = html.replace(/@media [^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  assert.doesNotMatch(outside, /header \{[^}]*flex-wrap/);
  assert.doesNotMatch(outside, /\.hr \.btn \.bl \{ display: none/);
  assert.doesNotMatch(outside, /#btn-up, \.brand \{ flex: none; \}/); // the Up arrow and logo are not changed on a computer
  assert.doesNotMatch(outside, /header \.btn:focus-visible/);
});

test('every control in the bar has a name that survives when its words are hidden', () => {
  const header = html.match(/<header>[\s\S]*?<\/header>/)[0];
  const buttons = [...header.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 5);
  for (const b of buttons) assert.match(b, /aria-label="[^"]+"/, `${b} has an aria-label`);
  // buttons added by the extra pieces get their words as the name, and Health says how many things need a look
  assert.match(html, /if \(label\) b\.setAttribute\('aria-label', label\)/);
  assert.match(html, /btn\.setAttribute\('aria-label', btn\.title\)/);
});

test('touch targets are at least 44 px on small and touch screens, and the zoom buttons too', () => {
  const css = media('(max-width: 999px), (pointer: coarse)');
  assert.match(css, /header \.btn, #search-btn \{ height: 44px; min-width: 44px; \}/);
  assert.match(css, /header \.btn\.icon \{ width: 44px; \}/);
  assert.match(css, /#zoom button \{ width: 44px; height: 44px; \}/);
  assert.match(css, /#ask-mode button \{ height: 44px; \}/); // the Ask / Change switch too
});

test('on a phone, asking or drafting a change closes the details sheet first, and so does the summary after a change, so nothing hides the ask bar or the summary', () => {
  assert.match(html, /ask: \(text\) => \{ closeSheet\(\); askInput\.value = text; submitAsk\(\); \}/);
  assert.match(html, /draftChange\(text\) \{\s*if \(!canChange\(\)\) return false;\s*closeSheet\(\);/);
  assert.match(html, /function showChangeResult\(\) \{[\s\S]*?closeSheet\(\);[\s\S]*?sheetShell\(c\.question,/);
});

test('on a phone the details panel is a sheet at the bottom that starts closed and does not cover the ask bar', () => {
  const css = media('(max-width: 700px)');
  assert.match(css, /#panel \{ top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-height: min\(56vh, 480px\); \}/);
  assert.match(css, /body:not\(\.no-panel\) #ask \{ display: none; \}/);
  assert.match(css, /#panel-resize \{ display: none; \}/);
});

test('tapping a box on a phone opens the details; going into or out of a box, or tapping empty space, closes them', () => {
  assert.match(html, /if \(sel && isPhone\(\) && document\.body\.classList\.contains\('no-panel'\)\) \{ setPanel\(true\); if \(typeof sel === 'string'\) bringIntoView\(sel\); \}/);
  assert.match(html, /svg\.addEventListener\('click', closeSheet\);/);
  assert.match(html, /closeSheet\(\);\n  go\(item, \{ zoomFrom: item \}\);/);
  assert.match(html, /function up\(\) \{ if \(state\.container === 'root'\) return; closeSheet\(\);/);
  // the choice on a phone is not saved, so it can't close the side panel on a desktop that shares the storage
  assert.match(html, /if \(!isPhone\(\)\) store\.set\('panel', on\);/);
});

test('the top bar height is measured, and everything under it follows', () => {
  assert.match(html, /new ResizeObserver\(syncHeader\)\.observe\(headerEl\)/);
  for (const sel of ['#context', '#flowbar', '#panel', '#panel-resize']) assert.match(html, new RegExp(`${sel} \\{[^}]*calc\\(var\\(--hh, 64px\\) \\+ \\d+px\\)`), `${sel} follows the bar`);
});

test('motion is switched off for people who ask for less of it', () => {
  const css = media('(prefers-reduced-motion: reduce) and (max-width: 999px), (prefers-reduced-motion: reduce) and (pointer: coarse)');
  assert.match(css, /#panel, body\.no-panel #panel, #viewport\.anim, #ask, #flowbar, #zoom button \{ transition: none; \}/);
});

/** Runs the one-line start-up script (before anything is drawn) against a pretend browser. */
function startUp({ phone, hash = '' }) {
  const classes = new Set();
  const script = html.match(/<body>\s*<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    matchMedia: (q) => ({ matches: phone && q.includes('max-width: 700px') }),
    location: { hash },
    window: { self: 1, top: 1 },
    document: { documentElement: { hasAttribute: () => false }, body: { classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) } } },
  });
  return classes;
}

test('a phone starts with the details closed (so they never flash open), unless the link points at a box', () => {
  assert.ok(startUp({ phone: true }).has('no-panel'));
  assert.ok(!startUp({ phone: true, hash: '#v=a&s=n:web' }).has('no-panel'));
  assert.ok(!startUp({ phone: false }).has('no-panel'));
});

test('opening the details sheet on a phone does not re-fit the map', () => {
  assert.match(html, /if \(was !== on && !isPhone\(\)\) fit\(true\);/);
});

test('Flows and Filters open inside the screen wherever the bar wrapped', () => {
  assert.match(media('(max-width: 999px), (max-width: 1279px) and (pointer: coarse)'), /header \.rel \{ position: static; \}[^\n]*\n  #flowmenu, #legend \{ position: fixed;/);
});

test('the zoom buttons move out from under the ask bar on tablets and phones', () => {
  assert.match(html, /@media \(max-width: 999px\), \(max-width: 1279px\) and \(pointer: coarse\) \{\n  header \.hr \.btn \{ width: 44px; \}[\s\S]*?#zoom \{ left: auto; right: calc\(var\(--pw\) \+ 16px\); bottom: auto; top: calc\(var\(--hh, 56px\) \+ 8px\);/);
});

test('the phone sheet is reachable and closable by keyboard: Escape closes it, closed it is hidden from tab and screen readers, focus moves in and back', () => {
  assert.match(media('(max-width: 700px)'), /body\.no-panel #panel \{[^}]*visibility: hidden;/);
  assert.match(html, /else if \(isPhone\(\) && !document\.body\.classList\.contains\('no-panel'\)\) closeSheet\(\);/);
  assert.match(html, /panel\.setAttribute\('role', 'dialog'\); panel\.setAttribute\('aria-label', 'Details'\)/);
  assert.match(html, /if \(on && keyboardUser\) \{ sheetReturn = document\.activeElement; panel\.focus/);
  assert.match(html, /sheetReturn\.focus\?\./);
});

test('on a phone the description folds to one line, with a More / Less button that says whether it is open and is remembered', () => {
  const css = media('(max-width: 700px)');
  assert.match(css, /#context\.folded \.cd \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; \}/);
  assert.match(css, /#context \.ctx-more:not\(\[hidden\]\) \{ display: inline-flex; align-items: center; min-height: 44px;/);
  assert.match(html, /\.ctx-more \{ display: none; \}/); // only phones show it
  assert.match(html, /<button type="button" class="ctx-more" aria-controls="ctx-desc" hidden><\/button>/);
  assert.match(html, /more\.setAttribute\('aria-expanded', String\(open\)\);/);
  assert.match(html, /store\.set\('contextOpen', !open\)/);
  assert.match(html, /desc\.inert = isPhone\(\) && long && !open;/); // the hidden lines can't be tabbed into
});

test('on a phone the warning about connecting an AI tool shows only while the ask bar is in use, and is read out when it appears', () => {
  assert.match(media('(max-width: 700px)'), /#ask:not\(\.asking\) #ask-warn \{ display: none; \}/);
  assert.match(html, /<div id="ask-live" role="status" aria-live="polite"><\/div>/);
  assert.match(html, /\['pointerdown', 'touchstart', 'focusin'\]\.forEach\(\(t\) => askBox\.addEventListener\(t, \(\) => askOn\(true\)/); // a tap counts even when the input is switched off
  assert.match(html, /askBox\.addEventListener\('focusout', \(ev\) => \{ if \(!askBox\.contains\(ev\.relatedTarget\)\) askOn\(false\); \}\);/);
  assert.match(html, /const on = isPhone\(\) && askInput\.disabled && !warn\.hidden; if \(on\) \{ askForm\.tabIndex = 0;/); // keyboard users can reach the note when the input is switched off
});

test('on a phone the zoom buttons sit side by side in the top row, beside the search icon', () => {
  assert.match(media('(max-width: 700px)'), /header #zoom \{ position: static; flex: none; flex-direction: row;/);
  assert.match(html, /if \(isPhone\(\)\) headerEl\.insertBefore\(zoomEl, headerEl\.querySelector\('\.hc'\)\); else zoomHome\.insertBefore\(zoomEl, zoomNext\);/);
  assert.match(media('(max-width: 700px)'), /#crumbs button:not\(\.cur\), #crumbs \.sep \{ display: none; \}/); // the path shows where you are, so the row fits at 360 px
});

test('nothing new shows on a computer: the buttons added no new tooltips', () => {
  assert.doesNotMatch(html, /id="search-btn" title=/);
  assert.doesNotMatch(html, /id="flows-btn" title=/);
});
