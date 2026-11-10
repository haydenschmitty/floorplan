#!/usr/bin/env node
// floorplan describer: turn the built graph into per-module worksheets that Claude (or parallel
// subagents) use to write a human-readable name + one-line description for every file and route.
//
// usage: node describe.mjs [root]                  write worksheets + description skeletons, print an index
//        node describe.mjs [root] --all            include entries that already have descriptions
//        node describe.mjs [root] --max-files 40   files per worksheet before splitting into parts
//        node describe.mjs [root] --json           the index as one JSON object (floorplan/describe-result@1)
//
// Run build.mjs first: worksheets are generated from floorplan/graph.json.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fmtNum, mapDir, toPosix, unattendedMode, printJson } from './lib/common.mjs';
import { fallbackFileName, fallbackRouteName, routeKey } from './lib/names.mjs';

const args = parseArgs(process.argv.slice(2));
unattendedMode(args);
const root = path.resolve(args._[0] || '.');
const outDir = mapDir(root);
const graphFile = path.join(outDir, 'graph.json');
const SCHEMA = 'floorplan/describe-result@1';
if (!fs.existsSync(graphFile)) {
  if (args.json) await printJson({ schema: SCHEMA, ok: false, errors: ['No floorplan/graph.json. Run build.mjs first.'] }, 1);
  console.error('✗ No floorplan/graph.json. Run build.mjs first.'); process.exit(1);
}
const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const maxFiles = Number(args['max-files']) || 40;
const wsDir = path.join(outDir, '.cache', 'worksheets');
const descDir = path.join(outDir, 'descriptions');
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(descDir, { recursive: true });
for (const f of fs.readdirSync(wsDir)) fs.unlinkSync(path.join(wsDir, f));

const nodes = new Map(g.nodes.map((n) => [n.id, n]));
const fileByPath = new Map(g.files.map((f) => [f.p, f]));
const label = (id) => nodes.get(id)?.label || id;
// Who the map is written for (architecture.json "audience", copied into graph.meta by build.mjs).
const audience = g.meta?.audience === 'developers' ? 'developers' : 'everyone';
const STYLE = audience === 'developers'
  ? 'technical style for engineers: name the frameworks, patterns and mechanics where they help.'
  : 'plain language for a non-technical owner: what it does for the business or its users, in everyday words, still specific. No jargon (endpoint, ORM, blueprint, webhook, worker…): the path and method/URL are already shown next to it. See "Plain language" in references/writing-descriptions.md.';

