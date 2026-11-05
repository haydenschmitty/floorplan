#!/usr/bin/env node
// Facts for marking "recent work" on the map: what changed since the last map (from refresh.mjs),
// uncommitted changes, and recent commits, each tied to the card it shows up as. Claude adds the why
// (what the user asked for) and writes floorplan/recent-work.json. Read-only.
// usage: node recent.mjs [root] [--days 7]
import fs from 'node:fs';
import path from 'node:path';
import { git, parseArgs, mapDir, readJsonFile } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const dir = mapDir(root);
const graphFile = path.join(dir, 'graph.json');
if (!fs.existsSync(graphFile)) { console.error('✗ No floorplan/graph.json. Run build.mjs first.'); process.exit(1); }
const G = readJsonFile(graphFile);
const readJson = (f) => { try { return readJsonFile(f); } catch { return null; } };
const changes = readJson(path.join(dir, '.cache', 'changes.json'));
const current = readJson(path.join(dir, 'recent-work.json'));

const files = new Map(G.files.map((f) => [f.p, f]));
const labels = new Map(G.nodes.map((n) => [n.id, n.label]));
const routesOf = new Map();
for (const r of G.routes) { if (!routesOf.has(r.f)) routesOf.set(r.f, []); routesOf.get(r.f).push(`${r.m} ${r.p}`); }
const card = (p) => {
  const f = files.get(p);
  if (!f) return '(not on the map)';
  const rs = routesOf.get(p) || [];
  return `"${f.name}" in ${labels.get(f.n) || f.n}${rs.length ? ` · ${rs.length} endpoint(s)` : ''}`;
};
const L = [];
const MAX = 40;
const list = (rows) => { rows.slice(0, MAX).forEach((r) => L.push('  ' + r)); if (rows.length > MAX) L.push(`  … +${rows.length - MAX} more`); };

L.push(`RECENT WORK FACTS for ${G.project.name}  (map built ${G.meta.generatedAt})`);
L.push(current?.tasks
  ? `Current recent-work.json: ${current.tasks.length} task(s), updated ${current.updatedAt || 'unknown'}. Rewrite it: it replaces the previous highlights.`
  : 'No recent-work.json yet.');

if (changes) {
  L.push('', `CHANGED SINCE THE PREVIOUS MAP (${changes.since} → ${changes.at})`);
  const rows = [
    ...changes.files.new.map((p) => `new      ${p}  → ${card(p)}`),
    ...changes.files.edited.map((p) => `edited   ${p}  → ${card(p)}`),
    ...changes.files.moved.map((m) => `moved    ${m.from} → ${m.to}  → ${card(m.to)}`),
    ...changes.files.deleted.map((p) => `deleted  ${p}  (gone from the map; mention it in the task summary)`),
    ...changes.routes.new.map((k) => `new endpoint      ${k}`),
    ...changes.routes.moved.map((m) => `re-pathed endpoint ${m.from} → ${m.to}`),
    ...changes.routes.removed.map((k) => `removed endpoint  ${k}`),
  ];
  if (rows.length) list(rows); else L.push('  nothing');
}

const since = changes?.since || current?.updatedAt || new Date(Date.now() - (Number(args.days) || 7) * 86400000).toISOString();
if (!(G.meta.repos || []).length) {
  L.push('', 'NO GIT REPOSITORIES  Refresh compares fingerprints without git.');
  if (!changes) {
    const days = Number(args.days) || 7, cutoff = Date.now() - days * 86400000;
    const touched = G.files.filter((f) => { try { return fs.statSync(path.join(root, f.p)).mtimeMs >= cutoff; } catch { return false; } });
    L.push(`FILES MODIFIED IN THE LAST ${days} DAYS (mtime hints, not a diff): ${touched.length}`);
    list(touched.map((f) => `${f.p}  → ${card(f.p)}`));
  }
}
for (const r of G.meta.repos || []) {
  const abs = path.join(root, r.path);
  const prefix = r.path === '.' ? '' : r.path + '/';
  const status = (git(abs, ['status', '--porcelain=v1', '-uall']) || '').split('\n').filter(Boolean);
  const log = (git(abs, ['log', `--since=${since}`, '--max-count=20', '--no-merges', '--name-only', '--date=short', '--format=@@%h %ad %s']) || '').trim();
  if (!status.length && !log) continue;
  L.push('', `REPO ${r.path === '.' ? G.meta.rootName : r.path}`);
  if (status.length) {
    L.push('  uncommitted:');
    list(status.map((s) => { const p = prefix + s.slice(3).replace(/^.* -> /, '').replace(/"/g, ''); return `  ${s.slice(0, 2).trim().padEnd(2)} ${p}  → ${card(p)}`; }));
  }
  if (log) {
    L.push(`  commits since ${since.slice(0, 10)}:`);
    for (const block of log.split('@@').filter(Boolean)) {
      const [head, ...paths] = block.trim().split('\n').filter(Boolean);
      L.push(`    ${head}`);
      paths.slice(0, 8).forEach((p) => L.push(`        ${prefix + p}  → ${card(prefix + p)}`));
      if (paths.length > 8) L.push(`        … +${paths.length - 8} more files`);
    }
  }
}

L.push('', 'Write floorplan/recent-work.json (refs: a file path, a node id, or "METHOD /path"; see references/schema.md#recent-work):',
  '  { "tasks": [ { "title": "…", "request": "what the user asked for", "summary": "what was done toward it, and where it stands",',
  '      "items": [ { "ref": "<file path>", "change": "changed|new", "note": "what changed here, and how it serves the request" } ] } ] }',
  'Then run build.mjs. Use { "tasks": [] } when nothing was worked on.');
console.log(L.join('\n'));
