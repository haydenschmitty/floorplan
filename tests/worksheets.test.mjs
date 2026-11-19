// The description worksheets show what the code does, not only what it's called: the code of each endpoint
// and the whole of very short files, within tight caps and with secrets masked, plus the files that import,
// request or name each file. Without them, a one-line placeholder reads like the feature its name promises.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, shopApp, makeProject, run, writeJson, cleanup, FAKE_PASSWORD } from './helpers.mjs';

const worksheets = (root) => {
  const dir = path.join(root, 'floorplan', '.cache', 'worksheets');
  return Object.fromEntries(fs.readdirSync(dir).map((f) => [f.replace(/\.md$/, ''), fs.readFileSync(path.join(dir, f), 'utf8')]));
};
/** One file's entry in a worksheet: from its "## path" heading to the next one. */
const entry = (ws, file) => {
  const at = ws.indexOf(`## ${file}  (`);
  assert.ok(at >= 0, `the worksheet lists ${file}`);
  const next = ws.indexOf('\n## ', at + 1);
  return ws.slice(at, next < 0 ? undefined : next);
};
/** Lines inside ``` fences, across the whole worksheet. */
const quotedLines = (ws) => [...ws.matchAll(/^(```|~~~)\n([\s\S]*?)\n\1$/gm)].flatMap((m) => m[2].split('\n'));
const mapIt = (root, arch) => { if (arch) writeJson(path.join(root, 'floorplan', 'architecture.json'), arch); run('scan.mjs', root); run('build.mjs', root, '--no-claude-md'); return run('describe.mjs', root); };
const ONE = (paths = ['**']) => ({ project: { name: 'App' }, nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'The app.', paths }] });

let shop, ws;
before(() => { shop = shopApp(); mapIt(shop); ws = worksheets(shop); });
after(() => cleanup(shop));

test('a placeholder endpoint shows its code, so "saves a note" can be told from "replies that it saved one"', () => {
  const notes = entry(ws.api, 'shop-api/routes/notes.js');
  assert.match(notes, /router\.post\('\/notes', async \(req, res\) => \{ res\.json\(\{ saved: true \}\); \}\);/);
  assert.match(entry(ws.api, 'shop-api/routes/admin.js'), /res\.status\(204\)\.end\(\)/, 'the delete that deletes nothing');
  assert.match(entry(ws.api, 'shop-api/routes/orders.js'), /res\.json\(\{ ok: !!DB_PASSWORD \}\)/, 'the refund that moves no money');
  assert.match(ws.api, /Say what each thing does today \("Say what it does today" in references\/writing-descriptions\.md\)/);
});

test('each file says which files import it, send it web requests or name it, and when nothing does', () => {
  assert.match(entry(ws.api, 'shop-api/routes/notes.js'), /^imported by: shop-api\/server\.js$/m);
  assert.match(entry(ws.api, 'shop-api/auth.js'), /^imported by: shop-api\/routes\/orders\.js, shop-api\/server\.js$/m);
  assert.match(entry(ws.api, 'shop-api/routes/orders.js'), /^sent web requests by: shop-web\/src\/api\.js \(GET \/api\/orders, POST \/api\/orders\/:id\/refund\)$/m);
  assert.match(entry(ws.web, 'shop-web/src/App.jsx'), /^imported by: nothing \(no file imports it, sends it web requests or names it\)$/m);
});

test("the sample shop's password never reaches a worksheet; its line is quoted masked", () => {
  for (const [k, text] of Object.entries(worksheets(shop))) assert.ok(!text.includes(FAKE_PASSWORD), k);
  assert.match(entry(ws.api, 'shop-api/config.js'), /export const DB_PASSWORD = "«hidden»";/);
  for (const f of fs.readdirSync(path.join(shop, 'floorplan', 'descriptions'))) assert.ok(!fs.readFileSync(path.join(shop, 'floorplan', 'descriptions', f), 'utf8').includes(FAKE_PASSWORD));
});

test('worksheets stay small: the sample shop needs under 7 KB for both', () => {
  // 2.4 KB before code was quoted; every one of its 8 files is short, so all are quoted whole
  const bytes = Object.values(ws).reduce((s, t) => s + Buffer.byteLength(t), 0);
  assert.ok(bytes < 7 * 1024, `${bytes} bytes`);
});

test('in a longer file, each endpoint is quoted on its own: its body, not the next one, with long ones cut', () => {
  const filler = Array.from({ length: 30 }, (_, i) => `  total += ${i};`);
  const p = makeProject({
    'api/server.js': [
      `import express from 'express';`,
      `const app = express();`,
      `const helper = () => 1;`,
      `app.get('/api/tickets', async (req, res) => {`,
      `  res.json([]);`,
      `});`,
      ``,
      `app.post('/api/tickets', async (req, res) => {`,
      `  let total = 0;`,
      ...filler,
      `  res.json({ total });`,
      `});`,
      `app.delete('/api/tickets/:id', removeTicket);`,
      `export function removeTicket(req, res) {`,
      `  res.status(204).end(); // ${'x'.repeat(200)}`,
      `}`,
      `app.listen(3000);`,
    ].join('\n'),
    'api/views.py': [
      `from fastapi import APIRouter`,
      `router = APIRouter()`,
      ...Array.from({ length: 20 }, (_, i) => `X${i} = ${i}`),
      `@router.post("/refunds")`,
      `async def refund(order_id: int):`,
      `    """Refunds an order."""`,
      `    return {"ok": True}`,
      ``,
      `@router.get("/refunds")`,
      `async def list_refunds():`,
      `    return []`,
    ].join('\n'),
  }, { repos: ['api'] });
  try {
    mapIt(p, ONE());
    const w = worksheets(p).app;
    const server = entry(w, 'api/server.js');
    assert.doesNotMatch(server, /code \(the whole file/, 'a long file is not quoted whole');
    // the GET's body, and nothing of the POST below it
    assert.match(server, /route: GET \/api\/tickets[^\n]*\n {2}code, line 4-6:\n```\napp\.get\('\/api\/tickets', async \(req, res\) => \{\n {2}res\.json\(\[\]\);\n\}\);\n```/);
    // a long body stops at 12 lines and says how much more there is
    assert.match(server, /route: POST \/api\/tickets[^\n]*\n {2}code, line 8-19:\n```\napp\.post[\s\S]*?\n… \(22 more lines\)\n```/);
    // a one-line route that names a handler in the same file quotes the handler too, long lines cut
    assert.match(server, /route: DELETE \/api\/tickets\/:id[^\n]*\n {2}code, line 42:\n```\napp\.delete\('\/api\/tickets\/:id', removeTicket\);\n```\n {2}its handler removeTicket, line 43:\n```\nexport function removeTicket\(req, res\) \{\n {2}res\.status\(204\)\.end\(\); \/\/ x+ …\n\}\n```/);
    for (const l of quotedLines(w)) assert.ok(l.length <= 162, l);
    const views = entry(w, 'api/views.py');
    assert.match(views, /code, line 23-26:\n```\n@router\.post\("\/refunds"\)\nasync def refund\(order_id: int\):\n {4}"""Refunds an order\."""\n {4}return \{"ok": True\}\n```/);
    assert.match(views, /code, line 28-30:\n```\n@router\.get\("\/refunds"\)\nasync def list_refunds\(\):\n {4}return \[\]\n```/);
  } finally { cleanup(p); }
});

