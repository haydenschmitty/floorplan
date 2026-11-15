// Health's checks for the usual mistakes in apps built on Supabase, Firebase, Stripe, Next.js and Vite:
// tables without row-level security, Firebase rules that let anyone in, Stripe webhooks that don't
// check the signature, secret keys in variables the browser gets, and CORS that allows every website.
// Each check has cases it must find and look-alikes it must leave alone (a false alarm costs more than
// a miss). Secret-looking values are assembled at runtime so none is ever committed to this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, makeProject, scanAndBuild, readGraph, cleanup, openEndpoints } from './helpers.mjs';

const { findIssues, leakyPublicVar } = await lib('health.mjs');
const find = (src, file, lang, k) => findIssues(src, { path: file, category: 'code', lang }).filter((x) => x.k === k);
const FAKE_OPENAI_KEY = ['sk', 'proj', 'Zq8x', 'T3Bl', 'bkFJ', 'k2m9', 'Wv4r', 'Lp7d', 'Hs1n'].join('');
const NEXT_YEAR = new Date().getUTCFullYear() + 1;

// ---------- secret keys in variables the browser gets ----------

test('public variables named like secret keys are recognised, and keys that are public by design are not', () => {
  assert.equal(leakyPublicVar('VITE_OPENAI_API_KEY'), 'OpenAI');
  assert.equal(leakyPublicVar('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY'), 'Supabase');
  assert.equal(leakyPublicVar('NEXT_PUBLIC_STRIPE_SECRET_KEY'), 'Stripe');
  assert.equal(leakyPublicVar('REACT_APP_ANTHROPIC_KEY'), 'Anthropic');
  assert.equal(leakyPublicVar('NEXT_PUBLIC_DATABASE_URL'), '');
  for (const ok of ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'VITE_FIREBASE_API_KEY',
    'VITE_GOOGLE_MAPS_API_KEY', 'NEXT_PUBLIC_GITHUB_CLIENT_ID', 'NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'NEXT_PUBLIC_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY']) {
    assert.equal(leakyPublicVar(ok), null, ok);
  }
});

test('code that reads a secret from a public variable is found, wherever the framework reads them', () => {
  assert.deepEqual(find(`const key = import.meta.env.VITE_OPENAI_API_KEY;\n`, 'src/chat.ts', 'typescript', 'public-env').map((x) => [x.name, x.line]), [['VITE_OPENAI_API_KEY', 1]]);
  assert.equal(find(`fetch(u, { headers: { Authorization: process.env['NEXT_PUBLIC_STRIPE_SECRET_KEY'] } })`, 'app/page.tsx', 'typescript', 'public-env').length, 1);
  assert.equal(find(`import { PUBLIC_OPENAI_KEY } from '$env/static/public';`, 'src/routes/+page.svelte', 'svelte', 'public-env').length, 1);
  // PUBLIC_ means nothing to Node, the anon key is public by design, and tests are left alone
  assert.deepEqual(find(`const k = process.env.PUBLIC_OPENAI_KEY;`, 'server.js', 'javascript', 'public-env'), []);
  assert.deepEqual(find(`createClient(url, import.meta.env.VITE_SUPABASE_ANON_KEY)`, 'src/db.ts', 'typescript', 'public-env'), []);
  assert.deepEqual(find(`const key = import.meta.env.VITE_OPENAI_API_KEY;`, 'src/chat.test.ts', 'typescript', 'public-env'), []);
});

// ---------- Stripe webhooks ----------

