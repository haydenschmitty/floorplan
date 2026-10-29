#!/usr/bin/env node
// floorplan scanner: discover every repo under a codebase root, list files, extract imports,
// symbols and HTTP routes/calls, resolve them, and write floorplan/.cache/scan.json.
// Prints a compact summary meant to be read by Claude (the JSON itself can be large).
//
// usage: node scan.mjs [root] [--out <file>] [--include-worktrees] [--max-file-kb 2048]

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { discover, gitFiles, gitInfo, classify, toPosix, parseArgs, fmtNum, HARD_IGNORE_DIRS, MAP_DIR, LEGACY_MAP_DIR, isMapDir, mapDir, keepOutOfGit } from './lib/common.mjs';
import { extract, callableCallsVia, findBigTreeRoot } from './lib/extract.mjs';
import { findIssues } from './lib/health.mjs';
import { findScreens } from './lib/screens.mjs';
import { createResolver } from './lib/resolve.mjs';
import { resolveRoutes, matchCalls } from './lib/routes.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = args.out ? path.dirname(path.dirname(path.resolve(args.out))) : mapDir(root);
const outFile = path.resolve(args.out || path.join(outDir, '.cache', 'scan.json'));
const maxBytes = (Number(args['max-file-kb']) || 2048) * 1024;
const t0 = Date.now();
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

// ---------- 1. discover repos and files ----------
const found = discover(root, { includeWorktrees: !!args['include-worktrees'] });
const repos = [];
const fileList = []; // { path, repo }
const seen = new Set();
// map folders (ours, or an old show-code/ one) are output, not code
const mapDirs = new Map();
const inMap = (p) => {
  const segs = p.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] !== MAP_DIR && segs[i] !== LEGACY_MAP_DIR) continue;
    const d = segs.slice(0, i + 1).join('/');
    if (!mapDirs.has(d)) mapDirs.set(d, isMapDir(path.join(root, d)));
    if (mapDirs.get(d)) return true;
  }
  return false;
};
const ignoredByDir = (p) => p.split('/').some((seg) => HARD_IGNORE_DIRS.has(seg)) || inMap(p);

for (const r of found.repos) {
  const listed = gitFiles(r.abs);
  const info = gitInfo(r.abs);
  const prefix = r.path === '.' ? '' : r.path + '/';
  let count = 0;
  for (const f of listed || []) {
    const p = prefix + f;
    if (seen.has(p) || ignoredByDir(p)) continue;
    seen.add(p);
    fileList.push({ path: p, repo: r.path });
    count++;
  }
  repos.push({ path: r.path, name: path.basename(r.abs), ...info, files: count, ...(r.worktreeOf ? { worktreeOf: toPosix(r.worktreeOf) } : {}) });
}
for (const p of found.loose) if (!seen.has(p) && !inMap(p)) { seen.add(p); fileList.push({ path: p, repo: null }); }

// ---------- 2. classify, read, extract ----------
const files = [];
const phpSources = new Map(); // kept only until extraction; never written to the map
const bigtreeRoots = new Set(fileList.flatMap(({ path: p }) => {
  const match = /^(.*?)core\/inc\/bigtree\//.exec(p);
  return match ? [match[1].replace(/\/$/, '')] : [];
}));
for (const { path: p, repo } of fileList) {
  const abs = path.join(root, p);
  let st;
  try { st = fs.statSync(abs); } catch { continue; }
  if (!st.isFile()) continue;
  const { category, lang } = classify(p, st.size);
  const f = { path: p, repo, category, lang, bytes: st.size, loc: 0 };
  if ((category === 'code' || category === 'config' || category === 'docs') && st.size <= maxBytes) {
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { src = ''; }
    if (src.includes('\u0000')) { f.category = 'asset'; files.push(f); continue; }
    f.loc = src.split('\n').filter((l) => l.trim()).length;
    if (category === 'code' && src.length) {
      if (lang === 'php') phpSources.set(p, src);
      try {
        Object.assign(f, extract(src, lang, p));
        if (lang === 'php') { const site = findBigTreeRoot(src, p); if (site !== null) bigtreeRoots.add(site); }
      } catch (e) { f.extractError = String(e.message || e); }
      // h: exact content. sig: the parts a description depends on (exports, routes, docstring),
      // so edits inside function bodies don't mark a file's description as stale.
      f.h = hash(src);
      f.sig = hash(JSON.stringify([(f.symbols || []).map((s) => s.name).sort(), (f.routes || []).map((r) => `${r.method} ${r.path}`).sort(), f.doc || '']));
    }
    // extension hooks: per-file health findings (lib/health.mjs) and app screens (lib/screens.mjs)
    if (src.length) {
      try { const iss = findIssues(src, f); if (iss?.length) f.issues = iss; } catch (e) { f.healthError = String(e.message || e); }
      try { const scr = findScreens(src, f); if (scr?.length) f.screens = scr; } catch (e) { f.screensError = String(e.message || e); }
    }
  } else if (category === 'code' || category === 'config' || category === 'docs') {
    // too big to read and parse, but still on the map: count its lines without loading it all
    f.tooLarge = true;
    f.loc = countLines(abs);
  }
  files.push(f);
}

