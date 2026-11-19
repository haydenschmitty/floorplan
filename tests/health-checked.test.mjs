// "What was checked": a clean Health panel means something only if each check had something to look at. Health
// says, per check, what it read or that it found nothing to read, louder when the code looks like it runs a server
// but no endpoints were found (#53). In graph.json, in the build's report and --json, and in the Health panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SKILL, makeProject, run, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const ARCH = { project: { name: 'Sample', summary: 'A sample app.' }, nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'The app.', paths: ['**'] }] };
const byCheck = (graph) => Object.fromEntries(graph.health.checked.map((c) => [c.check, c]));

test('a server whose endpoints the scan can’t see: the endpoint check says it didn’t run, loudly', () => {
  const root = makeProject({
    'package.json': JSON.stringify({ name: 'raw' }),
    'server.js': `import http from 'node:http';\nhttp.createServer((req, res) => {\n  if (req.url === '/orders') return res.end(JSON.stringify(listOrders()));\n  res.end('ok');\n}).listen(3000);\nfunction listOrders() { return []; }\n`,
    'web/index.html': `<!doctype html><title>Shop</title>\n`,
  }, { arch: ARCH });
  try {
    const out = scanAndBuild(root);
    const graph = readGraph(root);
    assert.equal(graph.routes.length, 0);
    const c = byCheck(graph);
    assert.deepEqual(Object.keys(c), ['endpoints', 'supabase', 'firebase', 'stripe', 'secrets']);
    assert.equal(c.endpoints.checked, false);
    assert.equal(c.endpoints.loud, true);
    assert.match(c.endpoints.text, /no endpoints found, but server\.js looks like it runs a server \(it calls http\.createServer\)/);
    for (const k of ['supabase', 'firebase', 'stripe']) { assert.equal(c[k].checked, false, k); assert.equal(c[k].loud, undefined, k); }
    assert.equal(c.supabase.text, 'no Supabase found');
    assert.match(c.secrets.text, /^read \d+ files$/);
    // the report says so next to HEALTH, so the agent passes it on
    assert.match(out, /HEALTH {2}nothing found\n {2}what was checked:\n {2}! Endpoint sign-in: not checked: no endpoints found, but server\.js/);
    assert.match(out, / {2}· Supabase table rules: no Supabase found/);
    const json = JSON.parse(run('build.mjs', root, '--no-claude-md', '--json'));
    assert.deepEqual(json.health.checked, graph.health.checked);
  } finally { cleanup(root); }
});

test('each check says what it read: endpoints, Supabase tables, Firebase rules files, Stripe webhooks, files', () => {
  const root = makeProject({
    'package.json': JSON.stringify({ name: 'full', dependencies: { express: '^4.19.0', stripe: '^16.0.0', '@supabase/supabase-js': '^2.45.0' } }),
    'server/index.js': [
      `import express from 'express';`,
      `import Stripe from 'stripe';`,
      `const app = express();`,
      `const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);`,
      `app.get('/api/orders', requireUser, (req, res) => res.json([]));`,
      `app.post('/api/orders', requireUser, (req, res) => res.json({}));`,
      `app.post('/api/stripe', express.raw({ type: 'application/json' }), (req, res) => {`,
      `  const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);`,
      `  if (event.type === 'checkout.session.completed') fulfil(event);`,
      `  res.end();`,
      `});`,
      `function requireUser(req, res, next) { if (!req.user) return res.status(401).end(); next(); }`,
      `function fulfil() {}`,
      `app.listen(3000);`,
    ].join('\n'),
    'src/db.ts': `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);\n`,
    'supabase/migrations/1_init.sql': `create table public.notes (id bigint primary key);\nalter table public.notes enable row level security;\ncreate table public.tags (id bigint primary key);\nalter table public.tags enable row level security;\n`,
    'firestore.rules': `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /users/{uid} {\n      allow read, write: if request.auth != null && request.auth.uid == uid;\n    }\n  }\n}\n`,
  }, { arch: ARCH });
  try {
    const out = scanAndBuild(root);
    const c = byCheck(readGraph(root));
    assert.deepEqual(Object.values(c).map((x) => [x.check, x.checked, x.text, !!x.loud]), [
      ['endpoints', true, 'checked 3 endpoints', false],
      ['supabase', true, 'checked 2 tables in the migrations', false],
      ['firebase', true, 'checked 1 rules file', false],
      ['stripe', true, 'checked 1 file that receives Stripe events', false],
      ['secrets', true, c.secrets.text, false],
    ]);
    assert.match(out, / {2}✓ Endpoint sign-in: checked 3 endpoints\n/);
  } finally { cleanup(root); }
});

