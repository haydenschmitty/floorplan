// Turn per-file route definitions + mounts into full paths, then match HTTP call literals to them.
// This is what links a frontend repo to a backend repo when no import connects them.
import { csRoutePath, csAccess, csAttrNames } from './extract.mjs';

export const routeSegments = (p) => p.split('/').filter(Boolean).map((s) =>
  /^(<[^>]*>|\{[^}]*\}|:\w+|\[\.{0,3}[^\]]*\]|\*{1,2}|\$\{[^}]*\})$/.test(s) || /\$\{|\{[^}]*\}/.test(s) ? '*' : s);

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/;
// .NET test projects are folders named like Orders.Api.Tests or Orders.IntegrationTests. Only C# files in
// them count as tests: a JavaScript or Python folder can be named that way for other reasons
// (Checkout.ABTests/), and its endpoints must stay on the map and in Health.
const DOTNET_TEST_FILE = /(^|\/)[\w-]+(?:\.[\w-]+)*\.\w*Tests?\/(?:[^/]+\/)*[^/]+\.cs$/;
const isTestFile = (p) => TEST_FILE.test(p) || DOTNET_TEST_FILE.test(p);

/** offset → 1-based line number in src, from one pass over it. */
const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

const joinPath =(...parts) => '/' + parts.map((p) => (p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/**
 * @param files      scanned files: { path, lang, routes, mounts, routers, imports:[{names, aliases, alias, files[]}] }
 * @returns routes   [{ file, method, path, line }]
 */
/**
 * What a JS file exports as `name` ('default' for its default export): { file, v, kind }, following barrels
 * (`export { default as authRoutes } from './auth.routes.js'`, `export * from './routes.js'`). kind is
 * 'router' (v is the router variable), 'function', 'other' (some other value) or 'unknown'.
 */
function exportOf(byPath, file, name, depth = 0) {
  const t = byPath.get(file);
  if (!t || name == null || name === '*' || depth > 8) return { file, v: '*', kind: 'unknown' };
  const sym = (t.symbols || []).find((s) => (name === 'default' ? s.default : s.name === name && !s.default));
  if (sym) {
    const local = sym.default ? sym.name : name;
    if (sym.kind === 'function' || sym.kind === 'class') return { file, v: '*', kind: 'function' };
    if (t.routerVars?.includes(local)) return { file, v: local, kind: 'router' };
    return { file, v: '*', kind: 'other' };
  }
  const passed = (t.imports || []).filter((i) => i.reexport && i.files?.length);
  for (const imp of passed) if (imp.exported && Object.hasOwn(imp.exported, name)) return exportOf(byPath, imp.files[0], imp.exported[name], depth + 1);
  if (name !== 'default') for (const imp of passed) if (!imp.exported) { const r = exportOf(byPath, imp.files[0], name, depth + 1); if (r.kind !== 'unknown') return r; }
  return { file, v: '*', kind: 'unknown' };
}

/**
 * JS: the router a mount points at, or null when it isn't one this scan can place (middleware, a package's
 * export, a value it can't follow). Never the mounting file itself unless the router was made there: taking
 * an unknown name for "this file" put its prefix on every route the file serves or mounts (#71).
 */
function jsMountTarget(f, mount, imports, byPath) {
  const bound = (local) => imports.find((i) => i.locals && Object.hasOwn(i.locals, local));
  // `import * as routes from` then routes.admin names the module's admin export
  const exported = (imp, local, rest) => exportOf(byPath, imp.files[0], imp.locals[local] === '*' ? rest[0] : imp.locals[local]);
  const [head, ...rest] = mount.var.split('.');
  const imp = bound(head);
  if (imp && !mount.call) {
    const t = exported(imp, head, rest);
    // an imported function handed to app.use() is middleware (or a handler), not a router
    return mount.on && t.kind === 'function' ? null : { file: t.file, v: t.v };
  }
  if (!imp && !mount.call && !rest.length && f.routerVars?.includes(head)) return { file: f.path, v: head }; // a router made in this file (#98)
  // a router a factory returns: app.use('/billing', createBillingRoutes()), or a variable assigned that call
  const via = mount.call ? mount.var : mount.via;
  if (via) {
    const [vh, ...vr] = via.split('.');
    const fimp = bound(vh);
    if (fimp) return { file: exported(fimp, vh, vr).file, v: '*' };
  }
  return null;
}

/** The file (and router variable, '*' = all) a mount statement points at, or null. */
function mountTarget(f, mount, byPath) {
  const imports = (f.imports || []).filter((i) => i.files?.length);
  if (mount.spec) {
    const imp = imports.find((i) => i.spec === mount.spec);
    if (!imp) return null;
    const t = f.lang !== 'python' && exportOf(byPath, imp.files[0], 'default');
    return { file: imp.files[0], v: t?.kind === 'router' ? t.v : '*' };
  }
  if (!mount.var) return null;
  if (f.lang !== 'python') return jsMountTarget(f, mount, imports, byPath);
  const [head, attr] = mount.var.split('.');
  // First the import that binds the mounted name in this file: `from app.routes import campaigns as
  // campaign_routes` binds campaign_routes (not campaigns), and wins over `from app.platform import pricing`
  // whose module merely ends in a router's name (platform).
  const bound = imports.find((imp) => imp.from
    ? Object.hasOwn(imp.aliases || {}, head) || (imp.names?.includes(head) && !Object.values(imp.aliases || {}).includes(head))
    : (imp.alias || imp.spec?.split('.')[0]) === head);
  if (bound && (attr || bound.from)) {
    const orig = bound.aliases?.[head] || head;
    const file = (bound.from && bound.files.length > 1 && bound.files[bound.names.indexOf(orig)]) || bound.files[0];
    return { file, v: attr || orig };
  }
  for (const imp of imports) {
    if (attr && (imp.alias === head || imp.spec?.split('.').pop() === head || imp.names?.includes(head))) {
      return { file: imp.files[imp.names?.indexOf(head) ?? 0] || imp.files[0], v: attr };
    }
    if (!attr) {
      const orig = imp.aliases?.[head] || head;
      if (imp.names?.includes(orig)) return { file: imp.files.length === 1 ? imp.files[0] : imp.files[imp.names.indexOf(orig)] || imp.files[0], v: orig };
    }
  }
  return { file: f.path, v: head }; // defined in the same file
}

export function resolveRoutes(files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const servesOrMounts = (p) => { const t = byPath.get(p); return !!(t?.routes?.length || t?.mounts?.some((m) => m.var || m.spec)); };
  // mountsTo[file] = [{ from, on, v, prefix, line }]   (v === '*' applies to every route in the file)
  const mountsTo = new Map();
  // middleware for every route under a path, registered on a router or app: app.use('/api/*', auth),
  // app.use(requireAuth), or the middleware before a handler: [{ file, on, prefix, line, mw }]
  const scoped = [];
  for (const f of files) for (const mount of isTestFile(f.path) ? [] : f.mounts || []) {
    const t = mountTarget(f, mount, byPath);
    // JS: what app.use() is handed is a router only if it serves or mounts something
    if (mount.on && (!t || (t.file !== f.path && !servesOrMounts(t.file)))) {
      const mw = [...(mount.mw || []), ...(mount.var ? [mount.var.split('.').pop()] : [])];
      if (mw.length && scoped.length < 1000) scoped.push({ file: f.path, on: mount.on, prefix: mount.prefix, line: mount.line, mw });
      continue;
    }
    if (!t) continue;
    if (!mountsTo.has(t.file)) mountsTo.set(t.file, []);
    mountsTo.get(t.file).push({ from: f.path, on: mount.on, v: t.v, prefix: mount.prefix, line: mount.line, mw: mount.mw || [], as: mount.as || '' });
  }
  // routers mounted inside another router of the same file: a mount of the whole file ('*') reaches them
  // through that router, not directly (api.route('/frentes', frentes) under app.route('/api', api))
  const nested = new Set();
  for (const [to, ms] of mountsTo) for (const m of ms) if (m.from === to && m.v !== '*') nested.add(`${to}|${m.v}`);
  const mountsOf = (file, v) => (mountsTo.get(file) || []).filter((m) => v == null || m.v === v || (m.v === '*' && !nested.has(`${file}|${v}`)));
  // the router a mount is registered on: the receiver in its own file (same file: compose), or any in a Python file
  const parentOf = (m, file) => (m.from === file ? (m.on ? [file, m.on] : null) : [m.from, m.on ?? null]);
  // Laravel route-name prefixes, composed the same way: ->name('admin.') on the group that loads admin.php
  const outerNames = (file, seen = new Set()) => {
    const m = (mountsTo.get(file) || [])[0];
    if (!m || seen.has(file) || m.from === file) return m?.as || '';
    return outerNames(m.from, new Set(seen).add(file)) + m.as;
  };
  // a Laravel route is answered by a controller method: its endpoint sits in that controller's file
  const classFile = new Map();
  for (const f of files) if (f.lang === 'php') for (const c of f.classes || []) if (!classFile.has(c.toLowerCase())) classFile.set(c.toLowerCase(), f);
  // a controller's methods by name (exact, then any case), looked up once per route
  const methodsOf = new Map();
  const methodIn = (ctrl, fn) => {
    if (!methodsOf.has(ctrl.path)) {
      const exact = new Map(), loose = new Map();
      for (const m of ctrl.methods || []) { if (!exact.has(m.name)) exact.set(m.name, m); if (!loose.has(m.name.toLowerCase())) loose.set(m.name.toLowerCase(), m); }
      methodsOf.set(ctrl.path, { exact, loose });
    }
    const { exact, loose } = methodsOf.get(ctrl.path);
    return exact.get(fn) || loose.get(String(fn).toLowerCase()) || null;
  };
  // Every prefix a file's routes live under, composing nested mounts (a router mounted into a router
  // that is itself mounted), e.g. app.use('/api', api) + api.use('/users', users) → /api/users.
  // Each file's answer is remembered (files mounted twice into each other would otherwise be walked once per
  // path through them, which doubles with every level), and a file has at most MAX_PREFIXES of them.
  const MAX_PREFIXES = 50;
  const prefixMemo = new Map(), mwMemo = new Map();
  const outerPrefixes = (file, v, seen = new Set()) => {
    const key = `${file}|${v ?? ''}`;
    if (prefixMemo.has(key)) return prefixMemo.get(key);
    const ms = mountsOf(file, v);
    if (!ms.length || seen.has(key)) return [''];
    const next = new Set(seen).add(key);
    const out = new Set();
    for (const m of ms) {
      const up = parentOf(m, file);
      for (const p of up ? outerPrefixes(up[0], up[1], next) : ['']) if (out.size < MAX_PREFIXES) out.add(joinPath(p, m.prefix));
    }
    prefixMemo.set(key, [...out]);
    return prefixMemo.get(key);
  };

  // Middleware applied where a file's routers are mounted, all the way up: app.use('/admin', requireStaff, admin)
  // then admin.use('/orders', orders) puts requireStaff in front of every route in orders.
  const mountMw = (file, v, seen = new Set()) => {
    const key = `${file}|${v ?? ''}`;
    if (mwMemo.has(key)) return mwMemo.get(key);
    const ms = mountsOf(file, v);
    if (!ms.length || seen.has(key)) return [];
    const next = new Set(seen).add(key);
    // a route is only as protected as its least-protected mount
    const each = ms.map((m) => { const up = parentOf(m, file); return [...m.mw, ...(up ? mountMw(up[0], up[1], next) : [])]; });
    mwMemo.set(key, each.reduce((a, b) => a.filter((x) => b.includes(x))));
    return mwMemo.get(key);
  };

  // Scoped middleware covers the routes registered on its router after it, under its path, and every router
  // mounted there after it, all the way down. covers(s) is the set of `${file}|${v}` reached ('*' = every router).
  const mountsFrom = new Map();
  for (const [to, ms] of mountsTo) for (const m of ms) { if (!mountsFrom.has(m.from)) mountsFrom.set(m.from, []); mountsFrom.get(m.from).push({ to, v: m.v, on: m.on, line: m.line }); }
  const below = (s) => {
    const keys = new Set(), queue = [];
    const add = (file, v) => { const k = `${file}|${v}`; if (!keys.has(k) && keys.size < 5000) { keys.add(k); queue.push([file, v]); } };
    for (const m of mountsFrom.get(s.file) || []) if (m.on === s.on && m.line > s.line) add(m.to, m.v);
    while (queue.length) {
      const [file, v] = queue.pop();
      for (const m of mountsFrom.get(file) || []) if (v === '*' || m.on == null || m.on === v) add(m.to, m.v);
    }
    return keys;
  };
  const scopes = scoped.map((s) => ({ ...s, keys: below(s), under: outerPrefixes(s.file, s.on).map((p) => routeSegments(joinPath(p, s.prefix))) }));
  const underPath = (segs, path) => { const p = routeSegments(path); return segs.length <= p.length && segs.every((x, i) => x === p[i] || x === '*' || p[i] === '*'); };
  const scopedMw = (f, r, path) => scopes
    .filter((s) => ((s.file === f.path && s.on === r.var && s.line < r.line) || s.keys.has(`${f.path}|${r.var}`) || s.keys.has(`${f.path}|*`)) && s.under.some((u) => underPath(u, path)))
    .flatMap((s) => s.mw);

  // Firebase deploys a function under the name the functions entry file exports it as, so
  // `export { approveItem as approve } from './items'` renames it: `${file}|approveItem` -> ['approve']
  const exportedAs = new Map();
  for (const f of files) for (const imp of f.imports || []) {
    if (!imp.exported || !imp.files?.length) continue;
    for (const [as, orig] of Object.entries(imp.exported)) {
      if (as === orig) continue;
      const k = `${imp.files[0]}|${orig}`;
      exportedAs.set(k, [...(exportedAs.get(k) || []), as]);
    }
  }

  // onRequest(app) serves an Express app under the function's name; its own routes are the endpoints
  const wrapsApp = (file, prefix) => [...mountsTo].some(([to, ms]) => ms.some((m) => m.from === file && m.prefix === prefix) && byPath.get(to)?.routes?.some((r) => r.framework !== 'firebase'));

  const routes = [];
  const mappers = mapperCallIndex(files);
  for (const f of files) {
    // Test files define throwaway apps and stub servers; their routes aren't part of the system.
    if (!f.routes?.length || isTestFile(f.path)) continue;
    for (const r of f.routes) {
      if (r.framework === 'firebase') {
        if (r.method === 'ANY' && wrapsApp(f.path, r.path)) continue;
        // served at its own name, whatever the file's routers are mounted under
        for (const name of exportedAs.get(`${f.path}|${r.handler}`) || [r.handler]) routes.push({ file: f.path, method: r.method, path: '/' + name, line: r.line, handler: name, framework: 'firebase', ...(r.doc ? { doc: r.doc } : {}) });
        continue;
      }
      if (r.framework === 'laravel') {
        const ctrl = r.action && classFile.get(r.action.cls.toLowerCase());
        const fn = r.action?.fn;
        const meth = ctrl && methodIn(ctrl, fn);
        const mw = mountMw(f.path, null);
        const names = r.routeName ? outerNames(f.path) : '';
        for (const mp of outerPrefixes(f.path, null)) routes.push({
          file: ctrl ? ctrl.path : f.path, method: r.method, path: joinPath(mp, r.path),
          line: ctrl ? meth?.line || (ctrl.symbols || []).find((s) => s.kind === 'class')?.line || 1 : r.line,
          ...(ctrl ? { handler: fn, defFile: f.path, defLine: r.line } : {}), ...(meth?.doc ? { doc: meth.doc } : {}),
          framework: 'laravel', ...(r.routeName ? { routeName: names + r.routeName } : {}), ...(r.action ? { action: r.action } : {}),
          ...(r.mw?.length ? { mw: r.mw } : {}), ...(mw.length ? { mountMw: mw } : {}), ...(r.page ? { page: r.page } : {}), ...(r.quiet ? { quiet: true } : {}),
        });
        continue;
      }
      const defPrefix = (r.var && f.routers?.[r.var]) || '';
      const calls = r.mapper && mappers.get(`${f.repo ?? ''}|${r.mapper}`);
      if (calls) { routes.push(...calls.map((c) => mappedRoute(f, r, c, defPrefix))); continue; }
      const fromMounts = mountMw(f.path, r.var);
      for (const mp of outerPrefixes(f.path, r.var)) {
        const path = joinPath(mp, defPrefix, r.path);
        const mw = scopes.length ? [...new Set([...fromMounts, ...scopedMw(f, r, path)])] : fromMounts;
        routes.push({ file: f.path, method: r.method, path, line: r.line, ...(r.handler ? { handler: r.handler } : {}), ...(r.doc ? { doc: r.doc } : {}), ...(mw.length ? { mountMw: mw } : {}), ...(r.caseInsensitive ? { caseInsensitive: true } : {}) });
      }
    }
  }
  routes.push(...conventionalRoutes(files), ...inheritedRoutes(files));
  return dedupe(routes, (r) => `${r.file}|${r.method}|${r.path}`);
}

/** Where each ASP.NET Core project mapper (MapOrders(this RouteGroupBuilder g)) is called: `${repo}|${name}` -> calls */
function mapperCallIndex(files) {
  const index = new Map();
  for (const f of files) for (const c of f.mapperCalls || []) {
    if (isTestFile(f.path)) continue;
    const k = `${f.repo ?? ''}|${c.name}`;
    index.set(k, [...(index.get(k) || []), c]);
  }
  return index;
}

const hasAccess = (a) => !!(a?.guard || a?.anonymous);
const accessOf = (a) => (a.anonymous ? { anonymous: true } : { guard: a.guard });

/** A route inside a project mapper, under the prefix (and sign-in check) of the group it was called on. */
function mappedRoute(f, r, call, defPrefix) {
  const access = !hasAccess(r.auth) && hasAccess(call.access) ? { access: { ...accessOf(call.access), mounted: true } } : {};
  return {
    file: f.path, method: r.method, path: joinPath(call.prefix, defPrefix, r.path), line: r.line,
    ...(r.handler ? { handler: r.handler } : {}), ...(r.doc ? { doc: r.doc } : {}), caseInsensitive: true, ...access,
  };
}

/**
 * Actions declared on a base controller with no [Route] of its own, served by each subclass under the
 * subclass's [Route]. Who may call one: the action's own attributes, else the subclass's, else the base's.
 */
function inheritedRoutes(files) {
  const bases = new Map(); // `${repo}|${base}` -> { actions, attrs }
  for (const f of files) for (const a of f.baseActions || []) {
    const k = `${f.repo ?? ''}|${a.base}`;
    if (!bases.has(k)) bases.set(k, { actions: [], attrs: f.csTypes?.find((t) => t.name === a.base)?.attrs || '' });
    bases.get(k).actions.push(a);
  }
  if (!bases.size) return [];
  const out = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    for (const t of f.csTypes || []) {
      if (t.abstract) continue;
      for (const b of t.bases) {
        const base = bases.get(`${f.repo ?? ''}|${b}`);
        // every action once per subclass: a real project has a handful of each, so stop well before code
        // you didn't write could multiply them into millions
        if (base) for (const a of base.actions) { for (const r of inheritedAction(f, t, a, base.attrs)) out.push(r); if (out.length >= 20000) return out; }
      }
    }
  }
  return out;
}

/** One base-controller action as served by subclass `t`, once per [Route] on the subclass. */
function inheritedAction(f, t, a, baseAttrs) {
  const tokens = { controller: t.name.replace(/Controller$/, ''), action: a.action, area: t.area };
  const sub = csAccess(t.attrs);
  const base = csAccess(baseAttrs);
  const winner = [a.auth, sub, base].find(hasAccess);
  const decos = [...a.auth.decos, ...csAttrNames(t.attrs), ...t.bases, ...csAttrNames(baseAttrs)];
  const access = { ...(winner ? accessOf(winner) : {}), decos, inherited: true };
  return (t.prefixes.length ? t.prefixes : ['']).map((prefix) => csRoutePath(prefix, a.template, tokens)).filter(Boolean)
    .map((path) => ({ file: f.path, method: a.method, path, line: t.line, handler: a.handler, caseInsensitive: true, access }));
}

/**
 * ASP.NET Core controllers without route attributes are reached through a MapControllerRoute pattern
 * ("{controller=Home}/{action=Index}/{id?}") set up elsewhere in the same repo; area controllers only
 * through a pattern with {area}.
 */
function conventionalRoutes(files) {
  const patterns = new Map(); // repo -> [pattern]
  for (const f of files) for (const p of f.controllerConventions || []) {
    if (isTestFile(f.path)) continue;
    const k = f.repo ?? '';
    patterns.set(k, [...(patterns.get(k) || []), p]);
  }
  const out = [];
  for (const f of files) {
    const ps = patterns.get(f.repo ?? '');
    if (!ps || !f.conventionalActions?.length || isTestFile(f.path)) continue;
    for (const a of f.conventionalActions) {
      const pattern = ps.find((p) => /\{area\b/.test(p) === !!a.area);
      if (!pattern) continue;
      const path = joinPath(...pattern.split('/').map((seg) => seg
        .replace(/\{controller(?:=[^}]*)?\}/, a.controller)
        .replace(/\{action(?:=[^}]*)?\}/, a.action)
        .replace(/\{area(?::exists)?(?:=[^}]*)?\}/, a.area || '')));
      for (const method of a.methods) out.push({ file: f.path, method, path, line: a.line, handler: a.handler, caseInsensitive: true });
    }
  }
  return out;
}

