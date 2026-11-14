// Screens: the pages a person can open in the app (Next.js routes, React Router routes, …), so the
// map can be entered from what people recognise ("the checkout page") instead of code layers.
//
// findScreens(src, file) — called by scan.mjs for every code/config/docs file with its source.
//                          Returns raw screen hints for that file, stored in scan.json files[].screens:
//                            { fw, url }                        the file itself is the screen (file-based routers)
//                            { fw, url, comp, spec, files }     a router entry pointing at a component (resolved by import)
//                            { fw, url, target }                a router config naming the screen's file path
// buildScreens(ctx)      — called by build.mjs with { graph, scan, arch, root } after the graph is built.
//                          Returns graph.screens: [{ id, url, file, app, fw, name, description, behind: [{ id, note, kind }] }]
//                          kind: screen | part | request | server | data | outside (in that order, ~16 items).
//
// Supported: Next.js (app + pages router), React Router (JSX <Route> and route objects, v5–v7 incl.
// routes.ts config), Vue Router, Angular routes, TanStack Router (createFileRoute), SvelteKit, Remix
// (flat + nested routes), Nuxt, Astro, Expo Router.

import fs from 'node:fs';
import path from 'node:path';
import { blankBlockComments, importStatements } from './common.mjs';

const P = path.posix;
const JS_LANGS = new Set(['typescript', 'javascript', 'vue', 'svelte', 'astro']);

// ======================= scan side =======================