test('nothing to look at, without a server in sight: said plainly, not loudly; an app on Supabase with no migrations is loud', () => {
  const root = makeProject({
    'package.json': JSON.stringify({ name: 'site', dependencies: { '@supabase/supabase-js': '^2.45.0', stripe: '^16.0.0' } }),
    'src/main.ts': `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);\nimport Stripe from 'stripe';\nexport const s = Stripe;\n`,
    // a dev server started by a build tool's createServer isn't the app's server
    'scripts/dev.js': `import { createServer } from 'vite';\nconst server = await createServer({});\nawait server.listen();\n`,
  }, { arch: ARCH });
  try {
    scanAndBuild(root);
    const c = byCheck(readGraph(root));
    assert.equal(c.endpoints.loud, undefined, c.endpoints.text);
    assert.match(c.endpoints.text, /^not checked: no endpoints found\. If your app has a server/);
    assert.equal(c.supabase.loud, true);
    assert.match(c.supabase.text, /^not checked: the app uses Supabase, but no migrations that create tables were found/);
    assert.equal(c.stripe.text, 'the app uses Stripe, but no code that receives its events was found');
  } finally { cleanup(root); }
});

test('a Supabase Edge Function with no endpoints the scan can see makes the endpoint line loud', () => {
  const root = makeProject({
    'supabase/functions/send-invite/index.ts': `export default async function handler(req: Request) {\n  return new Response('ok');\n}\n`,
  }, { arch: ARCH });
  try {
    scanAndBuild(root);
    const c = byCheck(readGraph(root));
    assert.equal(c.endpoints.loud, true);
    assert.match(c.endpoints.text, /supabase\/functions\/send-invite\/index\.ts looks like it runs a server \(it’s a Supabase Edge Function\)/);
  } finally { cleanup(root); }
});

