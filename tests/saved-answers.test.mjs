// Saved answers: Save on the answer card keeps the question and its answer in a small list at the left, for this
// browser tab only. Each one reopens with its answer board, and has its own x. Checks on the built page, like
// phone.test.mjs, plus the list's own rules run in a pretend tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8'); });
after(() => cleanup(root));

/** The savedAnswers() factory from the built page, run against a pretend sessionStorage. */
function loadList(storage) {
  const src = /\/\* saved-answers:start \*\/([\s\S]*?)\/\* saved-answers:end \*\//.exec(html);
  assert.ok(src, 'the page has the saved-answers list code');
  return new Function('sessionStorage', `${src[1]}; return savedAnswers;`)(storage);
}
function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const answer = (question, text = 'An answer.') => ({ title: 'T', answer: text, items: [{ id: 'a', note: '' }], steps: [], followups: [], question });

test('saving keeps the newest first, and saving the same question again replaces the older answer', () => {
  const list = loadList(fakeStorage())();
  list.add(answer('How do orders work?'));
  list.add(answer('Where are payments?'));
  list.add(answer('How do orders work?', 'A newer answer.'));
  assert.deepEqual(list.items().map((a) => a.question), ['How do orders work?', 'Where are payments?']);
  assert.equal(list.items()[0].answer, 'A newer answer.');
  assert.equal(list.has('How do orders work?'), true);
});

test('each saved answer can be removed on its own', () => {
  const list = loadList(fakeStorage())();
  list.add(answer('One?'));
  list.add(answer('Two?'));
  list.remove('One?');
  assert.deepEqual(list.items().map((a) => a.question), ['Two?']);
});

test('the list survives a reload of the same tab (sessionStorage), and whether it is shown is kept too', () => {
  const storage = fakeStorage();
  const first = loadList(storage)();
  first.add(answer('Kept?'));
  first.setOpen(false);
  const again = loadList(storage)();
  assert.deepEqual(again.items().map((a) => a.question), ['Kept?']);
  assert.equal(again.open(), false);
});

test('a finished answer has a Save button; progress lines do not', () => {
  assert.match(html, /function renderAnswer\(a\) \{[\s\S]*?sheetShell\(a\.question, [\s\S]*?, a\);/);
  assert.match(html, /\$\{answer \? `<button class="btn icon[^`]*" data-act="save"/);
});

test('the list sits at the left above the zoom buttons, the Ask bar narrows while it is open, and it is left out of exports and phones', () => {
  assert.match(html, /<div id="saved" class="glass" hidden><\/div>/);
  assert.match(html, /#saved \{ position: absolute; left: 16px; bottom: 66px;/);
  assert.match(html, /body\.saved-open #ask \{ width: min\(700px, calc\(100% - var\(--pw\) - 520px\)\); \}/);
  assert.match(html, /body\.exported #saved \{ display: none; \}/);
});