export function findScreens(src, file) {
  if (file.category !== 'code' || !JS_LANGS.has(file.lang)) return [];
  const p = file.path;
  const out = [];
  const page = fileBasedScreen(p, src);
  if (page) out.push(page);
  if (file.lang === 'typescript' || file.lang === 'javascript' || file.lang === 'vue') {
    for (const r of routerScreens(src, file)) out.push(r);
  }
  // de-dupe within a file
  const seen = new Set();
  return out.filter((s) => { const k = `${s.url}|${s.comp || ''}|${s.spec || ''}|${s.target || ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Turn file-router segments into a URL. Returns null when the file isn't routable (private folders, intercepts). */
function segmentsToUrl(segs, { indexName = null } = {}) {
  const out = [];
  for (let s of segs) {
    if (!s) continue;
    if (/^\(\.+\)/.test(s)) return null;                 // Next intercepting routes: (.)photo
    if (/^\(.*\)$/.test(s) || s.startsWith('@')) continue; // route groups, parallel slots
    if (s.startsWith('_')) return null;                  // Next private folders
    if (indexName && s === indexName) continue;
    s = s.replace(/^\[\[\.\.\.(.+)\]\]$/, '*').replace(/^\[\.\.\.(.+)\]$/, '*').replace(/^\[\[(.+)\]\]$/, ':$1?').replace(/^\[(.+)\]$/, ':$1');
    out.push(s);
  }
  return '/' + out.join('/');
}

function fileBasedScreen(p, src) {
  let m;
  // Next.js app router: app/**/page.tsx
  if ((m = /(?:^|\/)app\/((?:[^/]+\/)*)page\.(?:tsx|jsx|ts|js|mdx)$/.exec(p))) {
    const url = segmentsToUrl(m[1].split('/'));
    return url && { fw: 'next-app', url };
  }
  // SvelteKit: src/routes/**/+page.svelte
  if ((m = /(?:^|\/)routes\/((?:[^/]+\/)*)\+page\.svelte$/.exec(p))) {
    const url = segmentsToUrl(m[1].split('/').map((s) => s.replace(/^\[(\.\.\.)?([^\]=]+)(=[^\]]+)?\]$/, (_, rest, name) => rest ? '[...x]' : `[${name}]`)));
    return url && { fw: 'sveltekit', url };
  }
  // TanStack Router file routes: createFileRoute('/products/$id')
  if ((m = /\bcreateFileRoute\(\s*["'`]([^"'`]*)["'`]\s*\)/.exec(src)) && !/__root/.test(p)) {
    const url = normalizeUrl(m[1].replace(/\/_[^/]+/g, '').replace(/\$([A-Za-z_]\w*)/g, ':$1').replace(/\/\$$/, '/*'));
    return url && { fw: 'tanstack', url };
  }
  // Remix / React Router v7 file routes: app/routes/*
  if ((m = /(?:^|\/)app\/routes\/(.+)\.(?:tsx|jsx|ts|js|mdx)$/.exec(p)) && !/react-native/.test(src)) {
    if (!/\bexport\s+default\b/.test(src)) return null; // resource routes (loader/action only) aren't screens
    let rel = m[1];
    if (/(^|\/)route$/.test(rel)) rel = rel.replace(/\/?route$/, '');            // folder routes: products.$id/route.tsx
    const segs = [];
    for (const part of rel.split('/')) for (const raw of part.split(/\.(?![^[]*\])/)) {
      let s = raw.replace(/\[(.*?)\]/g, '$1');
      if (s === '_index' || s === 'index') continue;
      if (s.startsWith('_')) continue;                   // pathless layout
      s = s.replace(/_$/, '');
      if (s === '$') s = '*';
      else if (/^\(\$(\w+)\)$/.test(s)) s = ':' + s.slice(2, -1) + '?';
      else if (/^\((.+)\)$/.test(s)) s = s.slice(1, -1);
      else if (s.startsWith('$')) s = ':' + s.slice(1);
      if (s) segs.push(s);
    }
    return { fw: 'remix', url: '/' + segs.join('/') };
  }
  // Expo Router: app/**/*.tsx that renders React Native
  if ((m = /(?:^|\/)app\/((?:[^/]+\/)*)([^/]+)\.(?:tsx|jsx|ts|js)$/.exec(p)) && /from\s+["'](react-native|expo-router)["']/.test(src)) {
    const base = m[2];
    if (base.startsWith('_') || base.startsWith('+') || /\+api$/.test(base) || /^(page|layout|route)$/.test(base)) return null;
    const url = segmentsToUrl([...m[1].split('/'), base], { indexName: 'index' });
    return url && { fw: 'expo', url };
  }
  // Pages routers: Next.js (pages/**.tsx), Nuxt (pages/**.vue), Astro (src/pages/**.astro)
  if ((m = /(?:^|\/)pages\/((?:[^/]+\/)*)([^/]+)\.(tsx|jsx|ts|js|vue|astro|mdx?)$/.exec(p))) {
    const [, dir, base, ext] = m;
    if (/^api\//.test(dir) || base.startsWith('_') || /\.(test|spec|stories)$/.test(base) || /(^|\/)(components?|_[^/]*)\//.test(dir)) return null;
    if ((ext === 'ts' || ext === 'js') && !/\bexport\s+default\b/.test(src)) return null;
    const fw = ext === 'vue' ? 'nuxt' : ext === 'astro' ? 'astro' : 'next-pages';
    const url = segmentsToUrl([...dir.split('/'), base], { indexName: 'index' });
    return url && { fw, url };
  }
  return null;
}

function normalizeUrl(u) {
  if (u == null) return null;
  let s = String(u).trim().split(/[?#]/)[0];
  s = s.replace(/\(([^()]*)\)/g, (m0, inner) => (/^[\w-]+$/.test(inner) ? m0 : '')); // vue param regexes :id(\\d+)
  s = ('/' + s).replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}
const joinUrl = (parent, child) => {
  if (child == null) return parent;
  if (child.startsWith('/')) return normalizeUrl(child);
  return normalizeUrl((parent || '') + '/' + child);
};
const isCatchAll = (u) => /^\/?(\*\*?|:pathMatch.*|:catchAll.*)$/.test(u);

const WRAPPER = /^(Route|Routes|Switch|Navigate|Redirect|Outlet|Suspense|React\.Suspense|Fragment|React\.Fragment|ErrorBoundary|\w*(Guard|Protected|Private|Require\w*|Auth\w*|Provider|Boundary|Layout|Wrapper|Shell))$/;
const pickComponent = (names) => names.filter((n) => !WRAPPER.test(n)).pop() || null;

/** local name -> import spec, including default imports and lazy(() => import('...')) bindings. */
function importBindings(code) {
  const map = new Map();
  // the clause is found first and taken apart after: one pattern with several optional parts separated by \s*
  // tries every way of splitting a long run of spaces between them. Lists of names can be any length.
  for (const c of importStatements(code, /\bimport\b(?=\s)/g, { spaced: false })) {
    const clause = c.clause.trim().replace(/^type\s+/, '');
    const m = [null, /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)?.[1], /\{([^}]*)\}/.exec(clause)?.[1], /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1], c.spec];
    if (m[1]) map.set(m[1], m[4]);
    if (m[3]) map.set(m[3], m[4]);
    for (const part of (m[2] || '').split(',')) {
      const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (orig) map.set((alias || orig).trim(), m[4]);
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?(?:lazy|loadable|lazyWithRetry|defineAsyncComponent|dynamic)\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*import\(\s*["']([^"']+)["']/g)) map.set(m[1], m[2]);
  return map;
}

const ROUTER_SIGNAL = /createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements|useRoutes|RouterProvider|createRouter|new\s+(?:Vue)?Router\s*\(|RouteRecordRaw|RouteObject|provideRouter|RouterModule|Routes\s*=\s*\[|\broutes\s*(?::\s*[\w<>[\]][\w<>[\] \t]{0,200})?=\s*\[/;

function routerScreens(src, file) {
  const code = blankBlockComments(src).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
  const out = [];
  const bindings = importBindings(code);
  const nests = new Map(); // hint -> nesting depth; a layout and its index child share a URL, the child wins
  const make = (fw, url, comp, spec, nest = 0) => {
    if (!url || isCatchAll(url.replace(/^\//, ''))) return;
    spec = spec || (comp ? bindings.get(comp.split('.')[0]) : null) || null;
    if (!comp && !spec) return;
    const hint = { fw, url, ...(comp ? { comp } : {}), ...(spec ? { spec } : {}) };
    // the scanner resolves this file's imports after the hooks run; read them lazily when scan.json is written
    if (spec) Object.defineProperty(hint, 'files', { enumerable: true, get: () => (file.imports || []).find((i) => i.spec === spec && i.files?.length)?.files });
    nests.set(hint, nest);
    out.push(hint);
  };

  // React Router v7 config: app/routes.ts with route("path", "routes/file.tsx") / index("routes/home.tsx")
  if (/(^|\/)routes\.(ts|js|mjs)$/.test(file.path) && /@react-router\/dev\/routes|\b(route|index)\(\s*["']/.test(code)) {
    const calls = [];
    const closeParen = bracketCloser(code, '(', ')');
    for (const m of code.matchAll(/\b(route|index|layout|prefix)\(\s*/g)) {
      const end = closeParen(m.index + m[0].length - 1);
      if (end < 0) continue;
      // the first two arguments (a path and a file) are all that's read; a layout's children may run on for pages
      const args = [...code.slice(m.index, Math.min(end, m.index + 2000)).matchAll(/["'`]([^"'`]*)["'`]/g)].slice(0, 2).map((x) => x[1]);
      calls.push({ type: m[1], start: m.index, end, args });
      if (calls.length >= MAX_RECORDS) break;
    }
    for (const c of calls) {
      const parents = calls.filter((o) => o !== c && o.start < c.start && o.end > c.end && (o.type === 'route' || o.type === 'prefix')).sort((a, b) => a.start - b.start);
      let base = '';
      for (const o of parents) base = joinUrl(base, o.args[0]);
      const dir = P.dirname(file.path);
      if (c.type === 'route' && c.args.length >= 2) out.push({ fw: 'react-router', url: joinUrl(base, c.args[0]), target: P.normalize(P.join(dir, c.args[1])) });
      if (c.type === 'index' && c.args.length >= 1) out.push({ fw: 'react-router', url: base || '/', target: P.normalize(P.join(dir, c.args[0])) });
    }
    if (out.length) return out;
  }

  // JSX: <Route path="x" element={<X/>} />, nested routes join paths
  if (/<Route\b/.test(code)) {
    const stack = [];
    for (const m of code.matchAll(/<Route\b|<\/Route\s*>/g)) {
      if (m[0].startsWith('</')) {
        const top = stack.pop();
        if (top && top.pendingAt != null && !top.done) {
          const inner = code.slice(top.pendingAt, m.index);
          if (!/<Route\b/.test(inner)) make('react-router', top.url, pickComponent([...inner.matchAll(/<([A-Z][\w.]*)/g)].map((x) => x[1])), null, stack.length + 1);
        }
        continue;
      }
      const end = tagEnd(code, m.index + 6);
      if (end < 0) continue;
      const attrs = code.slice(m.index + 6, end);
      const selfClosing = /\/\s*$/.test(attrs);
      const parent = stack.length ? stack[stack.length - 1].url : '';
      const pathAttr = /\bpath\s*=\s*(?:["']([^"']*)["']|\{\s*["'`]([^"'`]*)["'`]\s*\})/.exec(attrs);
      const isIndex = /(^|\s)index(\s|=\{?true|\/|$)/.test(attrs);
      const url = pathAttr ? joinUrl(parent, pathAttr[1] ?? pathAttr[2]) : (parent || '/');
      const el = /\belement\s*=\s*\{/.exec(attrs);
      let comp = null;
      if (el) { const close = bracketCloser(attrs, '{', '}')(el.index + el[0].length - 1); comp = pickComponent([...attrs.slice(el.index, close > 0 ? close : undefined).matchAll(/<([A-Z][\w.]*)/g)].map((x) => x[1])); }
      comp = comp || /\b[Cc]omponent\s*=\s*\{\s*([A-Z][\w$.]*)\s*\}/.exec(attrs)?.[1] || null;
      if (!comp) { const r = /\brender\s*=\s*\{/.exec(attrs); if (r) comp = pickComponent([...attrs.slice(r.index).matchAll(/<([A-Z][\w.]*)/g)].map((x) => x[1])); }
      const lazySpec = /\blazy\s*=\s*\{[^}]*import\(\s*["']([^"']+)["']/.exec(attrs)?.[1];
      if ((pathAttr || isIndex) && (comp || lazySpec)) make('react-router', url, comp, lazySpec, stack.length);
      if (!selfClosing) stack.push({ url: pathAttr ? url : parent, pendingAt: (pathAttr || isIndex) && !comp && !lazySpec ? end + 1 : null, done: !!comp });
    }
  }

  // Route objects: { path: 'x', element: <X/> | component: X | component: () => import('./X.vue'), children: [...] }
  if (ROUTER_SIGNAL.test(code)) {
    const recs = [];
    const closeBrace = bracketCloser(code, '{', '}');
    for (const m of code.matchAll(/\bpath\s*:\s*(["'`])([^"'`]*)\1|\bindex\s*:\s*true\b/g)) {
      const open = enclosingBrace(code, m.index);
      if (open < 0) continue;
      const close = closeBrace(open);
      if (close < 0) continue;
      if (recs.some((r) => r.open === open)) { const r = recs.find((x) => x.open === open); if (m[2] != null) r.path = m[2]; continue; }
      recs.push({ open, close, path: m[2] ?? null, index: m[2] == null });
      if (recs.length >= MAX_RECORDS) break;
    }
    // each record is read in full, and one holding the others holds all of their text too: a real table is read
    // a few times over, a file of hundreds of records each wrapped around the next no more than this
    let reading = 10 * code.length + 100000;
    for (const r of recs) {
      if ((reading -= r.close - r.open) < 0) break;
      const own = maskNested(code.slice(r.open + 1, r.close));
      if (/\bredirect(To)?\s*:/.test(own) && !/\b(element|component|Component)\s*:/.test(own)) continue;
      const parents = recs.filter((o) => o !== r && o.open < r.open && o.close > r.close).sort((a, b) => a.open - b.open);
      let base = '';
      for (const o of parents) if (o.path != null) base = joinUrl(base, o.path);
      const url = r.path != null ? joinUrl(base, r.path) : (base || '/');
      const raw = code.slice(r.open + 1, r.close);
      let comp = null, spec = null;
      const el = /\belement\s*:\s*</.exec(own);
      if (el) comp = pickComponent([...own.slice(el.index).split(/,\s*\n/)[0].matchAll(/<([A-Z][\w.]*)/g)].map((x) => x[1]));
      comp = comp || /\b(?:component|Component)\s*:\s*([A-Z][\w$.]*)/.exec(own)?.[1] || null;
      if (!comp) spec = /\b(?:component|Component|lazy|loadComponent|element)\s*:[^,\n]*?import\(\s*["']([^"']+)["']/.exec(raw.replace(/\bchildren\s*:\s*\[[\s\S]*$/, ''))?.[1] || null;
      if (comp || spec) make(/\.vue["']|createRouter|VueRouter|RouteRecordRaw/.test(code) ? 'vue-router' : /RouterModule|provideRouter|loadComponent/.test(code) ? 'angular' : 'react-router', url, comp, spec, parents.length);
    }
  }
  const best = new Map();
  for (const h of out) if (!best.has(h.url) || (nests.get(h) || 0) > (nests.get(best.get(h.url)) || 0)) best.set(h.url, h);
  return out.filter((h) => best.get(h.url) === h);
}

/** Index of the '>' that closes a JSX opening tag starting at i (skips braces and strings). */
// How far tagEnd looks for the end of a tag, and enclosingBrace back for the "{" a route object's path sits in: a
// real tag, or the keys before a path, are far shorter, and an unclosed one in a large file would otherwise be
// scanned to the end from every place it's tried. (Route tables themselves can be any length: see bracketCloser.)
const REACH = 20000;
const MAX_RECORDS = 500;
function tagEnd(s, i) {
  let depth = 0, q = null;
  for (const stop = Math.min(s.length, i + REACH); i < stop; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}
/**
 * closer(i): the index of the `close` that matches the `open` at s[i] (skipping strings), or -1. Route tables can
 * be any length: one reading finds the match of every bracket it passes, so the brackets nested inside are
 * answered without reading again, and an unclosed one is read to the end once. Reading from places no earlier
 * reading covered (a bracket inside a string it skipped) stops after ten times the text's length in all.
 */
function bracketCloser(s, open, close) {
  const known = new Map();
  let budget = 10 * s.length + 100000;
  return (i) => {
    if (known.has(i)) return known.get(i);
    const opens = []; // brackets passed outside strings, not yet matched
    let depth = 0, q = null;
    for (let k = i; k < s.length; k++) {
      if (--budget < 0) return -1;
      const c = s[k];
      if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === open) {
        // a bracket matched by an earlier reading: what's inside reads the same way again, so skip it
        if (depth > 0 && known.has(k)) {
          const to = known.get(k);
          if (to < 0) { for (const j of opens) known.set(j, -1); return -1; }
          k = to;
          continue;
        }
        depth++;
        opens.push(k);
      } else if (c === close) {
        const j = opens.pop();
        if (j !== undefined) known.set(j, k);
        if (--depth === 0) return k;
      }
    }
    for (const j of opens) known.set(j, -1);
    return -1;
  };
}
function enclosingBrace(s, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0 && j > i - REACH; j--) {
    const c = s[j];
    if (c === '}' || c === ']') depth++;
    else if (c === '{' || c === '[') { if (depth === 0) return c === '{' ? j : -1; depth--; }
  }
  return -1;
}
/** Blank out nested {...} and [...] so only an object's own keys remain (children arrays disappear). */
function maskNested(s) {
  let out = '', depth = 0;
  for (const c of s) {
    if (c === '{' || c === '[') { depth++; out += depth === 1 ? c : ' '; continue; }
    if (c === '}' || c === ']') { out += depth === 1 ? c : ' '; depth = Math.max(0, depth - 1); continue; }
    out += depth ? (c === '\n' ? '\n' : ' ') : c;
  }
  return out;
}

// ======================= build side =======================

const UI_KIT = /(^|\/)(components\/(ui|common|shared|primitives|base|icons?|layout)|ui|primitives)\//i;
const UTILITY = /(^|\/)(utils?|helpers?|constants?|types?|typings|styles?|theme|icons?|config|i18n|locales?)(\/|\.[a-z]+$)|\.d\.ts$|(^|\/)(index|globals?)\.(css|scss)$/i;
const TESTY = /(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright|__mocks__|fixtures|stories)(\/|$)|\.(test|spec|stories)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;
const DATA_PATH = /(^|\/)(models?|schemas?|entities|entity|db|database|repositor(y|ies)|dao|tables?|prisma|orm)(\/|\.[a-z]+$|_)/i;
const DB_LABEL = /postgres|mysql|maria|sqlite|mongo|redis|\bdatabase\b(?!s)|\bdb\b|supabase|firebase|firestore|dynamo|prisma|planetscale|cockroach|\bsql\b/i;
const GET_VERBS = /^(list|get|fetch|load|search|find|look|lookup|check|export|download|preview|calculate|compute|count|show|view|read|poll|ping|generate|validate|verify|resolve|suggest|autocomplete)s?$/;
const DB_PKG =/sqlalchemy|psycopg|\bpg\b|postgres|mysql|mongo|prisma|redis|sqlite|knex|typeorm|sequelize|drizzle|supabase|firebase|dynamo|gorm|diesel|activerecord/i;
const AUTHY = /(^|\/)(auth|middlewares?|decorators?|permissions?|security|extensions)(\/|\.[a-z]+$|_)/i;
const VERBS = new Set('place book reserve claim view read write post put rename renew rotate revoke grant request notify email share attach detach link unlink accept reject decline finalize lock unlock release hold quote estimate count tag untag filter sort report track subscribe unsubscribe join leave follow rate review comment reply flag block activate deactivate suspend resume pause poll ping backfill seed migrate map match swap replace convert recalculate rerun reprocess regenerate recount reorder restock return exchange weigh label fulfill dispatch deliver build deploy upsert insert fill clear flush purge expire invalidate trigger handle ack list get fetch load create add update edit save delete remove search find look check send start stop run mark apply approve cancel set reset preview calculate compute generate refresh submit record adjust issue redeem void close open print scan sync import export upload download move transfer assign archive restore publish unpublish toggle enable disable confirm complete process verify validate log sign register login logout invite connect disconnect wake retry resend bulk merge split duplicate clone schedule queue push pull test rebuild reprice receive pick pack ship refund charge pay collect capture authorize'.split(' '));

export function buildScreens({ graph, scan, root }) {
  const files = new Map(graph.files.map((f) => [f.p, f]));
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const routes = graph.routes || [];
  const topOf = (id) => { let n = nodes.get(id), guard = 0; while (n?.parent && guard++ < 50) n = nodes.get(n.parent); return n?.id || id; };
  const kindsOf = (id) => { const ks = new Set(); let n = nodes.get(id), guard = 0; while (n && guard++ < 50) { ks.add(n.kind); n = nodes.get(n.parent); } return ks; };
  const appOf = (p) => topOf(files.get(p)?.n);
  const isTest = (p) => TESTY.test(p) || kindsOf(files.get(p)?.n).has('test');
  const isData = (p) => kindsOf(files.get(p)?.n).has('data') || DATA_PATH.test(p);

  // ---------- collect screen hints ----------
  const scanFiles = scan.files || [];
  const pathsByStem = new Map();
  const stemOf = (p) => p.replace(/\.(d\.)?[a-z0-9]+$/i, '').replace(/\/index$/, '');
  for (const f of graph.files) pathsByStem.set(stemOf(f.p), f.p);
  // which folders use Next.js (to tell a Next pages/ router from a React app's pages/ folder of components)
  const nextFiles = new Set((scan.extEdges || []).filter((e) => e.pkg === 'npm:next').map((e) => e.from));
  const usesNext = (p) => { const base = p.replace(/(^|\/)(src\/)?pages\/.*$/, '$1'); for (const f of nextFiles) if (f.startsWith(base)) return true; return false; };
  const edgesFrom = new Map();
  for (const e of scan.edges || []) { if (!edgesFrom.has(e.from)) edgesFrom.set(e.from, []); edgesFrom.get(e.from).push(e.to); }
  const resolveHint = (from, h) => {
    if (h.target) {
      if (files.has(h.target)) return h.target;
      return pathsByStem.get(stemOf(h.target)) || null;
    }
    const resolved = (h.files || []).filter((x) => files.has(x) && !/\.d\.ts$/.test(x));
    if (resolved.length) return resolved[0];
    if (h.spec) {
      const tail = h.spec.replace(/^(\.\.?\/)+|^[@~#]\//, '').replace(/\.(tsx|jsx|ts|js|vue|svelte)$/, '');
      const hit = (edgesFrom.get(from) || []).find((to) => stemOf(to).endsWith(tail));
      if (hit && files.has(hit)) return hit;
      return null;
    }
    return h.comp ? from : null; // component defined in the router file itself
  };
  const routed = []; // router entries: { url, file, fw }
  const pageHints = [];
  for (const f of scanFiles) for (const h of f.screens || []) {
    if (!h || typeof h.url !== 'string') continue;
    if (h.comp || h.spec || h.target) { const file = resolveHint(f.path, h); if (file) routed.push({ url: h.url, file, fw: h.fw }); }
    else pageHints.push({ url: h.url, file: f.path, fw: h.fw });
  }
  const routedFiles = new Set(routed.map((r) => r.file));
  const candidates = [...routed];
  for (const h of pageHints) {
    if (h.fw === 'next-pages' && (routedFiles.has(h.file) || !usesNext(h.file))) continue;
    if (h.fw === 'nuxt' && routedFiles.has(h.file)) continue;
    candidates.push(h);
  }

  // ---------- link indexes ----------
  const out = new Map(), indeg = new Map();
  for (const l of graph.links || []) {
    if (!out.has(l.a)) out.set(l.a, []);
    out.get(l.a).push(l);
    if (l.k === 'import' && l.a.startsWith('f:') && l.b.startsWith('f:')) indeg.set(l.b, (indeg.get(l.b) || 0) + 1);
  }
  const appSize = new Map();
  for (const f of graph.files) { const a = topOf(f.n); appSize.set(a, (appSize.get(a) || 0) + 1); }
  const noiseFront = (p) => UI_KIT.test(p) || UTILITY.test(p) || (indeg.get('f:' + p) || 0) >= Math.max(6, Math.round((appSize.get(appOf(p)) || 0) * 0.05));
  const isDb = (n) => DB_PKG.test((n.packages || []).join(' ')) || DB_LABEL.test(n.label);
  const noiseBack = (p) => !isData(p) && (UTILITY.test(p) || AUTHY.test(p) || (indeg.get('f:' + p) || 0) >= Math.max(10, Math.round((appSize.get(appOf(p)) || 0) * 0.08)));

  // ---------- source regions (to follow only what a screen / an endpoint really uses) ----------
  const srcCache = new Map();
  const lines = (p) => {
    if (srcCache.has(p)) return srcCache.get(p);
    let v = null;
    try { if (root) v = fs.readFileSync(path.join(root, p), 'utf8').split('\n'); } catch {}
    srcCache.set(p, v);
    return v;
  };
  const symRanges = (p) => {
    const s = (files.get(p)?.s || []).map((x) => ({ name: x[0], line: x[2] })).sort((a, b) => a.line - b.line);
    return s.map((x, i) => ({ ...x, end: (s[i + 1]?.line || 1e9) - 1 }));
  };
  /** Line ranges of a file covered by a focus (null = the whole file). */
  const rangesFor = (p, focus) => {
    if (!focus || !focus.size) return null;
    const rs = symRanges(p).filter((x) => focus.has(x.name)).map((x) => [x.line, x.end]);
    return rs.length ? rs : null;
  };
  const textOf = (p, ranges) => {
    const ls = lines(p); if (!ls) return null;
    if (!ranges) return ls.join('\n');
    return ranges.map(([a, b]) => ls.slice(a - 1, Math.min(b, ls.length)).join('\n')).join('\n');
  };
  const inRanges = (line, ranges) => !ranges || ranges.some(([a, b]) => line >= a && line <= b);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stemName = (p) => { const b = P.basename(p).replace(/\.[^.]+$/, ''); return /^(index|__init__|route|page)$/.test(b) ? P.basename(P.dirname(p)) : b; };
  /** Which of a file's outgoing import links are used inside `text`, and what names/members they're used for. */
  const usedImports = (p, text, filter) => {
    const res = [];
    for (const l of out.get('f:' + p) || []) {
      if (l.k !== 'import' || !l.b.startsWith('f:')) continue;
      const to = l.b.slice(2);
      if (filter && !filter(to)) continue;
      if (text == null) { res.push({ to, focus: namedFocus(l.names) }); continue; }
      const names = (l.names || []).filter((n) => n !== 'default' && n !== '*');
      if (names.length) {
        const hit = names.filter((n) => new RegExp(`(^|[^\\w$.])${esc(n)}\\b`).test(text));
        if (!hit.length) continue;
        const members = new Set(), pos = new Map(); // pos: where each member is first used (earlier ranks first)
        for (const n of hit) for (const m of text.matchAll(new RegExp(`\\b${esc(n)}\\.(\\w+)`, 'g'))) {
          const k = `${n}.${m[1]}`;
          members.add(k);
          if (!pos.has(k)) pos.set(k, m.index / text.length);
        }
        res.push({ to, focus: new Set(hit), members: members.size ? members : null, pos });
      } else {
        // module import (python `from pkg import module [as alias]`, `import * as alias`): the module's
        // name or alias in the text means it's used, and what's called on it narrows the focus
        const stem = stemName(to);
        const whole = (lines(p) || []).join('\n');
        const aliases = [stem, ...[...whole.matchAll(new RegExp(`\\b${esc(stem)}["']?\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1]),
          ...[...whole.matchAll(new RegExp(`\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+["'][^"']*${esc(stem)}["']`, 'g'))].map((m) => m[1])];
        const used = aliases.some((a) => new RegExp(`\\b${esc(a)}\\b`, a === stem ? 'i' : '').test(text));
        if (!used && !(l.names || []).includes('default')) continue;
        const members = new Set();
        for (const a of aliases) for (const m of text.matchAll(new RegExp(`\\b${esc(a)}\\.(\\w+)`, 'g'))) members.add(m[1]);
        res.push({ to, focus: members.size ? members : null });
      }
    }
    return res;
  };
  const namedFocus = (names) => { const n = (names || []).filter((x) => x !== 'default' && x !== '*'); return n.length ? new Set(n) : null; };
  /** The object member a call line sits in (`productAPI.getAll`), found by walking up to a shallower `key:` line. */
  const memberAt = (p, line, symLine, symName) => {
    const ls = lines(p); if (!ls) return null;
    const ind = (s) => s.match(/^\s*/)[0].length;
    const KEY = /^\s*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?::|\(|=\s*(?:async\s*)?\()/;
    const KEYWORDS = /^(if|for|while|switch|catch|return|function|await|typeof|new|else|do|try|with|const|let|var|throw|yield)$/;
    const keyOf = (s) => { const m = KEY.exec(s); return m && !KEYWORDS.test(m[1]) ? m[1] : null; };
    const own = line > symLine && keyOf(ls[line - 1] || '');
    if (own) return `${symName}.${own}`; // one-line member: `list: () => api.get('/x')`
    // the outermost `key:` / `method(` line above the call, below the symbol's own line
    let min = ind(ls[line - 1] || ''), found = null;
    for (let i = line - 1; i > symLine; i--) {
      const s = ls[i - 1] || ''; if (!s.trim()) continue;
      const d = ind(s);
      if (d < min) { const k = keyOf(s); if (k) { found = k; min = d; } }
    }
    return found && `${symName}.${found}`;
  };
  const symbolAt = (p, line) => { let best = null; for (const r of symRanges(p)) if (r.line <= line) best = r; return best; };

  // ---------- route notes ----------
  const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const routeNote = (r) => {
    const name = String(r.name || '').trim();
    if (!name) return 'Asks the server for something';
    const first = name.split(/\s+/)[0].toLowerCase();
    const keepCase = /^[A-Z0-9]{2,}/.test(name.split(/\s+/)[0]);
    const body = keepCase ? name : lc(name);
    // "Place order" → "Asks the server to place order"; "Product list" → "… for the product list"
    const verb = r.m === 'GET' ? GET_VERBS.test(first) : VERBS.has(first) || VERBS.has(first.replace(/e?s$/, '')) || (!/s$/.test(first) && name.split(/\s+/).length > 1);
    return verb ? `Asks the server to ${body}` : `Asks the server for ${/^(the|a|an)\b/i.test(body) ? body : 'the ' + body}`;
  };
  const humanUrl = (url) => {
    const segs = url.split('/').filter(Boolean);
    if (!segs.length) return 'Home';
    const last = [...segs].reverse().find((s) => !s.startsWith(':') && s !== '*') || 'Page';
    const word = last.replace(/[-_]+/g, ' ');
    return word.charAt(0).toUpperCase() + word.slice(1) + (segs[segs.length - 1].startsWith(':') ? ' (one item)' : '');
  };
  const frontNote = (p, depth, parentName) => {
    const b = P.basename(p);
    if (/^use[A-Z]/.test(b) || /(^|\/)hooks?\//.test(p)) return 'Logic this screen uses';
    if (/(^|\/)(contexts?|stores?|state|atoms)\//i.test(p) || /(Context|Provider|Store|[-_.]store|slice|atoms?)\.[jt]sx?$/.test(b)) return 'Shared state this screen uses';
    if (/^[a-z]/.test(b) && /\.(ts|js|mjs)$/.test(b)) {
      return (out.get('f:' + p) || []).some((l) => l.k === 'http') || /api|client|service|quer(y|ies)|requests?/i.test(b) ? 'Talks to the server for this screen' : 'Helper code this screen uses';
    }
    return depth <= 1 ? 'A component on this screen' : `Part of ${parentName}`;
  };

  // ---------- behind: walk from the screen's file ----------
  function behind(page, app, url) {
    const appKind = (id) => nodes.get(id)?.kind;
    const frontOk = (p) => files.has(p) && !isTest(p) && (appOf(p) === app || ['ui', 'library', 'feature'].includes(appKind(appOf(p))));
    // 1) frontend walk with focus (which exports of each file are actually used)
    const seen = new Map(); // path -> { depth, focus:Set|null(all), members:Set|null, parent }
    const queue = [{ p: page, depth: 0, focus: null, members: null, parent: null }];
    // a file reached twice is used for the union of both reasons; null focus/members means "all of it"
    const union = (a, b) => (a && b ? new Set([...a, ...b]) : null);
    const merge = (cur, nx) => {
      const focus = union(cur.focus, nx.focus), members = union(cur.members, nx.members);
      const changed = (focus?.size ?? -1) !== (cur.focus?.size ?? -1) || (members?.size ?? -1) !== (cur.members?.size ?? -1) || nx.depth < cur.depth;
      return changed ? { ...cur, focus, members, depth: Math.min(cur.depth, nx.depth) } : null;
    };
    let guard = 0;
    while (queue.length && guard++ < 400) {
      const it = queue.shift();
      const prev = seen.get(it.p);
      // how close to the screen each member is used (the page's own calls rank above a child's)
      const md = prev?.md || new Map();
      for (const x of it.members || []) md.set(x, Math.min(md.get(x) ?? 9, it.depth - 1 + (it.pos?.get(x) ?? 0.99) * 0.5));
      const m = prev ? merge(prev, it) : it;
      if (prev) prev.md = md;
      if (m) m.md = md;
      if (!m) continue;
      seen.set(it.p, m);
      const noisy = it.p !== page && noiseFront(it.p);
      if (noisy || m.depth >= 3) continue; // shared building blocks: we only read their calls
      const text = textOf(it.p, rangesFor(it.p, m.focus));
      for (const u of usedImports(it.p, text, frontOk)) {
        if (u.to === page) continue;
        queue.push({ p: u.to, depth: m.depth + 1, focus: u.focus, members: u.members || null, pos: u.pos, parent: it.p });
      }
    }
    // 2) requests: HTTP calls from the visited files, inside the parts this screen uses
    const reqs = new Map(); // routeIndex -> { order, from }
    let order = 0;
    const byDepth = [...seen.entries()].sort((a, b) => a[1].depth - b[1].depth);
    for (const [p, v] of byDepth) {
      const ranges = rangesFor(p, v.focus);
      for (const l of out.get('f:' + p) || []) {
        if (l.k !== 'http' || !l.calls) continue;
        for (const [ri, line] of l.calls) {
          if (ri == null || !routes[ri] || !inRanges(line, ranges)) continue;
          let rank = v.depth + 0.5;
          const sym = v.focus ? symbolAt(p, line) : null;
          const mem = sym && memberAt(p, line, sym.line, sym.name);
          if (mem && v.members && !v.members.has(mem) && [...v.members].some((x) => x.startsWith(sym.name + '.'))) continue;
          if (mem && v.md?.has(mem)) rank = v.md.get(mem);
          const prev = reqs.get(ri);
          if (!prev) reqs.set(ri, { order: order++, from: p, rank });
          else prev.rank = Math.min(prev.rank, rank);
        }
      }
    }
    const reqList = [...reqs.entries()].sort((a, b) => a[1].rank - b[1].rank || a[1].order - b[1].order).map(([ri]) => ri);

    // ---------- rank the screen's own parts ----------
    const urlWords = new Set(url.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const frontData = [...seen.keys()].filter((p) => p !== page && kindsOf(files.get(p)?.n).has('data'));
    const comps = [...seen.entries()].filter(([p]) => p !== page && !noiseFront(p) && !frontData.includes(p)).map(([p, v]) => {
      const f = files.get(p);
      const related = p.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && urlWords.has(w));
      const calls = (out.get('f:' + p) || []).some((l) => l.k === 'http');
      const score = (v.depth === 1 ? 3 : v.depth === 2 ? 1.5 : 0) + Math.min(3, Math.log10((f?.loc || 1) + 1)) + (related ? 1.5 : 0) + (calls ? 1 : 0) - Math.min(2, Math.max(0, (indeg.get('f:' + p) || 0) - 2) / 4);
      return { p, v, score };
    }).sort((a, b) => b.score - a.score);
    const BUDGET = 15; // plus the screen itself
    const nComp = Math.min(4, comps.length);
    const nReq = Math.min(reqList.length, 4 + Math.min(2, 4 - nComp));
    const shownReqs = reqList.slice(0, nReq);

    // 3) server side: the handler of each shown request, what its body uses, a few levels down
    const server = new Map(); // path -> { score, routes:[ri], role:'handler'|'logic', depth }
    const dataHits = new Map(); // path -> Set(names)
    const extHits = new Map(); // nodeId -> { count, via }
    const addExt = (id, via) => { const n = nodes.get(id); if (!n || n.kind !== 'external') return; const e = extHits.get(id) || { count: 0, via }; e.count++; extHits.set(id, e); };
    const extsOf = (p) => { for (const l of out.get('f:' + p) || []) if (l.b.startsWith('n:')) addExt(l.b.slice(2), p); };
    const backOk = (p) => files.has(p) && !isTest(p);
    for (const ri of shownReqs) {
      const r = routes[ri];
      const h = r.f;
      if (!files.has(h)) continue;
      const hs = server.get(h) || { score: 0, routes: [], role: 'handler', depth: 0 };
      hs.score += 3; hs.routes.push(ri); server.set(h, hs);
      const nextRoute = routes.filter((x) => x.f === h && x.l > r.l).reduce((m, x) => Math.min(m, x.l), Infinity);
      const body = textOf(h, [[r.l, Math.min(nextRoute - 1, r.l + 400)]]);
      extsOf(h);
      const q = usedImports(h, body, backOk).map((u) => ({ ...u, depth: 1, via: ri }));
      const visited = new Set([h]);
      while (q.length) {
        const u = q.shift();
        if (visited.has(u.to)) continue;
        visited.add(u.to);
        if (isData(u.to)) {
          const set = dataHits.get(u.to) || new Set();
          for (const n of u.focus || []) set.add(n);
          dataHits.set(u.to, set);
          extsOf(u.to);
          continue;
        }
        if (noiseBack(u.to)) continue;
        const s = server.get(u.to) || { score: 0, routes: [], role: 'logic', depth: u.depth };
        s.score += 2 / u.depth; if (!s.routes.includes(u.via)) s.routes.push(u.via); s.depth = Math.min(s.depth, u.depth);
        server.set(u.to, s);
        extsOf(u.to);
        if (u.depth >= 3) continue;
        const text = textOf(u.to, rangesFor(u.to, u.focus));
        for (const v of usedImports(u.to, text, backOk)) q.push({ ...v, depth: u.depth + 1, via: u.via });
      }
    }
    // outside services the screen itself talks to (payment SDKs, hosted APIs), and data it reads
    // directly (full-stack frameworks: a page or server action that queries the database)
    for (const p of seen.keys()) extsOf(p);
    for (const p of frontData) if (!dataHits.has(p)) dataHits.set(p, new Set());

    const servers = [...server.entries()].sort((a, b) => (a[1].role === 'handler' ? 0 : 1) - (b[1].role === 'handler' ? 0 : 1) || b[1].score - a[1].score);
    const datas = [...dataHits.entries()].sort((a, b) => b[1].size - a[1].size);
    const exts = [...extHits.entries()].sort((a, b) => b[1].count - a[1].count);

    // ---------- cap: screen → components → requests → server → data → outside ----------
    const caps = { comp: nComp, server: Math.min(3, servers.length), data: Math.min(2, datas.length), ext: Math.min(2, exts.length) };
    let spare = BUDGET - nReq - caps.comp - caps.server - caps.data - caps.ext;
    const most = { comp: 6, server: 5, ext: 3, data: 3 };
    const avail = { comp: comps.length, server: servers.length, ext: exts.length, data: datas.length };
    for (const k of ['comp', 'server', 'ext', 'data']) { const extra = Math.max(0, Math.min(spare, Math.min(most[k], avail[k]) - caps[k])); caps[k] += extra; spare -= extra; }

    const name = (p) => files.get(p)?.name || stemName(p);
    const items = [{ id: 'f:' + page, note: 'The screen itself', kind: 'screen' }];
    for (const c of comps.slice(0, caps.comp)) items.push({ id: 'f:' + c.p, note: frontNote(c.p, c.v.depth, name(c.v.parent || page)), kind: 'part' });
    for (const ri of shownReqs) items.push({ id: 'r:' + ri, note: routeNote(routes[ri]), kind: 'request' });
    for (const [p, s] of servers.slice(0, caps.server)) {
      const rn = s.routes.map((ri) => routes[ri]?.name).filter(Boolean);
      const first = rn[0] ? `“${rn[0]}”` : 'these requests';
      const more = rn.length > 1 ? ` and ${rn.length - 1} more` : '';
      items.push({ id: 'f:' + p, note: s.role === 'handler' ? `Server code that handles ${first}${more}` : `Does the work behind ${first}${more}`, kind: 'server' });
    }
    for (const [p, names] of datas.slice(0, caps.data)) {
      const ns = [...names].filter((n) => /^[A-Z][a-z]/.test(n)).sort((a, b) => a.length - b.length).slice(0, 2).map((n) => n.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      items.push({ id: 'f:' + p, note: ns.length ? `Keeps the ${ns.join(' and ')} records` : 'Saved data this reads or changes', kind: 'data' });
    }
    for (const [id, e] of exts.slice(0, caps.ext)) {
      const n = nodes.get(id);
      items.push({ id: 'n:' + id, note: isDb(n) ? 'Where the data is kept' : `Outside service, used by ${name(e.via)}`, kind: 'outside' });
    }
    return items;
  }

  // ---------- assemble ----------
  const screens = new Map();
  for (const c of candidates) {
    if (!files.has(c.file) || isTest(c.file)) continue;
    const app = appOf(c.file);
    const url = normalizeUrl(c.url) || '/';
    const id = `screen:${app}:${url}`;
    if (screens.has(id)) continue;
    const f = files.get(c.file);
    screens.set(id, { id, url, file: c.file, app, fw: c.fw, name: f.auto && /\b(page|index|route)\b/i.test(f.name) ? humanUrl(url) : f.name || humanUrl(url), description: f.d || '' });
  }
  const list = [...screens.values()].sort((a, b) => a.app.localeCompare(b.app) || a.url.localeCompare(b.url));
  for (const s of list) {
    try { s.behind = behind(s.file, s.app, s.url); } catch (e) { s.behind = [{ id: 'f:' + s.file, note: 'The screen itself', kind: 'screen' }]; }
  }
  return list;
}