// Add only the framework rules for files inside an identified BigTree site. Errors remain
// per-file extraction notes, so one broken file cannot prevent the rest of a map being built.
const phpPaths = new Set(phpSources.keys());
const sites = [...bigtreeRoots].sort((a, b) => b.length - a.length);
for (const f of files) {
  if (!phpSources.has(f.path)) continue;
  const site = sites.find((r) => !r || f.path.startsWith(r + '/'));
  if (site === undefined) continue;
  try {
    Object.assign(f, extract(phpSources.get(f.path), 'php', f.path, { bigtreeRoot: site, files: phpPaths }));
    f.sig = hash(JSON.stringify([(f.symbols || []).map((s) => s.name).sort(), (f.routes || []).map((r) => `${r.method} ${r.path}`).sort(), f.doc || '']));
  } catch (e) { f.extractError = String(e.message || e); }
}

phpSources.clear();

/** Lines in a file, read in chunks so a huge file is never held in memory at once. */
function countLines(abs) {
  let fd, n = 0, last = 10;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(1 << 20);
    for (let got; (got = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      for (let i = 0; i < got; i++) if (buf[i] === 10) n++;
      last = buf[got - 1];
    }
  } catch { return 0; } finally { if (fd !== undefined) fs.closeSync(fd); }
  return n + (last === 10 ? 0 : 1);
}

// ---------- 3. resolve imports ----------
const resolve = createResolver(root, files);
const edges = [];
const externals = new Map(); // `${eco}:${name}` -> { eco, name, count, files:Set }
const extEdges = [];
let unresolved = 0;
for (const f of files) {
  if (!f.imports) continue;
  for (const imp of f.imports) {
    const res = resolve(f, imp);
    if (res.file || res.files) {
      imp.files = res.files || [res.file];
      const targets = res.files ? res.files.map((t, i) => [t, res.names?.[i]]) : [[res.file, null]];
      for (const [to, subName] of targets) {
        if (to === f.path) continue;
        edges.push({ from: f.path, to, names: subName ? [] : (imp.names || []), line: imp.line, ...(imp.dynamic ? { dynamic: true } : {}) });
      }
    } else if (res.external) {
      const key = `${res.eco}:${res.external}`;
      if (!externals.has(key)) externals.set(key, { eco: res.eco, name: res.external, count: 0, files: new Set() });
      const e = externals.get(key);
      e.count++;
      e.files.add(f.path);
      extEdges.push({ from: f.path, pkg: key });
    } else if (res.unresolved) unresolved++;
  }
}
// merge duplicate edges (same from/to)
const edgeMap = new Map();
for (const e of edges) {
  const k = e.from + '\u0000' + e.to;
  const prev = edgeMap.get(k);
  if (prev) { prev.names = [...new Set([...prev.names, ...e.names])]; prev.count++; }
  else edgeMap.set(k, { ...e, count: 1 });
}

