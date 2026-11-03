// Code-quality scoring: how risky is each file, and each part of the map, to keep working on?
//
// Two steps, like Health (health.mjs):
//   1. fileMetrics(src, f)   runs per file during the scan and measures the file on its own
//                            (how tangled its functions are, how big and readable it is,
//                            and signs of careless or machine-written code).
//   2. buildQuality(...)     runs at build time, adds what needs the whole map (unused files,
//                            code copied between files),
//                            blends everything into one 0-100 score per file, and rolls it up
//                            into every module.
//
// Scores run from 0 (healthy) to 100 (risky). They are rough indicators, not verdicts.
// Every threshold and weight is in this file so they are easy to tune.

import fs from 'node:fs';
import path from 'node:path';
import { TEST_FILE, EXAMPLE_FILE } from './health.mjs';

/** How much each measure counts toward a file's score. */
export const WEIGHTS = { complexity: 35, maintainability: 25, duplication: 25, slop: 15 };
/** A file nothing uses is never better than "worth a look", however tidy it is. */
export const DEAD_END_FLOOR = 50;

/** Score bands shown on the map. */
export const BANDS = [
  { id: 'good', label: 'Mostly good', max: 33 },
  { id: 'watch', label: 'Worth a look', max: 66 },
  { id: 'risky', label: 'High risk', max: 100 },
];

const BRACE_LANGS = new Set(['typescript', 'javascript', 'vue', 'svelte', 'astro', 'go', 'java', 'kotlin', 'csharp', 'rust', 'php', 'swift', 'c', 'cpp']);
const INDENT_LANGS = new Set(['python']);
const SKIP_PATH = /(^|\/)(migrations|alembic|versions|fixtures?|seeds?|generated|__generated__|vendor|node_modules)\/|\.d\.ts$|\.min\.[a-z]+$|\.generated\./i;

/** Does this file get scored at all? Tests, examples, generated and vendored code don't. */
export function isScored(p, lang) {
  return (BRACE_LANGS.has(lang) || INDENT_LANGS.has(lang)) && !TEST_FILE.test(p) && !EXAMPLE_FILE.test(p) && !SKIP_PATH.test(p);
}

// 0 at `good` or below, 100 at `bad` or above, a straight line between
const ramp = (v, good, bad) => Math.max(0, Math.min(100, ((v - good) / (bad - good)) * 100));
// a file is as risky as its worst part, softened by how the rest looks
const blend = (parts) => Math.round(Math.max(...parts) * 0.6 + (parts.reduce((s, x) => s + x, 0) / parts.length) * 0.4);

const BRANCH = /\b(?:if|else if|elif|for|while|case|catch|except|when)\b|&&|\|\||\band\b|\bor\b|\?(?![.?:])/g;
const FN_START = /\b(?:function\b|func\b|fn\b|def\b)|=>\s*\{?\s*$|^\s*(?:(?:public|private|protected|static|async|override|final|abstract)\s+)*[\w$<>\[\],\s]*\b[\w$]+\s*\([^;]*\)\s*(?::\s*[\w$<>\[\]|,\s]+)?\s*\{\s*$/;
const NOT_FN = /^\s*(?:if|for|while|switch|catch|else|try|return|with)\b/;

/** Strips comments and string contents from a line so braces and keywords inside them don't count. */
function stripLine(line, lang) {
  let s = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  s = lang === 'python' ? s.replace(/#.*$/, '') : s.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  return s;
}

/**
 * Functions in a file as { line, len, branches, depth }, found by matching braces (or indentation for Python).
 * Each function is measured by its own lines: code in a function nested inside it counts for the inner one,
 * so a file-wide wrapper like (() => { ... })() isn't mistaken for one enormous function.
 */
function functionsIn(lines, lang) {
  const fns = [];
  if (INDENT_LANGS.has(lang)) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:async\s+)?def\s+\w+/.exec(lines[i]);
      if (!m) continue;
      const base = m[1].length;
      let end = i, branches = 0, depth = 0;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        const ind = /^\s*/.exec(lines[j])[0].length;
        if (ind <= base) break;
        end = j;
        branches += (stripLine(lines[j], lang).match(BRANCH) || []).length;
        depth = Math.max(depth, Math.floor((ind - base) / 4));
      }
      fns.push({ line: i + 1, len: end - i + 1, branches, depth });
    }
    return fns;
  }
  const stack = []; // open blocks: { fn|null, depth }
  let open = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = stripLine(lines[i], lang);
    const startsFn = FN_START.test(s) && !NOT_FN.test(s) && s.includes('{');
    for (const ch of s) {
      if (ch === '{') {
        const fn = startsFn && !stack.some((b) => b.isStart && b.line === i) ? { line: i + 1, len: 0, branches: 0, depth: 0, from: i, base: open, parent: [...stack].reverse().find((b) => b.fn)?.fn || null } : null;
        stack.push({ fn, line: i, isStart: !!fn });
        open++;
        if (fn) fns.push(fn);
      } else if (ch === '}') {
        const b = stack.pop();
        open = Math.max(0, open - 1);
        if (b?.fn) { b.fn.total = i - b.fn.from + 1; if (b.fn.parent) b.fn.parent.nested = (b.fn.parent.nested || 0) + b.fn.total; }
      }
    }
    const branches = (s.match(BRANCH) || []).length;
    const inner = [...stack].reverse().find((b) => b.fn)?.fn;
    if (inner) { inner.branches += branches; inner.depth = Math.max(inner.depth, open - inner.base); }
  }
  for (const f of fns) f.len = (f.total || 0) - (f.nested || 0);
  return fns.filter((f) => f.len > 0);
}

