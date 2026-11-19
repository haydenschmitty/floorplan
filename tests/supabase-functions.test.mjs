// Supabase Edge Functions: each folder under supabase/functions/ is an endpoint at /functions/v1/<name>,
// a function's own router (Hono) has its endpoints moved under /functions/v1, _shared/ isn't a function,
// the website's supabase.functions.invoke('<name>') and fetch(`${SUPABASE_URL}/functions/v1/<name>`)
// reach them, and Health judges each by its own code (verify_jwt lets the public anon key through).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { edgeFunctionRoutes } = await lib('supabase-functions.mjs');

let root, graph, summary;
before(() => {
  root = makeProject({
    'web/package.json': JSON.stringify({ name: 'web', dependencies: { '@supabase/supabase-js': '^2.45.0' } }),
    'web/src/api.ts': [
      `import { supabase } from './supabase';`,
      `export const invite = (email: string) => supabase.functions.invoke('send-invite', { body: { email } });`,
      'export const remove = () => fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-account`, { method: "POST" });',
      `export const items = () => supabase.functions.invoke('catalog/items', {`,
      `  method: 'GET',`,
      `});`,
    ].join('\n'),
    'web/src/supabase.ts': `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);`,
    'supabase/config.toml': '[functions.delete-account]\nverify_jwt = false\n',
    // checks who is calling
    'supabase/functions/send-invite/index.ts': [
      `import { createClient } from 'npm:@supabase/supabase-js@2';`,
      `import { corsHeaders } from '../_shared/cors.ts';`,
      `Deno.serve(async (req) => {`,
      `  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization')! } } });`,
      `  const { data: { user } } = await supabase.auth.getUser();`,
      `  if (!user) return new Response('Unauthorized', { status: 401, headers: corsHeaders });`,
      `  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });`,
      `});`,
    ].join('\n'),
    // checks nothing (and verify_jwt is off)
    'supabase/functions/delete-account/index.ts': [
      `import { createClient } from 'npm:@supabase/supabase-js@2';`,
      `Deno.serve(async (req) => {`,
      `  const { id } = await req.json();`,
      `  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);`,
      `  await admin.auth.admin.deleteUser(id);`,
      `  return new Response('ok');`,
      `});`,
    ].join('\n'),
    // the older serve() from Deno's standard library
    'supabase/functions/nightly-digest/index.ts': [
      `import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';`,
      ``,
      `serve(async () => new Response('sent'));`,
    ].join('\n'),
    // a function with a router of its own: Supabase hands it the address from /catalog on
    'supabase/functions/catalog/index.ts': [
      `import { Hono } from 'jsr:@hono/hono';`,
      `const app = new Hono();`,
      `app.get('/catalog/items', (c) => c.json([]));`,
      `app.post('/catalog/items', (c) => c.json({}));`,
      `Deno.serve(app.fetch);`,
    ].join('\n'),
    'supabase/functions/_shared/cors.ts': `export const corsHeaders = { 'Access-Control-Allow-Origin': '*' };`,
  }, { arch: {
    project: { name: 'edge', summary: 'Test fixture.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      { id: 'functions', label: 'Functions', kind: 'service', summary: 'The Edge Functions.', paths: ['supabase/**'] },
    ],
  } });
  summary = run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('each Edge Function is an endpoint under /functions/v1, and a router inside one has its endpoints moved there', () => {
  assert.deepEqual(routeKeys(graph), [
    'ANY /functions/v1/delete-account', 'ANY /functions/v1/nightly-digest', 'ANY /functions/v1/send-invite',
    'GET /functions/v1/catalog/items', 'POST /functions/v1/catalog/items',
  ]);
  const r = graph.routes.find((x) => x.p === '/functions/v1/send-invite');
  assert.equal(`${r.f}:${r.l}`, 'supabase/functions/send-invite/index.ts:3');
  assert.match(summary, /SUPABASE EDGE FUNCTIONS {2}4 function\(s\), 5 endpoint\(s\) under \/functions\/v1/);
});

test("the website's invoke() calls and requests to /functions/v1 reach the functions", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.b.slice(2)} ${[...l.labels].sort().join(', ')}`).sort();
  assert.deepEqual(http, [
    'supabase/functions/catalog/index.ts GET /functions/v1/catalog/items',
    'supabase/functions/delete-account/index.ts ANY /functions/v1/delete-account',
    'supabase/functions/send-invite/index.ts ANY /functions/v1/send-invite',
  ]);
});

test('Health judges each function by its own code', () => {
  // send-invite checks the user; delete-account and nightly-digest check nothing (verify_jwt or not: the anon key passes it)
  assert.deepEqual(openEndpoints(graph).filter((k) => k.startsWith('ANY')), ['ANY /functions/v1/delete-account', 'ANY /functions/v1/nightly-digest']);
  const checked = graph.health.checked.find((c) => c.check === 'endpoints');
  assert.equal(checked.checked, true, checked.text);
});

test('invoke() is a POST unless its options say otherwise, and a name in a comment is not a call', () => {
  const calls = (src) => extract(src, 'typescript', 'src/a.ts').calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(calls(`await supabase.functions.invoke("send-invite", { body });\n`), ['POST /functions/v1/send-invite']);
  assert.deepEqual(calls(`await supabase.functions.invoke<Items>('list-items', {\n  headers: { a: 'b' },\n  method: "GET",\n});\n`), ['GET /functions/v1/list-items']);
  assert.deepEqual(calls(`// supabase.functions.invoke('old-one')\nconst name = 'x';\n`), []);
});

test("only a folder's index file under supabase/functions is a function, and only when it serves", () => {
  const src = {
    'supabase/functions/a/index.ts': 'Deno.serve(() => new Response("a"));',
    'supabase/functions/_shared/index.ts': 'Deno.serve(() => new Response("shared"));',
    'supabase/functions/b/helpers.ts': 'Deno.serve(() => new Response("b"));',
    'supabase/functions/c/index.ts': 'export const util = 1;',
    'apps/api/supabase/functions/d/index.js': 'export default { fetch: () => new Response("d") };',
    'src/supabase/functionsx/e/index.ts': 'Deno.serve(() => new Response("e"));',
  };
  const routes = [];
  edgeFunctionRoutes(Object.keys(src).map((path) => ({ path })), routes, (p) => src[p]);
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path} ${r.file}`), [
    'ANY /functions/v1/a supabase/functions/a/index.ts',
    'ANY /functions/v1/d apps/api/supabase/functions/d/index.js',
  ]);
});
