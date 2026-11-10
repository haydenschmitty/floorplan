// Turn per-file route definitions + mounts into full paths, then match HTTP call literals to them.
// This is what links a frontend repo to a backend repo when no import connects them.

export const routeSegments = (p) => p.split('/').filter(Boolean).map((s) =>
  /^(<[^>]*>|\{[^}]*\}|:\w+|\[\.{0,3}[^\]]*\]|\*{1,2}|\$\{[^}]*\})$/.test(s) || /\$\{|\{[^}]*\}/.test(s) ? '*' : s);

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/;

const joinPath =(...parts) => '/' + parts.map((p) => (p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/**
 * @param files      scanned files: { path, lang, routes, mounts, routers, imports:[{names, aliases, alias, files[]}] }
 * @returns routes   [{ file, method, path, line }]
 */
/** The file (and router variable, '*' = all) a mount statement points at. */
function mountTarget(f, mount) {
  const imports = (f.imports || []).filter((i) => i.files?.length);
  if (mount.spec) { const imp = imports.find((i) => i.spec === mount.spec); return imp ? { file: imp.files[0], v: '*' } : null; }
  const [head, attr] = mount.var.split('.');
  if (f.lang !== 'python') {
    // JS: match the mounted name to the local binding of an import or require (every router can be called `router`)
    const imp = imports.find((i) => i.locals && Object.hasOwn(i.locals, head));
    return { file: imp ? imp.files[0] : f.path, v: '*' };
  }
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
  // mountsTo[file] = [{ from, v, prefix }]   (v === '*' applies to every route in the file)
  const mountsTo = new Map();
  for (const f of files) for (const mount of TEST_FILE.test(f.path) ? [] : f.mounts || []) {
    const t = mountTarget(f, mount);
    if (!t) continue;
    if (!mountsTo.has(t.file)) mountsTo.set(t.file, []);
    mountsTo.get(t.file).push({ from: f.path, v: t.v, prefix: mount.prefix, mw: mount.mw || [] });
  }
  // Every prefix a file's routes live under, composing nested mounts (a router mounted into a router
  // that is itself mounted), e.g. app.use('/api', api) + api.use('/users', users) → /api/users.
  // Each file's answer is remembered (files mounted twice into each other would otherwise be walked once per
  // path through them, which doubles with every level), and a file has at most MAX_PREFIXES of them.
  const MAX_PREFIXES = 50;
  const prefixMemo = new Map(), mwMemo = new Map();
  const outerPrefixes = (file, v, seen = new Set()) => {
    const key = `${file}|${v ?? ''}`;
    if (prefixMemo.has(key)) return prefixMemo.get(key);
    const ms = (mountsTo.get(file) || []).filter((m) => v == null || m.v === '*' || m.v === v);
    if (!ms.length || seen.has(file)) return [''];
    const next = new Set(seen).add(file);
    const out = new Set();
    for (const m of ms) for (const p of m.from === file ? [''] : outerPrefixes(m.from, null, next)) if (out.size < MAX_PREFIXES) out.add(joinPath(p, m.prefix));
    prefixMemo.set(key, [...out]);
    return prefixMemo.get(key);
  };

  // Middleware applied where a file's routers are mounted, all the way up: app.use('/admin', requireStaff, admin)
  // then admin.use('/orders', orders) puts requireStaff in front of every route in orders.
  const mountMw = (file, v, seen = new Set()) => {
    const key = `${file}|${v ?? ''}`;
    if (mwMemo.has(key)) return mwMemo.get(key);
    const ms = (mountsTo.get(file) || []).filter((m) => v == null || m.v === '*' || m.v === v);
    if (!ms.length || seen.has(file)) return [];
    const next = new Set(seen).add(file);
    // a route is only as protected as its least-protected mount
    const each = ms.map((m) => [...m.mw, ...(m.from === file ? [] : mountMw(m.from, null, next))]);
    mwMemo.set(key, each.reduce((a, b) => a.filter((x) => b.includes(x))));
    return mwMemo.get(key);
  };

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
  const byPath = new Map(files.map((f) => [f.path, f]));
  const wrapsApp = (file, prefix) => [...mountsTo].some(([to, ms]) => ms.some((m) => m.from === file && m.prefix === prefix) && byPath.get(to)?.routes?.some((r) => r.framework !== 'firebase'));

  const routes = [];
  for (const f of files) {
    // Test files define throwaway apps and stub servers; their routes aren't part of the system.
    if (!f.routes?.length || TEST_FILE.test(f.path)) continue;
    for (const r of f.routes) {
      if (r.framework === 'firebase') {
        if (r.method === 'ANY' && wrapsApp(f.path, r.path)) continue;
        // served at its own name, whatever the file's routers are mounted under
        for (const name of exportedAs.get(`${f.path}|${r.handler}`) || [r.handler]) routes.push({ file: f.path, method: r.method, path: '/' + name, line: r.line, handler: name, framework: 'firebase', ...(r.doc ? { doc: r.doc } : {}) });
        continue;
      }
      const defPrefix = (r.var && f.routers?.[r.var]) || '';
      const mw = mountMw(f.path, r.var);
      for (const mp of outerPrefixes(f.path, r.var)) routes.push({ file: f.path, method: r.method, path: joinPath(mp, defPrefix, r.path), line: r.line, ...(r.handler ? { handler: r.handler } : {}), ...(r.doc ? { doc: r.doc } : {}), ...(mw.length ? { mountMw: mw } : {}) });
    }
  }
  return dedupe(routes, (r) => `${r.file}|${r.method}|${r.path}`);
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
  const rs = routes.map((r) => ({ ...r, segs: routeSegments(r.path) }));
  const pending = [];
  const learned = new Map(); // caller file or dir -> Map(prefix -> count)
  const learn = (key, prefix) => { if (!learned.has(key)) learned.set(key, new Map()); const m = learned.get(key); m.set(prefix, (m.get(prefix) || 0) + 1); };
  for (const f of files) {
    for (const call of f.calls || []) {
      const cs = routeSegments(call.path);
      let best = -Infinity, hits = [];
      for (const r of rs) {
        if (r.file === f.path) continue;
        // a Firebase callable (CALL) is only ever reached through httpsCallable, and only reaches callables
        if ((call.method === 'CALL') !== (r.method === 'CALL')) continue;
        if (call.method && r.method !== 'ANY' && r.method !== call.method) continue;
        const sc = score(cs, r.segs);
        if (!sc) continue;
        if (sc.s > best) { best = sc.s; hits = [{ r, ...sc }]; } else if (sc.s === best) hits.push({ r, ...sc });
      }
      if (!hits.length) continue;
      pending.push({ f, call, hits });
      if (!hits[0].weak && new Set(hits.map((h) => h.r.file)).size === 1) { learn(f.path, hits[0].prefix); learn(dir(f.path), hits[0].prefix); }
    }
  }
  const top = (key) => { const m = learned.get(key); return m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null; };
  const out = [];
  for (const { f, call, hits } of pending) {
    let keep = hits;
    const pref = top(f.path) ?? top(dir(f.path));
    // weak matches need the caller's own track record, not a neighbour's
    if (hits[0].weak) { const own = top(f.path); keep = own == null ? [] : hits.filter((h) => h.prefix === own); if (!keep.length) continue; }
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