const COMMENT_LINE = /^\s*(?:\/\/|#|\/\*|\*|<!--)/;


// ---------- careless or machine-written code ----------
// Rough signs, none proof on its own: comments that repeat the code, stubs left in, errors swallowed,
// commented-out code, throwaway names. Each hit is worth some points; many points in little code is the signal.
const COMMENT_TEXT = /^\s*(?:\/\/+|#+|\/\*+|\*)\s*(.*?)\s*(?:\*\/)?$/;
const CODE_LIKE = /(?:[;{})]\s*$|^\s*(?:if|for|while|const|let|var|return|import|def|class|await|throw|self\.|this\.)\b|\w+\([^)]*\)\s*;?\s*$)/;
const STUB = /not implemented|notimplemented|\bplaceholder\b|\bTODO\b|\bFIXME\b|\bimplement me\b|\bstub\b/i;
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*)?\s*\}|except[^\n:]*:\s*\n\s*pass\b/g;
const THROWAWAY_NAME = /\b(?:function|def|const|let|var)\s+(?:(?:handle|process|do|run|manage|perform)(?:Data|Item|Items|Stuff|Thing|Info|Result|Value|Input|Request)s?|(?:util|utils|helper|helpers|misc|temp|tmp|foo|bar|test)\d+|(?:my|new|old)(?:Func|Function|Method))\b/gi;
const words = (t) => (t.toLowerCase().match(/[a-z]{3,}/g) || []);
const codeWords = (t) => t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().match(/[a-z]{3,}/g) || [];

