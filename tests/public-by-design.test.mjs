// False alarms people reported from the Health tab's "Not a problem" dialog (#40-#52). Most came from one site:
// feeds, fact sheets and files written for search engines and AI tools, a CMS's own API, a webhook's "POST only"
// reply. Each case comes with its near miss, because a check that goes quiet on real problems is worse than a noisy one.
// Secret-looking values are assembled at runtime so none is ever committed to this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, openEndpoints, cleanup } from './helpers.mjs';

const { findIssues } = await lib('health.mjs');
const ARCH = { project: { name: 'Site', summary: 'A sample site.' }, nodes: [{ id: 'site', label: 'Site', kind: 'service', summary: 'The site.', paths: ['**'] }] };
const route = (path) => `src/app/${path}/route.ts`;
const STATIC_JSON = `export async function GET() { return Response.json({ name: 'Sample', plans: ['free', 'pro'] }); }\n`;
// one protected endpoint, so these tests look at the per-file issues rather than "nothing here checks logins"
const GUARDED = {
  'package.json': '{"name":"site","dependencies":{"next":"15"}}',
  'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
  [route('api/account')]: `import { getServerSession } from 'next-auth';\nexport async function GET() { const s = await getServerSession(); return Response.json(s); }\n`,
};

/** Maps a small Next.js project and returns the graph. */
function build(files) {
  const root = makeProject({ ...GUARDED, ...files }, { arch: ARCH });
  try { scanAndBuild(root); return readGraph(root); } finally { cleanup(root); }
}
const open = (files) => openEndpoints(build(files));

// ---------- feeds and files that exist to be read by anyone (#41, #49) ----------
test('feeds and files for crawlers and AI tools are public by their address', () => {
  const addresses = ['blog/rss.xml', 'blog/atom.xml', 'blog/feed.xml', 'rss', 'v1/llms.txt', 'llms-full.txt', 'ads.txt', 'humans.txt'];
  const found = open(Object.fromEntries(addresses.map((a) => [route(a), `import { posts } from '@/lib/db';\nexport async function GET() { return new Response(await posts()); }\n`])));
  assert.deepEqual(found, []);
});

test('that address only excuses reading it, and a social "feed" is not a public file', () => {
  const dbRead = `import { db } from '@/lib/db';\nexport async function GET() { return Response.json(await db.post.findMany()); }\n`;
  assert.deepEqual(open({ [route('api/feed')]: dbRead }), ['GET /api/feed']);
  assert.deepEqual(open({ [route('blog/rss.xml')]: `export async function POST(req: Request) { return Response.json(await req.json()); }\n` }), ['POST /blog/rss.xml']);
});

// ---------- the project itself says it's public (#44, #47, #48, #51, #52) ----------
const dataFeed = `import { db } from '@/lib/db';\nexport async function GET() { return Response.json(await db.plan.findMany()); }\n`;

test('an endpoint the project lists in its llms.txt or allows in robots.txt is public on purpose', () => {
  const files = {
    [route('v1/pricing.json')]: dataFeed, [route('v1/facts.txt')]: dataFeed, [route('v1/resources.json')]: dataFeed,
    [route('api/pages/[[...slug]]')]: dataFeed,
    'public/llms.txt': '# Sample\n- [Pricing](https://example.com/v1/pricing.json): plans\n- [Facts](/v1/facts.txt)\n- Pages as text: https://example.com/api/pages/about\n',
    'public/robots.txt': 'User-agent: *\nAllow: /v1/resources.json\nDisallow: /api/\n',
  };
  assert.deepEqual(open(files), []);
});