test('code that acts on Stripe payment events without checking the signature is found', () => {
  const js = [
    `import Stripe from 'stripe';`,
    `export async function POST(req) {`,
    `  const event = await req.json();`,
    `  switch (event.type) {`,
    `    case 'checkout.session.completed': await markPaid(event.data.object); break;`,
    `    case 'customer.subscription.deleted': await cancel(event.data.object); break;`,
    `  }`,
    `}`,
  ].join('\n');
  const [hit] = find(js, 'app/api/webhooks/stripe/route.ts', 'typescript', 'stripe-unsigned');
  assert.equal(hit.line, 5);
  assert.deepEqual(hit.events, ['checkout.session.completed', 'customer.subscription.deleted']);
  const py = `import stripe\n@app.post("/stripe")\nasync def hook(request):\n    event = await request.json()\n    if event["type"] == "invoice.paid":\n        grant_credits(event)\n`;
  assert.equal(find(py, 'api/billing.py', 'python', 'stripe-unsigned').length, 1);
});

test('verified Stripe webhooks, and code that only starts a checkout, are left alone', () => {
  const verified = `const event = stripe.webhooks.constructEvent(body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);\nif (event.type === 'checkout.session.completed') fulfil(event);`;
  assert.deepEqual(find(verified, 'server/stripe.js', 'javascript', 'stripe-unsigned'), []);
  const py = `event = stripe.Webhook.construct_event(payload, sig, secret)\nif event["type"] == "invoice.paid":\n    pay()`;
  assert.deepEqual(find(py, 'billing.py', 'python', 'stripe-unsigned'), []);
  // listing the events to subscribe to isn't handling them
  const setup = `await stripe.webhookEndpoints.create({ url, enabled_events: ['checkout.session.completed'] });`;
  assert.deepEqual(find(setup, 'scripts/setup-stripe.js', 'javascript', 'stripe-unsigned'), []);
});

// ---------- CORS ----------

test('CORS that allows every website is found, and marked serious only when login cookies go along', () => {
  const cors = (src, file = 'server.js', lang = 'javascript') => find(src, file, lang, 'cors-any').map((x) => x.credentials);
  assert.deepEqual(cors(`import cors from 'cors';\napp.use(cors());`), [false]);
  assert.deepEqual(cors(`const cors = require('cors');\napp.use(cors({ origin: true, credentials: true }));`), [true]);
  // browsers refuse "*" together with cookies, so that pair isn't the dangerous one
  assert.deepEqual(cors(`import cors from 'cors';\napp.use(cors({ origin: '*', credentials: true }));`), [false]);
  assert.deepEqual(cors(`res.setHeader('Access-Control-Allow-Origin', req.headers.origin);\nres.setHeader('Access-Control-Allow-Credentials', 'true');`), [true]);
  assert.deepEqual(cors(`app.add_middleware(\n    CORSMiddleware,\n    allow_origins=["*"],\n    allow_credentials=True,\n)`, 'main.py', 'python'), [true]);
  assert.deepEqual(cors(`CORS(app)`, 'app.py', 'python'), [false]);
  assert.deepEqual(cors(`CORS_ALLOW_ALL_ORIGINS = True\nCORS_ALLOW_CREDENTIALS = True`, 'mysite/settings.py', 'python'), [true]);
});

test('CORS limited to named websites is left alone', () => {
  const none = (src, file = 'server.js', lang = 'javascript') => assert.deepEqual(find(src, file, lang, 'cors-any'), [], src);
  none(`import cors from 'cors';\napp.use(cors({ origin: ['https://myapp.com'], credentials: true }));`);
  none(`import cors from 'cors';\napp.use(cors({ origin: process.env.ALLOWED_ORIGINS.split(',') }));`);
  none(`app.add_middleware(CORSMiddleware, allow_origins=["https://myapp.com"], allow_credentials=True)`, 'main.py', 'python');
  none(`CORS(app, origins=["https://myapp.com"], supports_credentials=True)`, 'app.py', 'python');
  none(`CORS(app, resources={r"/api/*": {"origins": "https://myapp.com"}})`, 'app.py', 'python');
});

// ---------- Supabase migrations ----------

