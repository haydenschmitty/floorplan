// A tripwire for what the plugin can do on someone's computer. docs/is-it-safe.md promises: no hooks, no
// MCP servers, no dependencies or install steps, nothing downloaded or run from the internet, one outbound
// network call (the opt-in waitlist), a fixed list of programs it runs, and vendored files that match their
// published versions. These tests fail if any of that changes, so a change like that can't slip in unnoticed,
// in a pull request or anywhere else. If a change is intended, update this file and docs/is-it-safe.md together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO, SKILL } from './helpers.mjs';

/** Relative paths of every file under dir, with forward slashes, leaving out git's own folder and installs. */
const allFiles = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).replace(/\\/g, '/'))
  .filter((f) => !/^(\.git|node_modules)\//.test(f));
const UPDATE = 'If this is intended, update tests/supply-chain.test.mjs and docs/is-it-safe.md together.';
const rel = (f) => path.relative(SKILL, f).replace(/\\/g, '/');
const read = (f) => fs.readFileSync(f, 'utf8');
const json = (p) => JSON.parse(read(path.join(REPO, p)));
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const shipped = allFiles(SKILL).map((f) => path.join(SKILL, f));
const isVendor = (f) => rel(f).startsWith('assets/vendor/');
// the code that runs: scripts, the map's server, the page and its add-ons (not the vendored layout engine)
const code = shipped.filter((f) => /\.(mjs|js|html)$/.test(f) && !isVendor(f));
/** Every match of `re` in the shipped code, as { file, text, line }, skipping comment lines. */
function find(re) {
  const out = [];
  for (const f of code) {
    read(f).split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const m of line.matchAll(new RegExp(re, 'g'))) out.push({ file: rel(f), text: m[0], line: i + 1, m });
    });
  }
  return out;
}

test('the plugin is only a skill: no hooks, MCP servers or commands that run on their own', () => {
  // .claude/ is the maintainer's own local settings, ignored by git
  const all = allFiles(REPO).filter((f) => !f.startsWith('.claude/'));
  assert.deepEqual(all.filter((f) => /(^|\/)(hooks\.json|\.mcp\.json|\.lsp\.json)$/.test(f) || /(^|\/)hooks\//.test(f)), [], `no hooks or MCP/LSP servers. ${UPDATE}`);
  // documentationUrl, privacyPolicyUrl and supportUrl are only links, shown on the Claude plugin directory listing
  assert.deepEqual(Object.keys(json('.claude-plugin/plugin.json')).sort(), ['author', 'description', 'documentationUrl', 'homepage', 'keywords', 'license', 'name', 'privacyPolicyUrl', 'repository', 'supportUrl', 'version'], `Claude Code manifest: nothing beyond the skill. ${UPDATE}`);
  assert.deepEqual(Object.keys(json('.codex-plugin/plugin.json')).sort(), ['author', 'description', 'homepage', 'interface', 'keywords', 'license', 'name', 'repository', 'requires_local_executor', 'skills', 'version'], `Codex manifest: nothing beyond the skill. ${UPDATE}`);
  assert.equal(json('.codex-plugin/plugin.json').skills, './skills/');
  // both marketplaces install from this repo itself, never from somewhere else
  assert.deepEqual(json('.claude-plugin/marketplace.json').plugins.map((p) => p.source), ['./']);
  for (const p of json('.agents/plugins/marketplace.json').plugins) assert.equal(typeof p.source === 'string' ? p.source : p.source?.path, './', `Codex marketplace source. ${UPDATE}`);
});

test('nothing to install: no dependencies and no install scripts', () => {
  const pkg = json('package.json');
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) assert.equal(pkg[k], undefined, `package.json ${k}. ${UPDATE}`);
  assert.deepEqual(pkg.scripts, { test: 'node --test' }, `package.json scripts: only the tests. ${UPDATE}`);
  assert.ok(!allFiles(REPO).some((f) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f)), 'no lockfile, because nothing is installed');
});