// Firebase callable helpers used from other files: `import { callFunction } from '../lib/firebase'`,
// then callFunction('approveItem', data) calls the approveItem function
const wrappers = new Map(files.filter((f) => f.callableWrappers).map((f) => [f.path, new Set(f.callableWrappers)]));
if (wrappers.size) for (const f of files) {
  const via = (f.imports || []).flatMap((imp) => Object.entries(imp.locals || {}).filter(([, orig]) => imp.files?.some((t) => wrappers.get(t)?.has(orig))).map(([local]) => local));
  if (!via.length) continue;
  let src;
  try { src = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
  for (const local of via) f.calls = [...(f.calls || []), ...callableCallsVia(src, local)];
}

// ---------- 4. routes and HTTP calls ----------
const routes = resolveRoutes(files);
const http = matchCalls(files, routes);
const hosts = [];
for (const f of files) for (const h of f.hosts || []) hosts.push({ from: f.path, host: h.host, line: h.line });

// ---------- 5. write scan.json ----------
const scan = {
  version: 1,
  generatedAt: new Date().toISOString(),
  root: toPosix(root),
  rootName: path.basename(root),
  repos,
  skipped: found.skipped,
  files: files.map((f) => ({
    path: f.path, repo: f.repo, category: f.category, lang: f.lang, loc: f.loc, bytes: f.bytes,
    ...(f.doc ? { doc: f.doc } : {}),
    ...(f.h ? { h: f.h, sig: f.sig } : {}),
    ...(f.symbols?.length ? { symbols: f.symbols } : {}),
    ...(f.tooLarge ? { tooLarge: true } : {}),
    ...(f.issues ? { issues: f.issues } : {}),
    ...(f.screens ? { screens: f.screens } : {}),
    ...(f.triggers ? { triggers: f.triggers } : {}),
  })),
  edges: [...edgeMap.values()].map(({ from, to, names, count, dynamic }) => ({ from, to, ...(names.length ? { names } : {}), ...(count > 1 ? { count } : {}), ...(dynamic ? { dynamic } : {}) })),
  externals: [...externals.values()].map((e) => ({ id: `${e.eco}:${e.name}`, eco: e.eco, name: e.name, imports: e.count, files: e.files.size })),
  extEdges: dedupeExt(extEdges),
  routes,
  http,
  hosts,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(scan));
if (!args.out) keepOutOfGit(outDir);

function dedupeExt(list) {
  const m = new Map();
  for (const e of list) { const k = e.from + '|' + e.pkg; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([k, count]) => { const [from, pkg] = k.split('|'); return { from, pkg, count }; });
}

// ---------- 6. summary for Claude ----------
const code = scan.files.filter((f) => f.category === 'code');
const out = [];
const line = (s = '') => out.push(s);
line(`Floorplan scan of ${scan.rootName}  (${((Date.now() - t0) / 1000).toFixed(1)}s) -> ${toPosix(path.relative(root, outFile))}`);
line();
line(`REPOS (${repos.length})`);
for (const r of repos) line(`  ${r.path.padEnd(40)} ${String(r.files).padStart(6)} files  ${r.branch || '-'}@${(r.head || '').slice(0, 8)}${r.worktreeOf ? '  (worktree)' : ''}`);
const looseCount = scan.files.filter((f) => f.repo === null).length;
if (looseCount) line(`  (outside any repo)${''.padEnd(22)} ${String(looseCount).padStart(6)} files`);
const wts = found.skipped.filter((s) => s.reason.includes('worktree'));
if (wts.length) line(`  skipped ${wts.length} duplicate worktree(s), e.g. ${wts.slice(0, 3).map((s) => s.path).join(', ')}`);
const dumps = found.skipped.filter((s) => s.reason.includes('data dump'));
if (dumps.length) line(`  skipped ${dumps.length} large non-git dir(s), e.g. ${dumps.slice(0, 2).map((s) => s.path).join(', ')}`);
line();

const byCat = {};
for (const f of scan.files) byCat[f.category] = (byCat[f.category] || 0) + 1;
line(`FILES  ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
const byLang = {};
for (const f of code) { byLang[f.lang] ??= { files: 0, loc: 0 }; byLang[f.lang].files++; byLang[f.lang].loc += f.loc; }
line(`CODE   ${Object.entries(byLang).sort((a, b) => b[1].loc - a[1].loc).slice(0, 10).map(([k, v]) => `${k} ${v.files} files/${fmtNum(v.loc)} loc`).join(' · ')}`);
line();

// directory tree of code, collapsing small dirs
line('CODE TREE (files / loc; dirs under 2% of code collapsed)');
const tree = { children: new Map(), files: 0, loc: 0 };
for (const f of code) {
  let node = tree;
  node.files++; node.loc += f.loc;
  const parts = f.path.split('/').slice(0, -1);
  for (const part of parts) {
    if (!node.children.has(part)) node.children.set(part, { children: new Map(), files: 0, loc: 0 });
    node = node.children.get(part);
    node.files++; node.loc += f.loc;
  }
}
const minLoc = Math.max(50, tree.loc * 0.02);
const printTree = (node, prefix, depth) => {
  const kids = [...node.children.entries()].sort((a, b) => b[1].loc - a[1].loc);
  const shown = kids.filter(([, n]) => n.loc >= minLoc);
  for (const [name, n] of shown) {
    line(`${prefix}${name}/`.padEnd(64) + `${String(n.files).padStart(5)}  ${fmtNum(n.loc).padStart(6)}`);
    if (depth < 5) printTree(n, prefix + '  ', depth + 1);
  }
  const rest = kids.length - shown.length;
  if (rest > 0) { const rf = kids.slice(shown.length).reduce((s, [, n]) => s + n.files, 0); line(`${prefix}… ${rest} smaller dir(s), ${rf} files`); }
};
printTree(tree, '  ', 0);
line();

// entrypoint candidates
const ENTRY = /(^|\/)(main|index|app|server|cli|manage|wsgi|asgi|__main__|program|lib)\.(py|ts|tsx|js|mjs|go|rs|java|kt|cs|rb)$|(^|\/)app\/(page|layout)\.(t|j)sx?$|(^|\/)cmd\/[^/]+\/main\.go$|(^|\/)Dockerfile[^/]*$|(^|\/)(docker-compose|compose)\.ya?ml$|(^|\/)(cloudbuild|serverless|vercel|netlify|fly|render|app)\.(ya?ml|json|toml)$/i;
const entries = scan.files.filter((f) => ENTRY.test(f.path) && f.path.split('/').length <= 5).map((f) => f.path);
line(`ENTRYPOINT / DEPLOY CANDIDATES (${entries.length})`);
for (const e of entries.slice(0, 30)) line(`  ${e}`);
if (entries.length > 30) line(`  … ${entries.length - 30} more`);
line();

// directory-level dependency clusters
const dirOf = (p, depth) => p.split('/').slice(0, -1).slice(0, depth).join('/') || '.';
const depthFor = (p) => {
  const r = p.split('/');
  return Math.min(r.length - 1, 3 + (repos.length > 1 ? 1 : 0));
};
const dirEdges = new Map();
for (const e of scan.edges) {
  const a = dirOf(e.from, depthFor(e.from)), b = dirOf(e.to, depthFor(e.to));
  if (a === b) continue;
  const k = `${a} -> ${b}`;
  dirEdges.set(k, (dirEdges.get(k) || 0) + (e.count || 1));
}
line(`IMPORT EDGES  ${scan.edges.length} file->file resolved, ${unresolved} unresolved. Heaviest directory->directory:`);
for (const [k, v] of [...dirEdges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) line(`  ${String(v).padStart(5)}  ${k}`);
line();

line(`HTTP  ${routes.length} route definitions, ${http.length} call->route matches (cross-file links not visible to imports)`);
const httpDir = new Map();
for (const h of http) {
  const k = `${dirOf(h.from, depthFor(h.from))} -> ${dirOf(h.to, depthFor(h.to))}`;
  httpDir.set(k, (httpDir.get(k) || 0) + 1);
}
for (const [k, v] of [...httpDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) line(`  ${String(v).padStart(5)}  ${k}`);
line();

// Firebase Cloud Functions: endpoints are already in the HTTP line; background ones need a place on the map
const fbRoutes = files.flatMap((f) => (f.routes || []).filter((r) => r.framework === 'firebase'));
const triggers = files.flatMap((f) => (f.triggers || []).map((t) => ({ ...t, file: f.path })));
if (fbRoutes.length || triggers.length) {
  const callable = fbRoutes.filter((r) => r.method === 'CALL').length;
  line(`FIREBASE FUNCTIONS  ${callable} callable, ${fbRoutes.length - callable} onRequest, ${triggers.length} background`);
  if (triggers.length) {
    line('  background (schedules and triggers; place them in a worker node):');
    for (const t of triggers.slice(0, 20)) line(`    ${t.name}  ${t.on}${t.what ? ` "${t.what}"` : ''}  ${t.file}:${t.line}`);
    if (triggers.length > 20) line(`    … ${triggers.length - 20} more`);
  }
  line();
}

const topExt = scan.externals.sort((a, b) => b.files - a.files).slice(0, 25);
line(`EXTERNAL PACKAGES (top ${topExt.length} by importing files)`);
line('  ' + topExt.map((e) => `${e.id}(${e.files})`).join('  '));
const hostCounts = new Map();
for (const h of hosts) hostCounts.set(h.host, (hostCounts.get(h.host) || 0) + 1);
if (hostCounts.size) {
  line(`EXTERNAL HOSTS called from code`);
  line('  ' + [...hostCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([h, c]) => `${h}(${c})`).join('  '));
}
line();
const big = code.filter((f) => f.loc > 1500).sort((a, b) => b.loc - a.loc).slice(0, 10);
if (big.length) { line('LARGEST FILES'); for (const f of big) line(`  ${fmtNum(f.loc).padStart(6)}  ${f.path}`); line(); }
const unread = files.filter((f) => f.tooLarge).sort((a, b) => b.bytes - a.bytes);
if (unread.length) {
  line(`NOT READ  ${unread.length} file(s) over ${fmtNum(maxBytes / 1024)} KB: on the map, but their imports, endpoints, requests and secrets weren't checked. Re-run scan.mjs with --max-file-kb <bigger> to read them.`);
  for (const f of unread.slice(0, 15)) line(`  ${fmtNum(Math.round(f.bytes / 1024)).padStart(6)} KB  ${f.path}`);
  if (unread.length > 15) line(`  … ${unread.length - 15} more`);
  line();
}
line('Next: read references/schema.md, explore entrypoints, then write floorplan/architecture.json and run build.mjs.');
console.log(out.join('\n'));
