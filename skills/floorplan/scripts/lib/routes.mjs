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
    mountsTo.get(t.file).push({ from: f.path, v: t.v, prefix: mount.prefix, mw: mount.mw || [], as: mount.as || '' });
  }
  // Laravel route-name prefixes, composed the same way: ->name('admin.') on the group that loads admin.php
  const outerNames = (file, seen = new Set()) => {
    const m = (mountsTo.get(file) || [])[0];
    if (!m || seen.has(file) || m.from === file) return m?.as || '';
    return outerNames(m.from, new Set(seen).add(file)) + m.as;
  };
  // a Laravel route is answered by a controller method: its endpoint sits in that controller's file
  const classFile = new Map();
  for (const f of files) if (f.lang === 'php') for (const c of f.classes || []) if (!classFile.has(c.toLowerCase())) classFile.set(c.toLowerCase(), f);
  // Every prefix a file's routes live under, composing nested mounts (a router mounted into a router
  // that is itself mounted), e.g. app.use('/api', api) + api.use('/users', users) → /api/users.
  const outerPrefixes = (file, v, seen = new Set()) => {
    const ms = (mountsTo.get(file) || []).filter((m) => v == null || m.v === '*' || m.v === v);
    if (!ms.length || seen.has(file)) return [''];
    const next = new Set(seen).add(file);
    const out = [];
    for (const m of ms) for (const p of m.from === file ? [''] : outerPrefixes(m.from, null, next)) out.push(joinPath(p, m.prefix));
    return [...new Set(out)];
  };

  // Middleware applied where a file's routers are mounted, all the way up: app.use('/admin', requireStaff, admin)
  // then admin.use('/orders', orders) puts requireStaff in front of every route in orders.
  const mountMw = (file, v, seen = new Set()) => {
    const ms = (mountsTo.get(file) || []).filter((m) => v == null || m.v === '*' || m.v === v);
    if (!ms.length || seen.has(file)) return [];
    const next = new Set(seen).add(file);
    // a route is only as protected as its least-protected mount
    const each = ms.map((m) => [...m.mw, ...(m.from === file ? [] : mountMw(m.from, null, next))]);
    return each.reduce((a, b) => a.filter((x) => b.includes(x)));
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
      if (r.framework === 'laravel') {
        const ctrl = r.action && classFile.get(r.action.cls.toLowerCase());
        const fn = r.action?.fn;
        const meth = ctrl && ((ctrl.methods || []).find((m) => m.name === fn) || (ctrl.methods || []).find((m) => m.name.toLowerCase() === fn.toLowerCase()));
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
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;
    for (const imp of imps) {
      const w = imp.wayfinder;
      for (const [local, orig] of Object.entries(imp.locals || {})) {
        const whole = orig === 'default' || orig === '*';
        // what's used off the binding: posts.show.url(…) → show, PostController.update.form(…) → update
        const uses = [];
        const re = new RegExp(String.raw`(?<![\w$.])${local.replace(/\$/g, '\\$')}((?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)`, 'g');
        for (const m of src.matchAll(re)) {
          const line = lineOf(m.index);
          if (line === imp.line) continue; // the import itself
          const chain = m[1].split('.').map((s) => s.replace(/[?\s]/g, '')).filter(Boolean);
          while (chain.length && WAYFINDER_HELPERS.has(chain[chain.length - 1])) chain.pop();
          uses.push({ chain: chain.map(unreserve), line });
        }
        if (!whole && !uses.length) uses.push({ chain: [], line: imp.line });
        for (const u of uses) {
          let key, hits;
          if (w.kind === 'route') {
            const name = [w.prefix, ...(whole ? [] : [unreserve(orig)]), ...u.chain].filter(Boolean).join('.');
            if (!name || (whole && !u.chain.length)) continue;
            key = name; hits = byName.get(squash(name));
            // Laravel keeps one route per name; the same name in two places is a clash we can't settle by reading
            if (new Set((hits || []).map((r) => r.file)).size > 1) hits = null;
          } else {
            const fn = whole ? u.chain[0] || '__invoke' : unreserve(orig);
            key = `${w.cls}@${fn}`; hits = byAction.get(`${w.cls.toLowerCase()}@${fn.toLowerCase()}`);
          }
          for (const r of hits || []) out.push({ from: f.path, to: r.file, method: r.method, path: r.path, call: key, line: u.line, routeLine: r.line });
        }
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
