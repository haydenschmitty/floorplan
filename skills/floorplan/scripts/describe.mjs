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
import { maskSecrets, lineIndex } from './lib/health.mjs';

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

// ---------- what the code does, and who uses it ----------
// A name says what code ought to do; the code says what it does. So each worksheet quotes the body of every
// endpoint it lists and the whole of very short files, and a reader can tell a placeholder ("replies OK and
// keeps nothing") from real behaviour without opening the file. It also lists the files that import each
// file, send it web requests or name it (a script started from package.json or a shell script), so nobody
// has to guess "run by hand" or "used by the release tools". Tight caps keep worksheets small; values that
// might be secret are masked (lib/health.mjs), and settings files such as .env are never quoted.
const CAP = { routeLines: 12, fileLines: 20, lineChars: 160, worksheetLines: 120, paths: 4 };
const NEVER_QUOTE = /(^|\/)\.env(\.|$)|(^|\/)\.(npmrc|netrc|pgpass|pypirc)$|\.(pem|key|p12|pfx|jks|keystore|crt|cer|tfvars)$|(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|credentials?\.json|client_secret[^/]*\.json|service[-_]?account[^/]*\.json)$|secret/i;
let scanFiles = [];
try { scanFiles = JSON.parse(fs.readFileSync(path.join(outDir, '.cache', 'scan.json'), 'utf8')).files || []; } catch {}
const scanInfo = new Map(scanFiles.map((f) => [f.path, f]));
const readable = (f) => f && !f.tooLarge && !NEVER_QUOTE.test(f.path) && (f.bytes || 0) <= 512 * 1024;
const sources = new Map();
/** A code file's text, or null for anything that isn't code we may quote (or doesn't exist, as in a blueprint). */
function source(p) {
  if (sources.has(p)) return sources.get(p);
  let text = null;
  const info = scanInfo.get(p);
  if (!g.meta?.blueprint && info?.category === 'code' && readable(info)) {
    try { const t = fs.readFileSync(path.join(root, p), 'utf8'); if (!t.includes('\u0000')) text = maskSecrets(t.replace(/\r\n?/g, '\n'), info); } catch {}
  }
  sources.set(p, text);
  return text;
}

