#!/usr/bin/env node
// floorplan refresh: bring an existing map up to date without redoing the whole thing.
// Re-scans, compares against the last build (graph.json), reconciles descriptions/*.json
// (renames carried over, deleted entries removed, entries whose exports/routes changed flagged
// with "review"), rebuilds, and reports exactly what is left for Claude to look at.
//
// usage: node refresh.mjs [root]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileGlob, parseArgs, mapDir } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = mapDir(root);
const graphFile = path.join(outDir, 'graph.json');
const archFile = path.join(outDir, 'architecture.json');
if (!fs.existsSync(graphFile) || !fs.existsSync(archFile)) {
  console.log('No existing map here (floorplan/graph.json + architecture.json). Do a full run instead.');
  process.exit(0);
}
const old = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const arch = JSON.parse(fs.readFileSync(archFile, 'utf8'));

// ---------- 1. re-scan (no tokens) ----------
const node = process.execPath;
execFileSync(node, [path.join(HERE, 'scan.mjs'), root], { stdio: ['ignore', 'ignore', 'inherit'] });
const scan = JSON.parse(fs.readFileSync(path.join(outDir, '.cache', 'scan.json'), 'utf8'));

const include = Array.isArray(arch.include) ? arch.include : ['code'];
const ignore = (arch.ignore || []).map(compileGlob);
const now = new Map(scan.files.filter((f) => include.includes(f.category) && !ignore.some((g) => g.test(f.path))).map((f) => [f.path, f]));
const before = new Map(old.files.map((f) => [f.p, f]));

// ---------- 2. diff files ----------
const added = [...now.keys()].filter((p) => !before.has(p));
const removed = [...before.keys()].filter((p) => !now.has(p));
const edited = [...now.keys()].filter((p) => before.has(p) && before.get(p).h && now.get(p).h !== before.get(p).h);
const digestChanged = edited.filter((p) => before.get(p).sig && now.get(p).sig !== before.get(p).sig);

// renames: same content, or same file name + same digest
const renames = new Map();
const addedLeft = new Set(added);
for (const r of removed) {
  const o = before.get(r);
  let match = o.h ? [...addedLeft].find((a) => now.get(a).h === o.h) : null;
  if (!match) {
    const cands = [...addedLeft].filter((a) => path.posix.basename(a) === path.posix.basename(r) && (!o.sig || now.get(a).sig === o.sig));
    if (cands.length === 1) match = cands[0];
  }
  if (match) { renames.set(r, match); addedLeft.delete(match); }
}
const deleted = removed.filter((r) => !renames.has(r));
const created = [...addedLeft];

// what changed in a file's exports/routes, for the review note
const oldRoutesByFile = new Map();
for (const r of old.routes || []) { if (!oldRoutesByFile.has(r.f)) oldRoutesByFile.set(r.f, []); oldRoutesByFile.get(r.f).push(`${r.m} ${r.p}`); }
const newRoutesByFile = new Map();
for (const r of scan.routes) { if (!newRoutesByFile.has(r.file)) newRoutesByFile.set(r.file, []); newRoutesByFile.get(r.file).push(`${r.method} ${r.path}`); }
function changeNote(p, prevPath = p) {
  const o = before.get(prevPath), n = now.get(p);
  const os = new Set((o.s || []).map((s) => s[0])), ns = new Set((n.symbols || []).map((s) => s.name));
  const plus = [...ns].filter((x) => !os.has(x)), minus = [...os].filter((x) => !ns.has(x));
  const orr = new Set(oldRoutesByFile.get(prevPath) || []), nr = new Set(newRoutesByFile.get(p) || []);
  const rPlus = [...nr].filter((x) => !orr.has(x)).length, rMinus = [...orr].filter((x) => !nr.has(x)).length;
  const parts = [];
  if (plus.length) parts.push(`new exports: ${plus.slice(0, 6).join(', ')}${plus.length > 6 ? '…' : ''}`);
  if (minus.length) parts.push(`removed exports: ${minus.slice(0, 6).join(', ')}${minus.length > 6 ? '…' : ''}`);
  if (rPlus) parts.push(`${rPlus} new route(s)`);
  if (rMinus) parts.push(`${rMinus} removed route(s)`);
  if (!parts.length) parts.push('docstring or structure changed');
  return parts.join('; ');
}

// ---------- 3. diff routes ----------
const oldRouteKeys = new Map((old.routes || []).map((r) => [`${r.m} ${r.p}`, r]));
const newRouteKeys = new Map(scan.routes.map((r) => [`${r.method} ${r.path}`, r]));
const routeMoves = new Map(); // old key -> new key (same handler in the same / renamed file)
const goneRoutes = [...oldRouteKeys.keys()].filter((k) => !newRouteKeys.has(k));
const newRoutes = new Set([...newRouteKeys.keys()].filter((k) => !oldRouteKeys.has(k)));
for (const k of goneRoutes) {
  const o = oldRouteKeys.get(k);
  const file = renames.get(o.f) || o.f;
  const m = [...newRoutes].find((nk) => { const n = newRouteKeys.get(nk); return n.file === file && o.h && n.handler === o.h; });
  if (m) { routeMoves.set(k, m); newRoutes.delete(m); }
}

