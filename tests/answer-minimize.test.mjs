// The answer card can be minimized to its question line and expanded again, so it stops covering the map
// without being thrown away. These are checks on the built page, like phone.test.mjs, not on a real screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'); });
after(() => cleanup(root));

test('the answer card has a minimize button next to Close that names what it will do', () => {
  assert.match(html, /data-act="min" title="\$\{askState\.min \? 'Expand' : 'Minimize'\}" aria-expanded="\$\{!askState\.min\}"/);
});

test('a minimized card hides its body and keeps the question line, which expands it again when clicked', () => {
  assert.match(html, /#ask-sheet\.min \.sb \{ display: none; \}/);
  assert.match(html, /sheet\.classList\.toggle\('min', askState\.min\);/);
  assert.match(html, /sheet\.querySelector\('\.q'\)\.onclick = \(\) => \{ if \(askState\.min\) setMin\(false\); \};/);
});

test('a new question opens the card again, so its answer is never hidden', () => {
  assert.match(html, /async function submitAsk\(\) \{[\s\S]*?askState\.min = false;/);
});
