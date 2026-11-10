// Maps for everyone are written in plain words. The build warns (never fails) when a part's label or summary
// uses developer words from the writing guide's "Jargon → plain" table or names a framework, and when a part
// holds many files that sit in folders of their own, so whoever writes the map can fix it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILL, lib, shopApp, makeProject, run, readJson, writeJson, cleanup } from './helpers.mjs';

const ARCH_FILE = (root) => path.join(root, 'floorplan', 'architecture.json');
/** build.mjs --json on a project: { code, json }. */
function build(root) {
  try { return { code: 0, json: JSON.parse(execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'build.mjs'), root, '--json', '--no-claude-md'], { encoding: 'utf8', stdio: 'pipe' })) }; }
  catch (e) { return { code: e.status, json: JSON.parse(String(e.stdout)) }; }
}

test('the words it catches, each once, and the product names it leaves alone', async () => {
  const { jargonIn } = await lib('names.mjs');
  const terms = (s, o) => jargonIn(s, o).map((j) => j.term);
  assert.deepEqual(terms('API client'), ['API client'], 'a phrase is reported once, not again as "API"');
  assert.deepEqual(terms('UI kit'), ['UI kit']);
  assert.deepEqual(terms('App shell & shared logic'), ['App shell']);
  assert.deepEqual(terms('The React screens and the Express server'), ['React', 'Express server']);
  assert.deepEqual(terms('Docker Compose starts the backend'), ['Docker Compose', 'backend']);
  assert.deepEqual(terms('Checks every webhook from Stripe'), ['webhook']);
  assert.deepEqual(terms('Database migrations'), ['migrations']);
  // plain words, product names the guide keeps, and everyday uses of words that are also tools
  for (const fine of ['Main server', 'Sign-in', 'Takes card payments through Stripe', 'Postgres database', 'Shopify listings',
    'Sends emails with SendGrid', 'Express delivery options', 'Spring sale prices', 'Customer sessions', 'Support queue',
    'Training sessions for workers', 'The Rails of the train set', 'Light fixtures', 'Store settings', 'Google Cloud files']) {
    assert.deepEqual(terms(fine), [], fine);
  }
  // an outside service's own node may be named after the product
  assert.deepEqual(terms('Prisma Accelerate', { frameworks: false }), []);
});

test('screen words count only where they mean screens: hooks, components and shells', async () => {
  const { jargonIn } = await lib('names.mjs');
  const terms = (s, o) => jargonIn(s, o).map((j) => j.term);
  // a React-style hook is jargon
  assert.deepEqual(terms('Custom hooks for the cart'), ['Custom hooks']);
  assert.deepEqual(terms('The useCart hook keeps totals'), ['useCart hook']);
  assert.deepEqual(terms('Shared hooks and context providers'), ['Shared hooks', 'context providers']);
  // near misses: hooks that aren't screen logic, which "shared screen logic" would describe wrongly
  for (const fine of ['Runs the project template\'s set-up hooks', 'Git hooks that check commits before they\'re saved', 'Hooks into the shipping service', 'Fishing hooks and lures', 'A shell script that backs up the files', 'Cryptographic primitives for signing']) {
    assert.deepEqual(terms(fine, { screens: false }), [], fine);
  }
  // "component" is a screen word on a part that is screens, and an ordinary word elsewhere
  assert.deepEqual(terms('Shared components', { screens: true }), ['components']);
  assert.deepEqual(terms('The billing component of the server', { screens: false }), []);
  assert.deepEqual(terms('UI components for the server\'s admin pages', { screens: false }), ['UI components']);
});