/** The declaration that starts on 0-based line `start`: decorators, signature and body, up to `limit`. */
function blockEnd(lines, start, lang, limit) {
  if (lang === 'python' && /^\s*@/.test(lines[start])) {
    let d = start;
    while (d < Math.min(limit, start + 15) && !/^\s*(async\s+)?def\s/.test(lines[d])) d++;
    if (d < limit && d < start + 15) {
      const indent = /^\s*/.exec(lines[d])[0].length;
      let i = d;
      while (i < limit && !/:\s*(#.*)?$/.test(lines[i])) i++;
      i++;
      while (i < limit && (!lines[i].trim() || /^\s*/.exec(lines[i])[0].length > indent)) i++;
      while (i > start + 1 && !lines[i - 1].trim()) i--;
      return i;
    }
  }
  let depth = 0, opened = false;
  for (let i = start; i < limit; i++) {
    const code = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$|#.*$/, '');
    for (const c of code) {
      if (c === '(' || c === '[' || c === '{') { depth++; if (c === '{') opened = true; }
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
    const t = lines[i].trim();
    if (depth <= 0 && t && !t.startsWith('@') && (opened || /[;),]$/.test(t))) return i + 1;
  }
  return limit;
}

/** Lines start..end (0-based, exclusive) as a quotable excerpt: dedented, long lines cut, at most `max`. */
function excerpt(lines, start, end, max) {
  let body = lines.slice(start, end);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (!body.length || body.some((l) => l.length > 400)) return null; // minified or generated: not worth quoting
  const more = body.length > max ? body.length - max : 0;
  body = body.slice(0, max);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
  body = body.map((l) => l.slice(indent)).map((l) => (l.length > CAP.lineChars ? l.slice(0, CAP.lineChars) + ' …' : l));
  if (more) body.push(`… (${more} more line${more > 1 ? 's' : ''})`);
  return { from: start + 1, to: start + Math.min(end - start, max), lines: body };
}

/** What a worksheet entry quotes: the whole file when it's very short, otherwise each endpoint's code. */
function quotesFor(f) {
  const text = source(f.p);
  if (text == null) return [];
  const lines = text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && lines.length <= CAP.fileLines && needs(f)) {
    const ex = excerpt(lines, 0, lines.length, CAP.fileLines);
    return ex ? [{ kind: 'file', ...ex }] : [];
  }
  const rs = (routesByFile.get(f.p) || []).filter((r) => args.all || r.auto || r.review);
  const starts = [...new Set((routesByFile.get(f.p) || []).map((r) => (r.l || 1) - 1))].sort((a, b) => a - b);
  const out = [];
  const done = new Set();
  for (const r of rs) {
    let start = (r.l || 1) - 1;
    // Next.js route files: the endpoint is the exported function named for its method
    if (start === 0 && /^[A-Z]+$/.test(r.h || '')) { const i = lines.findIndex((l) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${r.h}\\b`).test(l)); if (i >= 0) start = i; }
    const key = routeKey({ method: r.m, path: r.p });
    if (done.has(start)) { out.push({ kind: 'route', key, same: true }); continue; }
    done.add(start);
    const limit = starts.find((s) => s > start) ?? lines.length;
    const ex = excerpt(lines, start, blockEnd(lines, start, f.l, limit), CAP.routeLines);
    if (!ex) continue;
    out.push({ kind: 'route', key, ...ex });
    // a one-line route that names a handler defined further down this file: quote the handler too
    const sym = ex.lines.length <= 2 && r.h ? (f.s || []).find((s) => s[0] === r.h && s[2] - 1 !== start) : null;
    if (sym && !done.has(sym[2] - 1)) {
      done.add(sym[2] - 1);
      const hs = sym[2] - 1;
      const hex = excerpt(lines, hs, blockEnd(lines, hs, f.l, starts.find((s) => s > hs) ?? lines.length), CAP.routeLines);
      if (hex) out.push({ kind: 'handler', key, name: r.h, ...hex });
    }
  }
  return out;
}

// who imports, requests or names each file the worksheets list
const listed = new Set([...byNode.values()].flat().map((f) => f.p));
const importers = new Map(), requesters = new Map(), mentions = new Map();
const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Map()); if (!m.get(k).has(v.from)) m.get(k).set(v.from, v); };
for (const l of g.links) {
  if (!l.a.startsWith('f:') || !l.b.startsWith('f:') || !listed.has(l.b.slice(2))) continue;
  if (l.k === 'import') add(importers, l.b.slice(2), { from: l.a.slice(2) });
  if (l.k === 'http') add(requesters, l.b.slice(2), { from: l.a.slice(2), what: l.labels || [] });
}
if (listed.size && !g.meta?.blueprint) {
  const byBase = new Map();
  for (const f of scanFiles) { const b = f.path.split('/').pop(); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(f.path); }
  const resolve = (token, from) => {
    const t = token.replace(/^(\.\/)+/, '');
    const cands = byBase.get(t.split('/').pop()) || [];
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), t));
    if (cands.includes(rel)) return rel;
    const tail = t.replace(/^(\.\.\/)+/, '');
    if (tail.includes('/')) { const m = cands.filter((c) => c === tail || c.endsWith('/' + tail)); return m.length === 1 ? m[0] : null; }
    return cands.length === 1 ? cands[0] : null; // a bare file name counts only when no other file has it
  };
  // (starts where a run of path characters starts, and is at most 300 long: unanchored, it would rescan a long
  // run of them from every position)
  const FILE_TOKEN = /(?<![\w@.\-/])[\w@.\-/]{0,300}[\w-]\.(?:py|js|mjs|cjs|ts|tsx|jsx|sh|bash|rb|go|php|ps1|pl|java|kt|rs|sql|swift|dart|cs)\b/g;
  const PY_MODULE = /\bpython[\d.]*\s+(?:-\w+\s+)*-m\s+([A-Za-z_][\w.]*)/g;
  for (const f of scanFiles) {
    if ((f.category !== 'code' && f.category !== 'config') || !readable(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
    const hits = [...text.matchAll(FILE_TOKEN)].map((m) => [m[0], m.index]);
    const lineOf = lineIndex(text);
    for (const m of text.matchAll(PY_MODULE)) hits.push([m[1].replace(/\./g, '/') + '.py', m.index]);
    for (const [token, at] of hits) {
      const target = resolve(token, f.path);
      if (!target || target === f.path || !listed.has(target) || importers.get(target)?.has(f.path)) continue;
      add(mentions, target, { from: f.path, line: lineOf(at) });
    }
  }
}
const pathList = (m, fmt) => { const v = [...(m?.values() || [])]; return v.slice(0, CAP.paths).map(fmt).join(', ') + (v.length > CAP.paths ? `, +${v.length - CAP.paths} more` : ''); };
const fence = (lines) => { const f = lines.some((l) => l.includes('```')) ? '~~~' : '```'; return [f, ...lines, f]; };

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
    // the code to quote: endpoints first (they're where placeholders hide), then very short files, within the cap
    const quotes = new Map(chunk.map((f) => [f.p, quotesFor(f)]));
    let budget = CAP.worksheetLines;
    const skipped = new Set();
    for (const kinds of [['route', 'handler'], ['file']]) {
      for (const f of chunk) for (const q of quotes.get(f.p)) {
        if (!kinds.includes(q.kind) || q.same) continue;
        if (q.lines.length <= budget) budget -= q.lines.length; else { q.skip = true; skipped.add(f.p); }
      }
    }
    out.push('Say what each thing does today ("Say what it does today" in references/writing-descriptions.md). Code quoted under an entry is what it really does: describe that, not what its name suggests, and say plainly when it is a placeholder. "imported by", "sent web requests by" and "named in" list every file the scan saw using it; don\'t say who or what runs or uses something beyond that unless its own code shows it.' + ([...quotes.values()].some((qs) => qs.some((q) => q.lines && !q.skip)) ? ' Values that might be secret are shown as «hidden».' : ''));
    out.push('');
    let routeCount = 0;
    for (const f of chunk) {
      const qs = quotes.get(f.p);
      const show = (q, title) => { if (q.same) out.push(`  code: the same lines as the endpoint above`); else if (!q.skip) out.push(`  ${title}:`, ...fence(q.lines)); };
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
      // who runs or uses it, as files: only what the code shows, so nobody has to guess
      const imp = importers.get(f.p), req = requesters.get(f.p), named = mentions.get(f.p);
      if (imp) out.push(`imported by: ${pathList(imp, (v) => v.from)}`);
      if (req) out.push(`sent web requests by: ${pathList(req, (v) => `${v.from}${v.what.length ? ` (${v.what.slice(0, 2).join(', ')})` : ''}`)}`);
      if (named) out.push(`named in: ${pathList(named, (v) => `${v.from} line ${v.line}`)}`);
      if (!imp && !req && !named && !(routesByFile.get(f.p) || []).length && needs(f)) out.push('imported by: nothing (no file imports it, sends it web requests or names it)');
      const fileQuote = qs.find((q) => q.kind === 'file');
      if (fileQuote) show(fileQuote, `code (the whole file, ${fileQuote.lines.length} line${fileQuote.lines.length > 1 ? 's' : ''})`);
      for (const r of routesByFile.get(f.p) || []) {
        routeCount++;
        const mark = r.review ? `  REVIEW (${r.review}); current: ${r.name} — ${r.d}` : r.auto ? '  NEW' : '  (described)';
        const key = routeKey({ method: r.m, path: r.p });
        out.push(`route: ${key}  handler ${r.h || '?'}${r.doc ? ` (${r.doc})` : ''}${mark}`);
        for (const q of qs.filter((x) => x.key === key)) show(q, q.kind === 'handler' ? `its handler ${q.name}, line ${q.from}` : `code, line ${q.from}${q.to > q.from ? `-${q.to}` : ''}`);
      }
      if (skipped.has(f.p)) out.push('  (code not quoted: this worksheet already quotes as much as it holds. Open the file if the digest leaves it unclear.)');
      out.push('');
    }
    fs.writeFileSync(path.join(wsDir, `${key}.md`), out.join('\n'));

    // skeleton: keep anything already written, add missing keys
    // (a file that holds something other than an object, or whose files or routes do, counts as empty)
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    let existing = {};
    try { existing = obj(JSON.parse(fs.readFileSync(descFile, 'utf8'))); } catch {}
    const skel = { files: { ...obj(existing.files) }, routes: { ...obj(existing.routes) } };
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