test('migrations: tables, row-level security on and off, renames, drops and open rules are read in order', () => {
  const sql = [
    `create table public.profiles (id uuid primary key);`,
    `-- alter table public.profiles disable row level security;`,
    `alter table public.profiles enable row level security;`,
    `create table if not exists "notes" (id bigint);`,
    `create temp table scratch (id int);`,
    `alter table notes rename to posts;`,
    `drop table if exists old_stuff;`,
    `create policy "Anyone can join" on public.waitlist for insert to anon with check (true);`,
    `create policy "Owners read" on public.profiles for select using (auth.uid() = id);`,
    `create policy "Anyone reads" on public.posts for select using (true);`,
  ].join('\n');
  const got = findIssues(sql, { path: 'supabase/migrations/1_init.sql', category: 'code', lang: 'sql' }).map(({ k, table, on, to, line, cmd }) => [k, table, on ?? to ?? cmd ?? null, line]);
  assert.deepEqual(got, [
    ['sql-table', 'public.profiles', null, 1],
    ['sql-rls', 'public.profiles', true, 3],
    ['sql-table', 'public.notes', null, 4],
    ['sql-rename', 'public.notes', 'public.posts', 6],
    ['sql-drop', 'public.old_stuff', null, 7],
    ['sql-open-policy', 'public.waitlist', 'insert', 8],
  ]);
});

test('row-level security switched on in a loop of dynamic SQL counts for the tables the loop names (#113)', () => {
  const rls = (sql) => findIssues(sql, { path: 'supabase/migrations/2_rls.sql', category: 'code', lang: 'sql' }).filter((x) => x.k.startsWith('sql-rls')).map(({ k, table, on, line }) => [k, table ?? null, on, line]);
  // foreach over an array literal, with format()
  assert.deepEqual(rls([
    `do $$ declare t text; begin`,
    `  foreach t in array array['wallets', 'ledger'] loop`,
    `    execute format('alter table public.%I enable row level security', t);`,
    `  end loop;`,
    `end $$;`,
  ].join('\n')), [['sql-rls', 'public.wallets', true, 3], ['sql-rls', 'public.ledger', true, 3]]);
  // a list declared first, a statement glued together with ||, FOR … IN SELECT unnest('{…}'), and a name given outright
  assert.deepEqual(rls([
    `DO $body$`,
    `DECLARE t text; tables text[] := ARRAY['orders', 'payments'];`,
    `BEGIN`,
    `  FOREACH t IN ARRAY tables LOOP`,
    `    EXECUTE 'ALTER TABLE public.' || quote_ident(t) || ' ENABLE ROW LEVEL SECURITY';`,
    `  END LOOP;`,
    `  FOR t IN SELECT unnest('{invoices,refunds}'::text[]) LOOP`,
    `    EXECUTE format('alter table %I force row level security', t);`,
    `  END LOOP;`,
    `  EXECUTE format('alter table %I enable row level security', 'audit_log');`,
    `END $body$;`,
  ].join('\n')), [
    ['sql-rls', 'public.orders', true, 5], ['sql-rls', 'public.payments', true, 5],
    ['sql-rls', 'public.invoices', true, 8], ['sql-rls', 'public.refunds', true, 8],
    ['sql-rls', 'public.audit_log', true, 10],
  ]);
  // switched off the same way is switched off
  assert.deepEqual(rls(`do $$ declare t text; begin foreach t in array array['wallets'] loop execute format('alter table public.%I disable row level security', t); end loop; end $$;`), [['sql-rls', 'public.wallets', false, 1]]);
  // tables from a query: it plainly switches RLS on, but for tables the migration doesn't name
  assert.deepEqual(rls([
    `do $$ declare r record; begin`,
    `  for r in select tablename from pg_tables where schemaname = 'public' loop`,
    `    execute format('alter table public.%I enable row level security', r.tablename);`,
    `  end loop;`,
    `end $$;`,
  ].join('\n')), [['sql-rls-dynamic', null, true, 3]]);
  // near misses: a loop over the same list that does something else, an execute after its loop ended, a comment
  assert.deepEqual(rls(`do $$ declare t text; begin\n  foreach t in array array['wallets'] loop\n    execute format('grant select on public.%I to authenticated', t);\n  end loop;\nend $$;`), []);
  assert.deepEqual(rls(`do $$ declare t text; begin\n  foreach t in array array['wallets'] loop\n    perform 1;\n  end loop;\n  execute format('alter table public.%I enable row level security', t);\nend $$;`), [['sql-rls-dynamic', null, true, 5]]);
  assert.deepEqual(rls(`-- foreach t in array array['wallets'] loop execute format('alter table public.%I enable row level security', t); end loop;\n`), []);
});