test('the list of words is the guide\'s: every entry points at a row of the "Jargon → plain" table', async () => {
  const { JARGON } = await lib('names.mjs');
  const guide = fs.readFileSync(path.join(SKILL, 'references', 'writing-descriptions.md'), 'utf8');
  const table = /### Jargon → plain\n([\s\S]*?)\n\n/.exec(guide)[1];
  const rows = table.split('\n').slice(2).map((l) => l.split('|')[1].trim());
  for (const j of JARGON) assert.ok(rows.includes(j.row), `names.mjs JARGON row "${j.row}" is not a row of the guide's table`);
  assert.match(guide, /build\.mjs` warns when a part's `label` or `summary`/, 'the guide says the build checks these');
});

test('a map for everyone: developer words in labels and summaries are warnings that name the part', () => {
  const p = shopApp();
  try {
    const arch = readJson(ARCH_FILE(p));
    arch.nodes = [
      { id: 'api', label: 'Main server', kind: 'service', summary: 'The Express server and its middleware.', paths: ['shop-api/**'] },
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The pages customers use.', paths: ['shop-web/src/App.jsx'] },
      { id: 'client', label: 'API client', kind: 'library', parent: 'web', summary: 'Asks the main server for orders.', paths: ['shop-web/src/api.js'] },
      { id: 'pg', label: 'Postgres', kind: 'external', summary: 'Where Stripe payments and orders are kept.' },
    ];
    writeJson(ARCH_FILE(p), arch);
    run('scan.mjs', p);
    const { code, json } = build(p);
    assert.equal(code, 0, 'a warning never fails the build');
    assert.equal(json.ok, true);
    assert.deepEqual(json.plainLanguage, {
      checked: true,
      count: 2,
      items: [
        { node: 'api', field: 'summary', term: 'Express server', say: "a framework or library's name: say what the part does instead (it may appear once, in project.summary)" },
        { node: 'api', field: 'summary', term: 'middleware', say: 'a check every request passes through ("makes sure you\'re signed in")' },
        { node: 'client', field: 'label', term: 'API client', say: 'ready-made code for talking to a service ("talks to Stripe", "server connection")' },
      ],
    });
    const warning = json.warnings.find((w) => w.startsWith('plain language: node "client"'));
    assert.equal(warning, 'plain language: node "client" uses developer words: "API client" in its label (ready-made code for talking to a service ("talks to Stripe", "server connection")). This map is for everyone, so reword them ("Jargon → plain" in references/writing-descriptions.md).');
    assert.ok(!json.warnings.some((w) => /node "(web|pg)"/.test(w)), 'plain parts, and product names on an outside service, are left alone');
    assert.match(json.report, /plain language: node "api" uses developer words: "Express server" in its summary/);
    // the same in the plain report people read
    assert.match(run('build.mjs', p, '--no-claude-md', '--check'), /! \d+ warning\(s\):[\s\S]*plain language: node "client"/);
  } finally { cleanup(p); }
});

test('a map for developers is not checked, and a plain map has nothing to report', () => {
  const p = shopApp();
  try {
    const arch = readJson(ARCH_FILE(p));
    writeJson(ARCH_FILE(p), { ...arch, audience: 'developers', nodes: arch.nodes.map((n) => ({ ...n, summary: 'Express API with middleware and a React frontend.' })) });
    run('scan.mjs', p);
    let { json } = build(p);
    assert.deepEqual(json.plainLanguage, { checked: false, count: 0, items: [] });
    assert.ok(!json.warnings.some((w) => w.startsWith('plain language')));
    writeJson(ARCH_FILE(p), arch);
    ({ json } = build(p));
    assert.deepEqual(json.plainLanguage, { checked: true, count: 0, items: [] });
    assert.deepEqual(json.partsToSplit, []);
  } finally { cleanup(p); }
});

test('a part with many files in folders of its own gets a gentle warning naming the folders', () => {
  const files = {};
  for (const [dir, n] of [['items', 9], ['admin', 8], ['settings', 7], ['sidebar', 3]]) for (let i = 0; i < n; i++) files[`web/src/components/${dir}/Part${i}.jsx`] = `export default function Part${i}() { return null; }\n`;
  for (let i = 0; i < 30; i++) files[`web/src/flat/F${i}.jsx`] = `export const f${i} = ${i};\n`;
  for (let i = 0; i < 30; i++) files[`web/tests/a${i % 3}/t${i}.test.js`] = `export const t${i} = ${i};\n`;
  const p = makeProject(files, { repos: ['web'], arch: { project: { name: 'Web' }, nodes: [
    { id: 'blocks', label: 'Screen parts', kind: 'ui', summary: 'Everything on the screens.', paths: ['web/src/components/**'] },
    { id: 'flat', label: 'Small pieces', kind: 'ui', summary: 'Small pieces.', paths: ['web/src/flat/**'] },
    { id: 'checks', label: 'Checks', kind: 'test', summary: 'Automatic checks.', paths: ['web/tests/**'] },
  ] } });
  try {
    run('scan.mjs', p);
    const { code, json } = build(p);
    assert.equal(code, 0);
    assert.deepEqual(json.partsToSplit, [{ id: 'blocks', files: 27, folders: [
      { dir: 'web/src/components/items', files: 9 }, { dir: 'web/src/components/admin', files: 8 },
      { dir: 'web/src/components/settings', files: 7 }, { dir: 'web/src/components/sidebar', files: 3 },
    ] }], 'one flat folder, and a part made of tests, are fine');
    assert.ok(json.warnings.includes('node "blocks" holds 27 files and no smaller parts, and they sit in folders that could each be one: web/src/components/items/ (9), web/src/components/admin/ (8), web/src/components/settings/ (7), web/src/components/sidebar/ (3). Consider children by feature area ("Second level" in references/choosing-boundaries.md).'), json.warnings.join('\n'));
    // once it has children, it's fine
    const arch = readJson(ARCH_FILE(p));
    arch.nodes.push({ id: 'items', label: 'Items', kind: 'ui', parent: 'blocks', summary: 'Items.', paths: ['web/src/components/items/**'] });
    writeJson(ARCH_FILE(p), arch);
    assert.deepEqual(build(p).json.partsToSplit, []);
  } finally { cleanup(p); }
});
