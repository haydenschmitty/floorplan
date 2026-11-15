// "Open in editor" opens the editor people use: VS Code by default, or one set by name or as a link template in
// architecture.json ("editor") or on the map's server (--editor, FLOORPLAN_EDITOR). The setting is text Floorplan
// didn't write, so only editors' own link schemes are taken, never a script, data, web or file: link, and the page
// checks it again before building a link. The page's own code is run here (not a real browser).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { SKILL, shopApp, run, readGraph, readJson, writeJson, cleanup } from './helpers.mjs';

const { editorTemplate, EDITOR_PRESETS, EDITOR_SCHEMES } = await import(new URL('../skills/floorplan/assets/page-safety.mjs', import.meta.url));

const roots = [];
const servers = [];
after(async () => {
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((resolve) => { s.once('exit', resolve); s.kill(); })));
  roots.forEach(cleanup);
});
const fails = (fn) => { try { fn(); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } assert.fail('expected the script to fail'); };

/** A shop map built with this architecture.json "editor" (left out when undefined). */
function built(editor) {
  const root = shopApp();
  roots.push(root);
  const file = path.join(root, 'floorplan', 'architecture.json');
  if (editor !== undefined) writeJson(file, { ...readJson(file), editor });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  return root;
}

const START = '// ---------- editor links ----------';
const END = '// ---------- end: editor links ----------';
/** The page's editor-link code, from the built map, run with this graph and (optionally) what the server injected. */
function pageLinks(html, G, server) {
  const a = html.indexOf(START), b = html.indexOf(END);
  assert.ok(a > 0 && b > a, 'the built page has its editor-link code between the expected markers');
  const ctx = { window: server ? { FLOORPLAN_SERVER: server } : {}, G, PLAN: !!G.meta.blueprint };
  return vm.runInNewContext(html.slice(a, b) + '\n;({ editorUrl, EDITOR, EDITOR_SCHEMES })', ctx);
}
const page = (root) => fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
const rootPath = (root) => encodeURI(readGraph(root).meta.root.replace(/\\/g, '/'));