function slopSigns(lines, src) {
  const signs = [];
  let restating = 0, stubs = 0, commentedOut = 0, run = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = COMMENT_TEXT.exec(lines[i]);
    const isComment = m && COMMENT_LINE.test(lines[i]) && !/^\s*(?:#!|\/\/\s*@|\/\*\*?\s*$)/.test(lines[i]);
    if (!isComment) { if (run >= 3) commentedOut++; run = 0; continue; }
    const text = m[1];
    if (CODE_LIKE.test(text) && !/[.?!]$/.test(text) && text.length > 8) run++; else { if (run >= 3) commentedOut++; run = 0; }
    if (STUB.test(text)) stubs++;
    // a short comment whose words are mostly the next line's own words: "// increment the counter" above counter++
    const ws = words(text), next = (lines.slice(i + 1, i + 3).find((l) => l.trim() && !COMMENT_LINE.test(l)) || '');
    if (ws.length >= 2 && ws.length <= 6 && !/[.]\s*\w/.test(text)) {
      const cw = new Set(codeWords(next));
      if (cw.size && ws.filter((w) => cw.has(w) || cw.has(w.replace(/(?:ing|es|s|ed)$/, ''))).length / ws.length >= 0.6) restating++;
    }
  }
  if (run >= 3) commentedOut++;
  const stubBodies = (src.match(/(?:throw new Error|raise NotImplementedError|panic)\(?\s*['"]?(?:not implemented|todo)/gi) || []).length;
  const emptyCatch = (src.match(EMPTY_CATCH) || []).length;
  const names = (src.match(THROWAWAY_NAME) || []).length;
  const logs = src.startsWith('#!') ? 0 : (src.match(/\bconsole\.(?:log|debug)\(/g) || []).length; // a command-line tool prints on purpose
  if (restating >= 2) signs.push([restating, `${restating} comments only repeat the line below them`]);
  if (stubs + stubBodies) signs.push([(stubs + stubBodies) * 2, `${stubs + stubBodies} unfinished ${stubs + stubBodies === 1 ? 'spot' : 'spots'} (TODO, placeholder or "not implemented")`]);
  if (emptyCatch) signs.push([emptyCatch * 3, `${emptyCatch} ${emptyCatch === 1 ? 'error is' : 'errors are'} caught and silently ignored`]);
  if (commentedOut) signs.push([commentedOut * 3, `${commentedOut} ${commentedOut === 1 ? 'block' : 'blocks'} of old code left commented out`]);
  if (names) signs.push([names * 2, `${names} vague or throwaway ${names === 1 ? 'name' : 'names'} (like handleData or util2)`]);
  if (logs >= 5) signs.push([logs * 0.5, `${logs} leftover debug logs`]);
  return signs;
}

/**
 * Measures one file. Returns null for files that aren't scored.
 * { cx, mt, sl, why[] }: complexity, maintainability and carelessness (0-100), and the plain-language reasons behind them.
 */
export function fileMetrics(src, f) {
  if (!isScored(f.path, f.lang) || !src) return null;
  const lines = src.split('\n');
  const why = [];

  // complexity: the longest, most branching and most deeply nested function
  const fns = functionsIn(lines, f.lang);
  const longest = fns.reduce((a, b) => (b.len > a.len ? b : a), { len: 0 });
  const branchiest = fns.reduce((a, b) => (b.branches > a.branches ? b : a), { branches: 0 });
  const deepest = fns.reduce((a, b) => (b.depth > a.depth ? b : a), { depth: 0 });
  const cx = fns.length ? blend([ramp(longest.len, 40, 200), ramp(branchiest.branches, 10, 50), ramp(deepest.depth, 3, 8)]) : 0;
  const longFns = fns.filter((x) => x.len > 80).length;
  if (longFns) why.push(`${longFns} ${longFns === 1 ? 'function is' : 'functions are'} over 80 lines (longest ${longest.len}, line ${longest.line})`);
  if (branchiest.branches > 20) why.push(`one function has ${branchiest.branches} decision points (line ${branchiest.line}), so it is hard to follow and test`);
  if (deepest.depth > 5) why.push(`code is nested ${deepest.depth} levels deep (line ${deepest.line})`);

  // maintainability: file size, very long lines, and how much of the code is explained
  const loc = f.loc || lines.filter((l) => l.trim()).length;
  const comments = lines.filter((l) => COMMENT_LINE.test(l)).length;
  const longLine = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const wide = lines.filter((l) => l.length > 140).length;
  const parts = [ramp(loc, 200, 1000)];
  if (longLine < 1000) parts.push(ramp(wide / Math.max(loc, 1), 0.03, 0.25)); // 1000+ is minified or data, not hand-written
  if (loc > 150) parts.push(ramp(0.04 - comments / loc, 0, 0.04)); // under 4% comments on a big file
  if (loc > 100 && !f.doc) parts.push(20);
  const mt = blend(parts);
  if (loc > 400) why.push(`${loc.toLocaleString('en-US')} lines in one file: smaller files are easier to understand and safer to change`);
  if (loc > 150 && comments / loc < 0.02) why.push('almost no comments explaining what this file is for');
  if (wide >= 3 && wide / Math.max(loc, 1) >= 0.05 && longLine < 1000) why.push(`${wide} lines are over 140 characters long (longest ${longLine})`);


  // careless code: many signs packed into little code
  const signs = slopSigns(lines, src);
  const points = signs.reduce((n, [v]) => n + v, 0);
  const sl = Math.round(Math.min(ramp(points, 2, 15), ramp((points / Math.max(loc, 50)) * 100, 1.5, 8)));
  if (sl > 20) for (const [, text] of signs) why.push(text);

  return { cx, mt, sl, why };
}


// ---------- code copied between files ----------
const DUP_WINDOW = 6;      // this many matching lines in a row count as copied code
const DUP_MIN_CHARS = 140; // ...unless they are mostly boilerplate (braces, imports, one-word lines)
const BOILERPLATE = /^(?:[\[\]{}();,]+|import\b.*|from\b.*import\b.*|export\s*\{.*|\}\s*(?:else|catch|finally)?\s*\{?|end|else|try:|try\s*\{|return;?|break;?|continue;?|pass|#.*|\/\/.*|\*.*|\/\*.*)$/;

/** For each scored file, how much of it also appears in another file: Map(path -> { score, why }). */
function findDuplicates(graph, root) {
  const seen = new Map(); // window hash -> Set of files it appears in
  const perFile = new Map();
  for (const f of graph.files) {
    if (!isScored(f.p, f.l) || f.tooLarge) continue;
    let src;
    try { src = fs.readFileSync(path.join(root, f.p), 'utf8'); } catch { continue; }
    const lines = src.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l && !BOILERPLATE.test(l));
    const hashes = [];
    for (let i = 0; i + DUP_WINDOW <= lines.length; i++) {
      const w = lines.slice(i, i + DUP_WINDOW).join('\n');
      if (w.length < DUP_MIN_CHARS) { hashes.push(null); continue; }
      hashes.push(w);
      if (!seen.has(w)) seen.set(w, new Set());
      seen.get(w).add(f.p);
    }
    perFile.set(f.p, { hashes, lines: lines.length });
  }
  const repoOf = new Map(graph.files.map((f) => [f.p, f.r]));
  const out = new Map();
  for (const [p, { hashes, lines }] of perFile) {
    const covered = new Set();
    const partners = new Map();
    hashes.forEach((w, i) => {
      if (!w) return;
      const others = [...seen.get(w)].filter((x) => x !== p);
      if (!others.length) return;
      for (let k = i; k < i + DUP_WINDOW; k++) covered.add(k);
      for (const o of others) partners.set(o, (partners.get(o) || 0) + 1);
    });
    if (!covered.size || !lines) continue;
    const ratio = covered.size / lines;
    const best = [...partners.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const other = repoOf.get(best) && repoOf.get(best) !== repoOf.get(p) ? ' (in another repo)' : '';
    const pct = Math.round(ratio * 100);
    if (pct < 10) continue;
    out.set(p, { score: Math.round(ramp(ratio, 0.05, 0.4)), why: `about ${pct}% of this file is copied in ${best}${other}${partners.size > 1 ? ` and ${partners.size - 1} other ${partners.size === 2 ? 'file' : 'files'}` : ''}` });
  }
  return out;
}

/**
 * Scores every file and module on the finished map.
 * `scan.files[].quality` holds the per-file measures; `graph.health` supplies unused files.
 */
export function buildQuality({ graph, scan, root }) {
  const measured = new Map(scan.files.filter((f) => f.quality).map((f) => [f.path, f.quality]));
  const unused = new Set((graph.health?.issues || []).filter((i) => i.kind === 'unused-file').flatMap((i) => i.items.filter((x) => x.startsWith('f:')).map((x) => x.slice(2))));

  const dups = root ? findDuplicates(graph, root) : new Map();
  const files = {};
  for (const f of graph.files) {
    const m = measured.get(f.p);
    if (!m) continue;
    const dup = dups.get(f.p);
    const metrics = { complexity: m.cx, maintainability: m.mt, duplication: dup ? dup.score : 0, slop: m.sl || 0, deadEnd: unused.has(f.p) ? 100 : 0 };
    const keys = Object.keys(WEIGHTS);
    const avg = keys.reduce((n, k) => n + metrics[k] * WEIGHTS[k], 0) / keys.reduce((n, k) => n + WEIGHTS[k], 0);
    // a single bad measure can't be averaged away: the score is at least 80% of the worst firm measure
    // (carelessness is a rougher guess, so it counts for 60%) and an unused file is never better than "worth a look"
    const floor = Math.max(metrics.complexity, metrics.maintainability, metrics.duplication) * 0.8;
    const score = Math.round(Math.max(avg, floor, metrics.slop * 0.6, unused.has(f.p) ? DEAD_END_FLOOR : 0));
    const why = [...m.why];
    if (dup) why.push(dup.why);
    if (unused.has(f.p)) why.push('nothing in the app uses this file, so it may be leftover code');
    files[f.p] = { s: score, m: metrics, ...(why.length ? { why } : {}) };
  }

  // modules: lines-weighted average of every file inside (sub-modules included), pulled toward the worst file
  const own = new Map();
  for (const f of graph.files) if (files[f.p]) (own.get(f.n) || own.set(f.n, []).get(f.n)).push(f);
  const kids = new Map();
  for (const n of graph.nodes) if (n.parent) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n.id);
  const nodes = {};
  const collect = (id) => [...(own.get(id) || []), ...(kids.get(id) || []).flatMap(collect)];
  for (const n of graph.nodes) {
    const list = collect(n.id);
    if (!list.length) continue;
    const loc = list.reduce((s, f) => s + Math.max(f.loc, 1), 0);
    const mean = list.reduce((s, f) => s + files[f.p].s * Math.max(f.loc, 1), 0) / loc;
    const worst = list.reduce((a, b) => (files[b.p].s > files[a.p].s ? b : a));
    nodes[n.id] = { s: Math.round(mean * 0.65 + files[worst.p].s * 0.35), worst: worst.p, n: list.length };
  }
  return { v: 1, weights: WEIGHTS, bands: BANDS, files, nodes };
}
