// Keeps a short block in the project's CLAUDE.local.md pointing future Claude Code sessions at the map, so
// "where is X / how does Y work" starts from the map instead of a fresh search of the code.
// CLAUDE.local.md is Claude Code's personal, uncommitted project memory (loaded at launch like CLAUDE.md,
// including from parent folders); the map itself isn't committed, so its pointer isn't either. The file
// is added to the repo's local ignore list (.git/info/exclude), which leaves tracked files untouched.
// The block sits between markers and is rewritten in place; the rest of the file is never touched.
// It's added only when the user asks for it (build.mjs --claude-md); a block that's already there is
// kept current. Put <!-- floorplan:off --> in CLAUDE.local.md to opt out.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './common.mjs';

const START = '<!-- floorplan:start -->';
const END = '<!-- floorplan:end -->';
const NAME = 'CLAUDE.local.md';

function block(rel) {
  return `${START}
## Floorplan: map of this codebase

\`${rel}/\` holds a map of this codebase: every module, file and endpoint with a plain-English name and a one-line description, and what connects to what. For questions like "where is X", "how does Y work" or "what uses Z", look it up before searching the code (run these from the folder this file is in):

- \`node ${rel}/query.mjs find "<words>"\`: modules, files and endpoints that match
- \`node ${rel}/query.mjs show <file path | module id | "GET /path">\`: what it is, what it uses, what uses it
- \`node ${rel}/query.mjs path <from> <to>\`: how two things connect
- \`node ${rel}/query.mjs overview\`: the whole system at a glance

The map can lag behind recent edits, so confirm in the code before changing anything. Open it with \`node ${rel}/serve.mjs\`. After big changes, update it with the floorplan skill (the user can just ask to "update the floorplan"; only changed files are re-read).
${END}`;
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
/** The text with the block removed (normalized to \n), or null when there's no block. */
const stripBlock = (text) => {
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 || b < a) return null;
  return [text.slice(0, a).trimEnd(), text.slice(b + END.length).trimStart()].filter(Boolean).join('\n\n').replace(/\r\n/g, '\n');
};

/**
 * Adds a path (relative to root, forward slashes) to the enclosing repo's .git/info/exclude unless git
 * already ignores it. The project's tracked files are never edited.
 */
export function ignoreUncommitted(root, name, comment) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return 'not in a git repo';
  if (git(root, ['ls-files', '--', name])) return `${name} is committed in this repo; the Floorplan section will show up in it`;
  if (git(root, ['check-ignore', '-q', '--', name]) !== null) return 'already ignored';
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const excl = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!excl) return 'could not find .git/info/exclude';
  const file = path.resolve(root, excl);
  const line = '/' + prefix + name;
  const cur = read(file) || '';
  if (!cur.split(/\r?\n/).includes(line)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cur.replace(/\s*$/, cur.trim() ? '\n' : '') + `# ${comment}\n${line}\n`);
  }
  return 'ignored locally via .git/info/exclude';
}

/** Adds CLAUDE.local.md to the enclosing repo's .git/info/exclude unless git already ignores it. */
function excludeLocally(root) {
  return ignoreUncommitted(root, NAME, 'personal Claude Code notes (added by Floorplan)');
}

/** Refreshes the block, or adds it when `add` (the user asked for it); moves it out of a committed CLAUDE.md written by older versions. */
export function writeClaudeMd(root, outDir, { add = false } = {}) {
  const rel = path.relative(root, outDir).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'skipped (map is outside the codebase)';
  const had = ['CLAUDE.local.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md')].some((f) => stripBlock(read(path.join(root, f)) ?? '') != null);
  if (!add && !had) return 'not added (offer it to the user; add it with --claude-md)';
  const notes = [];

  // older versions wrote the block into CLAUDE.md, which is usually committed: take it back out
  for (const f of [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')]) {
    const t = read(f);
    const rest = t == null ? null : stripBlock(t);
    if (rest == null) continue;
    const eol = t.includes('\r\n') ? '\r\n' : '\n';
    const tracked = !!git(path.dirname(f), ['ls-files', '--', path.basename(f)]);
    if (!rest.trim() && !tracked) fs.unlinkSync(f);
    else fs.writeFileSync(f, rest.replace(/\n/g, eol) + (rest.trim() ? eol : ''));
    notes.push(`moved the Floorplan section out of ${path.relative(root, f).replace(/\\/g, '/')}${!rest.trim() && tracked ? ' (now empty; delete it if you like)' : ''}`);
  }

  const file = path.join(root, NAME);
  const old = read(file);
  if (old?.includes('<!-- floorplan:off -->')) return 'skipped (opted out)';
  const eol = old?.includes('\r\n') ? '\r\n' : '\n';
  const text = block(rel).replace(/\n/g, eol);
  let next;
  if (old == null) next = text + eol;
  else {
    const a = old.indexOf(START), b = old.indexOf(END);
    next = a >= 0 && b > a ? old.slice(0, a) + text + old.slice(b + END.length) : old.replace(/\s*$/, '') + eol + eol + text + eol;
  }
  if (next !== old) { fs.writeFileSync(file, next); notes.unshift(`${old == null ? 'created' : 'updated'} ${NAME}`); }
  else notes.unshift(`${NAME} unchanged`);
  notes.push(excludeLocally(root));
  return notes.join('; ');
}