test('a whole app: tables a loop covers are protected, ones it can’t name are “can’t tell”, and the rest are still open (#113)', () => {
  const root = makeProject({
    'package.json': JSON.stringify({ name: 'wallet', dependencies: { '@supabase/supabase-js': '^2.45.0' } }),
    'src/db.ts': `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);\n`,
    'supabase/migrations/20250101000000_init.sql': [
      `create table public.wallets (id uuid primary key, user_id uuid);`,
      `create table public.ledger (id uuid primary key, wallet_id uuid);`,
      `create table public.notes (id uuid primary key, body text);`,
    ].join('\n'),
    'supabase/migrations/20250102000000_rls.sql': [
      `do $$ declare t text; begin`,
      `  foreach t in array array['wallets', 'ledger'] loop`,
      `    execute format('alter table public.%I enable row level security', t);`,
      `  end loop;`,
      `  foreach t in array array['notes'] loop`,
      `    execute format('grant select on public.%I to authenticated', t);`,
      `  end loop;`,
      `end $$;`,
    ].join('\n'),
  }, { arch: { project: { name: 'Wallet', summary: 'A sample app.' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', summary: 'The app.', paths: ['**'] }] } });
  try {
    scanAndBuild(root);
    let issues = readGraph(root).health.issues.filter((i) => i.kind === 'database-rules');
    // the loop that only grants access leaves notes open
    assert.deepEqual(issues.map((i) => [i.severity, i.title]), [['high', 'Anyone can read and change your notes table']]);

    // a later migration that switches it on for whatever pg_tables lists: notes can't be told either way, and a
    // table created after it is still never switched on
    fs.writeFileSync(path.join(root, 'supabase/migrations/20250103000000_all.sql'), [
      `do $$ declare r record; begin`,
      `  for r in select tablename from pg_tables where schemaname = 'public' loop`,
      `    execute format('alter table public.%I enable row level security', r.tablename);`,
      `  end loop;`,
      `end $$;`,
      `create table public.payouts (id uuid primary key);`,
    ].join('\n'));
    scanAndBuild(root);
    issues = readGraph(root).health.issues.filter((i) => i.kind === 'database-rules');
    const byId = Object.fromEntries(issues.map((i) => [i.id.split(':')[0], i]));
    assert.equal(byId.rls.title, 'Anyone can read and change your payouts table');
    assert.equal(byId['rls-unsure'].severity, 'medium');
    assert.equal(byId['rls-unsure'].title, 'Floorplan can’t tell whether your notes table is protected');
    assert.deepEqual(byId['rls-unsure'].locations, [{ file: 'supabase/migrations/20250103000000_all.sql', line: 3 }]);
    assert.match(byId['rls-unsure'].fix, /- public\.notes: created in supabase\/migrations\/20250101000000_init\.sql:3/);
  } finally { cleanup(root); }
});

// ---------- a whole app ----------

const futureRules = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if request.time < timestamp.date(${NEXT_YEAR}, 3, 1);\n    }\n  }\n}\n`;

/** A Vite + Supabase app with one of every mistake, beside a Next.js-style Stripe webhook and an Express server. */
function riskyApp() {
  return makeProject({
    'package.json': JSON.stringify({ name: 'vibe', dependencies: { '@supabase/supabase-js': '^2.45.0', stripe: '^16.0.0', express: '^4.19.0', cors: '^2.8.5' } }),
    'src/db.ts': `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);\n`,
    'src/chat.ts': `export async function ask(q: string) {\n  return fetch('https://api.openai.com/v1/chat/completions', { headers: { Authorization: 'Bearer ' + import.meta.env.VITE_OPENAI_API_KEY } });\n}\n`,
    '.env.local': `VITE_SUPABASE_URL=https://abcd.supabase.co\nVITE_OPENAI_API_KEY=${FAKE_OPENAI_KEY}\n`,
    'supabase/migrations/20250101000000_init.sql': [
      `create table public.profiles (id uuid primary key references auth.users, name text);`,
      `create table public.notes (id bigint generated always as identity primary key, user_id uuid, body text);`,
      `create table public.old_stuff (id int);`,
      `create table public.waitlist (email text primary key);`,
      `alter table public.waitlist enable row level security;`,
      `create policy "Anyone can join" on public.waitlist for insert to anon with check (true);`,
    ].join('\n'),
    'supabase/migrations/20250201000000_lock_profiles.sql': `alter table public.profiles enable row level security;\ndrop table public.old_stuff;\n`,
    'firestore.rules': futureRules,
    'storage.rules': `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} {\n      allow read, write;\n    }\n  }\n}\n`,
    'database.rules.json': `{\n  "rules": {\n    ".read": true,\n    ".write": "auth != null"\n  }\n}\n`,
    'app/api/webhooks/stripe/route.ts': `import Stripe from 'stripe';\nexport async function POST(req: Request) {\n  const event = await req.json();\n  if (event.type === 'checkout.session.completed') await fulfil(event.data.object);\n  return new Response('ok');\n}\nasync function fulfil(s: unknown) {}\n`,
    'server/index.js': `import express from 'express';\nimport cors from 'cors';\nconst app = express();\napp.use(cors({ origin: true, credentials: true }));\napp.listen(3001);\n`,
  }, { arch: { project: { name: 'Vibe', summary: 'A sample app.' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', summary: 'The app.', paths: ['**'] }] } });
}

test('a whole app: each mistake becomes one plain-English issue with a fix to paste', () => {
  const root = riskyApp();
  try {
    scanAndBuild(root);
    const graph = readGraph(root);
    const issues = graph.health.issues;
    const byId = (prefix) => issues.filter((i) => i.id.startsWith(prefix));

    // Supabase: only notes is open (profiles was locked later, old_stuff was dropped, waitlist has RLS)
    const [rls] = byId('rls:');
    assert.equal(rls.severity, 'high');
    assert.equal(rls.title, 'Anyone can read and change your notes table');
    assert.deepEqual(rls.locations, [{ file: 'supabase/migrations/20250101000000_init.sql', line: 2 }]);
    assert.match(rls.fix, /alter table <table> enable row level security/);
    // the waitlist's open insert rule is worth a look, not an alarm
    const [policy] = byId('open-policy:');
    assert.equal(policy.severity, 'medium');
    assert.match(policy.detail, /public form/);

    // Firebase: test mode with its date, open storage, and a database anyone can read
    const fb = Object.fromEntries(byId('firebase-rules:').map((i) => [i.id.split(':')[1], i]));
    assert.equal(fb['firestore.rules'].severity, 'high');
    assert.match(fb['firestore.rules'].title, new RegExp(`open to anyone until March 1, ${NEXT_YEAR}`));
    assert.match(fb['firestore.rules'].fix, /firebase deploy --only firestore:rules/);
    assert.equal(fb['storage.rules'].severity, 'high');
    assert.equal(fb['storage.rules'].title, 'Anyone can upload, replace or delete your Firebase files');
    assert.equal(fb['database.rules.json'].severity, 'medium');
    assert.equal(fb['database.rules.json'].title, 'Anyone can read everything in your Firebase Realtime Database');

    // Stripe: one specific issue, and the same webhook isn't also reported as an open endpoint
    const [stripe] = byId('stripe-webhook:');
    assert.equal(stripe.severity, 'high');
    assert.match(stripe.title, /fake a Stripe payment/);
    assert.match(stripe.fix, /await req\.text\(\)/);
    assert.ok(!openEndpoints(graph).includes('POST /api/webhooks/stripe'), openEndpoints(graph).join(', '));

    // the OpenAI key in a VITE_ variable: set in .env.local and read by browser code
    const [pub] = byId('public-env');
    assert.equal(pub.severity, 'high');
    assert.equal(pub.title, 'VITE_OPENAI_API_KEY is sent to every visitor’s browser');
    assert.deepEqual(pub.locations.map((l) => l.file).sort(), ['.env.local', 'src/chat.ts']);

    // CORS that echoes any origin with cookies
    const [cors] = byId('cors');
    assert.equal(cors.severity, 'medium');
    assert.equal(cors.title, 'Any website could act as your signed-in users');

    // important issues come first, and no key value reaches anything Floorplan writes
    assert.equal(issues[0].severity, 'high');
    for (const f of fs.readdirSync(path.join(root, 'floorplan'), { recursive: true })) {
      const p = path.join(root, 'floorplan', f);
      if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(FAKE_OPENAI_KEY.slice(4)), `${f} contains the key`);
    }
  } finally { cleanup(root); }
});

test('the same app done right raises none of these issues', () => {
  const root = makeProject({
    'package.json': JSON.stringify({ name: 'tidy', dependencies: { '@supabase/supabase-js': '^2.45.0', stripe: '^16.0.0', cors: '^2.8.5' } }),
    'src/db.ts': `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);\n`,
    'supabase/migrations/20250101000000_init.sql': `create table public.notes (id bigint primary key, user_id uuid);\nalter table public.notes enable row level security;\ncreate policy "Own notes" on public.notes for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);\n`,
    'firestore.rules': `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /users/{userId} {\n      allow read, write: if request.auth != null && request.auth.uid == userId;\n    }\n    match /products/{id} {\n      allow read: if true;\n    }\n  }\n}\n`,
    'app/api/webhooks/stripe/route.ts': `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\nexport async function POST(req: Request) {\n  const event = stripe.webhooks.constructEvent(await req.text(), req.headers.get('stripe-signature')!, process.env.STRIPE_WEBHOOK_SECRET!);\n  if (event.type === 'checkout.session.completed') await fulfil(event.data.object);\n  return new Response('ok');\n}\nasync function fulfil(s: unknown) {}\n`,
    'server/index.js': `import express from 'express';\nimport cors from 'cors';\nconst app = express();\napp.use(cors({ origin: ['https://tidy.app'], credentials: true }));\napp.listen(3001);\n`,
  }, { arch: { project: { name: 'Tidy', summary: 'A sample app.' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', summary: 'The app.', paths: ['**'] }] } });
  try {
    scanAndBuild(root);
    const kinds = readGraph(root).health.issues.map((i) => i.kind);
    for (const k of ['database-rules', 'stripe-webhook', 'public-env-secret', 'cors']) assert.ok(!kinds.includes(k), `unexpected ${k}: ${kinds.join(', ')}`);
  } finally { cleanup(root); }
});

test('plain Postgres migrations without Supabase are not held to Supabase’s rules, and expired test mode is called out', () => {
  const root = makeProject({
    'db/schema.sql': `create table users (id serial primary key, email text);\n`,
    'firestore.rules': `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if request.time < timestamp.date(2020, 1, 1);\n    }\n  }\n}\n`,
  }, { arch: { project: { name: 'Plain', summary: 'A sample app.' }, nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'The app.', paths: ['**'] }] } });
  try {
    scanAndBuild(root);
    const issues = readGraph(root).health.issues;
    assert.ok(!issues.some((i) => i.id.startsWith('rls:')), 'no row-level security issue without Supabase');
    const [fb] = issues.filter((i) => i.id === 'firebase-rules:firestore.rules');
    assert.equal(fb.severity, 'medium');
    assert.equal(fb.title, 'Your Firebase Firestore test-mode rules ran out on January 1, 2020');
  } finally { cleanup(root); }
});