test('the only commands pre-approved are the skill’s own scripts, and that list is fixed', () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(read(path.join(SKILL, 'SKILL.md')).replace(/\r\n/g, '\n'))[1];
  // each script runs without a prompt while the skill is in use, so adding one is a deliberate change
  const SCRIPTS = ['build.mjs', 'describe.mjs', 'open.mjs', 'plan.mjs', 'recent.mjs', 'refresh.mjs', 'scan.mjs', 'status.mjs'];
  const granted = /^allowed-tools:\n((?: {2}- .*\n?)+)/m.exec(front + '\n')?.[1].trim().split('\n').map((l) => l.replace(/^\s*- /, '').trim());
  assert.deepEqual(granted, SCRIPTS.map((s) => `Bash(node \${CLAUDE_SKILL_DIR}/scripts/${s} *)`), `SKILL.md allowed-tools: exactly the skill's own scripts. ${UPDATE}`);
  const scripts = fs.readdirSync(path.join(SKILL, 'scripts')).filter((n) => !fs.statSync(path.join(SKILL, 'scripts', n)).isDirectory()).sort();
  assert.deepEqual(scripts, SCRIPTS, `scripts/ list. ${UPDATE}`);
});

test('it reaches the internet in one place: the waitlist, only when someone signs up', () => {
  // no network modules except the map's own local server
  const netImports = find(/from\s+['"](?:node:)?(https?|http2|net|tls|dgram|dns|undici)['"]|require\(\s*['"](?:node:)?(https?|http2|net|tls|dgram|dns|undici)['"]\s*\)/);
  assert.deepEqual(netImports.map((x) => `${x.file}: ${x.text}`), [`assets/serve.mjs: from 'node:http'`], `network modules. ${UPDATE}`);
  // the server listens on this machine only
  assert.match(read(path.join(SKILL, 'assets', 'serve.mjs')), /server\.listen\(port, '127\.0\.0\.1'\);/);
  assert.doesNotMatch(read(path.join(SKILL, 'assets', 'serve.mjs')), /\.listen\([^)]*(0\.0\.0\.0|::)/);

  // every request: to the map's own server, except the one waitlist call
  const LOCAL = /^(['"`]\/|s\.url \+)/;
  const calls = find(/\bfetch\(\s*([^,)]+)/).map((x) => ({ ...x, arg: x.m[1].trim() }));
  const outside = calls.filter((c) => !LOCAL.test(c.arg));
  assert.deepEqual(outside.map((c) => `${c.file}: fetch(${c.arg}`), ['assets/serve.mjs: fetch(WAITLIST_URL'], `requests that leave this computer. ${UPDATE}`);
  assert.match(read(path.join(SKILL, 'assets', 'serve.mjs')), /const WAITLIST_URL = process\.env\.FLOORPLAN_WAITLIST_URL \|\| 'https:\/\/floorplan-waitlist-690500262396\.us-central1\.run\.app\/';/);
  assert.deepEqual(find(/\b(WebSocket|XMLHttpRequest|sendBeacon|importScripts)\b/).map((x) => `${x.file}: ${x.text}`), [], `other ways to reach a server. ${UPDATE}`);
  assert.deepEqual(find(/new EventSource\(\s*(?!['"`]\/)/).map((x) => `${x.file}:${x.line}`), [], 'live reload only from the local server');

  // the map page loads nothing from the internet: layout engine and fonts are built in
  const page = read(path.join(SKILL, 'assets', 'viewer.html'));
  assert.doesNotMatch(page, /<script[^>]*\ssrc=/i, 'no external scripts');
  assert.doesNotMatch(page, /<link[^>]*href=["']https?:/i, 'no external stylesheets or fonts');
  assert.doesNotMatch(page, /url\(\s*["']?https?:/i, 'no external images or fonts in CSS');
});

test('it runs a fixed list of programs, and never through a shell', () => {
  const importers = find(/from\s+['"](?:node:)?child_process['"]/).map((x) => x.file).sort();
  assert.deepEqual(importers, ['assets/serve.mjs', 'scripts/lib/common.mjs', 'scripts/open.mjs', 'scripts/refresh.mjs'], `files that start programs. ${UPDATE}`);
  // only spawn and execFileSync, which take a program and its arguments (regex .exec() is text matching)
  const names = find(/import\s*\{([^}]*)\}\s*from\s+['"](?:node:)?child_process['"]/).flatMap((x) => x.m[1].split(',').map((n) => n.trim()));
  assert.deepEqual([...new Set(names)].sort(), ['execFileSync', 'spawn'], `child_process functions used. ${UPDATE}`);
  assert.deepEqual(find(/(?<![.\w])(exec|execSync|fork|spawnSync|execFile)\(/).map((x) => `${x.file}:${x.line} ${x.text}`), [], `other ways to start programs. ${UPDATE}`);
  assert.deepEqual(find(/shell:\s*true/).map((x) => `${x.file}:${x.line}`), [], 'never through a shell');
  // what each call starts: where/which, the Claude Code or Codex CLI, Node running the skill's own scripts,
  // git, and the system's "open this address in the browser" command
  const ALLOWED = new Set([
    "process.platform === 'win32' ? 'where' : 'which'",
    'cli.cmd',
    'process.execPath',
    'node',
    "'git'",
    'opener[0]',
    'cmd',
  ]);
  const starts = find(/\b(spawn|execFileSync)\(\s*([^,]+),/).map((x) => ({ ...x, prog: x.m[2].trim() }));
  assert.ok(starts.length >= 8, 'found the calls');
  assert.deepEqual(starts.filter((s) => !ALLOWED.has(s.prog)).map((s) => `${s.file}:${s.line} ${s.prog}`), [], `programs started. ${UPDATE}`);
  assert.match(read(path.join(SKILL, 'scripts', 'refresh.mjs')), /const node = process\.execPath;/);
  // the browser openers open the map's local address and nothing else
  const openers = /\? \['cmd', \['\/c', 'start', '', u\]\] : process\.platform === 'darwin' \? \['open', \[u\]\] : \['xdg-open', \[u\]\]/;
  assert.match(read(path.join(SKILL, 'assets', 'serve.mjs')), /\? \['cmd', \['\/c', 'start', '', privateUrl\]\] : process\.platform === 'darwin' \? \['open', \[privateUrl\]\] : \['xdg-open', \[privateUrl\]\]/);
  assert.match(read(path.join(SKILL, 'scripts', 'open.mjs')), openers);
});

test('no code is downloaded, decoded or built from text at run time', () => {
  assert.deepEqual(find(/(?<![.\w])eval\(/).map((x) => `${x.file}:${x.line}`), [], `eval. ${UPDATE}`);
  // the one exception: serve.mjs loads the map's own lookup code from floorplan/query.mjs, a file the build wrote
  assert.deepEqual(find(/new Function\(/).map((x) => x.file), ['assets/serve.mjs'], `new Function. ${UPDATE}`);
  assert.match(read(path.join(SKILL, 'assets', 'serve.mjs')), /const coreSrc = fs\.readFileSync\(path\.join\(here, 'query\.mjs'\), 'utf8'\)/);
  assert.deepEqual(find(/\bimport\s*\(/).map((x) => `${x.file}:${x.line}`), [], `dynamic import. ${UPDATE}`);
  assert.deepEqual(find(/from\s+['"](?:node:)?(vm|worker_threads|inspector|wasi)['"]|new Worker\(|WebAssembly\./).map((x) => `${x.file}: ${x.text}`), [], `other ways to run code. ${UPDATE}`);
  // decoding base64: only Health reading the middle of a token it found, to tell what kind of token it is
  assert.deepEqual(find(/\batob\(|['"]base64['"]\s*\)/).filter((x) => x.file !== 'scripts/build.mjs').map((x) => x.file), ['scripts/lib/health.mjs'], `base64 decoding. ${UPDATE}`);
  // no long opaque strings that could hide a payload (the build inlines the logo and fonts from files)
  assert.deepEqual(find(/[A-Za-z0-9+/=]{160,}/).map((x) => `${x.file}:${x.line}`), [], 'long encoded strings');
});

test('every shipped file is source, text or a known kind of image or font', () => {
  const kinds = new Set(shipped.map((f) => path.extname(f).toLowerCase()));
  assert.deepEqual([...kinds].sort(), ['.html', '.js', '.json', '.md', '.mjs', '.png', '.txt', '.woff2', '.yaml'].filter((k) => kinds.has(k)), 'kinds of file');
  for (const k of kinds) assert.ok(['.html', '.js', '.json', '.md', '.mjs', '.png', '.txt', '.woff2', '.yaml'].includes(k), `unexpected kind of file: ${k}. ${UPDATE}`);
});

test('vendored files are unchanged: the layout engine matches elkjs 0.9.3 on npm byte for byte', () => {
  const VENDOR = {
    // npm: elkjs@0.9.3, package/lib/elk.bundled.js
    'elk.bundled.js': 'b0745abd7f23cd91690a1587e377edbe19fd7233c783300290936720546216d4',
    'elkjs-LICENSE.md': null,
    'fonts/inter-LICENSE.txt': null,
    'fonts/inter-latin-ext-wght-normal.woff2': null,
    'fonts/inter-latin-wght-normal.woff2': null,
    'fonts/jetbrains-mono-LICENSE.txt': null,
    'fonts/jetbrains-mono-latin-ext-wght-normal.woff2': null,
    'fonts/jetbrains-mono-latin-wght-normal.woff2': null,
  };
  const dir = path.join(SKILL, 'assets', 'vendor');
  assert.deepEqual(allFiles(dir).sort(), Object.keys(VENDOR).sort(), `vendored files. ${UPDATE}`);
  assert.equal(sha256(path.join(dir, 'elk.bundled.js')), VENDOR['elk.bundled.js'], `elk.bundled.js changed. ${UPDATE}`);
});

test('checksums tell an exact copy of a release from a changed one', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-checksums-'));
  // fingerprints of this checkout (CHECKSUMS.txt itself is the last release's, so it's left alone)
  const list = path.join(tmp, 'list.txt'), copy = path.join(tmp, 'copy');
  const tool = (...args) => execFileSync(process.execPath, [path.join(REPO, 'tools', 'checksums.mjs'), ...args, '--list', list], { encoding: 'utf8' });
  const run = (dir) => { try { return { ok: true, out: tool('--check', dir) }; } catch (e) { return { ok: false, out: String(e.stdout) }; } };
  try {
    tool();
    // an exact copy of every file it lists
    const listed = read(list).split('\n').filter((l) => /^[0-9a-f]{64}  /.test(l)).map((l) => l.slice(66));
    for (const f of listed) { fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true }); fs.copyFileSync(path.join(REPO, f), path.join(copy, f)); }
    const same = run(copy);
    assert.ok(same.ok, same.out);
    assert.match(same.out, /all \d+ files are identical/);
    fs.appendFileSync(path.join(copy, 'skills', 'floorplan', 'scripts', 'build.mjs'), '\n// changed\n');
    fs.writeFileSync(path.join(copy, 'skills', 'floorplan', 'scripts', 'extra.mjs'), '');
    const diff = run(copy);
    assert.equal(diff.ok, false);
    assert.match(diff.out, /Changed:\n {2}skills\/floorplan\/scripts\/build\.mjs/);
    assert.match(diff.out, /Not in the release:\n {2}skills\/floorplan\/scripts\/extra\.mjs/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
