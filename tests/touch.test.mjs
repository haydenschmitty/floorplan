// Touch gestures: the built map lets a finger drag it, two fingers pinch and move it, and no gesture leaves it stuck or
// re-fits it. These are checks on the built page (the rules and the code are there), not on a real screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'); });
after(() => cleanup(root));

test('the map takes the touch itself, and the page does not bounce under it (touch screens only)', () => {
  assert.match(html, /#stage \{ cursor: grab; touch-action: none; \}/); // a finger can drag the map, and a pinch doesn't zoom the whole page
  assert.match(html, /@media \(pointer: coarse\) \{ html, body \{ overscroll-behavior: none; \} \}/);
});

test('two fingers pinch the map (zooming around the point between them) and move it, using the same limits as the wheel', () => {
  assert.match(html, /const k = clamp\(t0\.k \* now\.d \/ pinch\.d, 0\.08, 2\.5\)/);
  assert.match(html, /const k = clamp\(state\.t\.k \* f, 0\.08, 2\.5\)/); // the wheel's limits
  assert.match(html, /if \(fingers\.size === 2\) \{ if \(drag\?\.moved\) swallowClick = true; drag = null;/); // the second finger ends the one-finger drag
});

test('a drag follows only the finger that started it, ends when the browser cancels the touch, and a phone\'s address bar does not re-fit the map', () => {
  assert.match(html, /if \(!drag \|\| ev\.pointerId !== drag\.id\) return;/);
  assert.match(html, /window\.addEventListener\('pointercancel', endDrag\)/);
  assert.match(html, /window\.addEventListener\('pointercancel', liftFinger\)/);
  assert.match(html, /if \(matchMedia\('\(pointer: coarse\)'\)\.matches && \(heightOnly \|\| drag \|\| pinch\)\) return;\n  fit\(false\);/);
});

test('a third finger is ignored, and the click that ends a drag is swallowed once and cleared at the next touch, so the next tap still works', () => {
  assert.match(html, /swallowClick = false; svg\.classList\.remove\('anim'\)/);
  assert.match(html, /if \(ev\.pointerType === 'touch'\) \{\n    if \(fingers\.size >= 2\) return; \/\/ a third finger is ignored/);
});

test('a tap does not leave a hover tooltip over the details, and a tooltip stays on a narrow screen', () => {
  assert.match(html, /\(ev\) => \{ touching = ev\.pointerType === 'touch'; \}/);
  assert.match(html, /if \(!html \|\| touching \|\| drag\?\.moved/);
  assert.match(html, /tip\.style\.left = Math\.max\(8, x\) \+ 'px'; tip\.style\.top = Math\.max\(8, y\) \+ 'px';/);
});

test('none of this changes a mouse: the glide is only cancelled for a finger, and a mouse drag keeps its original one-time click guard', () => {
  assert.match(html, /if \(ev\.pointerType === 'touch'\) swallowClick = true; else stage\.addEventListener\('click', \(e\) => e\.stopPropagation\(\), \{ capture: true, once: true \}\)/);
  assert.match(html, /stage\.addEventListener\('click', \(\) => select\(null\)\);/);
});