test('a worksheet quotes at most 120 lines: endpoints first, then short files, and says what it left out', () => {
  const files = { 'app/routes.js': `import express from 'express';\nconst app = express();\n${Array.from({ length: 30 }, (_, i) => `app.get('/r${i}', (req, res) => res.json(${i}));`).join('\n')}\n` };
  for (let i = 0; i < 12; i++) files[`app/m${String(i).padStart(2, '0')}.js`] = Array.from({ length: 15 }, (_, j) => `export const v${j} = ${i * 100 + j};`).join('\n');
  const p = makeProject(files, { repos: ['app'] });
  try {
    mapIt(p, ONE());
    const w = worksheets(p).app;
    const quoted = quotedLines(w).length;
    assert.ok(quoted <= 120 && quoted > 90, `${quoted} lines quoted`);
    assert.equal((entry(w, 'app/routes.js').match(/^ {2}code, line/gm) || []).length, 30, 'every endpoint is quoted');
    assert.match(entry(w, 'app/m00.js'), /code \(the whole file, 15 lines\)/);
    assert.match(entry(w, 'app/m11.js'), /\(code not quoted: this worksheet already quotes as much as it holds/);
  } finally { cleanup(p); }
});

test('a script started from package.json or a shell script says so; a file nothing uses says that', () => {
  const p = makeProject({
    'app/package.json': JSON.stringify({ name: 'app', scripts: { start: 'node server.js' } }),
    'app/server.js': `console.log('up');\n`,
    'app/scripts/start.sh': `#!/bin/sh\npython app/create_owner.py\npython -m app.warm_up\n`,
    'app/app/create_owner.py': `print("owner")\n`,
    'app/app/warm_up.py': `print("warm")\n`,
    'app/tools/export_prices.mjs': `console.log('prices');\n`,
  }, { repos: ['app'] });
  try {
    mapIt(p, { ...ONE(['app/**']), include: ['code', 'config'] });
    const w = worksheets(p).app;
    assert.match(entry(w, 'app/server.js'), /^named in: app\/package\.json line 1$/m);
    assert.match(entry(w, 'app/app/create_owner.py'), /^named in: app\/scripts\/start\.sh line 2$/m);
    assert.match(entry(w, 'app/app/warm_up.py'), /^named in: app\/scripts\/start\.sh line 3$/m);
    assert.match(entry(w, 'app/tools/export_prices.mjs'), /^imported by: nothing/m);
  } finally { cleanup(p); }
});

test('settings files like .env, and files named for secrets, are never quoted', () => {
  const key = ['sk', 'live', 'Zx81Qw7Rt5Yu3Io9Pa2Sd4Fg6'].join('_');
  const p = makeProject({
    'app/.env': `STRIPE_KEY=${key}\n`,
    'app/secrets.js': `export const stripe = 1;\n`,
    'app/pay.js': `export const KEY = '${key}';\nexport const pay = () => KEY;\n`,
    'app/.gitignore': '.env\n',
  }, { repos: ['app'] });
  try {
    mapIt(p, { ...ONE(), include: ['code', 'config'] });
    const all = Object.values(worksheets(p)).join('\n');
    assert.ok(!all.includes(key), 'the key is in no worksheet');
    assert.doesNotMatch(all, /STRIPE_KEY=/);
    assert.doesNotMatch(entry(all, 'app/secrets.js'), /```/);
    assert.match(entry(all, 'app/pay.js'), /export const KEY = '«hidden»';/);
  } finally { cleanup(p); }
});

test('maskSecrets hides anything that might be a secret, even where Health stays quiet', async () => {
  const { maskSecrets } = await lib('health.mjs');
  const stripe = ['sk', 'live', 'Zx81Qw7Rt5Yu3Io9Pa2Sd4Fg6'].join('_');
  const pem = ['-----BEGIN RSA PRIVATE', 'KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE', 'KEY-----'].join(' ');
  const random = ['q8Zr3VbN1xLk7TcW', '2mYp5HgD9sJf4AeU'].join('');
  const src = [
    `const stripe = "${stripe}";`,
    `const db = "postgres://app:${FAKE_PASSWORD}@db.example.net/shop";`,
    `const apiKey = "${FAKE_PASSWORD}";`,
    `client_secret: "${FAKE_PASSWORD}"`,
    `const blob = "${random}";`,
    pem,
    `const title = "Refunds";`,
  ].join('\n');
  // a test file: Health excuses most keys there, but a worksheet still mustn't show them
  const out = maskSecrets(src, { path: 'app/tests/pay.test.js', lang: 'javascript', category: 'code' });
  for (const secret of [stripe, FAKE_PASSWORD, random, 'MIIEow']) assert.ok(!out.includes(secret), `${secret.slice(0, 6)}… is hidden:\n${out}`);
  assert.match(out, /const title = "Refunds";/, 'ordinary strings stay');
  assert.match(out, /postgres:\/\/app:«hidden»@db\.example\.net\/shop/);
  // unquoted values in a settings-style file, which only Health's own check catches
  assert.ok(!maskSecrets(`DB_PASSWORD=${FAKE_PASSWORD}\n`, { path: 'app/settings.ini', lang: 'ini', category: 'config' }).includes(FAKE_PASSWORD));
});