function dedupe(list, key) {
  const seen = new Set();
  return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Score how well a call path matches a route path; null when they can't match. */
function score(c, r) {
  const n = Math.min(c.length, r.length);
  if (n === 0) return null;
  let literal = 0, wild = 0, loose = 0;
  for (let i = 1; i <= n; i++) {
    const a = c[c.length - i], b = r[r.length - i];
    if (a === b && a !== '*') literal++;
    else if (b === '*') wild++;           // route parameter: matches anything
    else if (a === '*') loose++;          // call interpolation vs a fixed route segment: possible, less likely
    else return null;
  }
  wild += loose;
  const extra = Math.max(c.length, r.length) - n;
  if (literal === 0) return null;
  // thin evidence (one literal segment under an unknown prefix): only kept if the prefix matches
  // what this caller is known to use, see matchCalls
  const weak = (literal === 1 && wild === 0 && extra > 2) || (literal === 1 && wild > 0 && extra > 0);
  // the part of the route the call didn't spell out, usually the client's base URL ("api/store")
  const prefix = r.length > c.length ? r.slice(0, r.length - n).join('/') : '';
  return { s: literal * 3 + wild - loose * 0.8 - extra * 0.5 + (extra === 0 ? 1 : 0) - (weak ? 100 : 0), literal, prefix, weak };
}

/**
 * Match call literals against resolved routes.
 * Ties are broken by the caller's learned base prefix: if a client's unambiguous calls all land
 * under /api/store, its ambiguous `/orders` means /api/store/orders, not /api/admin/orders.
 * @returns [{ from, to, method, path, call, line }]
 */
export function matchCalls(files, routes) {
  // ASP.NET Core matches paths ignoring case, so /api/Orders answers a call to /api/orders
  const rs = routes.map((r) => ({ ...r, segs: routeSegments(r.caseInsensitive ? r.path.toLowerCase() : r.path) }));
  const pending = [];
  const learned = new Map(); // caller file or dir -> Map(prefix -> count)
  const learn = (key, prefix) => { if (!learned.has(key)) learned.set(key, new Map()); const m = learned.get(key); m.set(prefix, (m.get(prefix) || 0) + 1); };
  const scope = clientScope(files);
  for (const f of files) {
    for (const call of f.calls || []) {
      const cs = routeSegments(call.path);
      const csLower = routeSegments(call.path.toLowerCase());
      let best = -Infinity, hits = [];
      const all = [];
      for (const r of rs) {
        if (r.file === f.path) continue;
        // a Firebase callable (CALL) is only ever reached through httpsCallable, and only reaches callables
        if ((call.method === 'CALL') !== (r.method === 'CALL')) continue;
        if (call.method && r.method !== 'ANY' && r.method !== call.method) continue;
        const sc = score(r.caseInsensitive ? csLower : cs, r.segs);
        if (!sc) continue;
        all.push({ r, ...sc });
        if (sc.s > best) { best = sc.s; hits = [{ r, ...sc }]; } else if (sc.s === best) hits.push({ r, ...sc });
      }
      if (!hits.length) continue;
      // as much evidence as the best match, whatever the length: /tasks/:id could be /tasks/{task} or /api/v2/tasks/{task}
      const alts = hits[0].weak ? [] : all.filter((h) => h.literal === hits[0].literal);
      pending.push({ f, call, hits, alts });
      // learn a caller's base only from calls nothing else could answer: every equally good match agrees on it
      if (!hits[0].weak && new Set(hits.map((h) => h.r.file)).size === 1 && new Set(alts.map((h) => h.prefix)).size === 1) for (const k of [f.path, dir(f.path), scope(f)]) learn(k, hits[0].prefix);
    }
  }
  const top = (key) => { const m = learned.get(key); return m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null; };
  const out = [];
  for (const { f, call, hits, alts } of pending) {
    let keep = hits;
    const pref = top(f.path) ?? top(dir(f.path));
    // a client whose other calls go under one base (its base URL holds /api/v2) means that base here too,
    // even when a shorter address elsewhere fits this call more closely (thin evidence still needs the file's own record)
    const own = top(f.path), base = pref ?? top(scope(f));
    if (base != null && !hits[0].weak) {
      const underBase = (list) => list.filter((h) => h.prefix === base && (!h.weak || own === base));
      // the best matches under that base first: a looser one under it (a fixed /api/users/stripe for
      // `/api/users/${id}`) only stands in when none of the best is, and then the closest of them
      let viaBase = underBase(keep);
      if (!viaBase.length) {
        const more = underBase(alts);
        const s = Math.max(...more.map((h) => h.s));
        viaBase = more.filter((h) => h.s === s);
      }
      if (viaBase.length) keep = viaBase;
    }
    // weak matches need the caller's own track record, not a neighbour's
    if (hits[0].weak) { keep = own == null ? [] : hits.filter((h) => h.prefix === own); if (!keep.length) continue; }
    // no method visible at the call site: fetch's default is GET
    if (!call.method && keep.some((h) => h.r.method === 'GET') && new Set(keep.map((h) => h.r.method)).size > 1) keep = keep.filter((h) => h.r.method === 'GET' || h.r.method === 'ANY');
    if (new Set(keep.map((h) => h.r.file)).size > 1) {
      const narrowed = pref == null ? [] : keep.filter((h) => h.prefix === pref);
      if (narrowed.length) keep = narrowed;
    }
    if (new Set(keep.map((h) => h.r.file)).size > 3) continue;
    for (const { r } of keep) out.push({ from: f.path, to: r.file, method: r.method, path: r.path, call: call.path, line: call.line, routeLine: r.line });
  }
  return dedupe(out, (e) => `${e.from}|${e.to}|${e.method}|${e.path}`);
}
const dir = (p) => p.split('/').slice(0, -1).join('/');
// a folder holding one of these is an app or package of its own
const MANIFEST = /(?:^|\/)(?:package\.json|deno\.jsonc?|pubspec\.yaml|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|composer\.json|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj)$/;
/**
 * The client a file belongs to, for sharing what its other files taught about the base URL: the nearest folder
 * with a package.json (or another package manifest) inside the file's repo, else the repo. Never a folder that
 * only holds clients (apps/, or src/ in a repo), so a base one client uses doesn't spread to the ones beside it.
 */
function clientScope(files) {
  const roots = new Set(files.filter((f) => MANIFEST.test(f.path)).map((f) => dir(f.path)));
  const memo = new Map();
  return (f) => {
    const repo = f.repo == null || f.repo === '.' ? '' : f.repo;
    const key = repo + '|' + dir(f.path);
    if (!memo.has(key)) {
      let d = dir(f.path);
      while (d && d !== repo && !roots.has(d)) d = dir(d);
      memo.set(key, '\0client:' + (roots.has(d) ? d : repo));
    }
    return memo.get(key);
  };
}

// ---------- Laravel: Wayfinder calls and Inertia pages ----------

// what Wayfinder hangs off each route function: show.url(), show.form.patch(), store.definition
const WAYFINDER_HELPERS = new Set(['url', 'form', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'definition', 'withQuery']);
const JS_RESERVED = new Set('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof new return super switch this throw try typeof var void while with yield let static enum await implements package protected interface private public'.split(' '));
/** Wayfinder names a route or action after a reserved word with "Method" on the end (deleteMethod). */
const unreserve = (s) => { const m = /^(.+)Method$/.exec(s); return m && JS_RESERVED.has(m[1]) ? m[1] : s; };
/** Route names compared loosely: Wayfinder writes `verify-otp` as verifyOtp, folder names stay as they are. */
const squash = (s) => s.toLowerCase().replace(/[-_]/g, '');

/**
 * Laravel Wayfinder calls matched to endpoints: named routes (`import { show } from '@/routes/posts'`,
 * then show(post), or `import posts from '@/routes/posts'`, then posts.show.url(post)) by route name, and
 * controller actions (`import PostController from '@/actions/App/Http/Controllers/PostController'`, then
 * PostController.update.form(post)) by controller method.
 * @returns [{ from, to, method, path, call, line, routeLine }]
 */
export function matchWayfinder(files, routes, readSource) {
  const byName = new Map(), byAction = new Map();
  const add = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of routes) {
    if (r.routeName) add(byName, squash(r.routeName), r);
    if (r.action?.cls) add(byAction, `${r.action.cls.toLowerCase()}@${r.action.fn.toLowerCase()}`, r);
  }
  const out = [];
  if (!byName.size && !byAction.size) return out;
  for (const f of files) {
    const imps = (f.imports || []).filter((i) => i.wayfinder);
    if (!imps.length) continue;
    const src = readSource(f.path) || '';
    const lineOf = lineIndex(src);
    // what's used off each binding: posts.show.url(…) → show, PostController.update.form(…) → update, found in
    // one pass over the file for all of them (a pass per name would read a file importing thousands many times)
    const bindings = new Map();
    for (const imp of imps) for (const [local, orig] of Object.entries(imp.locals || {})) {
      if (!bindings.has(local)) bindings.set(local, []);
      bindings.get(local).push({ imp, orig, uses: [] });
    }
    for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)((?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)/g)) {
      const bs = bindings.get(m[1]);
      if (!bs) continue;
      const line = lineOf(m.index);
      const chain = m[2].split('.').map((s) => s.replace(/[?\s]/g, '')).filter(Boolean);
      while (chain.length && WAYFINDER_HELPERS.has(chain[chain.length - 1])) chain.pop();
      for (const b of bs) if (line !== b.imp.line) b.uses.push({ chain: chain.map(unreserve), line }); // not the import itself
    }
    const done = new Set(); // each call once per file: the first use stands for the rest
    for (const bs of bindings.values()) for (const { imp, orig, uses } of bs) {
      const w = imp.wayfinder;
      const whole = orig === 'default' || orig === '*';
      if (!whole && !uses.length) uses.push({ chain: [], line: imp.line });
      for (const u of uses) {
        let key, hits;
        if (w.kind === 'route') {
          const name = [w.prefix, ...(whole ? [] : [unreserve(orig)]), ...u.chain].filter(Boolean).join('.');
          if (!name || (whole && !u.chain.length) || done.has('route|' + name)) continue;
          key = name; hits = byName.get(squash(name));
          // Laravel keeps one route per name; the same name in two places is a clash we can't settle by reading
          if (new Set((hits || []).map((r) => r.file)).size > 1) hits = null;
        } else {
          const fn = whole ? u.chain[0] || '__invoke' : unreserve(orig);
          key = `${w.cls}@${fn}`;
          if (done.has('action|' + key)) continue;
          hits = byAction.get(`${w.cls.toLowerCase()}@${fn.toLowerCase()}`);
        }
        done.add(`${w.kind}|${key}`);
        for (const r of hits || []) out.push({ from: f.path, to: r.file, method: r.method, path: r.path, call: key, line: u.line, routeLine: r.line });
      }
    }
  }
  return dedupe(out, (e) => `${e.from}|${e.to}|${e.method}|${e.path}`);
}

