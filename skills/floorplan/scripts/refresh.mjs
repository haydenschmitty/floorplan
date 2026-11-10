#!/usr/bin/env node
// floorplan refresh: bring an existing map up to date without redoing the whole thing.
// Re-scans, compares against the last build (graph.json), reconciles descriptions/*.json
// (renames carried over, deleted entries removed, entries whose exports/routes changed flagged
// with "review"), rebuilds, and reports exactly what is left for Claude to look at.
//
// usage: node refresh.mjs [root] [--from-code] [--json] [--unattended]
//
// --json prints one JSON object (floorplan/refresh-result@1): the change counts, the build's own --json
// result, and NEXT as items with stable codes. In unattended mode (FLOORPLAN_UNATTENDED=1 or --unattended)
// it exits 1 when there's no map, the scan fails, or the build fails; otherwise those exit 0 as before.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileGlob, globProblem, parseArgs, mapDir, unattendedMode, printJson } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const unattended = unattendedMode(args);
const SCHEMA = 'floorplan/refresh-result@1';
const root = path.resolve(args._[0] || '.');
const outDir = mapDir(root);
const graphFile = path.join(outDir, 'graph.json');
const archFile = path.join(outDir, 'architecture.json');
if (!fs.existsSync(graphFile) || !fs.existsSync(archFile)) {
  const msg = 'No existing map here (floorplan/graph.json + architecture.json). Do a full run instead.';
  if (args.json) await printJson({ schema: SCHEMA, ok: false, map: false, errors: [msg], build: null, next: [{ code: 'first_map', text: msg }], report: msg }, unattended ? 1 : 0);
  console.log(msg);
  process.exit(unattended ? 1 : 0);
}
const old = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const arch = JSON.parse(fs.readFileSync(archFile, 'utf8'));
// build.mjs with --json, read back: the result as data, and its report exactly as build prints it
const node = process.execPath;
function runBuild(...extra) {
  let out = '', ok = true;
  try { out = execFileSync(node, [path.join(HERE, 'build.mjs'), root, ...extra, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); }
  catch (e) { out = String(e.stdout || ''); ok = false; }
  try { const result = JSON.parse(out); return { ok, result, text: result.report ?? '' }; }
  catch { return { ok: false, result: null, text: out }; }
}

// A blueprint is redrawn from plan.json, not from code. --from-code maps the real code instead
// (plan.json is kept, so the blueprint can be drawn again with plan.mjs + build.mjs).
if (old.meta?.blueprint && !args['from-code']) {
  const next = 'This map is a blueprint, redrawn from floorplan/plan.json. Edit plan.json and architecture.json to change the plan. Once the code exists, run refresh.mjs --from-code for a map of the real code; plan.json stays.';
  let planOut;
  try { planOut = execFileSync(node, [path.join(HERE, 'plan.mjs'), root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); }
  catch (e) {
    if (args.json) await printJson({ schema: SCHEMA, ok: false, map: true, blueprint: true, errors: ['plan.mjs found problems in plan.json'], build: null, next: [{ code: 'fix_plan', text: 'Fix the problems in plan.json above, then run refresh.mjs again.' }], report: String(e.stdout || '') }, 1);
    process.stdout.write(String(e.stdout || '')); process.exit(1);
  }
  const passed = process.argv.slice(2).filter((a) => a.startsWith('--') && a !== '--json');
  const b = runBuild(...passed);
  if (args.json) await printJson({ schema: SCHEMA, ok: b.ok, map: true, blueprint: true, errors: b.ok ? [] : (b.result?.errors || ['build failed']), build: b.result, next: [{ code: 'blueprint', text: next }], report: planOut + '\n' + b.text }, b.ok ? 0 : 1);
  if (!b.ok) { process.stdout.write(b.text + '\n'); process.exit(1); }
  process.stdout.write(planOut + '\n' + b.text + '\n');
  console.log('\nNEXT  ' + next);
  process.exit(0);
}

// ---------- 1. re-scan (no tokens) ----------
let scanResult = null;
try {
  scanResult = JSON.parse(execFileSync(node, [path.join(HERE, 'scan.mjs'), root, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
} catch (e) {
  // only unattended mode fails a scan on purpose (a repo git can't list, or no files at all)
  let failed = null;
  try { failed = JSON.parse(String(e.stdout || '')); } catch {}
  if (!failed) throw e;
  const errors = failed.errors || ['scan failed'];
  if (args.json) await printJson({ schema: SCHEMA, ok: false, map: true, errors, scan: failed, build: null, next: [{ code: 'fix_scan', text: 'Fix what stopped the scan (above), then run refresh.mjs again.' }], report: errors.map((m) => `✗ ${m}`).join('\n') }, 1);
  for (const m of errors) console.log(`✗ ${m}`);
  process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(path.join(outDir, '.cache', 'scan.json'), 'utf8'));

const include = Array.isArray(arch.include) ? arch.include : ['code'];
// a pattern that isn't valid is left out here; build.mjs (run below) reports it by name
const ignore = (Array.isArray(arch.ignore) ? arch.ignore : []).filter((g) => !globProblem(g)).map(compileGlob);
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
    // a file that isn't an object, or whose files or routes aren't, is left as it is: the build below names it
    const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(d) || ['files', 'routes'].some((k) => d[k] !== undefined && !isObj(d[k]))) continue;
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
const built = runBuild();
const buildOut = built.text;
const buildOk = built.ok;
const B = built.result; // null only if the build crashed before it could report

// ---------- 6. report ----------
const since = new Date(old.meta.generatedAt);
const L = [];
L.push(`Floorplan refresh — last map ${since.toLocaleString()}`);
L.push(`  files   +${created.length} new · −${deleted.length} deleted · ${renames.size} moved/renamed (descriptions carried over) · ${edited.length} edited, ${digestChanged.length} with changed exports/routes`);
L.push(`  routes  +${newRoutes.size} new · −${goneRoutes.length - routeMoves.size} removed · ${routeMoves.size} re-pathed (descriptions carried over)`);
L.push(`  descriptions: ${carried + routeCarried} carried over, ${pruned + routePruned} removed, ${flagged} flagged for review`);
if (!before.values().next().value?.h) L.push('  (the previous map predates content fingerprints, so edits since then could not be detected; future refreshes will)');
for (const p of scanResult?.problems || []) L.push(`  ! ${p.message}`);
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
// NEXT, with a stable code per item so a program can act on it (see docs/unattended.md)
const todo = [];
const largeChange = created.length + deleted.length > Math.max(20, before.size * 0.15);
if (!buildOk) todo.push({ code: 'fix_build', text: 'Fix the build errors above in architecture.json (usually a flow step or annotation pointing at a deleted file), then run build.mjs.', errors: B?.errors || [] });
if (B ? B.files?.unassigned > 0 : /unassigned, by directory/.test(buildOut)) todo.push({ code: 'assign_new_files', text: 'New files landed outside every node: add globs (or a node) in architecture.json for the directories listed under "unassigned".', directories: B?.unassignedByDirectory || [] });
if (B?.descriptions ? !B.descriptions.complete : /Run describe/.test(buildOut)) todo.push({ code: 'describe', text: 'Run describe.mjs: it writes worksheets for only the new and flagged items. Fill them in (drop each "review" field once the entry is accurate), then run build.mjs.', ...(B?.descriptions ? { missing: { files: B.descriptions.files.total - B.descriptions.files.described, routes: B.descriptions.routes.total - B.descriptions.routes.described }, review: B.descriptions.review } : {}) });
if (largeChange) todo.push({ code: 'review_structure', text: 'This is a large change: re-read the summaries of the modules that gained or lost many files, and check the flows still hold.' });
todo.push({ code: 'recent_work', text: 'Mark recent work: run recent.mjs, rewrite recent-work.json for what was just worked on (an empty "tasks" list if nothing was), then run build.mjs.' });
L.push('NEXT');
todo.forEach((t, i) => L.push(`  ${i + 1}. ${t.text}`));
if (!args.json) console.log(L.join('\n'));
else {
  await printJson({
    schema: SCHEMA,
    ok: buildOk,
    map: true,
    blueprint: false,
    since: old.meta.generatedAt,
    errors: buildOk ? [] : (B?.errors?.length ? B.errors : ['build failed']),
    warnings: (scanResult?.problems || []).map((p) => p.message),
    changes: {
      files: { new: created.length, deleted: deleted.length, moved: renames.size, edited: edited.length, digestChanged: digestChanged.length },
      routes: { new: newRoutes.size, removed: goneRoutes.length - routeMoves.size, repathed: routeMoves.size },
      descriptions: { carried: carried + routeCarried, removed: pruned + routePruned, flagged },
      large: largeChange,
      fingerprints: !!before.values().next().value?.h,
    },
    newFilesByDirectory: [...byDir.entries()].sort((a, b) => b[1] - a[1]).map(([dir, files]) => ({ dir, files })),
    changesFile: 'floorplan/.cache/changes.json',
    build: B,
    next: todo,
    report: L.join('\n'),
  });
}
// unattended: a refresh whose build failed is a failure
if (unattended && !buildOk) process.exitCode = 1;
