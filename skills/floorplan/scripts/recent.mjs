#!/usr/bin/env node
// Facts for marking "recent work" on the map: what changed since the last map (from refresh.mjs),
// uncommitted changes, and recent commits, each tied to the card it shows up as. Claude adds the why
// (what the user asked for) and writes floorplan/recent-work.json. Read-only.
// usage: node recent.mjs [root] [--days 7] [--json]
// --json prints one JSON object (floorplan/recent-result@1): the same facts as data, plus the text as "text".
import fs from 'node:fs';
import path from 'node:path';
import { git, parseArgs, mapDir, unattendedMode, printJson } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
unattendedMode(args);
const root = path.resolve(args._[0] || '.');
const dir = mapDir(root);
const graphFile = path.join(dir, 'graph.json');
const SCHEMA = 'floorplan/recent-result@1';
if (!fs.existsSync(graphFile)) {
  if (args.json) await printJson({ schema: SCHEMA, ok: false, errors: ['No floorplan/graph.json. Run build.mjs first.'] }, 1);
  console.error('✗ No floorplan/graph.json. Run build.mjs first.'); process.exit(1);
}
const G = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const changes = readJson(path.join(dir, '.cache', 'changes.json'));
const current = readJson(path.join(dir, 'recent-work.json'));

const files = new Map(G.files.map((f) => [f.p, f]));
const labels = new Map(G.nodes.map((n) => [n.id, n.label]));
const routesOf = new Map();
for (const r of G.routes) { if (!routesOf.has(r.f)) routesOf.set(r.f, []); routesOf.get(r.f).push(`${r.m} ${r.p}`); }
/** The card a path shows up as, as data: null when it isn't on the map. */
const cardOf = (p) => {
  const f = files.get(p);
  if (!f) return null;
  return { name: f.name, node: f.n, nodeLabel: labels.get(f.n) || f.n, endpoints: routesOf.get(p) || [] };
};
const card = (p) => {
  const c = cardOf(p);
  if (!c) return '(not on the map)';
  return `"${c.name}" in ${c.nodeLabel}${c.endpoints.length ? ` · ${c.endpoints.length} endpoint(s)` : ''}`;
};
const L = [];
const MAX = 40;
const list = (rows) => { rows.slice(0, MAX).forEach((r) => L.push('  ' + r)); if (rows.length > MAX) L.push(`  … +${rows.length - MAX} more`); };
const data = { schema: SCHEMA, ok: true, project: G.project.name, mapBuiltAt: G.meta.generatedAt, current: current?.tasks ? { tasks: current.tasks.length, updatedAt: current.updatedAt || null } : null, changedSinceMap: null, since: null, repos: [] };

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
  data.changedSinceMap = {
    since: changes.since, at: changes.at,
    files: {
      new: changes.files.new.map((p) => ({ path: p, card: cardOf(p) })),
      edited: changes.files.edited.map((p) => ({ path: p, card: cardOf(p) })),
      moved: changes.files.moved.map((m) => ({ from: m.from, to: m.to, card: cardOf(m.to) })),
      deleted: changes.files.deleted,
    },
    routes: changes.routes,
  };
}

const since = changes?.since || current?.updatedAt || new Date(Date.now() - (Number(args.days) || 7) * 86400000).toISOString();
data.since = since;
for (const r of G.meta.repos || []) {
  const abs = path.join(root, r.path);
  const prefix = r.path === '.' ? '' : r.path + '/';
  const status = (git(abs, ['status', '--porcelain=v1', '-uall']) || '').split('\n').filter(Boolean);
  const log = (git(abs, ['log', `--since=${since}`, '--max-count=20', '--no-merges', '--name-only', '--date=short', '--format=@@%h %ad %s']) || '').trim();
  if (!status.length && !log) continue;
  const repo = { path: r.path, uncommitted: [], commits: [] };
  data.repos.push(repo);
  L.push('', `REPO ${r.path === '.' ? G.meta.rootName : r.path}`);
  if (status.length) {
    L.push('  uncommitted:');
    const rows = status.map((s) => ({ status: s.slice(0, 2).trim(), path: prefix + s.slice(3).replace(/^.* -> /, '').replace(/"/g, '') }));
    repo.uncommitted = rows.map((u) => ({ ...u, card: cardOf(u.path) }));
    list(rows.map((u) => `  ${u.status.padEnd(2)} ${u.path}  → ${card(u.path)}`));
  }
  if (log) {
    L.push(`  commits since ${since.slice(0, 10)}:`);
    for (const block of log.split('@@').filter(Boolean)) {
      const [head, ...paths] = block.trim().split('\n').filter(Boolean);
      L.push(`    ${head}`);
      paths.slice(0, 8).forEach((p) => L.push(`        ${prefix + p}  → ${card(prefix + p)}`));
      if (paths.length > 8) L.push(`        … +${paths.length - 8} more files`);
      const m = /^(\S+) (\S+) ?(.*)$/.exec(head) || [];
      repo.commits.push({ hash: m[1] || head, date: m[2] || null, subject: m[3] || '', files: paths.map((p) => ({ path: prefix + p, card: cardOf(prefix + p) })) });
    }
  }
}

L.push('', 'Write floorplan/recent-work.json (refs: a file path, a node id, or "METHOD /path"; see references/schema.md#recent-work):',
  '  { "tasks": [ { "title": "…", "request": "what the user asked for", "summary": "what was done toward it, and where it stands",',
  '      "items": [ { "ref": "<file path>", "change": "changed|new", "note": "what changed here, and how it serves the request" } ] } ] }',
  'Then run build.mjs. Use { "tasks": [] } when nothing was worked on.');
const changedSince = !!changes && [...Object.values(changes.files), ...Object.values(changes.routes)].some((a) => a.length);
// nothingRecent: no changes since the last map, nothing uncommitted and no commits, so recent-work.json is { "tasks": [] }
if (args.json) await printJson({ ...data, nothingRecent: !changedSince && !data.repos.length, text: L.join('\n') });
else console.log(L.join('\n'));