test('being blocked in robots.txt, being only near a listed address, or changing data does not count', () => {
  const files = {
    [route('api/private.json')]: dataFeed, [route('v1/pricing.json/details')]: dataFeed, [route('v1/stats')]: dataFeed,
    [route('v1/leads.json')]: `import { db } from '@/lib/db';\nexport async function POST(req: Request) { return Response.json(await db.lead.create({ data: await req.json() })); }\n`,
    'public/llms.txt': '- [Pricing](/v1/pricing.json)\n- [Leads](/v1/leads.json)\n',
    'public/robots.txt': 'User-agent: *\nAllow: /\nDisallow: /api/private.json\n',
  };
  assert.deepEqual(open(files), ['GET /api/private.json', 'GET /v1/pricing.json/details', 'GET /v1/stats', 'POST /v1/leads.json']);
});

test('a catch-all route needs a listed address under it, and "/" alone never covers everything', () => {
  const files = { [route('[...slug]')]: dataFeed, 'public/robots.txt': 'User-agent: *\nAllow: /\n', 'public/llms.txt': 'See https://example.com/ for more.\n' };
  assert.deepEqual(open(files), ['GET /[...slug]']);
});

test('a listing in another repo says nothing about this one', () => {
  const root = makeProject({
    'web/package.json': '{"name":"web","dependencies":{"next":"15"}}',
    'web/public/llms.txt': '- [Stats](/v1/stats)\n',
    'api/package.json': '{"name":"api","dependencies":{"next":"15"}}',
    'api/src/app/v1/stats/route.ts': dataFeed,
    'api/src/app/api/account/route.ts': GUARDED[route('api/account')],
  }, { repos: ['web', 'api'], arch: ARCH });
  try { scanAndBuild(root); assert.deepEqual(openEndpoints(readGraph(root)), ['GET /v1/stats']); } finally { cleanup(root); }
});

// ---------- a response marked for everyone (#48, #49) ----------
test('a response cached for everyone is public on purpose, including through its helper', () => {
  const files = {
    [route('v1/product.json')]: `import { db } from '@/lib/db';\nexport async function GET() { return new Response(JSON.stringify(await db.plan.findMany()), { headers: { 'Cache-Control': 'public, max-age=3600' } }); }\n`,
    [route('v1/sheet.txt')]: `import { db } from '@/lib/db';\nexport const dynamic = 'force-static';\nexport async function GET() { return new Response(await db.sheet()); }\n`,
    [route('v1/hourly.json')]: `import { db } from '@/lib/db';\nexport const revalidate = 3600;\nexport async function GET() { return Response.json(await db.sheet()); }\n`,
    [route('v1/helper.json')]: `import { db } from '@/lib/db';\nimport { publicJson } from '@/lib/public-json';\nexport async function GET() { return publicJson(await db.sheet()); }\n`,
    'src/lib/public-json.ts': `export const publicJson = (body: unknown) => Response.json(body, { headers: { 'cache-control': 'public, s-maxage=600' } });\n`,
    'src/lib/db.ts': `import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\n`,
  };
  assert.deepEqual(open(files), []);
});

test('a private response, or one open to other sites but not cached, is not public by that alone', () => {
  const files = {
    [route('api/me.json')]: `import { db } from '@/lib/db';\nexport async function GET() { return new Response(JSON.stringify(await db.user.first()), { headers: { 'Cache-Control': 'private, no-store' } }); }\n`,
    [route('api/open.json')]: `import { db } from '@/lib/db';\nexport async function GET() { return new Response(JSON.stringify(await db.user.first()), { headers: { 'Access-Control-Allow-Origin': '*' } }); }\n`,
    [route('api/nocache.json')]: `import { db } from '@/lib/db';\nexport const revalidate = 0;\nexport async function GET() { return Response.json(await db.user.first()); }\n`,
  };
  assert.deepEqual(open(files), ['GET /api/me.json', 'GET /api/nocache.json', 'GET /api/open.json']);
});