test('PHP that answers requests itself, with no endpoints the scan can see, makes the endpoint line loud', () => {
  const page = (body) => `<?php\nrequire __DIR__.'/lib/db.php';\n${body}\n`;
  const loud = (files) => {
    const root = makeProject({ 'lib/db.php': '<?php\nfunction save($x) {}\n', ...files }, { arch: ARCH });
    try { scanAndBuild(root); return byCheck(readGraph(root)).endpoints; } finally { cleanup(root); }
  };
  let c = loud({ 'app/contact.php': page(`if ($_SERVER['REQUEST_METHOD'] === 'POST') { save($_POST['email']); }`) });
  assert.equal(c.loud, true);
  assert.match(c.text, /app\/contact\.php looks like it runs a server \(it reads \$_SERVER\['REQUEST_METHOD'\]\)/);
  // under a document root the same script is a page: an endpoint, found though Health can't judge it yet, so not loud
  c = loud({ 'public/contact.php': page(`if ($_SERVER['REQUEST_METHOD'] === 'POST') { save($_POST['email']); }`) });
  assert.equal(c.loud, undefined, c.text);
  assert.match(c.text, /^not checked: 1 endpoint found, but set up in a way Floorplan can’t check for a login yet/);
  c = loud({ 'src/Controller/OrderController.php': `<?php\nclass OrderController {\n    #[Route('/orders', methods: ['GET'])]\n    public function list() { return []; }\n}\n` });
  assert.match(c.text, /OrderController\.php looks like it runs a server \(it declares routes with #\[Route\]\)/);
  c = loud({ 'index.php': `<?php\n$app = AppFactory::create();\n$app->get('/orders', fn ($req, $res) => $res);\n$app->run();\n` });
  assert.match(c.text, /index\.php looks like it runs a server \(it calls \$app->get\)/);
  // only mentioned in a comment or a string, a container's $app->get('config'), a template showing a value, or a test: quiet
  c = loud({
    'src/notes.php': page(`// read $_POST here later\n$help = 'use $_GET and $_SERVER["REQUEST_METHOD"]';\n$config = $app->get('config');`),
    'resources/views/form.blade.php': `<p>{{ $_GET['q'] ?? '' }}</p>\n`,
    'tests/Feature/ContactTest.php': page(`$_POST['email'] = 'a@example.com';`),
  });
  assert.equal(c.loud, undefined, c.text);
  assert.match(c.text, /^not checked: no endpoints found\. If your app has a server/);
});

// ---------- the Health panel ----------

/** Runs the Health panel's code against a stand-in for the viewer, and returns the list's HTML and the overview row's. */
function panel(health) {
  const shown = [];
  const sections = {};
  let button;
  const el = () => ({ style: { setProperty() {} }, classList: { toggle() {} }, setAttribute() {}, appendChild() {}, remove() {}, querySelector: () => ({ innerHTML: '' }) });
  const h = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const SC = {
    graph: { health, meta: { rootName: 'sample' } }, h, exported: false, agent: { name: 'Claude', app: 'Claude Code' },
    store: { get: (k, d) => d, set() {} }, icons: {}, state: {},
    icon: () => '', iconI: () => '', plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
    addHeaderButton: (b) => { button = Object.assign(el(), b); return button; },
    addPanelSection: (where, fn) => { sections[where] = fn; },
    showPanel: (html) => shown.push(html), closePanel() {}, refreshPanel() {}, on() {},
  };
  const context = { window: { Floorplan: SC }, document: { createElement: el, head: { appendChild() {} } }, fetch: () => Promise.reject(new Error('offline')) };
  vm.runInNewContext(fs.readFileSync(path.join(SKILL, 'assets', 'ui', '20-health.js'), 'utf8'), context);
  button.onClick();
  return { list: shown.pop(), overview: sections.overview().html };
}

test('the Health panel lists what was checked, the gaps standing out, with file names shown as text', () => {
  const health = {
    summary: { high: 0, medium: 0, low: 0 }, issues: [],
    checked: [
      { check: 'endpoints', label: 'Endpoint sign-in', checked: false, loud: true, text: 'not checked: no endpoints found, but <img src=x onerror=alert(1)>.js looks like it runs a server' },
      { check: 'secrets', label: 'Secrets in code', checked: true, text: 'read 12 files' },
    ],
  };
  const { list, overview } = panel(health);
  assert.match(list, /<h3>What was checked<\/h3>/);
  assert.match(list, /class="k loud"[^>]*>.*<b>Endpoint sign-in:<\/b> not checked: no endpoints found, but &lt;img src=x onerror=alert\(1\)&gt;\.js/);
  assert.doesNotMatch(list, /<img/);
  assert.match(list, /<div class="k"><span class="dot" style="background:var\(--ok\)"><\/span><span><b>Secrets in code:<\/b> read 12 files/);
  // "nothing stood out" doesn't read as all clear while a check had nothing to look at
  assert.match(list, /Nothing stood out, but one check had nothing to look at/);
  assert.match(overview, /Endpoint sign-in: nothing found to check/);
  // a map built before this, with no list, looks as it did
  const old = panel({ summary: { high: 0, medium: 0, low: 0 }, issues: [] });
  assert.doesNotMatch(old.list, /What was checked/);
  assert.match(old.list, /Nothing stood out\./);
});
