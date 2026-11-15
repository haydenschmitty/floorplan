// Keeps a personal Cursor rule pointing later chats in this project at the map, so "where is X / how does Y
// work" starts from the map instead of a fresh search of the code. The rule is one file,
// .cursor/rules/floorplan.mdc, loaded by Cursor like any other project rule. It is not committed: the path
// is added to the clone's local ignore list (.git/info/exclude), which leaves tracked files untouched.
// AGENTS.md is shared with the team, so this never writes that. The block sits between markers and is
// rewritten in place; anything else in the file is left alone. It's added only when the user asks
// (build.mjs --cursor-rules); a file that's already there is kept current. Put <!-- floorplan:off --> in
// the file to opt out.
import fs from 'node:fs';
import path from 'node:path';
import { ignoreUncommitted } from './claudemd.mjs';

const START = '<!-- floorplan:start -->';
const END = '<!-- floorplan:end -->';
const REL = '.cursor/rules/floorplan.mdc';

function block(mapRel) {
  return `${START}
## Floorplan: map of this codebase

\`${mapRel}/\` holds a map of this codebase: every module, file and endpoint with a plain-English name and a one-line description, and what connects to what. For questions like "where is X", "how does Y work" or "what uses Z", look it up before searching the code (run these from the folder this file is in):

- \`node ${mapRel}/query.mjs find "<words>"\`: modules, files and endpoints that match
- \`node ${mapRel}/query.mjs show <file path | module id | "GET /path">\`: what it is, what it uses, what uses it
- \`node ${mapRel}/query.mjs path <from> <to>\`: how two things connect
- \`node ${mapRel}/query.mjs overview\`: the whole system at a glance

The map can lag behind recent edits, so confirm in the code before changing anything. Open it with \`node ${mapRel}/serve.mjs\`. After big changes, update it when asked to "update the floorplan" (only changed files are re-read). Questions about the map belong in the Cursor chat; the map's Ask bar does not run Cursor.
${END}`;
}

const FRONT = `---
description: Look up this codebase on its Floorplan map before searching the code
alwaysApply: true
---
`;

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

/** Refreshes the Cursor rule, or adds it when `add` (the user asked for it). */
export function writeCursorRule(root, outDir, { add = false } = {}) {
  const mapRel = path.relative(root, outDir).replace(/\\/g, '/');
  if (!mapRel || mapRel.startsWith('..') || path.isAbsolute(mapRel)) return 'skipped (map is outside the codebase)';
  const file = path.join(root, REL);
  const old = read(file);
  if (!add && old == null) return 'not added (offer it to the user; add it with --cursor-rules)';
  if (old?.includes('<!-- floorplan:off -->')) return 'skipped (opted out)';
  const eol = old?.includes('\r\n') ? '\r\n' : '\n';
  const body = block(mapRel);
  const text = body.replace(/\n/g, eol);
  let next;
  if (old == null) next = (FRONT + '\n' + body + '\n').replace(/\n/g, eol);
  else {
    const a = old.indexOf(START), b = old.indexOf(END);
    next = a >= 0 && b > a ? old.slice(0, a) + text + old.slice(b + END.length) : old.replace(/\s*$/, '') + eol + eol + text + eol;
  }
  const notes = [];
  if (next !== old) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    notes.push(`${old == null ? 'created' : 'updated'} ${REL}`);
  } else notes.push(`${REL} unchanged`);
  notes.push(ignoreUncommitted(root, REL, 'personal Cursor rule (added by Floorplan)'));
  return notes.join('; ');
}