// ---------- reads nothing private (#45, #46, #47, #52) ----------
test('a Next.js GET that reads no database, session or secret has no data to protect', () => {
  const files = {
    [route('v1/policy.json')]: STATIC_JSON,
    [route('v1/product.json')]: `export async function GET() { return Response.json({ pricing: process.env.NEXT_PUBLIC_PRICING, env: process.env.NODE_ENV }); }\n`,
    [route('api/campaign/countdown')]: `const END = Date.parse('2026-12-01');\nexport async function GET() { return Response.json({ left: END - Date.now() }); }\n`,
    [route('v1/links.json')]: `import { LINKS } from '@/lib/links';\nexport async function GET() { return Response.json(LINKS); }\n`,
    'src/lib/links.ts': `export const LINKS = ['/docs', '/pricing'];\n`,
    // a rate limiter keeps its counts in Redis, but that isn't what the endpoint returns
    [route('v1/limited.json')]: `import { consumeRateLimit } from '@/lib/rate-limit';\nexport async function GET(req: Request) { await consumeRateLimit(req); return Response.json({ ok: true }); }\n`,
    'src/lib/rate-limit.ts': `import { Redis } from '@upstash/redis';\nconst r = Redis.fromEnv();\nexport const consumeRateLimit = (req: Request) => r.incr(req.url);\n`,
    [route('api/pages/[[...slug]]')]: `import { PAGES } from '@/lib/pages';\nexport async function GET(_: Request, { params }: { params: { slug: string[] } }) { const p = PAGES[params.slug.join('/')]; return p ? new Response(p) : new Response('', { status: 404 }); }\n`,
    'src/lib/pages.ts': `export const PAGES: Record<string, string> = { about: 'About us' };\n`,
  };
  assert.deepEqual(open(files), []);
});

test('reading a database, session, cookie, secret or a file chosen by the caller, even through an import, still counts', () => {
  const files = {
    [route('api/users')]: `import { prisma } from '@/lib/prisma';\nexport async function GET() { return Response.json(await prisma.user.findMany()); }\n`,
    [route('api/orders')]: `import { listOrders } from '@/lib/orders';\nexport async function GET() { return Response.json(await listOrders()); }\n`,
    'src/lib/orders.ts': `import { lookup } from './store';\nexport const listOrders = () => lookup('orders');\n`,
    'src/lib/store.ts': `import { createClient } from '@supabase/supabase-js';\nconst c = createClient('https://x.supabase.co', 'anon');\nexport const lookup = (t: string) => c.from(t).select();\n`,
    'src/lib/prisma.ts': `import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n`,
    [route('api/cart')]: `import { cookies } from 'next/headers';\nexport async function GET() { return Response.json({ cart: (await cookies()).get('cart')?.value }); }\n`,
    [route('api/quote')]: `export async function GET() { const r = await fetch('https://pay.example.com', { headers: { key: process.env.PAYMENT_KEY! } }); return Response.json(await r.json()); }\n`,
    [route('api/files/[name]')]: `import { readFile } from 'node:fs/promises';\nexport async function GET(_: Request, { params }: { params: { name: string } }) { return new Response(await readFile('uploads/' + params.name)); }\n`,
  };
  assert.deepEqual(open(files), ['GET /api/cart', 'GET /api/files/[name]', 'GET /api/orders', 'GET /api/quote', 'GET /api/users']);
});

test('an import that can\'t be followed could hold anything, so it counts as reading something', () => {
  assert.deepEqual(open({ [route('api/orders')]: `import { listOrders } from '@/lib/missing';\nexport async function GET() { return Response.json(await listOrders()); }\n` }), ['GET /api/orders']);
});

test('a public cache header counts in other frameworks too, on the endpoint that sets it', () => {
  const graph = build({ 'server/routes.js': [
    `import express from 'express';`, `const router = express.Router();`,
    `router.get('/api/plans', (req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json([]); });`,
    `router.get('/api/books', (req, res) => res.json([]));`,
    `export default router;`, '',
  ].join('\n') });
  assert.deepEqual(openEndpoints(graph), ['GET /api/books']);
});

