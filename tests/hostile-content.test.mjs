// Mapping code you didn't write, or sharing a map: text from a repository and text written about it (by an agent
// or a person) can't break the page, leak a secret, crash the build, stall the scan or disguise a name. Every
// hostile string here is made at run time; nothing secret-looking is committed.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { makeProject, run, readJson, writeJson, readGraph, cleanup, SKILL, lib } from './helpers.mjs';

const pageSafety = () => import(new URL('../skills/floorplan/assets/page-safety.mjs', import.meta.url));
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), RLO = String.fromCharCode(0x202e), ZWSP = String.fromCharCode(0x200b);
// What a browser's HTML parser reacts to inside a <script>, plus quotes, template syntax and line separators
const H = `<!--<script> </script><ScRiPt >--> &amp; <img src=x onerror=1> ${LS}${PS} \`\${x}\` '"`;
/** A random-looking key in a well-known format, assembled now. */
const fakeKey = () => ['sk', 'live', crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(24, 'Q7')].join('_');

/** The data block of a page: its body parsed as the JSON it holds, or a reason it can't be. */
async function dataOf(html) {
  const { scriptBlocks } = await pageSafety();
  const blocks = scriptBlocks(html);
  const data = blocks.find((b) => b.body.startsWith('window.FLOORPLAN = '));
  assert.ok(data, 'the page has its data block');
  assert.ok(data.body.endsWith(';'), 'the data block ends where the page meant it to (nothing swallowed the rest of the page)');
  return { graph: JSON.parse(data.body.slice('window.FLOORPLAN = '.length, -1)), blocks };
}
/** The page's Content-Security-Policy, as { directive: [values] }, and where in the page it sits. */
function policyOf(html) {
  const m = /<meta http-equiv="Content-Security-Policy" [^>]*content="([^"]*)">/.exec(html);
  if (!m) return null;
  return { at: m.index, directives: Object.fromEntries(m[1].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v])) };
}
/** Every inline script's hash is in the policy, and nothing else is. */
async function assertHashesMatch(html) {
  const { scriptBlocks } = await pageSafety();
  const p = policyOf(html);
  const want = new Set(scriptBlocks(html).map((b) => `'sha256-${crypto.createHash('sha256').update(b.body.replace(/\r\n?/g, '\n')).digest('base64')}'`));
  assert.deepEqual(new Set(p.directives['script-src']), want, 'script-src lists exactly the page\'s own scripts');
  assert.ok(want.size >= 8, 'found the page\'s scripts');
  assert.ok(p.at < html.search(/<script\b/i), 'the policy comes before the first script');
  assert.ok(!p.directives['script-src'].some((v) => /unsafe|\*|data:|http/.test(v)), 'no script may run from anywhere else');
}

async function startServer(root) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_NO_PROMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  return { base, stop: () => new Promise((resolve) => { if (server.exitCode !== null) return resolve(); server.once('exit', resolve); server.kill(); }) };
}

// ---------- 1. text that would break the page ----------