test('editor settings: named editors and link templates in an editor\'s scheme are taken, anything else is named', () => {
  assert.deepEqual(editorTemplate(undefined), { template: null });
  assert.deepEqual(editorTemplate(''), { template: null });
  assert.equal(editorTemplate('cursor').template, 'cursor://file/{path}:{line}');
  assert.equal(editorTemplate(' Zed ').template, EDITOR_PRESETS.zed);
  assert.equal(editorTemplate('idea').template, 'idea://open?file={path}&line={line}');
  for (const name of ['vscode', 'vscode-insiders', 'vscodium', 'windsurf', 'phpstorm']) assert.ok(editorTemplate(name).template, name);
  assert.equal(editorTemplate('zed://file/{path}:{line}:{column}').template, 'zed://file/{path}:{line}:{column}');
  assert.equal(editorTemplate('CURSOR://file/{path}').template, 'CURSOR://file/{path}');
  // near miss: "file://" inside an editor's own link is fine, it's the editor that reads it
  assert.equal(editorTemplate('subl://open?url=file://{path}&line={line}').template, 'subl://open?url=file://{path}&line={line}');

  const refused = {
    'javascript:alert(1)//{path}': /starts with "javascript:", which isn't an editor's link/,
    'JavaScript:alert(1)//{path}': /starts with "javascript:"/,
    'data:text/html,{path}': /"data:"/,
    'http://example.com/{path}': /"http:"/,
    'https://example.com/open?f={path}': /"https:"/,
    'file:///{path}': /"file:"/,
    'vbscript:{path}': /"vbscript:"/,
    'ms-msdt:/id {path}': /"ms-msdt:"/,
    'notepad': /isn't an editor's name/,
    '//{path}': /isn't an editor's name/,
    'vscode://file/a.js': /needs \{path\}/,
    'vscode://file/{path}:{lines}': /has \{lines\}/,
    'vscode://file/{path}" onclick="x': /space, quote/,
    'vscode://file/{path}<b>': /space, quote/,
    'vscode://file/{path}\tx': /control character/,
    [`vscode://file/${'a'.repeat(300)}{path}`]: /longer than 300/,
  };
  for (const [value, why] of Object.entries(refused)) assert.match(editorTemplate(value).error || '', why, value);
  assert.match(editorTemplate(42).error, /must be an editor's name/);
});

test('by default the links open VS Code, exactly as before', () => {
  const root = built(undefined);
  const g = readGraph(root);
  assert.equal(g.meta.editor, undefined);
  const { editorUrl, EDITOR } = pageLinks(page(root), g);
  assert.equal(EDITOR, 'vscode://file/{path}:{line}');
  assert.equal(editorUrl('shop-api/server.js'), `vscode://file/${rootPath(root)}/shop-api/server.js:1`);
  assert.equal(editorUrl('shop-api/routes/orders.js', 7), `vscode://file/${rootPath(root)}/shop-api/routes/orders.js:7`);
});

test('architecture.json "editor" picks the editor by name or by link, for the buttons and the right-click menu', () => {
  const root = built('cursor');
  const g = readGraph(root);
  assert.equal(g.meta.editor, 'cursor://file/{path}:{line}');
  assert.equal(pageLinks(page(root), g).editorUrl('shop-api/server.js', 3), `cursor://file/${rootPath(root)}/shop-api/server.js:3`);
  // the page builds every editor link through editorUrl, and escapes it in the button's href
  assert.doesNotMatch(page(root), /vscode:\/\/file\/\$\{/);
  assert.equal((page(root).match(/href="\$\{hk\(url\)\}"/g) || []).length, 3);

  const jb = built('idea://open?file={path}&line={line}');
  const links = pageLinks(page(jb), readGraph(jb));
  assert.equal(links.editorUrl('shop-web/src/App.jsx', 2), `idea://open?file=${rootPath(jb)}/shop-web/src/App.jsx&line=2`);
});

test('a path that would break the link is encoded: query and fragment characters, quotes, spaces', () => {
  const root = built('idea');
  const g = readGraph(root);
  const { editorUrl } = pageLinks(page(root), g);
  const url = editorUrl('notes/a b#1&x=y+"z".js', 4);
  assert.equal(url, `idea://open?file=${rootPath(root)}/notes/a%20b%231%26x%3Dy%2B%22z%22.js&line=4`);
  assert.doesNotMatch(url.slice(url.indexOf('?file=') + 6, url.indexOf('&line=')), /[#&?="<> ]/);
  // a path encodeURI can't take gets no link rather than an error
  assert.equal(editorUrl('bad' + String.fromCharCode(0xd800) + '.js'), null);
});

test('a hostile "editor" is a build error, and one put in the page some other way is never used', () => {
  const root = shopApp();
  roots.push(root);
  const file = path.join(root, 'floorplan', 'architecture.json');
  run('scan.mjs', root);
  for (const bad of ['javascript:alert(document.domain)//{path}', 'https://example.com/?f={path}', 'data:text/html;base64,PHNjcmlwdD4={path}', 'vscode://file/{path}"><img src=x onerror=alert(1)>']) {
    writeJson(file, { ...readJson(file), editor: bad });
    assert.match(fails(() => run('build.mjs', root, '--no-claude-md')), /editor "/);
  }
  // the page checks again: a graph or server setting that skipped the checks falls back to VS Code
  writeJson(file, { ...readJson(file), editor: undefined });
  run('build.mjs', root, '--no-claude-md');
  const html = page(root), g = readGraph(root);
  for (const bad of ['javascript:alert(1)//{path}', 'http://example.com/{path}', 'vscode://file/{path}"x', 'data:,{path}', 'ms-msdt:{path}', 'zed://file/', 42]) {
    assert.equal(pageLinks(html, { ...g, meta: { ...g.meta, editor: bad } }).EDITOR, 'vscode://file/{path}:{line}', String(bad));
    assert.equal(pageLinks(html, g, { editor: bad }).EDITOR, 'vscode://file/{path}:{line}', String(bad));
  }
  // near miss: a good setting in either place is used
  assert.equal(pageLinks(html, { ...g, meta: { ...g.meta, editor: 'zed://file/{path}:{line}' } }).EDITOR, 'zed://file/{path}:{line}');
});

test('an exported copy and a blueprint have no editor links, whatever the setting', () => {
  const root = built('cursor');
  const g = readGraph(root);
  assert.equal(pageLinks(page(root), { ...g, meta: { ...g.meta, root: null } }).editorUrl('shop-api/server.js'), null);
  assert.equal(pageLinks(page(root), { ...g, meta: { ...g.meta, blueprint: {} } }).editorUrl('shop-api/server.js'), null);
});

test('the page and page-safety.mjs allow the same editor schemes', () => {
  const root = built(undefined);
  assert.deepEqual([...pageLinks(page(root), readGraph(root)).EDITOR_SCHEMES], EDITOR_SCHEMES);
  for (const t of Object.values(EDITOR_PRESETS)) assert.equal(editorTemplate(t).template, t, `${t} passes its own check`);
});

/** Starts the map's server with these arguments and environment; resolves { page } or { exit, out }. */
function serve(root, args = [], env = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const s = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open', ...args], {
    cwd: root, env: { ...process.env, FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_EDITOR: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(s);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    s.stdout.on('data', async (d) => {
      out += d;
      const m = /Floorplan: (http:\/\/\S+)/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      const html = await (await fetch(m[1] + '/')).text();
      const server = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(html)[1]);
      const token = server.token;
      const status = await (await fetch(m[1] + '/api/status', { headers: { 'x-floorplan-token': token } })).json();
      resolve({ html, server, status });
    });
    s.stderr.on('data', (d) => { out += d; });
    s.on('exit', (code) => { clearTimeout(timer); resolve({ exit: code, out }); });
  });
}

test('the map\'s server can set the editor for every map it shows, over architecture.json, and refuses a bad one', async () => {
  const root = built('cursor');
  const g = readGraph(root);
  const flag = await serve(root, ['--editor', 'zed']);
  assert.equal(flag.server.editor, 'zed://file/{path}:{line}');
  assert.equal(flag.status.editor, 'zed://file/{path}:{line}', 'open.mjs can tell which editor a running server uses');
  assert.equal(pageLinks(flag.html, g, flag.server).editorUrl('shop-api/server.js'), `zed://file/${rootPath(root)}/shop-api/server.js:1`);

  const fromEnv = await serve(root, [], { FLOORPLAN_EDITOR: 'windsurf' });
  assert.equal(fromEnv.server.editor, 'windsurf://file/{path}:{line}');
  // without either, the page uses architecture.json's
  const none = await serve(root);
  assert.equal(none.server.editor, null);
  assert.equal(pageLinks(none.html, g, none.server).EDITOR, 'cursor://file/{path}:{line}');

  const bad = await serve(root, ['--editor', 'javascript:alert(1)//{path}']);
  assert.equal(bad.exit, 1);
  assert.match(bad.out, /--editor "javascript:alert\(1\)\/\/\{path\}" starts with "javascript:"/);
  const badEnv = await serve(root, [], { FLOORPLAN_EDITOR: 'https://example.com/{path}' });
  assert.equal(badEnv.exit, 1);
  assert.match(badEnv.out, /FLOORPLAN_EDITOR "https:/);
});

test('open.mjs names a bad --editor before starting anything', () => {
  const root = built(undefined);
  const out = fails(() => execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'open.mjs'), root, '--no-open', '--editor=file:///{path}'], { encoding: 'utf8', stdio: 'pipe' }));
  assert.match(out, /--editor "file:\/\/\/\{path\}" starts with "file:"/);
  assert.ok(!fs.existsSync(path.join(root, 'floorplan', '.cache', 'server.json')), 'no server was started');
});
