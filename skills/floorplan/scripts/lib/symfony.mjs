// Symfony: the endpoints a Symfony app serves, worked out the way its router loads them. The Kernel imports
// the app's route config (config/routes.yaml, config/routes/*.yaml and *.php, or what an overridden
// Kernel::configureRoutes() imports instead), and that config either defines routes itself (`path:` and
// `controller:`, `$routes->add()`) or imports the #[Route] attributes of controllers: a folder, a glob, one class
// or one file, with a prefix, a name prefix and files to exclude. The scan reads each PHP file's side of this
// (extract.mjs: symfonyFacts); this follows the imports from the Kernel down.
//
// We follow Symfony's rules: what its router wouldn't load isn't an endpoint. A controller no import loads,
// one an import excludes and no other import loads, an abstract class, and imports for another environment
// than production (when@dev, an `if` on the environment) serve nothing. A route name loaded twice keeps the
// later one, as Symfony's route collection does. The one exception is an import whose path can't be read
// without running the code: what it might load can't be ruled out, so the app's controllers no readable
// import loads are listed at their own address, and the scan says why.

import path from 'node:path';
import { parseYaml } from './serverless.mjs';
import { compileGlob } from './common.mjs';

const P = path.posix;
const ENV = 'prod';
// samples in a test folder describe no real endpoints (the folders whose routes the other frameworks skip too)
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?)\//;
const MAX_DEPTH = 8;
// route config files read per app, counting each time one is imported again (a few dozen in real apps)
const MAX_LOADS = 2000;
// a route config file the default Kernel loads (MicroKernelTrait::configureRoutes)
const ROUTE_CONFIG = /^(?:(.*)\/)?config\/routes(?:\.(?:ya?ml|php)|\/[^/]+\.(?:ya?ml|php))$/;
// loaders that read code or config the scan doesn't map (API Platform's resources, services), not files
const FILE_TYPES = new Set(['attribute', 'annotation', 'glob', 'yaml', 'yml', 'php', 'directory']);