/**
 * Inertia pages: a Laravel endpoint whose controller method renders a page (Inertia::render('orders/show'),
 * or Route::inertia('/about', 'About')) is where that page opens. Returns screen hints to store on the
 * file that renders it (pointing at the page's file) and a link from each page to the endpoint serving it.
 * @returns { hints: [{ file, hint: { fw, url, target } }], http: [{ from, to, method, path, call, line, routeLine }] }
 */
export function inertiaLinks(files, routes) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  // page name → files: resources/js/pages/orders/show.tsx is 'orders/show' (Pages/Orders/Show.vue in older apps)
  const pages = new Map();
  for (const f of files) {
    const m = /(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js|vue|svelte)$/i.exec(f.path);
    if (!m || f.category !== 'code') continue;
    const k = m[1].toLowerCase();
    if (!pages.has(k)) pages.set(k, []);
    pages.get(k).push(f.path);
  }
  const shared = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  const pick = (name, near) => (pages.get(name.toLowerCase().replace(/\.(tsx|jsx|vue|svelte)$/, '')) || []).sort((a, b) => shared(b, near) - shared(a, near))[0] || null;
  const hints = [], http = [];
  for (const r of routes) {
    if (r.framework !== 'laravel' || (r.method !== 'GET' && r.method !== 'ANY')) continue;
    const renders = r.page ? [r.page] : (byPath.get(r.file)?.inertia || []).filter((x) => r.action && x.fn === r.action.fn).map((x) => x.page);
    for (const name of new Set(renders)) {
      const page = pick(name, r.file);
      if (!page) continue;
      hints.push({ file: r.file, hint: { fw: 'inertia', url: r.path.replace(/\{(\w+)(\?)?\}/g, ':$1$2'), target: page } });
      http.push({ from: page, to: r.file, method: r.method, path: r.path, call: `page ${name}`, line: 1, routeLine: r.line });
    }
  }
  return { hints, http };
}