// file -> neighbours, summarised by owning node
const usesOf = new Map(), usedBy = new Map();
const bump = (m, k, v) => { if (!m.has(k)) m.set(k, new Map()); m.get(k).set(v, (m.get(k).get(v) || 0) + 1); };
for (const l of g.links) {
  if (!l.a.startsWith('f:')) continue;
  const a = l.a.slice(2);
  const bNode = l.b.startsWith('f:') ? fileByPath.get(l.b.slice(2))?.n : l.b.slice(2);
  if (bNode) bump(usesOf, a, label(bNode));
  if (l.b.startsWith('f:')) { const aNode = fileByPath.get(a)?.n; if (aNode) bump(usedBy, l.b.slice(2), label(aNode)); }
}
const top = (m, n = 5) => m ? [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k}${v > 1 ? ` ×${v}` : ''}`).join(', ') : '';

const routesByFile = new Map();
for (const r of g.routes || []) { if (!routesByFile.has(r.f)) routesByFile.set(r.f, []); routesByFile.get(r.f).push(r); }

const needs = (f) => args.all || f.auto || f.review;
const byNode = new Map();
for (const f of g.files) {
  const rs = routesByFile.get(f.p) || [];
  if (!needs(f) && !rs.some((r) => args.all || r.auto || r.review)) continue;
  if (!byNode.has(f.n)) byNode.set(f.n, []);
  byNode.get(f.n).push(f);
}

const index = [];
for (const [nid, list] of byNode) {
  list.sort((a, b) => a.p.localeCompare(b.p));
  // Split into parts of at most maxFiles files or ~100 routes, whichever comes first.
  const chunks = [[]];
  let routesInChunk = 0;
  for (const f of list) {
    const nr = (routesByFile.get(f.p) || []).length;
    const cur = chunks[chunks.length - 1];
    if (cur.length && (cur.length >= maxFiles || routesInChunk + nr > 100)) { chunks.push([]); routesInChunk = 0; }
    chunks[chunks.length - 1].push(f);
    routesInChunk += nr;
  }
  const parts = chunks.length;
  for (let i = 0; i < parts; i++) {
    const chunk = chunks[i];
    const key = parts > 1 ? `${nid}--${i + 1}` : nid;
    const descFile = path.join(descDir, `${key}.json`);
    const n = nodes.get(nid);
    const out = [];
    out.push(`# Worksheet ${key}: ${n?.label || nid}${parts > 1 ? ` (part ${i + 1}/${parts})` : ''}`);
    out.push(`Audience: ${audience}. Write in ${STYLE}`);
    if (n?.summary) out.push(`Module: ${n.summary}`);
    out.push(`Write to: floorplan/descriptions/${key}.json (a skeleton is already there; fill in every "description", improve every "name").`);
    out.push('Entries marked REVIEW already have a description but their code changed: update name/description if the change matters, then delete the "review" field. Entries not listed here are fine; leave them alone.');
    out.push('');
    let routeCount = 0;
    for (const f of chunk) {
      out.push(`## ${f.p}  (${fmtNum(f.loc)} loc, ${f.l})${f.review ? '  REVIEW' : !needs(f) ? '  (already described; only its routes need work)' : ''}`);
      if (f.review) out.push(`current: ${f.name} — ${f.d}
changed: ${f.review}`);
      if (f.doc) out.push(`doc: ${f.doc}`);
      if (f.s?.length) {
        const syms = f.s.slice(0, 12).map((s) => `${s[0]}${s[1] === 'function' ? '()' : ''}${s[4] ? ` (${s[4]})` : ''}`);
        out.push(`defines: ${syms.join('; ')}${f.s.length > 12 ? `; … +${f.s.length - 12}` : ''}`);
      }
      const u = top(usesOf.get(f.p)), b = top(usedBy.get(f.p));
      if (u) out.push(`uses: ${u}`);
      if (b) out.push(`used by: ${b}`);
      for (const r of routesByFile.get(f.p) || []) {
        routeCount++;
        const mark = r.review ? `  REVIEW (${r.review}); current: ${r.name} — ${r.d}` : r.auto ? '  NEW' : '  (described)';
        out.push(`route: ${routeKey({ method: r.m, path: r.p })}  handler ${r.h || '?'}${r.doc ? ` (${r.doc})` : ''}${mark}`);
      }
      out.push('');
    }
    fs.writeFileSync(path.join(wsDir, `${key}.md`), out.join('\n'));

    // skeleton: keep anything already written, add missing keys
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(descFile, 'utf8')); } catch {}
    const skel = { files: { ...(existing.files || {}) }, routes: { ...(existing.routes || {}) } };
    for (const f of chunk) {
      if (!skel.files[f.p]) skel.files[f.p] = { name: f.auto ? fallbackFileName(f.p) : f.name, description: f.auto ? '' : f.d };
      for (const r of routesByFile.get(f.p) || []) {
        const k = routeKey({ method: r.m, path: r.p });
        if (!skel.routes[k]) skel.routes[k] = { name: r.auto ? fallbackRouteName({ handler: r.h, method: r.m, path: r.p }) : r.name, description: r.auto ? '' : r.d };
      }
    }
    if (!Object.keys(skel.routes).length) delete skel.routes;
    fs.writeFileSync(descFile, JSON.stringify(skel, null, 2) + '\n');
    index.push({ key, node: n?.label || nid, nodeId: nid, part: parts > 1 ? i + 1 : null, parts, files: chunk.length, routes: routeCount, loc: chunk.reduce((s, f) => s + f.loc, 0),
      worksheet: toPosix(path.relative(root, path.join(wsDir, `${key}.md`))), descriptions: toPosix(path.relative(root, descFile)) });
  }
}

const totals = index.reduce((s, w) => ({ files: s.files + w.files, routes: s.routes + w.routes }), { files: 0, routes: 0 });
if (args.json) {
  // "nothing to do" is success: every file and route already has a description
  await printJson({
    schema: SCHEMA, ok: true, nothingToDo: !index.length, audience, style: `Audience: ${audience}. Write in ${STYLE}`,
    worksheetsDir: toPosix(path.relative(root, wsDir)), descriptionsDir: toPosix(path.relative(root, descDir)),
    totals: { worksheets: index.length, ...totals },
    worksheets: index.sort((a, b) => b.files - a.files || a.key.localeCompare(b.key)),
  }, 0);
}
if (!index.length) { console.log('✓ Every file and route already has a description. Use --all to regenerate worksheets for everything.'); process.exit(0); }
console.log(`${index.length} worksheet(s) in floorplan/.cache/worksheets/ covering ${totals.files} files and ${totals.routes} routes still to describe.`);
console.log('Each has a matching skeleton in floorplan/descriptions/<key>.json. Fill those in, then run build.mjs.');
console.log(`Audience: ${audience}. Write in ${STYLE}\n`);
console.log('key'.padEnd(34) + 'files'.padStart(6) + 'routes'.padStart(8) + 'loc'.padStart(8) + '  module');
for (const w of index.sort((a, b) => b.files - a.files)) console.log(w.key.padEnd(34) + String(w.files).padStart(6) + String(w.routes).padStart(8) + fmtNum(w.loc).padStart(8) + '  ' + w.node);