test('a static read only applies to Next.js, where one file is one endpoint', () => {
  const graph = build({ 'server/routes.js': `import express from 'express';\nconst router = express.Router();\nrouter.get('/api/books', (req, res) => res.json([]));\nexport default router;\n` });
  assert.deepEqual(openEndpoints(graph), ['GET /api/books']);
});

// ---------- a CMS's own API (#42) ----------
const PAYLOAD_API = `/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */\n/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */\nimport config from '@payload-config';\nimport { REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes';\nexport const GET = REST_GET(config);\nexport const POST = REST_POST(config);\nexport const DELETE = REST_DELETE(config);\nexport const PATCH = REST_PATCH(config);\n`;

test('Payload CMS API routes check access themselves', () => {
  const graph = build({ [route('(payload)/api/[...slug]')]: PAYLOAD_API, [route('(payload)/api/graphql')]: `import config from '@payload-config';\nimport { GRAPHQL_POST } from '@payloadcms/next/routes';\nexport const POST = GRAPHQL_POST(config);\n` });
  assert.deepEqual(openEndpoints(graph), []);
  assert.deepEqual(graph.health.issues.filter((i) => i.kind === 'unprotected-endpoint'), []);
});

test('a route that only has a variable called payload is not Payload CMS', () => {
  assert.deepEqual(open({ [route('api/notes')]: `export async function POST(req: Request) { const payload = await req.json(); return Response.json(payload); }\n` }), ['POST /api/notes']);
});

// ---------- a webhook's "POST only" reply, and how it's locked (#43) ----------
const LOCKED_POST = (check) => `export async function POST(req: Request) {\n  ${check}\n  return Response.json({ ok: true });\n}\n`;
const POST_ONLY = `export async function GET() { return Response.json({ error: 'POST only' }, { status: 405 }); }\n`;

test('a GET that only answers "method not allowed" is not an open endpoint or a fake-events risk', () => {
  const graph = build({ [route('api/partner/webhook')]: POST_ONLY + LOCKED_POST(`if (!verifyPartnerSignature(req)) return new Response('', { status: 401 });`) });
  assert.deepEqual(openEndpoints(graph), []);
  assert.deepEqual(open({ [route('api/items')]: `export const GET = () => new Response(null, { status: 405, headers: { Allow: 'POST' } });\n` }), []);
});

test('a GET that reads data before answering 405, or a POST-only reply on POST itself, still counts', () => {
  assert.deepEqual(open({ [route('api/items')]: `import { db } from '@/lib/db';\nexport async function GET() { const rows = await db.item.findMany(); return Response.json(rows, { status: 405 }); }\n` }), ['GET /api/items']);
  assert.deepEqual(open({ [route('api/items')]: `export async function POST(req: Request) { await req.json(); return Response.json({ ok: true }); }\n${POST_ONLY}` }), ['POST /api/items']);
});

test('a webhook locked with a shared secret or a helper is not open', () => {
  const locks = [
    `if (req.headers.get('authorization') !== \`Bearer \${process.env.PARTNER_SECRET}\`) return new Response('', { status: 200 });`,
    `if (token !== process.env.PARTNER_TOKEN) return Response.redirect('/');`,
    `if (!crypto.timingSafeEqual(a, b)) return Response.redirect('/');`,
    `if (!isAuthorized(req)) return Response.redirect('/');`,
    `if (!verifyWebhookSecret(req)) return Response.redirect('/');`,
  ];
  for (const lock of locks) assert.deepEqual(open({ [route('api/partner/webhook')]: LOCKED_POST(lock) }), [], lock);
});

test('a webhook that does nothing to check its sender is still reported', () => {
  assert.deepEqual(open({ [route('api/partner/webhook')]: LOCKED_POST(`const event = await req.json(); console.log(event);`) }), ['POST /api/partner/webhook']);
  assert.deepEqual(open({ [route('api/partner/webhook')]: LOCKED_POST(`if (process.env.PARTNER_SECRET) console.log('configured');`) }), ['POST /api/partner/webhook']);
});