// ---------- 4. reconcile descriptions ----------
const descDir = path.join(outDir, 'descriptions');
let carried = 0, pruned = 0, flagged = 0, routeCarried = 0, routePruned = 0;
const digestSet = new Set(digestChanged);
if (fs.existsSync(descDir)) {
  for (const name of fs.readdirSync(descDir).filter((n) => n.endsWith('.json'))) {
    const fp = path.join(descDir, name);
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    let changed = false;
    const filesOut = {};
    for (const [p, v] of Object.entries(d.files || {})) {
      if (renames.has(p)) {
        const np = renames.get(p);
        filesOut[np] = now.get(np).sig !== before.get(p).sig ? { ...v, review: `moved from ${p}; ${changeNote(np, p)}` } : v;
        carried++; changed = true;
      } else if (deleted.includes(p)) { pruned++; changed = true; }
      else if (digestSet.has(p) && v.description) { filesOut[p] = { ...v, review: changeNote(p) }; flagged++; changed = true; }
      else filesOut[p] = v;
    }
    const routesOut = {};
    for (const [k, v] of Object.entries(d.routes || {})) {
      if (routeMoves.has(k)) { routesOut[routeMoves.get(k)] = { ...v, review: `path changed from ${k}` }; routeCarried++; changed = true; }
      else if (!newRouteKeys.has(k) && oldRouteKeys.has(k)) { routePruned++; changed = true; }
      else routesOut[k] = v;
    }
    if (changed) {
      const outObj = { files: filesOut, ...(Object.keys(routesOut).length ? { routes: routesOut } : {}) };
      if (!Object.keys(filesOut).length && !Object.keys(routesOut).length) fs.unlinkSync(fp);
      else fs.writeFileSync(fp, JSON.stringify(outObj, null, 2) + '\n');
    }
  }
}

// what changed since the last build, for recent.mjs (marking recent work on the map)
fs.writeFileSync(path.join(outDir, '.cache', 'changes.json'), JSON.stringify({
  since: old.meta.generatedAt, at: new Date().toISOString(),
  files: { new: created, edited: edited.filter((p) => !created.includes(p)), moved: [...renames].map(([a, b]) => ({ from: a, to: b })), deleted },
  routes: { new: [...newRoutes], removed: goneRoutes.filter((k) => !routeMoves.has(k)), moved: [...routeMoves].map(([a, b]) => ({ from: a, to: b })) },
}, null, 2));

// ---------- 5. rebuild (no tokens) ----------
let buildOut = '';
let buildOk = true;
try { buildOut = execFileSync(node, [path.join(HERE, 'build.mjs'), root, ...(args.agent ? ['--agent', String(args.agent)] : [])], { encoding: 'utf8' }); }
catch (e) { buildOut = (e.stdout || '') + (e.stderr || ''); buildOk = false; }

// ---------- 6. report ----------
const since = new Date(old.meta.generatedAt);
const L = [];
L.push(`Floorplan refresh — last map ${since.toLocaleString()}`);
L.push(`  files   +${created.length} new · −${deleted.length} deleted · ${renames.size} moved/renamed (descriptions carried over) · ${edited.length} edited, ${digestChanged.length} with changed exports/routes`);
L.push(`  routes  +${newRoutes.size} new · −${goneRoutes.length - routeMoves.size} removed · ${routeMoves.size} re-pathed (descriptions carried over)`);
L.push(`  descriptions: ${carried + routeCarried} carried over, ${pruned + routePruned} removed, ${flagged} flagged for review`);
if (!before.values().next().value?.h) L.push('  (the previous map predates content fingerprints, so edits since then could not be detected; future refreshes will)');
const byDir = new Map();
for (const p of created) { const d = p.split('/').slice(0, -1).join('/'); byDir.set(d, (byDir.get(d) || 0) + 1); }
if (byDir.size) {
  L.push('  new files by directory:');
  for (const [d, c] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`    ${String(c).padStart(4)}  ${d}/`);
}
L.push('');
L.push('BUILD');
L.push(buildOut.split('\n').filter((l) => /^(✗|!|  - |ASSIGNMENT|  unassigned|    |DESCRIPTIONS|  Run describe|✓)/.test(l)).slice(0, 40).join('\n'));
L.push('');
const todo = [];
if (!buildOk) todo.push('Fix the build errors above in architecture.json (usually a flow step or annotation pointing at a deleted file), then run build.mjs.');
if (/unassigned, by directory/.test(buildOut)) todo.push('New files landed outside every node: add globs (or a node) in architecture.json for the directories listed under "unassigned".');
if (/Run describe/.test(buildOut)) todo.push('Run describe.mjs: it writes worksheets for only the new and flagged items. Fill them in (drop each "review" field once the entry is accurate), then run build.mjs.');
if (created.length + deleted.length > Math.max(20, before.size * 0.15)) todo.push('This is a large change: re-read the summaries of the modules that gained or lost many files, and check the flows still hold.');
todo.push('Mark recent work: run recent.mjs, rewrite recent-work.json for what was just worked on (an empty "tasks" list if nothing was), then run build.mjs.');
L.push('NEXT');
todo.forEach((t, i) => L.push(`  ${i + 1}. ${t}`));
console.log(L.join('\n'));
