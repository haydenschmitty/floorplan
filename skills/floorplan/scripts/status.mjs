#!/usr/bin/env node
// Prints whether a floorplan already exists here and how stale it is. Never fails.
// usage: node status.mjs [root] [--json]
// --json prints one JSON object (floorplan/status-result@1) with "state": none | unbuilt | blueprint-started |
// blueprint | map, plus the text as "text".
import fs from 'node:fs';
import path from 'node:path';
import { git, mapDir, LEGACY_MAP_DIR, isMapDir, parseArgs, unattendedMode, printJson } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
unattendedMode(args);
const SCHEMA = 'floorplan/status-result@1';
const data = { schema: SCHEMA, ok: true, state: 'none', legacy: false };
const lines = [];
try {
  const root = path.resolve(args._[0] || '.');
  const legacy = !fs.existsSync(path.join(root, 'floorplan')) && isMapDir(path.join(root, LEGACY_MAP_DIR));
  data.legacy = legacy;
  if (legacy) lines.push(`(a map from before the rename is in ${LEGACY_MAP_DIR}/; the next scan, build or refresh moves it to floorplan/)`);
  const dir = legacy ? path.join(root, LEGACY_MAP_DIR) : mapDir(root, { migrate: false });
  const graphFile = path.join(dir, 'graph.json');
  const hasArch = fs.existsSync(path.join(dir, 'architecture.json'));
  if (!fs.existsSync(graphFile)) {
    const hasPlan = fs.existsSync(path.join(dir, 'plan.json'));
    data.state = hasPlan ? 'blueprint-started' : hasArch ? 'unbuilt' : 'none';
    lines.push(hasPlan ? 'a blueprint was started (plan.json) but never drawn: write architecture.json if it is missing, then run plan.mjs and build.mjs.' : hasArch ? 'architecture.json exists but was never built: run build.mjs.' : 'none: no floorplan here yet (fresh run).');
  } else {
    const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    Object.assign(data, { builtAt: g.meta.generatedAt, files: g.meta.counts.files, nodes: g.nodes.length, agent: g.meta.agent || null });
    if (g.meta.blueprint) {
      data.state = 'blueprint';
      lines.push(`a blueprint (planned, not built${g.meta.blueprint.source ? `, from ${g.meta.blueprint.source}` : ''}) built ${g.meta.generatedAt}: ${g.meta.counts.files} planned files, ${g.nodes.length} nodes.\nTo change the plan, edit floorplan/plan.json and architecture.json, then run refresh.mjs (it redraws from plan.json). If the code now exists and the user wants a map of it, run refresh.mjs --from-code.`);
    } else {
      data.state = 'map';
      data.repos = [];
      lines.push(`map built ${g.meta.generatedAt} covering ${g.meta.counts.files} files, ${g.nodes.length} nodes.`);
      for (const r of g.meta.repos || []) {
        const abs = path.join(root, r.path);
        const head = git(abs, ['rev-parse', 'HEAD']);
        // compared: false when there's no commit to compare (no git repo now, or none when the map was built)
        if (!head || !r.head) { lines.push(`  ${r.path}: not a git repo now`); data.repos.push({ path: r.path, compared: false }); continue; }
        const changed = head === r.head ? [] : (git(abs, ['diff', '--name-only', r.head, head]) || '').split('\n').filter(Boolean);
        const dirty = (git(abs, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
        data.repos.push({ path: r.path, compared: true, sameCommit: head === r.head, changedFiles: changed.length, uncommitted: dirty });
        lines.push(`  ${r.path}: ${head === r.head ? 'same commit' : `${changed.length} file(s) changed since ${r.head.slice(0, 7)}`}${dirty ? `, ${dirty} uncommitted` : ''}`);
        if (changed.length) lines.push(`    e.g. ${changed.slice(0, 6).map((p) => (r.path === '.' ? p : `${r.path}/${p}`)).join(', ')}`);
      }
      lines.push('A map exists: update it with refresh.mjs (only changed files cost tokens) rather than starting over.');
    }
  }
} catch (e) {
  data.state = 'unknown';
  data.error = e.message;
  lines.push(`status unavailable (${e.message})`);
}
if (args.json) await printJson({ ...data, text: lines.join('\n') });
else console.log(lines.join('\n'));