describe('hostile text in every field leaves a page whose data parses and round-trips exactly', () => {
  let root;
  before(() => {
    root = makeProject({
      'api/package.json': JSON.stringify({ name: 'api', dependencies: { express: '^4' } }),
      'api/server.js': [
        `/** Starts the server. ${H.replace(/\*\//g, '')} */`,
        `import express from 'express';`,
        `import evil from 'evil-pkg<!--<script>';`,
        `const app = express();`,
        `/** Lists things. <!--<script> </script> */`,
        `export function listThings(req, res) { res.json([]); }`,
        `app.get('/x<!--<script>', listThings);`,
        `app.get('/y</script><script>', listThings);`,
        `app.get('/z&amp;<b>', listThings);`,
        `app.listen(3000);`,
      ].join('\n'),
      'api/[[ref]]{{tpl}}${x}&b.js': `export const odd = 1;\n`,
      [`api/invoice${RLO}sj.js`]: `export const spoof = 1;\n`,
      'web/app.js': `export const go = () => fetch('https://evil.example/<!--<script>/x').then(() => fetch('/x<!--<script>'));\n`,
    }, {
      arch: {
        project: { name: `Shop ${H}`, summary: `Sells things. ${H}` },
        nodes: [
          { id: 'api', label: `Server ${H}`, kind: 'service', summary: `Answers. ${H}`, details: `Details ${H}`, tags: [`tag ${H}`], paths: ['api/**'], hosts: ['evil.example'] },
          { id: 'web', label: 'Website', kind: 'ui', summary: `Pages. ${H}`, paths: ['web/**'] },
        ],
        edges: [{ from: 'web', to: 'api', kind: 'http', label: `label ${H}`, description: `desc ${H}` }],
        annotations: [{ path: 'api/server.js', note: `note ${H}` }],
        flows: [{ id: 'f1', title: `Flow ${H}`, description: `about ${H}`, steps: [{ node: 'web', note: `asks ${H}` }, { node: 'api', note: `answers ${H}` }] }],
        tour: [{ node: 'api', title: `Stop ${H}`, note: `Look ${H}` }],
      },
    });
    writeJson(path.join(root, 'floorplan', 'descriptions', 'api.json'), {
      files: { 'api/server.js': { name: `Server file ${H}`, description: `Runs it. ${H}` } },
      routes: { 'GET /x<!--<script>': { name: `Odd route ${H}`, description: `Answers ${H}` } },
    });
    writeJson(path.join(root, 'floorplan', 'recent-work.json'), { tasks: [{ title: `Task ${H}`, request: `asked ${H}`, summary: `did ${H}`, status: `done ${H}`, items: [{ ref: 'api/server.js', change: 'changed', note: `changed ${H}` }] }] });
    writeJson(path.join(root, 'floorplan', 'custom-flows.json'), { flows: [{ id: 'c1', title: `Asked ${H}`, description: `d ${H}`, steps: [{ ref: 'n:web', note: `one ${H}` }, { ref: 'n:api', note: `two ${H}` }] }] });
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md', '--artifact');
  });
  after(() => cleanup(root));

  test('the hostile text really is in the map, in every kind of field', () => {
    const g = readGraph(root);
    const has = (v) => JSON.stringify(v).includes(JSON.stringify(H).slice(1, -1));
    assert.ok(has(g.project.name) && has(g.project.summary));
    assert.ok(g.nodes.every((n) => n.id === 'web' ? has(n.summary) : has(n.label) && has(n.summary) && has(n.details) && has(n.tags)));
    assert.ok(g.links.some((l) => has(l.desc)) && g.links.some((l) => has(l.labels)));
    assert.ok(has(g.flows[0]) && g.flows.some((f) => f.custom && has(f)) && has(g.tour));
    assert.ok(has(g.recent.tasks[0]) && has(g.recent.items[0].note));
    const server = g.files.find((f) => f.p === 'api/server.js');
    assert.ok(has(server.name) && has(server.d) && has(server.note));
    assert.ok(g.files.some((f) => f.p.includes('[[ref]]{{tpl}}${x}&b')) && g.files.some((f) => f.p.includes(RLO)), 'file names');
    assert.ok(g.routes.some((r) => r.p === '/x<!--<script>') && g.routes.some((r) => r.p === '/y</script><script>'), 'route paths');
    assert.ok(g.routes.some((r) => has(r.name)), 'endpoint names');
    assert.ok(server.s.some((s) => /<!--<script>/.test(s[4])), 'docstrings');
    assert.ok(g.nodes.some((n) => n.hosts.includes('evil.example')), 'hosts');
  });

  test('index.html: the data block ends where it should and holds exactly graph.json', async () => {
    const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
    const { graph, blocks } = await dataOf(html);
    assert.deepEqual(graph, readGraph(root));
    assert.ok(blocks.at(-1).end < html.length, 'the last script ends before the page does');
    assert.doesNotMatch(blocks.find((b) => b.body.startsWith('window.FLOORPLAN')).body, /[<>&]/, 'no character the HTML parser acts on');
    assert.ok(blocks.every((x) => !x.body.includes(LS) && !x.body.includes(PS)), 'no raw line or paragraph separators in any script');
    assert.match(html, /<title>Shop &lt;!--&lt;script&gt; &lt;\/script&gt;/, 'the title is escaped');
  });

  test('the copy for the Claude app (--artifact) round-trips too', async () => {
    const { graph } = await dataOf(fs.readFileSync(path.join(root, 'floorplan', 'artifact.html'), 'utf8'));
    assert.deepEqual(graph.nodes, readGraph(root).nodes);
    assert.deepEqual(graph.routes, readGraph(root).routes);
  });

  test('an exported copy round-trips, with the flows asked for', async () => {
    const file = path.join(root, 'shared.html');
    execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', file, '--include', 'flows,notes,recent,health'], { cwd: root });
    const { graph } = await dataOf(fs.readFileSync(file, 'utf8'));
    const built = readGraph(root);
    for (const k of ['project', 'nodes', 'files', 'routes', 'links', 'flows', 'tour', 'recent']) assert.deepEqual(graph[k], built[k], k);
  });

  test('the served page and the Export button: data and the server\'s own settings both parse', async () => {
    const s = await startServer(root);
    try {
      const html = await (await fetch(s.base + '/')).text();
      const { graph, blocks } = await dataOf(html);
      assert.deepEqual(graph, readGraph(root));
      const inject = blocks.find((b) => b.body.startsWith('window.FLOORPLAN_SERVER='));
      const settings = JSON.parse(inject.body.slice('window.FLOORPLAN_SERVER='.length, -1));
      assert.match(settings.token, /^[0-9a-f]{32}$/);
      const flow = { id: 'x1', title: `From the page ${H}`, steps: [{ ref: 'n:web', note: H }, { ref: 'n:api', note: H }] };
      const r = await fetch(s.base + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': settings.token }, body: JSON.stringify({ include: ['flows'], flows: [flow] }) });
      const exported = await dataOf(await r.text());
      assert.deepEqual(exported.graph.flows.find((f) => f.id === 'x1').steps.map((st) => st.note), [H, H]);
    } finally { await s.stop(); }
  });

  test('the page builder: placeholders in the data are left alone, and code keeps working', async () => {
    const { scriptJson, scriptCode } = await pageSafety();
    const v = { a: '__FLOORPLAN_TITLE__ <!--__UI_EXTENSIONS__--> /*__FLOORPLAN_DATA__*/null', b: H, c: [1, null, true] };
    assert.deepEqual(JSON.parse(scriptJson(v)), v);
    assert.doesNotMatch(scriptJson(v), /[<>&]/);
    assert.equal(scriptJson(undefined), 'null');
    const code = "const s = '</script><!--'; const r = /<!--x<\\/script>/; `<!--${s}`;";
    const safe = scriptCode(code);
    assert.doesNotMatch(safe, /<\/script|<!--/i);
    const out = vm.runInNewContext(`${safe}; [s, r.test('<!--x</script>'), r.test('x<!--x</script>y')]`);
    assert.deepEqual([...out], ['</script><!--', true, true], 'the same strings and the same matches');
    // the hostile repo's route survives in the page's own data
    assert.ok(readGraph(root).routes.some((r) => r.p === '/x<!--<script>'));
  });
});

// ---------- 2. secrets written into descriptions ----------

describe('a secret written into a description, label or note never reaches the map', () => {
  let root, key, json, before0;
  const HASH = crypto.randomBytes(20).toString('hex'); // a commit hash
  const UUID = crypto.randomUUID();
  before(() => {
    key = fakeKey();
    root = makeProject({
      'api/server.js': `import express from 'express';\nconst app = express();\napp.get('/orders/${UUID}', (req, res) => res.end());\napp.listen(3000);\n`,
      'web/components/UserProfileSettingsPanel2024.js': `export const panel = 1;\n`,
    }, {
      arch: {
        project: { name: 'Shop', summary: `Sells things. The key is ${key}.` },
        nodes: [
          { id: 'api', label: 'Server', kind: 'service', summary: `Uses token "${key}" for payments.`, paths: ['api/**'] },
          { id: 'web', label: 'Website', kind: 'ui', summary: 'Reads the token from the header and checks the password before showing anything.', paths: ['web/**'] },
        ],
      },
    });
    const pw = ['correct', 'horse', 'battery', 'staple', '42'].join('-');
    writeJson(path.join(root, 'floorplan', 'descriptions', 'api.json'), {
      files: {
        'api/server.js': { name: 'Server', description: `Connects with postgres://app:${pw}@db.example.net/shop and calls Stripe.` },
        'web/components/UserProfileSettingsPanel2024.js': { name: 'Profile settings', description: `Shows web/components/UserProfileSettingsPanel2024.js; changed in ${HASH}.` },
      },
      routes: { [`GET /orders/${UUID}`]: { name: 'One order', description: `Order ${UUID}, see commit ${HASH}.` } },
    });
    writeJson(path.join(root, 'floorplan', 'recent-work.json'), { tasks: [{ title: 'Payments', summary: `Set STRIPE_KEY=${key}`, items: [] }] });
    before0 = Object.fromEntries(['architecture.json', 'recent-work.json', 'descriptions/api.json'].map((f) => [f, fs.readFileSync(path.join(root, 'floorplan', f), 'utf8')]));
    run('scan.mjs', root);
    try { json = JSON.parse(run('build.mjs', root, '--no-claude-md', '--json')); } catch (e) { json = JSON.parse(e.stdout); }
  });
  after(() => cleanup(root));

  test('the value is in no file the build writes, and in no export', () => {
    const pw = ['correct', 'horse', 'battery', 'staple', '42'].join('-');
    for (const f of ['graph.json', 'index.html']) {
      const text = fs.readFileSync(path.join(root, 'floorplan', f), 'utf8');
      assert.ok(!text.includes(key), `${f} holds the key`);
      assert.ok(!text.includes(pw), `${f} holds the database password`);
    }
    const out = execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', path.join(root, 'x.html'), '--include', 'flows,notes,recent,health'], { cwd: root, encoding: 'utf8' });
    assert.match(out, /Exported/);
    assert.ok(!fs.readFileSync(path.join(root, 'x.html'), 'utf8').includes(key));
    const g = readGraph(root);
    assert.match(g.project.summary, /The key is «hidden»\./);
    assert.match(g.files.find((f) => f.p === 'api/server.js').d, /postgres:\/\/app:«hidden»@db\.example\.net\/shop/);
  });

  test('a warning names each file and field, never the value, in the report and in --json', () => {
    assert.equal(json.ok, true);
    const w = json.warnings.filter((x) => x.startsWith('secret-looking text'));
    assert.ok(w.some((x) => x.includes('architecture.json') && x.includes('project.summary') && x.includes('nodes[0].summary')), w.join('\n'));
    assert.ok(w.some((x) => x.includes('descriptions/api.json') && x.includes('files["api/server.js"].description')), w.join('\n'));
    assert.ok(w.some((x) => x.includes('recent-work.json') && x.includes('tasks[0].summary')), w.join('\n'));
    assert.ok(!JSON.stringify(json).includes(key), 'the build\'s output never repeats the key');
    assert.deepEqual(json.secretsHidden.map((s) => `${s.file} ${s.field}`).sort(), [
      'architecture.json nodes[0].summary', 'architecture.json project.summary',
      'descriptions/api.json files["api/server.js"].description', 'recent-work.json tasks[0].summary',
    ]);
    assert.match(json.report, /secret-looking text in architecture\.json/);
  });

  test('the files people wrote are left as they were', () => {
    for (const [f, text] of Object.entries(before0)) assert.equal(fs.readFileSync(path.join(root, 'floorplan', f), 'utf8'), text, f);
  });

  test('ordinary prose, commit hashes, UUIDs in route paths and long file names are left alone', () => {
    const g = readGraph(root);
    assert.equal(g.nodes.find((n) => n.id === 'web').summary, 'Reads the token from the header and checks the password before showing anything.');
    assert.ok(g.routes.some((r) => r.p === `/orders/${UUID}`));
    assert.equal(g.routes.find((r) => r.p === `/orders/${UUID}`).d, `Order ${UUID}, see commit ${HASH}.`);
    assert.equal(g.files.find((f) => f.p.endsWith('2024.js')).d, `Shows web/components/UserProfileSettingsPanel2024.js; changed in ${HASH}.`);
  });

  test('maskSecrets on prose: keys, connection passwords and generated-looking tokens go, words stay', async () => {
    const { maskSecrets } = await lib('health.mjs');
    // a generated-looking token: capitals, small letters and digits all the way through
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', 'abcdefghijkmnopqrstuvwxyz'];
    const random = Array.from(crypto.randomBytes(40), (b, i) => sets[i % 4][b % sets[i % 4].length]).join('');
    for (const t of [`key ${key} here`, `token ${random}`, 'password: "' + random + '"', `API_TOKEN=${random}`]) assert.ok(!maskSecrets(t).includes(random) && !maskSecrets(t).includes(key), t.slice(0, 12));
    for (const t of ['Sends the order to Stripe and waits for the webhook.', `Fixed in ${HASH}.`, `GET /users/${UUID}`, 'src/components/AdminDashboardUserTable.tsx', 'handleStripeWebhookEventForInvoice']) assert.equal(maskSecrets(t), t);
  });
});

// ---------- 3. what an exported copy may do: the Content-Security-Policy ----------

describe('Content-Security-Policy', () => {
  let root;
  before(() => {
    root = makeProject({ 'api/server.js': `import express from 'express';\nconst app = express();\napp.get('/x<!--<script>', (req, res) => res.end());\n` }, {
      arch: { project: { name: 'Shop' }, nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: H, paths: ['api/**'] }] },
    });
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md', '--artifact');
  });
  after(() => cleanup(root));

  test('an exported copy may run only its own scripts, and talk to nothing', async () => {
    const file = path.join(root, 'shared.html');
    execFileSync(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--export', file], { cwd: root });
    const html = fs.readFileSync(file, 'utf8');
    await assertHashesMatch(html);
    const { directives: d } = policyOf(html);
    assert.deepEqual(d['default-src'], ["'none'"]);
    assert.deepEqual(d['connect-src'], ["'none'"]);
    assert.deepEqual(d['img-src'], ['data:']);
    assert.deepEqual(d['font-src'], ['data:']);
    assert.deepEqual(d['style-src'], ["'unsafe-inline'"]);
    assert.deepEqual(d['base-uri'], ["'none'"]);
    assert.deepEqual(d['form-action'], ["'none'"]);
    assert.equal((html.match(/Content-Security-Policy/g) || []).length, 1, 'one policy (the local one was replaced)');
    assert.match(html.slice(0, policyOf(html).at), /^<!doctype html>\s*<html lang="en">\s*<head>\s*<meta charset="utf-8">\s*$/i, 'right after the charset');
  });

  test('the map on disk and the served page may also talk to their own local server, and nothing else', async () => {
    const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
    await assertHashesMatch(html);
    assert.deepEqual(policyOf(html).directives['connect-src'], ["'self'"]);
    const s = await startServer(root);
    try {
      const served = await (await fetch(s.base + '/')).text();
      await assertHashesMatch(served); // including the server's own settings script
      assert.match(served, /window\.FLOORPLAN_SERVER=/);
      assert.deepEqual(policyOf(served).directives['connect-src'], ["'self'"]);
    } finally { await s.stop(); }
  });

  test('the viewer needs nothing the policy forbids: no inline handlers, javascript: links, eval or background threads', () => {
    const sources = [fs.readFileSync(path.join(SKILL, 'assets', 'viewer.html'), 'utf8'), ...fs.readdirSync(path.join(SKILL, 'assets', 'ui')).map((n) => fs.readFileSync(path.join(SKILL, 'assets', 'ui', n), 'utf8'))].join('\n');
    assert.doesNotMatch(sources, /\son[a-z]+\s*=\s*["'`]/i, 'inline event handler attributes');
    assert.doesNotMatch(sources, /javascript:/i);
    assert.doesNotMatch(sources, /\beval\(|new Function|new Worker|importScripts|<script[^>]*\ssrc=/);
    const elk = fs.readFileSync(path.join(SKILL, 'assets', 'vendor', 'elk.bundled.js'), 'utf8');
    assert.doesNotMatch(elk, /\beval\(|new Function|Function\(|createObjectURL|<!--|<\/script/, 'the layout engine runs in the page itself, without eval or code built from a blob');
  });

  test('the copy for the Claude app carries no policy: the app runs its own code in that page', () => {
    assert.equal(policyOf(fs.readFileSync(path.join(root, 'floorplan', 'artifact.html'), 'utf8')), null);
  });

  test('scriptBlocks finds what a browser finds, including a script a stray "<!--<script>" would swallow', async () => {
    const { scriptBlocks, withPolicy } = await pageSafety();
    assert.deepEqual(scriptBlocks('<script>a="<\\/script>"</script><!-- <script>x</script> --><script>b</script>').map((x) => x.body), ['a="<\\/script>"', 'b']);
    assert.equal(scriptBlocks('<script>a="<!--<script>"</script><script>b</script>').length, 1);
    const page = withPolicy('<!doctype html><html><head>\n<meta charset="utf-8">\n<script>1</script></head></html>', 'export');
    assert.equal(withPolicy(page, 'export'), page, 'adding the policy again replaces it');
  });
});

// ---------- 4. patterns that would crash the build ----------

test('a pattern that isn\'t valid is a build error naming where it is, never a crash', () => {
  const root = makeProject({ 'api/a.js': 'export const a = 1;\n', 'web/b.js': 'export const b = 1;\n' }, {
    arch: {
      project: { name: 'Shop' }, ignore: ['src/*[z-a].js'],
      nodes: [
        { id: 'api', label: 'Server', kind: 'service', paths: ['api/**', '[evil'], exclude: ['x'.repeat(400)], hosts: ['{a,b'], packages: ['*a*a*a*a*a*a*a*a*a*a*a*a*a*b'] },
        { id: 'web', label: 'Website', kind: 'ui', paths: Array.from({ length: 501 }, (_, i) => `web/${i}/**`) },
      ],
    },
  });
  try {
    run('scan.mjs', root);
    let out, code = 0;
    try { out = run('build.mjs', root, '--no-claude-md', '--json'); } catch (e) { out = e.stdout; code = e.status; assert.equal(e.stderr, '', 'no stack trace'); }
    assert.equal(code, 1);
    const r = JSON.parse(out);
    assert.equal(r.ok, false);
    const has = (re) => assert.ok(r.errors.some((e) => re.test(e)), `${re}\n${r.errors.join('\n')}`);
    has(/^ignore\[0\] "src\/\*\[z-a\]\.js" is not a valid pattern: its range \[z-a\] runs backwards/);
    has(/^nodes\[0\] \("api"\)\.paths\[1\] "\[evil" is not a valid pattern: it has a "\[" with no "\]"/);
    has(/^nodes\[0\] \("api"\)\.exclude\[0\] "x{57}…" is not a valid pattern: it is longer than 300 characters/);
    has(/^nodes\[0\] \("api"\)\.hosts\[0\] "\{a,b" is not a valid pattern: it has a "\{" with no "\}"/);
    has(/^nodes\[0\] \("api"\)\.packages\[0\] .* is not a valid pattern: it has more than 12 wildcards/);
    has(/^nodes\[1\] \("web"\)\.paths has 501 patterns; at most 500/);
  } finally { cleanup(root); }
});

test('a description file that isn\'t an object is a build error naming the file, never a crash', () => {
  const root = makeProject({ 'api/a.js': 'export const a = 1;\n' }, {
    arch: { project: { name: 'Shop' }, nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The shop server.', paths: ['api/**'] }] },
  });
  const file = path.join(root, 'floorplan', 'descriptions', 'api.json');
  /** A script's --json result and exit code; it must print one JSON object and no stack trace. */
  const json = (script, ...args) => {
    let out, code = 0;
    try { out = run(script, root, ...args, '--json'); } catch (e) { out = e.stdout; code = e.status; assert.doesNotMatch(e.stderr, /Error/, `${script}: no stack trace`); }
    return { code, r: JSON.parse(out) };
  };
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const [text, says] of [
      ['null', /^descriptions\/api\.json must be an object like \{ "files": \{ … \}, "routes": \{ … \} \}, not null$/],
      ['[]', /^descriptions\/api\.json must be an object like .*, not a list$/],
      ['"words"', /^descriptions\/api\.json must be an object like .*, not text$/],
      ['7', /^descriptions\/api\.json must be an object like .*, not a number$/],
      ['{"files": 7}', /^descriptions\/api\.json: "files" must be an object, not a number$/],
      ['{"files": {}, "routes": ["GET /"]}', /^descriptions\/api\.json: "routes" must be an object, not a list$/],
    ]) {
      fs.writeFileSync(file, text);
      const built = json('build.mjs', '--no-claude-md');
      assert.equal(built.code, 1, text);
      assert.equal(built.r.ok, false, text);
      assert.equal(built.r.errors.length, 1, `${text}\n${built.r.errors.join('\n')}`);
      assert.match(built.r.errors[0], says);
      // a refresh leaves the file as it is and passes on what the build says about it
      const refreshed = json('refresh.mjs');
      assert.equal(refreshed.r.ok, false, text);
      assert.match(refreshed.r.errors[0], says);
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'the refresh left the file alone');
      // describe.mjs counts it as empty and writes a fresh one to fill in
      const described = json('describe.mjs');
      assert.equal(described.code, 0, text);
      assert.equal(described.r.ok, true, text);
      assert.deepEqual(Object.keys(readJson(file).files), ['api/a.js'], text);
    }
    // the file describe.mjs wrote builds
    assert.equal(json('build.mjs', '--no-claude-md').code, 0);
  } finally { cleanup(root); }
});

test('globs: valid ones still work, and the checks say plainly what is wrong', async () => {
  const { compileGlob, globProblem } = await lib('common.mjs');
  assert.ok(compileGlob('src/**/*.{ts,tsx}').test('src/a/b.tsx'));
  assert.ok(compileGlob('app/[id]/page.tsx').test('app/[id]/page.tsx'));
  assert.ok(compileGlob('src/[ab]*.js').test('src/a1.js'));
  assert.ok(compileGlob('a/**/**/**/b').test('a/x/b'), 'repeated ** folded');
  assert.equal(globProblem('src/**'), null);
  assert.match(globProblem('[]'), /empty/);
  assert.throws(() => compileGlob('[evil'), /"\[evil" is not a valid pattern/);
});

// ---------- 5. files that would stall the scan ----------

test('config files: comments stripped in one pass, and oversized ones skipped with a note', async () => {
  const { stripJsonComments, readJsonLoose, MAX_CONFIG_BYTES } = await lib('common.mjs');
  assert.deepEqual(JSON.parse(stripJsonComments('{ "a": "x // not a comment /* nor this */", /* c */ "b": [1, 2, /* d */ ], // e\n "c": "a,]", }')), { a: 'x // not a comment /* nor this */', b: [1, 2], c: 'a,]' });
  assert.deepEqual(JSON.parse(stripJsonComments('{"a": "q\\"//x"}')), { a: 'q"//x' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-cfg-'));
  try {
    // just under the size limit, full of comments that never close: one pass, so quick
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ ' + '/* '.repeat(Math.floor((MAX_CONFIG_BYTES - 100) / 3)) + '\n"compilerOptions": {} }');
    let t = Date.now();
    readJsonLoose(path.join(dir, 'tsconfig.json'));
    assert.ok(Date.now() - t < 1500, `${Date.now() - t} ms`);
    // over it: not read at all, and the scan says so
    const root = makeProject({ 'tsconfig.json': '{ ' + '/* '.repeat(Math.ceil(MAX_CONFIG_BYTES / 3) + 10) + ' }', 'src/a.ts': `import b from '@/b';\n`, 'src/b.ts': 'export default 1;\n' });
    try {
      t = Date.now();
      const out = run('scan.mjs', root);
      assert.ok(Date.now() - t < 15000);
      assert.match(out, /didn't read 1 config file\(s\) over 1 MB .*tsconfig\.json/);
      assert.ok(readJson(path.join(root, 'floorplan', '.cache', 'scan.json')).skipped.some((s) => s.path === 'tsconfig.json' && /not read/.test(s.reason)));
    } finally { cleanup(root); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a tsconfig whose "extends" leads back to itself doesn\'t crash the scan', () => {
  // one that names itself, and two that name each other; the imports below make the scan read both sets
  const root = makeProject({
    'tsconfig.json': JSON.stringify({ extends: './tsconfig.json' }),
    'src/a.ts': `import b from './b';\n`,
    'src/b.ts': 'export default 1;\n',
    'pkg/tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
    'pkg/tsconfig.base.json': JSON.stringify({ extends: './tsconfig.json' }),
    'pkg/c.ts': `import d from '@/d';\n`,
    'pkg/d.ts': 'export default 2;\n',
  });
  try {
    const out = run('scan.mjs', root);
    assert.match(out, /Floorplan scan of/);
    const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.ok(scan.edges.some((e) => e.from === 'src/a.ts' && e.to === 'src/b.ts'), 'ordinary imports are still linked');
  } finally { cleanup(root); }
});

test('files built to make pattern matching slow are scanned quickly', () => {
  const kb = (unit, n) => unit.repeat(Math.ceil((n * 1024) / unit.length)).slice(0, n * 1024);
  const mounts = {};
  for (let i = 0; i < 18; i++) mounts[`chain/f${i}.js`] = `const app = require('express')();\napp.use('/a${i}', require('./f${i + 1}'));\napp.use('/b${i}', require('./f${i + 1}'));\n`;
  mounts['chain/f18.js'] = `const app = require('express').Router();\napp.get('/x', h);\nmodule.exports = app;\n`;
  const root = makeProject({
    'blank.js': kb('\n', 400), 'dollar.js': kb('a$', 400), 'comments.js': kb('/*x ', 400), 'wrappers.js': kb('function f(p){fetch(`/a${p}`)}\n', 300),
    'defs.py': kb('def a(\n', 300), 'spaces.js': 'import a' + ' '.repeat(2000), 'keys.js': kb('sk-', 300), 'sql/schema.sql': kb('/* ', 300),
    'app/routes.ts': kb('route("a", ', 200), 'header.js': '// tool reads ' .repeat(1500) + '\nexport const x = 1;\n',
    ...mounts,
  });
  try {
    const t = Date.now();
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md', '--arch', writeArch(root));
    assert.ok(Date.now() - t < 30000, `scan and check took ${Date.now() - t} ms`);
  } finally { cleanup(root); }
});
// Reading quickly mustn't mean reading less: a cap on how far a pattern looks would drop a long list of names,
// and generated API clients import and re-export thousands of characters of them at once.
describe('long lists of names keep their links, however long', () => {
  const names = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}Response`);
  const list = (n, prefix, sep = ', ') => names(n, prefix).join(sep);
  let root, edges;
  before(() => {
    root = makeProject({
      'src/client/types.gen.ts': names(5000, 'Type').map((n) => `export type ${n} = { id: string };`).join('\n') + '\n',
      'src/client/sdk.gen.ts': names(5000, 'call').map((n) => `export const ${n} = () => 1;`).join('\n') + '\n',
      'src/client/schemas.gen.ts': names(300, 'Schema').map((n) => `export const ${n} = {};`).join('\n') + '\n',
      'src/client/index.ts': `export type { ${list(300, 'Type')} } from './types.gen';\nexport { ${list(300, 'call')} } from './sdk.gen';\n`,
      'src/app.ts': `import { ${list(300, 'Schema')} } from './client/schemas.gen';\n`,
      'src/everything.ts': `import {\n  ${list(5000, 'call', ',\n  ')},\n} from './client/sdk.gen';\nexport type { ${list(5000, 'Type')} } from './client/types.gen';\n`,
      'server/handlers.js': names(300, 'handle').map((n) => `exports.${n} = () => 1;`).join('\n') + '\n',
      'server/index.js': `const { ${list(300, 'handle')} } = require('./handlers');\n`,
      'api/models.py': names(300, 'Model').map((n) => `class ${n}:\n    pass\n`).join('\n'),
      'api/main.py': `from api.models import (\n    ${list(300, 'Model', ',\n    ')},\n)\n`,
    });
    run('scan.mjs', root);
    edges = readJson(path.join(root, 'floorplan', '.cache', 'scan.json')).edges;
  });
  after(() => cleanup(root));
  const edge = (from, to) => edges.find((e) => e.from === from && e.to === to);

  test('a 300-name import, re-export and export type each keep their link and every name', () => {
    assert.ok(list(300, 'Type').length > 2000, 'each list is longer than 2,000 characters');
    assert.equal(edge('src/app.ts', 'src/client/schemas.gen.ts')?.names.length, 300, 'import { … } from');
    assert.equal(edge('src/client/index.ts', 'src/client/sdk.gen.ts')?.names.length, 300, 'export { … } from');
    assert.equal(edge('src/client/index.ts', 'src/client/types.gen.ts')?.names.length, 300, 'export type { … } from');
  });

  test('5,000 names, over many lines or on one, keep their link too', () => {
    assert.equal(edge('src/everything.ts', 'src/client/sdk.gen.ts')?.names.length, 5000, 'a 5,000-name import over 5,000 lines');
    assert.equal(edge('src/everything.ts', 'src/client/types.gen.ts')?.names.length, 5000, 'a 5,000-name export type on one line');
  });

  test('a long require() destructuring and a long Python import list keep every name', () => {
    assert.equal(edge('server/index.js', 'server/handlers.js')?.names.length, 300, 'const { … } = require()');
    assert.equal(edge('api/main.py', 'api/models.py')?.names.length, 300, 'from x import ( … )');
  });

  test('a long Go import block, and a route table longer than 20,000 characters, are read in full', async () => {
    const { extract } = await lib('extract.mjs');
    const { findScreens } = await lib('screens.mjs');
    const pkgs = Array.from({ length: 1000 }, (_, i) => `example.com/shop/internal/services/package${i}`);
    const go = `package main\n\nimport (\n${pkgs.map((p) => `\t"${p}"`).join('\n')}\n)\n`;
    assert.ok(go.length > 20000);
    assert.deepEqual(extract(go, 'go', 'cmd/main.go').imports.map((i) => i.spec), pkgs);

    const pages = names(300, 'Page');
    const table = [
      `import { createBrowserRouter } from 'react-router-dom';`,
      `import { ${pages.join(', ')} } from './pages';`,
      `export const router = createBrowserRouter([`,
      `  {`,
      `    path: '/account',`,
      `    element: <Shell />,`,
      `    children: [`,
      ...pages.map((p, i) => `      { path: 'settings/section-${i}', element: <${p} /> },`),
      `    ],`,
      `  },`,
      `]);`,
    ].join('\n');
    assert.ok(table.length > 20000);
    const screens = findScreens(table, { path: 'src/router.tsx', category: 'code', lang: 'typescript' });
    assert.equal(screens.length, 300);
    const last = screens.find((s) => s.comp === 'Page299Response');
    assert.equal(last?.url, '/account/settings/section-299', 'the last route keeps the prefix of the route around it');
    assert.equal(last?.spec, './pages', 'and its page is found in the long import');
  });

  test('Health reads a long list of public settings to its end', async () => {
    const { findIssues } = await lib('health.mjs');
    const settings = [...names(200, 'PUBLIC_FEATURE_FLAG_'), 'PUBLIC_OPENAI_KEY'].join(', ');
    assert.ok(settings.length > 3000);
    const found = findIssues(`import { ${settings} } from '$env/static/public';\n`, { path: 'src/routes/+page.svelte', category: 'code', lang: 'svelte' });
    assert.deepEqual(found.filter((x) => x.k === 'public-env').map((x) => x.name), ['PUBLIC_OPENAI_KEY']);
  });
});

test('files of unclosed lists and brackets are still read quickly', async () => {
  const { extract } = await lib('extract.mjs');
  const { findScreens } = await lib('screens.mjs');
  const mb = (unit, n = 2) => unit.repeat(Math.ceil((n * 1024 * 1024) / unit.length));
  const cases = {
    'import { with no }': ['typescript', mb('import {')],
    '{ repeated': ['typescript', mb('{')],
    'export type { with no }': ['typescript', mb('export type {')],
    'import lists with no from': ['typescript', mb('import { a, b }\n') + "'"],
    'require() after an unclosed {': ['javascript', mb("const { a = require('x') ")],
    'require() after long spaces': ['javascript', mb(`const { a } =${' '.repeat(60)}require('x')`)],
    'from x import ( with no )': ['python', mb('from x import (\n')],
    'from followed by dots': ['python', `from ${'.'.repeat(200000)}\n`],
    'import ( with no )': ['go', mb('import (\n')],
    'route( inside an unclosed string': ['typescript', `route("${mb('route(')}`],
    'route( nested a million deep': ['typescript', mb('route("a", ', 1) + mb(')', 1)],
    'route objects nested deep': ['typescript', `createBrowserRouter\n${mb("{path:'a',", 0.5)}${mb('}', 0.5)}`],
  };
  for (const [name, [lang, src]] of Object.entries(cases)) {
    const t = performance.now();
    extract(src, lang, lang === 'python' ? 'app/routes.py' : lang === 'go' ? 'app/routes.go' : 'app/routes.ts');
    if (lang === 'typescript' || lang === 'javascript') findScreens(src, { path: 'app/routes.ts', category: 'code', lang });
    const ms = performance.now() - t;
    assert.ok(ms < 2000, `${name} (${(src.length / 1048576).toFixed(1)} MB) took ${Math.round(ms)} ms`);
  }
});

function writeArch(root) {
  const f = path.join(root, 'arch.json');
  writeJson(f, { project: { name: 'Slow' }, include: ['code', 'config', 'docs'], nodes: [{ id: 'all', label: 'Everything', kind: 'service', paths: ['**'] }] });
  return f;
}

// ---------- 6. names made to read as something else ----------

test('the map shows invisible and reordering characters as a visible marker, and keeps ids exact', () => {
  const root = makeProject({ [`api/invoice${RLO}sj.js`]: 'export const a = 1;\n', [`api/pay${ZWSP}ment.js`]: 'export const b = 1;\n' }, {
    arch: { project: { name: 'Shop' }, nodes: [{ id: 'api', label: `Server${RLO}`, kind: 'service', paths: ['api/**'] }] },
  });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md');
    const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
    const a = html.indexOf('const h = (s) =>'), b = html.indexOf('// ---------- when the browser says no');
    const { h, hk } = vm.runInNewContext(html.slice(a, b) + '\n;({ h, hk })');
    assert.equal(h(`invoice${RLO}sj.js`), 'invoice[U+202E]sj.js');
    assert.equal(h(`pay${ZWSP}ment <b>`), 'pay[U+200B]ment &lt;b&gt;');
    assert.equal(hk(`f:api/invoice${RLO}sj.js`), `f:api/invoice${RLO}sj.js`, 'ids the page reads back stay exact');
    assert.equal(h('Café 👍🏽 مرحبا 日本'), 'Café 👍🏽 مرحبا 日本', 'ordinary text in any language is untouched');
    // the keys are unchanged on the map
    assert.ok(readGraph(root).files.some((f) => f.p === `api/invoice${RLO}sj.js`));
    // every key attribute in the viewer uses hk, so a disguised name still opens the right card
    const viewer = fs.readFileSync(path.join(SKILL, 'assets', 'viewer.html'), 'utf8') + fs.readdirSync(path.join(SKILL, 'assets', 'ui')).map((n) => fs.readFileSync(path.join(SKILL, 'assets', 'ui', n), 'utf8')).join('\n');
    assert.deepEqual([...viewer.matchAll(/data-(?:go|sel|ref|flow|play|open|follow|del|rm|copy|cf|sc)="\$\{(?:SC\.)?h\(/g)].map((m) => m[0]), []);
  } finally { cleanup(root); }
});