/** A route's address as the map shows it: one slash between parts, none at the end, and {id<\d+>?1} as {id}. */
export const sfPath = (p) => {
  const s = ('/' + p).replace(/\{!?(\w+)(?:<[^>]*>)?(?:\?[^}]*)?\}/g, '{$1}').replace(/\/{2,}/g, '/');
  return s.length > 1 ? s.replace(/\/$/, '') : s;
};
/** A prefix put in front of a path, as Symfony's addPrefix does. */
const withPrefix = (prefix, p) => { const t = (prefix || '').trim().replace(/^\/+|\/+$/g, ''); return t ? `/${t}${p}` : p; };
const hasGlob = (p) => /[*?{[]/.test(p);
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : typeof v === 'object' ? Object.values(v) : [v]).filter((x) => typeof x === 'string');

/**
 * Symfony's endpoints, as scan routes ({ file, method, path, line, handler, framework: 'symfony', … }), with the
 * route config files read, the imports whose path couldn't be read, and how many endpoints are listed at their
 * own address because of them. read(path) gives a file's text.
 */
export function symfonyRoutes(files, read) {
  const empty = { routes: [], configs: [], unread: [], loose: 0 };
  const sf = files.filter((f) => f.lang === 'php' && f.symfony && !TEST_DIR.test(f.path));
  if (!sf.length && !files.some((f) => ROUTE_CONFIG.test(f.path))) return empty;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const paths = files.map((f) => f.path).sort();

  // each app is the folder its composer.json is in (getProjectDir()): its Kernel, and the classes under it
  const composerDirs = new Set(files.filter((f) => /(^|\/)composer\.json$/.test(f.path)).map((f) => P.dirname(f.path)));
  const rootMemo = new Map();
  const rootOf = (p) => {
    const dir = P.dirname(p);
    if (!rootMemo.has(dir)) rootMemo.set(dir, composerDirs.has(dir) ? dir : dir === '.' ? null : rootOf(dir));
    return rootMemo.get(dir);
  };
  const under = (root, p) => root === '.' || p.startsWith(root + '/');
  const apps = new Map(); // root -> { root, kernel }
  for (const f of sf) if (f.symfony.kernel) { const root = rootOf(f.path) ?? P.dirname(P.dirname(f.path)); if (!apps.has(root)) apps.set(root, { root, kernel: f }); }
  for (const p of paths) {
    const m = ROUTE_CONFIG.exec(p);
    if (!m || TEST_DIR.test(p)) continue;
    const root = m[1] ?? '.';
    if (!apps.has(root) && (composerDirs.has(root) || !composerDirs.size)) apps.set(root, { root, kernel: null });
  }
  // the app a file belongs to: the innermost one it's under
  const appList = [...apps.values()].sort((a, b) => b.root.length - a.root.length), appMemo = new Map();
  const appOf = (p) => {
    const dir = P.dirname(p);
    if (!appMemo.has(dir)) appMemo.set(dir, appList.find((a) => under(a.root, p)) || null);
    return appMemo.get(dir);
  };

  const configs = new Set(), unread = [];
  const loaded = new Set(); // `${file}|${class}` of every class some import loaded
  const routes = []; // per app, in the order Symfony would collect them
  const yamlCache = new Map();

  for (const app of apps.values()) {
    // classes by full name, among this app's files only (two apps in one repo can both have an App\Kernel)
    const classFile = new Map();
    for (const f of files) if (f.lang === 'php' && appOf(f.path) === app) for (const c of f.classes || []) if (!classFile.has(c.toLowerCase())) classFile.set(c.toLowerCase(), f);
    const byName = new Map(); // name -> route: a name loaded again replaces the earlier route, and goes last
    const keep = (r) => { byName.delete(r.name); byName.set(r.name, r); };
    let unreadHere = false, loads = 0;
    const abs = (spec, from) => (spec.startsWith('@base') ? P.normalize(P.join(app.root, spec.slice(5) || '.')) : P.normalize(P.join(P.dirname(from), spec)));

    const loadClass = (f, c, ctx) => {
      loaded.add(`${f.path}|${c.cls}`);
      for (const r of c.routes) for (const prefix of ctx.prefixes) keep({
        name: ctx.names + r.name, file: f.path, line: r.line, handler: r.fn, methods: r.methods, path: sfPath(prefix + r.path),
        ...(r.doc ? { doc: r.doc } : {}), ...(r.auto ? {} : { routeName: ctx.names + r.name }),
      });
    };
    const loadConfigRoute = (e, from, line, ctx) => {
      const f = e.controller && classFile.get(e.controller.cls.toLowerCase());
      const m = f && (f.methods || []).find((x) => x.name.toLowerCase() === e.controller.fn.toLowerCase());
      for (const p of e.paths) for (const prefix of ctx.prefixes) keep({
        name: ctx.names + e.name, routeName: ctx.names + e.name, methods: e.methods, path: sfPath(prefix + (p.startsWith('/') ? p : '/' + p)),
        file: f ? f.path : from, line: f ? m?.line || (f.symbols || []).find((s) => s.kind === 'class')?.line || 1 : line,
        ...(f ? { handler: e.controller.fn, defFile: from, defLine: line } : {}), ...(m?.doc ? { doc: m.doc } : {}),
      });
    };

    // chain: the config files being read, from the Kernel down; Symfony refuses to import one of them again
    const load = (e, from, ctx, depth, chain = new Set()) => {
      if (depth > MAX_DEPTH) return;
      if (e.kind === 'route') return loadConfigRoute(e, from, e.line, ctx);
      const next = {
        prefixes: e.prefix.length ? ctx.prefixes.flatMap((o) => e.prefix.map((p) => withPrefix(o, withPrefix(p, '')))) : ctx.prefixes,
        names: ctx.names + (e.namePrefix || ''),
      };
      if (e.resource == null) { unread.push({ file: from, line: e.line }); unreadHere = true; return; }
      if (e.type && !FILE_TYPES.has(e.type)) return; // API Platform, services…: not files of this app
      const attribute = e.type === 'attribute' || e.type === 'annotation';
      if (typeof e.resource === 'object') {
        const f = e.resource.cls && classFile.get(e.resource.cls.toLowerCase());
        const c = f?.symfony?.classes?.find((x) => x.cls.toLowerCase() === e.resource.cls.toLowerCase());
        if (c) loadClass(f, c, next);
        return;
      }
      if (e.resource.startsWith('@') && !e.resource.startsWith('@base')) return; // a bundle's routes
      const target = abs(e.resource, from);
      let match;
      try { match = compileGlob(target === '.' ? '**' : target); } catch { unread.push({ file: from, line: e.line }); unreadHere = true; return; }
      const excluded = e.exclude.map((x) => { try { return compileGlob(abs(x, from)); } catch { return null; } }).filter(Boolean);
      // a folder's files in path order (Symfony sorts them), never the ones starting with a dot
      const hits = paths.filter((p) => match.test(p) && !excluded.some((x) => x.test(p)) && !p.split('/').some((s) => s.startsWith('.')));
      for (const p of hits) {
        const f = byPath.get(p);
        if (attribute) { if (/\.php$/i.test(p)) for (const c of f?.symfony?.classes || []) loadClass(f, c, next); continue; }
        // route config files: by a glob, or one file (a folder is only read with type: directory)
        if (!hasGlob(target) && p !== target && e.type !== 'directory') continue;
        if (chain.has(p) || ++loads > MAX_LOADS) continue;
        if (/\.ya?ml$/i.test(p)) loadYaml(p, next, depth + 1, new Set(chain).add(p));
        else if (/\.php$/i.test(p)) { configs.add(p); for (const x of f?.symfony?.config || []) load(x, p, next, depth + 1, new Set(chain).add(p)); }
        else if (/\.xml$/i.test(p)) { unread.push({ file: from, line: e.line }); unreadHere = true; }
      }
    };

    const loadYaml = (p, ctx, depth, chain) => {
      const f = byPath.get(p);
      if (!f || f.tooLarge) return;
      configs.add(p);
      if (!yamlCache.has(p)) {
        const src = read(p);
        // where each key is first written, for the line an entry points at
        const keyLine = new Map();
        src.split('\n').forEach((l, i) => { const k = /^\s*['"]?([^\s:'"#][^:'"]*)['"]?\s*:/.exec(l)?.[1]; if (k && !keyLine.has(k)) keyLine.set(k, i + 1); });
        yamlCache.set(p, { doc: parseYaml(src), keyLine });
      }
      const { doc, keyLine } = yamlCache.get(p);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return;
      const lineOf = (key) => keyLine.get(key) || 1;
      const entries = (obj) => {
        for (const [key, v] of Object.entries(obj)) {
          if (key.startsWith('when@')) { if (key === `when@${ENV}` && v && typeof v === 'object') entries(v); continue; }
          if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
          if ('resource' in v) {
            const res = typeof v.resource === 'string' ? v.resource : v.resource && typeof v.resource === 'object' ? v.resource.path : null;
            const resource = typeof res !== 'string' ? null : /^[A-Za-z_][\w\\]*\\[A-Za-z_]\w*$/.test(res) && !/\.\w+$/.test(res) ? { cls: res } : res;
            load({ kind: 'import', resource, type: v.type ?? null, prefix: list(v.prefix), namePrefix: typeof v.name_prefix === 'string' ? v.name_prefix : '', exclude: list(v.exclude), line: lineOf(key) }, p, ctx, depth, chain);
          } else if ('path' in v) {
            const raw = v.controller ?? v.defaults?._controller;
            const [cls, fn] = typeof raw === 'string' ? raw.replace(/^\\/, '').split('::') : [];
            const methods = (typeof v.methods === 'string' ? v.methods.split(/[|,]/) : list(v.methods)).map((x) => x.trim().toUpperCase()).filter(Boolean);
            loadConfigRoute({ name: key, paths: list(v.path), methods, controller: cls ? { cls, fn: fn || '__invoke' } : null }, p, lineOf(key), ctx);
          }
        }
      };
      entries(doc);
    };

    // what the Kernel imports: its own configureRoutes(), or MicroKernelTrait's (the production folder, then
    // config/routes/, then config/routes.yaml or else config/routes.php, then routes on the Kernel itself)
    const top = { prefixes: [''], names: '' };
    const kernelPath = app.kernel?.path ?? P.join(app.root, 'src', 'Kernel.php');
    if (app.kernel?.symfony.kernel.overrides) {
      configs.add(app.kernel.path);
      for (const e of app.kernel.symfony.kernel.entries) load(e, app.kernel.path, top, 0, new Set([app.kernel.path]));
    } else {
      const imp = (resource, type = null) => load({ kind: 'import', resource, type, prefix: [], namePrefix: '', exclude: [], line: app.kernel?.symfony.kernel.line || 1 }, kernelPath, top, 0);
      imp(`@base/config/{routes}/${ENV}/*.{php,yaml}`);
      imp('@base/config/{routes}/*.{php,yaml}');
      imp(byPath.has(P.join(app.root, 'config/routes.yaml')) ? '@base/config/routes.yaml' : '@base/config/{routes}.php');
      if (app.kernel) imp(app.kernel.path.slice(app.root === '.' ? 0 : app.root.length + 1).replace(/^/, '@base/'), 'attribute');
    }
    app.unread = unreadHere;
    routes.push(...byName.values());
  }

  // controllers nothing loaded: Symfony doesn't serve them, unless an import we couldn't read might load them
  // (or no route config was found for their app at all), in which case they're listed at their own address
  let loose = 0;
  for (const f of sf) for (const c of f.symfony.classes || []) {
    if (loaded.has(`${f.path}|${c.cls}`)) continue;
    const app = appOf(f.path);
    if (app && !app.unread) continue;
    for (const r of c.routes) { loose++; routes.push({ name: r.name, file: f.path, line: r.line, handler: r.fn, methods: r.methods, path: sfPath(r.path), ...(r.doc ? { doc: r.doc } : {}), ...(r.auto ? {} : { routeName: r.name }), loose: true }); }
  }

  const out = [], seen = new Set();
  for (const r of routes) for (const method of r.methods.length ? r.methods : ['ANY']) {
    const k = `${r.file}|${method}|${r.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      file: r.file, method, path: r.path, line: r.line, ...(r.handler ? { handler: r.handler } : {}), framework: 'symfony',
      ...(r.doc ? { doc: r.doc } : {}), ...(r.routeName ? { routeName: r.routeName } : {}), ...(r.defFile ? { defFile: r.defFile, defLine: r.defLine } : {}), ...(r.loose ? { loose: true } : {}),
    });
  }
  return { routes: out, configs: [...configs], unread, loose };
}