// ---------- a browser tracker's site token (#40) ----------
const SITE_TOKEN = ['a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2'].join('');
const secrets = (src, p = 'src/components/Widget.tsx') => findIssues(src, { path: p, category: 'code', lang: 'typescript' }).filter((x) => x.k === 'secret');

test('a token handed to a browser tracker script is public by design', () => {
  const forms = [
    `export const T = () => <Script src="https://t.example.com/a.js" data-token="${SITE_TOKEN}" />;`,
    `const SITE_TOKEN = "${SITE_TOKEN}";\nexport const T = () => <Script src="https://t.example.com/a.js" data-site={SITE_TOKEN} />;`,
    `const token = "${SITE_TOKEN}";\nconst s = document.createElement('script');\ns.src = 'https://t.example.com/a.js';\ns.dataset.site = token;`,
    `const token = "${SITE_TOKEN}";\nconst s = document.createElement('script');\ns.setAttribute('data-site', token);`,
  ];
  for (const src of forms) assert.deepEqual(secrets(src), [], src);
  // the file says what it is, and the script tag takes the token some other way
  assert.deepEqual(secrets(`const TRACKER_TOKEN = "${SITE_TOKEN}";\nexport const A = () => <Script src={\`https://t.example.com/a.js?id=\${TRACKER_TOKEN}\`} />;`, 'src/components/SiteAnalytics.tsx'), []);
});

test('a token near a script tag but not given to it, or a secret by name, is still flagged', () => {
  const same = 'const SITE_TOKEN = "' + SITE_TOKEN + '";\n';
  assert.equal(secrets(`${same}fetch('/x', { headers: { t: SITE_TOKEN } });\nexport const T = () => <Script src="https://t.example.com/a.js" />;`).length, 1);
  assert.equal(secrets(`${same}export const T = () => <div data-site={SITE_TOKEN} />;`).length, 1);
  assert.equal(secrets(`const SITE_TOKEN = "${SITE_TOKEN}";\nexport const send = () => fetch('/x', { headers: { t: SITE_TOKEN } });`, 'src/components/SiteAnalytics.tsx').length, 1);
  for (const name of ['API_SECRET', 'ACCESS_TOKEN', 'AUTH_TOKEN', 'REFRESH_TOKEN', 'PRIVATE_KEY']) {
    assert.equal(secrets(`const ${name} = "${SITE_TOKEN}";\nexport const T = () => <Script src="https://t.example.com/a.js" data-site={${name}} />;`, 'src/components/SiteAnalytics.tsx').length, 1, name);
  }
});

// ---------- files a tool opens by name (#50) ----------
const unused = (files) => build(files).health.issues.filter((i) => i.kind === 'unused-file').flatMap((i) => i.items);

test('a file whose comment says a tool opens it, or that it is generated, is not unused', () => {
  const heads = [
    '// The CLI reads this file directly.', '/* This file is loaded by the migration runner at startup. */', '/**\n * Used by the tool: it opens this file by name.\n */',
    '# This file is read by the deploy script.', '/* THIS FILE WAS GENERATED AUTOMATICALLY. */', '// Do not delete: the build picks up this file at runtime.',
  ];
  heads.forEach((head) => assert.deepEqual(unused({ 'src/content/leftover.ts': `${head}\nexport const x = 1;\n` }), [], head));
});

test('a plain orphan, or one that only mentions those words in passing, still looks unused', () => {
  const found = ['// Reads the config file and returns it.', '// TODO: wire this into the CLI', `const s = 'The CLI reads this file directly';`, '/**\n * Create a record with an auto-generated id.\n */', '/** Do not modify the input array. */', '// Generated by the form, this value is trimmed.'];
  found.forEach((head) => assert.deepEqual(unused({ 'src/content/leftover.ts': `${head}\nexport const x = 1;\n` }), ['f:src/content/leftover.ts'], head));
});
