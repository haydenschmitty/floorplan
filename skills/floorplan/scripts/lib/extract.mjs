// Per-language, regex-based extraction of imports, exported symbols, HTTP routes and HTTP calls.
// Deliberately approximate: good enough to draw the map, cheap enough to run on any repo.

const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

const blank = (s) => s.replace(/[^\n]/g, ' ');
// Strip comments while keeping offsets (so line numbers stay right). Strings are stepped over, so a
// '/*' inside one (app.use('/api/*', cors())) doesn't start a comment that swallows the code after it.
const stripCStyle = (src) => {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      // quotes end at the line's end, backticks can span lines
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    let end = -1;
    if (c === '/' && src[i + 1] === '*') { end = src.indexOf('*/', i + 2); if (end >= 0) end += 2; }
    else if (c === '/' && src[i + 1] === '/' && !/[:\\]/.test(src[i - 1] || '')) { end = src.indexOf('\n', i); if (end < 0) end = src.length; }
    if (end >= 0) { out += blank(src.slice(i, end)); i = end; continue; }
    out += c;
    i++;
  }
  return out;
};
const stripHash = (src) => src.replace(/(^|\s)#[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));

const all = (re, s) => [...s.matchAll(re)];

// ---------- route tables keyed by "METHOD /path" ----------

// Servers without a framework often keep their endpoints in a lookup keyed by method and path, and
// a dispatcher picks the handler: { "GET /api/orders": listOrders } in JS, or
// { "POST /v1/claim": claim_draft, "GET /v1/paths/{slug}": lambda e, s: get_path(s, e) } in Python.
// There's no app.get(...) to find, so these keys are the endpoints. A value counts when it names a
// function (`listOrders`, `oauth.register`), is a short inline function that calls one, or wraps one
// (`requireAuth(listOrders)`). Tables of other things keyed the same way (access levels, docs, status
// codes, ALL_CAPS constants) are left alone, and a file needs two such entries before they count.
const TABLE_KEY = /^[ \t]*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY|ALL)[ \t]+(\/[^"'`\s]*)["'`][ \t]*:[ \t]*([^\n]*)/gm;
const NOT_A_HANDLER = /^(?:[A-Z][A-Z0-9_]*|true|false|null|undefined|None|True|False|await|new|return|lambda|function|async)$/;

function tableHandler(raw) {
  const v = raw.trim().replace(/,\s*$/, '').trim();
  const last = (dotted) => dotted.split('.').pop();
  const ref = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.exec(v);
  if (ref) return NOT_A_HANDLER.test(last(v)) ? null : { handler: last(v) };
  // lambda e, s: get_path(s, e)  ·  (req) => getPath(req)  ·  async function (req) { return getPath(req) }
  const inline = /^(?:lambda\b[^:]*:|(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|(?:async\s+)?function\b[^{]*\{)([\s\S]*)$/.exec(v);
  if (inline) {
    const call = [...inline[1].matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)].map((m) => last(m[1])).find((n) => !NOT_A_HANDLER.test(n));
    return { handler: call || null };
  }
  // requireAuth(listOrders), login_required(views.orders): the wrapped function is the handler
  const wrap = /^[A-Za-z_$][\w$.]*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[,)]/.exec(v);
  if (wrap && !NOT_A_HANDLER.test(last(wrap[1]))) return { handler: last(wrap[1]) };
  return null; // a string, number, object, list, or a call on a constant: not a route table
}

function keyedRouteTable(code, at) {
  const out = [];
  for (const m of all(TABLE_KEY, code)) {
    const h = tableHandler(m[3]);
    if (!h) continue;
    const method = m[1] === 'ALL' ? 'ANY' : m[1];
    out.push({ method, path: m[2], var: null, line: at(m.index), framework: 'table', ...(h.handler ? { handler: h.handler } : {}) });
  }
  return out.length >= 2 ? out : [];
}

// ---------- HTTP call literals ----------

const HTTP_CONTEXT = /\b(fetch|axios|ky|got|request|requests|httpx|aiohttp|session|client|http|https|api|Api|API|endpoint|Endpoint|url|Url|URL|BASE|base)\b|\.(get|post|put|patch|delete|head)\s*(<[^>]*>)?\s*\(|(?<![.\w$])(get|post|put|patch|delete)\s*\(\s*[rf]?["'`]\//;
const NAV_CONTEXT = /\b(router\.(push|replace|prefetch)|navigate|redirect|href|revalidatePath|pathname|Link|to=|location\.)\b|window\.location/;
const STR_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const IGNORED_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$|\.(test|example|invalid|local|localhost|internal)(:\d+)?$|(^|\.)example\.(com|org|net)$/;
const FILE_EXT_TAIL = /\.(png|jpe?g|gif|svg|ico|webp|css|js|mjs|ts|tsx|json|html?|txt|md|pdf|csv|xml|woff2?|ttf|map)$/i;

function normalizeCallLiteral(raw) {
  let s = raw.trim();
  let host = null;
  // a Firebase function's own address (https://us-central1-<project>.cloudfunctions.net/signDocument) is
  // this app's backend, not an outside service
  const fn = /^https?:\/\/[^/\s]*\.cloudfunctions\.net(\/.*)$/i.exec(s);
  if (fn) s = fn[1];
  const abs = /^https?:\/\/([^/${}\s]+)(.*)$/i.exec(s);
  if (abs) { host = abs[1].toLowerCase(); s = abs[2] || '/'; }
  // leading interpolations: ${API_BASE}/x, {BASE_URL}/x
  s = s.replace(/^(?:\$\{[^}]*\}|\{[^}]*\})+/, '');
  if (!s.startsWith('/')) return null;
  s = s.split(/[?#]/)[0];
  // a query string interpolated straight onto the last segment: `/cost-lots${qs}`, `/items{query}`
  s = s.replace(/([A-Za-z0-9_\-])(?:\$\{[^}]*\}|\{[^}]*\})+$/, '$1');
  if (!/^\/[\w\-.~%/*${}:@<>\[\]]*$/.test(s)) return null;
  if (FILE_EXT_TAIL.test(s)) return null;
  if (!/[a-zA-Z]{2,}/.test(s.replace(/\$\{[^}]*\}|\{[^}]*\}/g, ''))) return host ? { host, path: null } : null;
  return { host, path: s };
}

/**
 * Collapse every ${…} inside template literals to ${x}, counting braces, so nested templates like
 * `/orders${q ? `?${q}` : ''}` read as one literal "/orders${x}" instead of breaking at the inner backtick.
 */
export function flattenTemplates(line) {
  let out = '', inTpl = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { out += c + (line[i + 1] ?? ''); i++; continue; }
    if (c === '`') { inTpl = !inTpl; out += c; continue; }
    if (inTpl && c === '$' && line[i + 1] === '{') {
      let depth = 1, j = i + 2;
      for (; j < line.length && depth; j++) { if (line[j] === '{') depth++; else if (line[j] === '}') depth--; }
      out += '${x}'; i = j - 1; continue;
    }
    out += c;
  }
  return out;
}

// `api.post(…)`, or a bare helper imported from an API client: `post("/orders", …)`
const METHOD_CALL = /(?:\.|(?<![\w$])(?=(?:get|post|put|patch|delete)\s*\(\s*[rf]?["'`]\/))(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(/i;
const METHOD_OPT = /method\s*[:=]\s*["'`](\w+)/i;
// `const url = …`, `url = f"…"`, `this.endpoint = …`: a URL kept in a variable for the call below
const ASSIGN = /(?:\b(?:const|let|var)\s+|^\s*(?:self\.|this\.)?)([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]|. ]+?\s*)?=(?![=>])/;
/** Where a variable is passed to an HTTP call within the next few lines, and with which method. */
function variableUse(lines, i, name) {
  const use = new RegExp(`(?:\\.(get|post|put|patch|delete|head|request)\\s*(?:<[^>]*>)?\\s*\\(|\\b(?:fetch|axios|ky|got|request|urlopen)\\s*\\(|\\brequests\\.(get|post|put|patch|delete)\\s*\\()\\s*${name}\\b`, 'i');
  for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
    const m = use.exec(lines[j]);
    if (!m) continue;
    const verb = (m[1] && m[1].toLowerCase() !== 'request' ? m[1] : m[2]) || METHOD_OPT.exec(lines.slice(j, j + 4).join(' '))?.[1] || '';
    return { method: verb.toUpperCase() || null };
  }
  return null;
}

function extractCalls(src, at, { skip } = {}) {
  const calls = [];
  const hosts = [];
  const lines = src.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = flattenTemplates(lines[i]);
    const lineStart = offset;
    offset += lines[i].length + 1;
    if (line.length > 500 || NAV_CONTEXT.test(line)) continue;
    if (skip && skip.test(line)) continue;
    // a URL assigned to a variable counts when an HTTP call below uses that variable
    const assigned = ASSIGN.exec(line)?.[1];
    const use = assigned ? variableUse(lines, i, assigned) : null;
    if (!HTTP_CONTEXT.test(line) && !use) continue;
    const method = (METHOD_CALL.exec(line)?.[1] || METHOD_OPT.exec(line)?.[1] || use?.method || '').toUpperCase() || null;
    for (const m of line.matchAll(STR_LITERAL)) {
      const n = normalizeCallLiteral(m[2]);
      if (!n) continue;
      const lineNo = at(lineStart);
      if (n.host && !IGNORED_HOST.test(n.host) &&!n.host.includes('${') && !n.host.includes('{')) hosts.push({ host: n.host, line: lineNo });
      if (n.path && !n.host) calls.push({ path: n.path, method, line: lineNo });
    }
  }
  return { calls, hosts };
}

// ---------- JS / TS ----------

/** Imported names plus their local bindings: `import users, { a as b } from` → locals { users: 'default', b: 'a' }. */
function parseImportClause(clause) {
  const names = [];
  const locals = {};
  const c = clause.replace(/^type\s+/, '').trim();
  const brace = /\{([^}]*)\}/.exec(c);
  if (brace) for (const part of brace[1].split(',')) {
    const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s?.trim());
    if (orig) { names.push(orig); locals[alias || orig] = orig; }
  }
  const head = c.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(head);
  if (ns) locals[ns[1]] = '*';
  const def = /^([A-Za-z_$][\w$]*)/.exec(head);
  if (def && def[1] !== 'as') { names.push('default'); locals[def[1]] = 'default'; }
  return { names, locals };
}

function extractJs(src, filePath) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/(?:^|[;\n}])\s*import\s+(?!\()((?:type\s+)?[^'";]*?)\s+from\s+["']([^"'\n]+)["']/g, code)) imports.push({ spec: m[2], ...parseImportClause(m[1]), line: at(m.index) });
  for (const m of all(/(?:^|[;\n])\s*import\s+["']([^"'\n]+)["']/g, code)) imports.push({ spec: m[1], names: [], line: at(m.index) });
  for (const m of all(/\bexport\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g, code)) {
    // `export { a as b } from` → exported { b: 'a' }, the names this file passes on
    const clause = m[1].startsWith('{') ? parseImportClause(m[1]) : null;
    imports.push({ spec: m[2], names: clause ? clause.names : [], ...(clause ? { exported: clause.locals } : {}), line: at(m.index), reexport: true });
  }
  for (const m of all(/\brequire\(\s*["']([^"'\n]+)["']\s*\)/g, code)) {
    // `const usersRouter = require('./users')` / `const { a, b: c } = require(…)` bind local names
    const before = code.slice(code.lastIndexOf('\n', m.index) + 1, m.index);
    const bind = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(before);
    const locals = {};
    if (bind?.[1].startsWith('{')) for (const part of bind[1].slice(1, -1).split(',')) { const [orig, alias] = part.trim().split(/\s*:\s*/); if (orig) locals[(alias || orig).trim()] = orig.trim(); }
    else if (bind) locals[bind[1]] = 'default';
    imports.push({ spec: m[1], names: Object.values(locals), locals, line: at(m.index) });
  }
  for (const m of all(/\bimport\(\s*["']([^"'\n]+)["']\s*\)/g, code)) imports.push({ spec: m[1], names: [], line: at(m.index), dynamic: true });

  const symbols = [];
  const seen = new Set();
  const addSym = (name, kind, idx, isDefault) => {
    const key = name + (isDefault ? '#d' : '');
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({ name, kind, line: at(idx), ...(isDefault ? { default: true } : {}) });
  };
  for (const m of all(/^[ \t]*export\s+(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, code)) {
    const kind = m[2].startsWith('function') ? 'function' : ['const', 'let', 'var'].includes(m[2]) ? 'const' : m[2];
    addSym(m[3], kind, m.index, !!m[1]);
  }
  for (const m of all(/^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm, code)) {
    if (!['function', 'class', 'async'].includes(m[1])) addSym(m[1], 'default', m.index, true);
  }
  for (const m of all(/^[ \t]*export\s*\{([^}]*)\}\s*;?\s*$/gm, code)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig) addSym((alias || orig).trim(), 'export', m.index, (alias || '').trim() === 'default');
    }
  }
  // Next.js route handlers / module exports
  for (const m of all(/^[ \t]*module\.exports\s*=\s*([A-Za-z_$][\w$]*)?/gm, code)) addSym(m[1] || 'module.exports', 'default', m.index, true);

  // Express / Koa / Hono style routes and mounts
  const routes = [];
  const mounts = [];
  for (const m of all(/\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|options|head)\(\s*["'`](\/[^"'`]*)["'`]/g, code)) {
    if (!/^(app|server|fastify|hono|routes?|[a-z]*Router|router)$/.test(m[1])) continue;
    routes.push({ method: m[2].toUpperCase(), path: m[3], var: m[1], line: at(m.index) });
  }
  for (const m of all(/\b([A-Za-z_$][\w$]*)\.(use|route)\(\s*["'`](\/[^"'`]*)["'`]\s*,([^\n;]*)/g, code)) {
    const req = /require\(\s*["']([^"']+)["']\s*\)/.exec(m[4]);
    const mw = (m[4].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][w$.]*$/.test(s))).map((s) => s.split('.').pop());
    if (req) { mounts.push({ prefix: m[3], spec: req[1], line: at(m.index), ...(mw.length ? { mw } : {}) }); continue; }
    const args = m[4].replace(/\)\s*$/, '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$.]*$/.test(s));
    if (args.length) mounts.push({ prefix: m[3], var: args[args.length - 1], line: at(m.index), ...(args.length > 1 ? { mw: args.slice(0, -1).map((s) => s.split('.').pop()) } : {}) });
  }
  // Fastify plugins: app.register(ticketRoutes, { prefix: '/api/tickets' }), or register(import('./x.js'), …).
  // A plugin registered with no prefix still sits under its parent's, so it's a mount with an empty one.
  // Only an imported plugin counts: one defined in this file would put its prefix on every route here.
  for (const m of all(/\.register\(\s*(?:await\s+)?(?:(?:import|require)\(\s*["']([^"'\n]+)["']\s*\)|([A-Za-z_$][\w$]*))\s*(?:,\s*\{([^{}]*)\}\s*)?\)/g, code)) {
    const opts = m[3] || '';
    const prefix = /\bprefix\s*:\s*["'`](\/[^"'`$]*)["'`]/.exec(opts)?.[1] ?? (/\bprefix\s*:/.test(opts) ? null : '');
    if (prefix == null) continue;
    if (m[1]) mounts.push({ prefix, spec: m[1], line: at(m.index) });
    else if (imports.some((i) => i.locals && Object.hasOwn(i.locals, m[2]))) mounts.push({ prefix, var: m[2], line: at(m.index) });
  }

  // Next.js app/pages API routes, derived from the file path
  const next = /(?:^|\/)(?:src\/)?app\/(.*?)\/?route\.(?:t|j)sx?$/.exec(filePath) || /(?:^|\/)(?:src\/)?pages\/(api\/.*?)(?:\/index)?\.(?:t|j)sx?$/.exec(filePath);
  if (next) {
    const p = '/' + next[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/');
    const methods = all(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g, code).map((m) => m[1]);
    for (const method of methods.length ? methods : ['ANY']) routes.push({ method, path: p, var: null, line: 1, framework: 'next' });
  }

  routes.push(...keyedRouteTable(code, at));

  const triggers = /firebase-functions/.test(code) ? firebaseFunctions(code, at, routes, mounts) : [];

  // a mount's prefix (including Fastify's `prefix: '/api'` option, often on a line of its own) isn't a request
  const serverLine = /\b\w+\.(use|route)\(\s*["'`]\/|\b(?:app|server|fastify|hono|routes?|router|[a-z]+Router)\.(?:get|post|put|patch|delete|all|options|head)\(\s*["'`]\/|\bprefix\s*:\s*["'`]\//;
  const { calls, hosts } = extractCalls(code, at, { skip: serverLine });
  const seenCall = new Set(calls.map((c) => `${c.line}|${c.path}`));
  for (const c of wrapperCalls(code, at)) if (!seenCall.has(`${c.line}|${c.path}`)) calls.push(c);
  const callables = /\bhttpsCallable\b/.test(code) ? callableCalls(code, at) : { calls: [], wrappers: [] };
  calls.push(...callables.calls);
  return { imports, symbols, routes, mounts, calls, hosts, ...(triggers.length ? { triggers } : {}), ...(callables.wrappers.length ? { callableWrappers: callables.wrappers } : {}) };
}

// ---------- Firebase Cloud Functions ----------

// `export const approveItem = onCall(…)`, `exports.sign = functions.region('eu').https.onRequest(…)`,
// `export const nightly = onSchedule('every day 03:00', …)`: the exported name, the chain before the
// trigger (v1 style `functions.firestore.document('x')`), and the trigger itself
const FIREBASE_FN = /(?:\bexport\s+(?:const|let|var)\s+|(?:^|[;\n])[ \t]*(?:const|let|var)\s+|\b(?:module\.)?exports\.)([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*((?:[A-Za-z_$][\w$]*(?:\([^()]*\))?\s*\.\s*)*)((?:on|before)[A-Z]\w*)\s*(?:<[^;]{0,300}?>)?\s*\(/g;
const FIRST_STRING = /["'`]([^"'`\n]{1,120})["'`]/;

/**
 * Callable and onRequest functions become endpoints named after their export (CALL /approveItem,
 * ANY /signDocument); Firebase serves an Express app passed to onRequest under the function's name,
 * so that becomes a mount. Every other trigger (schedules, Firestore, Storage, Pub/Sub, Auth) is a
 * background job, returned for the scan summary.
 */
function firebaseFunctions(code, at, routes, mounts) {
  const triggers = [];
  for (const m of code.matchAll(FIREBASE_FN)) {
    const [, name, chain, on] = m;
    const line = at(m.index + m[0].indexOf(name));
    const args = code.slice(m.index + m[0].length, m.index + m[0].length + 300);
    if (on === 'onCall' || on === 'onCallGenkit' || on === 'onRequest') {
      routes.push({ method: on === 'onRequest' ? 'ANY' : 'CALL', path: '/' + name, var: null, line, framework: 'firebase', handler: name });
      const app = on === 'onRequest' && /^\s*(?:\{[^{}]*\}\s*,\s*)?([A-Za-z_$][\w$]*)\s*\)/.exec(args)?.[1];
      if (app) mounts.push({ prefix: '/' + name, var: app, line });
      continue;
    }
    // v1 triggers name the provider in the chain (functions.pubsub.schedule(…).onRun); v2 ones are named for it
    const provider = /\b(pubsub|firestore|storage|auth|database|tasks|analytics|remoteConfig|testLab)\b/.exec(chain)?.[1];
    if (chain ? !provider : !/^(onSchedule|onDocument|onObject|onMessagePublished|onValue|onTaskDispatched|onCustomEventPublished|on\w*Alert|onTestMatrix|onConfigUpdated|before[A-Z])/.test(on)) continue;
    // what it runs on: the last string in the chain (after any region), else the first argument
    const what = [...chain.matchAll(new RegExp(FIRST_STRING, 'g'))].pop()?.[1] || FIRST_STRING.exec(/^[^)]*/.exec(args)[0])?.[1] || null;
    triggers.push({ name, on: provider ? `${provider}.${on}` : on, ...(what ? { what } : {}), line });
  }
  return triggers;
}

// httpsCallable(functions, 'approveItem'), httpsCallable<Req, Res>(getFunctions(app), 'x') and the
// older functions.httpsCallable('x'); the generic arguments may span lines
const CALLABLE = /\bhttpsCallable\s*(?:<[^;]{0,300}?>)?\s*\(\s*(?:[^,()'"`]*(?:\([^()]*\))?\s*,\s*)?(["'`])([\w-]+)\1/g;
const DEFS = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]*>\s*)?\(([^)]*)\)\s*(?::\s*[^=]+?)?=>/g;
/** A callable's name as a path: grouped functions deploy as `group-name`, so 'items-approve' → /items/approve. */
const callablePath = (name) => '/' + name.split('-').filter(Boolean).join('/');

/**
 * Calls to Firebase callable functions, by name, plus helpers that wrap httpsCallable
 * (`const call = (name, data) => httpsCallable(functions, name)(data)`) and their same-file uses.
 * The helpers' names are returned too, so scan.mjs can follow uses in the files that import them.
 */
function callableCalls(code, at) {
  const calls = [...code.matchAll(CALLABLE)].map((m) => ({ path: callablePath(m[2]), method: 'CALL', line: at(m.index) }));
  const wrappers = [];
  for (const m of code.matchAll(DEFS)) {
    const name = m[1] || m[3];
    const p0 = /^[A-Za-z_$][\w$]*/.exec((m[2] ?? m[4]).trim())?.[0];
    if (!p0) continue;
    const body = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
    if (!new RegExp(`\\bhttpsCallable\\s*(?:<[^;]{0,300}?>)?\\s*\\(\\s*(?:[^,()'"\`]*(?:\\([^()]*\\))?\\s*,\\s*)?${p0}\\s*[,)]`).test(body)) continue;
    wrappers.push(name);
    calls.push(...callsVia(code, name, at(m.index)));
  }
  return { calls, wrappers };
}

/** Uses of a callable helper: `callFunction('approveItem', data)` → CALL /approveItem. */
function callsVia(code, name, skipLine = 0) {
  const out = [];
  const re = new RegExp(`(?<![\\w$.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:<[^;]{0,300}?>)?\\s*\\(\\s*(["'\`])([\\w-]+)\\1`, 'g');
  const at = lineIndex(code);
  for (const m of code.matchAll(re)) {
    const line = at(m.index);
    if (line !== skipLine) out.push({ path: callablePath(m[2]), method: 'CALL', line });
  }
  return out;
}
/** The same, in another file that imports the helper (under its local name there). */
export const callableCallsVia = (src, localName) => callsVia(stripCStyle(src), localName);

/**
 * Calls through a helper defined in the same file that adds a prefix and fetches, e.g.
 *   const call = (path, method = 'GET') => apiClient.request(`/inventory${path}`, { method });
 *   definitions: () => call('/definitions'),
 * becomes GET /inventory/definitions. Only same-file helpers whose first parameter is
 * spliced into a URL that an HTTP call fetches.
 */
function wrapperCalls(code, at) {
  const out = [];
  for (const m of code.matchAll(DEFS)) {
    const name = m[1] || m[3];
    const params = (m[2] ?? m[4]).split(',').map((p) => p.trim()).filter(Boolean);
    const pnames = params.map((p) => /^[A-Za-z_$][\w$]*/.exec(p)?.[0]);
    if (!pnames[0] || /^(get|post|put|patch|delete|request|fetch)$/i.test(name)) continue;
    const rawBody = code.slice(m.index + m[0].length, m.index + m[0].length + 700);
    const body = flattenTemplates(rawBody);
    if (!HTTP_CONTEXT.test(body)) continue;
    const tpl = spliced(rawBody, pnames[0]);
    if (tpl == null) continue;
    const methodIdx = pnames.findIndex((p, i) => i > 0 && (/^method$/i.test(p) || new RegExp(`method\\s*:\\s*${p}\\b`).test(body)));
    const defMethod = (methodIdx > 0 && /=\s*["'`](\w+)["'`]/.exec(params[methodIdx])?.[1]) || METHOD_CALL.exec(body)?.[1] || 'GET';
    const callRe = new RegExp(`\\b${name}\\s*(?:<[^>]*>)?\\(\\s*([\"'\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1([^\\n]*)`, 'g');
    const defLine = at(m.index);
    code.split('\n').forEach((raw, i) => {
      if (i + 1 === defLine) return; // the definition itself
      for (const c of flattenTemplates(raw).matchAll(callRe)) {
        const n = normalizeCallLiteral(tpl + c[2]);
        if (!n?.path || n.host) continue;
        const verb = methodIdx > 0 ? /["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(c[3])?.[1] : null;
        out.push({ path: n.path, method: (verb || defMethod).toUpperCase(), line: i + 1 });
      }
    });
  }
  return out;
}
/** The literal prefix right before ${param} in the helper's URL template (`${BASE}/prefix${path}` → "/prefix"), or null. */
function spliced(rawBody, param) {
  const raw = new RegExp(`\`((?:\\$\\{[^}]*\\})*)([^\`$]*)\\$\\{\\s*${param}\\s*\\}`).exec(rawBody);
  return raw ? raw[2] : null;
}

// ---------- Python ----------

function extractPy(src) {
  const code = stripHash(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/^[ \t]*import[ \t]+([\w., \t]+)$/gm, code)) {
    for (const part of m[1].split(',')) {
      const [mod, alias] = part.trim().split(/\s+as\s+/);
      if (mod) imports.push({ spec: mod.trim(), names: [], alias: alias?.trim(), line: at(m.index) });
    }
  }
  for (const m of all(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm, code)) {
    const names = [];
    const aliases = {};
    for (const part of m[2].replace(/[()\\]/g, ' ').split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig && orig !== '*') { names.push(orig.trim()); if (alias) aliases[alias.trim()] = orig.trim(); }
    }
    imports.push({ spec: m[1], names, aliases, from: true, line: at(m.index) });
  }

  const symbols = [];
  for (const m of all(/^(?:async[ \t]+)?def[ \t]+([A-Za-z]\w*)/gm, code)) symbols.push({ name: m[1], kind: 'function', line: at(m.index) });
  for (const m of all(/^class[ \t]+([A-Za-z]\w*)/gm, code)) symbols.push({ name: m[1], kind: 'class', line: at(m.index) });
  symbols.sort((a, b) => a.line - b.line);

  const routes = [];
  const routers = {};
  for (const m of all(/^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:\w+\.)?(Blueprint|APIRouter|Router)\(([^)]*)\)/gm, code)) {
    routers[m[1]] = /(?:url_)?prefix\s*=\s*["']([^"']*)["']/.exec(m[3])?.[1] || '';
  }
  for (const m of all(/^[ \t]*@([A-Za-z_]\w*)\.(route|get|post|put|patch|delete|api_route|websocket)\(\s*[rf]?["']([^"']*)["']([^\n]*)/gm, code)) {
    let methods = [m[2].toUpperCase()];
    if (m[2] === 'route' || m[2] === 'api_route') {
      // the decorator's arguments may continue over several lines, up to the next decorator or def
      const rest = code.slice(m.index + m[0].length - m[4].length, m.index + m[0].length + 400).split(/\n\s*(?:@|def |async def )/)[0];
      const ms = /methods\s*=\s*[\[(]([^\])]*)[\])]/.exec(rest);
      methods = ms ? [...ms[1].matchAll(/["'](\w+)["']/g)].map((x) => x[1].toUpperCase()) : ['GET'];
    }
    for (const method of methods) routes.push({ method, path: m[3], var: m[1], line: at(m.index) });
  }
  routes.push(...keyedRouteTable(code, at));
  // Django urls.py
  for (const m of all(/\b(?:re_)?path\(\s*r?["']([^"']*)["']\s*,(?!\s*include\()/g, code)) routes.push({ method: 'ANY', path: '/' + m[1].replace(/^\^|\$$/g, ''), var: null, line: at(m.index), framework: 'django' });

  const mounts = [];
  // path('api/orders/', include('orders.urls')): that module's urls sit under the prefix, and this file uses it
  for (const m of all(/\b(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*include\(\s*\(?\s*["']([\w.]+)["']/g, code)) {
    imports.push({ spec: m[2], names: [], line: at(m.index) });
    mounts.push({ spec: m[2], prefix: m[1].replace(/^\^|\$$/g, ''), line: at(m.index) });
  }
  for (const m of all(/\b(register_blueprint|include_router|mount)\(\s*([A-Za-z_][\w.]*)/g, code)) {
    // the call's arguments, up to its own closing bracket: dependencies=[Depends(x)] holds brackets of its own
    let depth = 1, j = m.index + m[0].length;
    while (j < code.length && depth && j - m.index < 2000) { if (code[j] === '(') depth++; else if (code[j] === ')') depth--; j++; }
    const args = code.slice(m.index + m[0].length, j - 1);
    // FastAPI checks applied to every route of the router where it's included:
    // app.include_router(admin.router, dependencies=[Depends(require_admin)])
    const deps = m[1] === 'include_router' ? /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(args)?.[1] : null;
    const mw = deps ? [...deps.matchAll(/\b(?:Depends|Security)\(\s*([\w.]+)/g)].map((d) => d[1].split('.').pop()) : [];
    mounts.push({ var: m[2], prefix: /(?:url_)?prefix\s*=\s*["']([^"']*)["']/.exec(args)?.[1] || '', line: at(m.index), ...(mw.length ? { mw } : {}) });
  }

  const routeLine = /^\s*@\w+\.(route|get|post|put|patch|delete)\(/;
  const { calls, hosts } = extractCalls(code, at, { skip: routeLine });
  return { imports, symbols, routes, mounts, calls, hosts, routers };
}

// ---------- Go ----------

function extractGo(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm, code)) imports.push({ spec: m[1], names: [], line: at(m.index) });
  for (const block of all(/^import\s*\(([\s\S]*?)\)/gm, code)) {
    for (const m of all(/(?:[\w.]+\s+)?"([^"]+)"/g, block[1])) imports.push({ spec: m[1], names: [], line: at(block.index) });
  }
  const symbols = [];
  for (const m of all(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, code)) symbols.push({ name: m[1], kind: 'function', line: at(m.index) });
  for (const m of all(/^type\s+([A-Z]\w*)\s+(struct|interface)?/gm, code)) symbols.push({ name: m[1], kind: m[2] || 'type', line: at(m.index) });
  const routes = [];
  for (const m of all(/\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(\/[^"]*)"/g, code)) {
    const method = /^handle/i.test(m[1]) ? 'ANY' : m[1].toUpperCase();
    const p = m[2].replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, '');
    routes.push({ method, path: p, var: null, line: at(m.index) });
  }
  const { calls, hosts } = extractCalls(code, at, { skip: /\.(HandleFunc|Handle|GET|POST)\(/ });
  return { imports, symbols, routes, mounts: [], calls, hosts };
}

// ---------- Rust ----------

function extractRust(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm, code)) imports.push({ spec: m[1], kind: 'mod', names: [], line: at(m.index) });
  for (const m of all(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/gm, code)) imports.push({ spec: m[1], kind: 'use', names: [], line: at(m.index) });
  const symbols = [];
  for (const m of all(/^[ \t]*pub\s+(?:async\s+)?(fn|struct|enum|trait|type|const|static)\s+(\w+)/gm, code)) symbols.push({ name: m[2], kind: m[1] === 'fn' ? 'function' : m[1], line: at(m.index) });
  const routes = [];
  for (const m of all(/#\[(get|post|put|patch|delete)\(\s*"([^"]+)"/g, code)) routes.push({ method: m[1].toUpperCase(), path: m[2], var: null, line: at(m.index) });
  for (const m of all(/\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)/g, code)) routes.push({ method: m[2].toUpperCase(), path: m[1], var: null, line: at(m.index) });
  const { calls, hosts } = extractCalls(code, at);
  return { imports, symbols, routes, mounts: [], calls, hosts };
}

// ---------- JVM ----------

function extractJvm(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1] || null;
  const imports = all(/^\s*import\s+(?:static\s+)?([\w.*]+)/gm, code).map((m) => ({ spec: m[1], names: [], line: at(m.index) }));
  const symbols = [];
  for (const m of all(/^\s*(?:public\s+|internal\s+)?(?:abstract\s+|final\s+|data\s+|sealed\s+|open\s+)*(class|interface|enum|record|object)\s+(\w+)/gm, code)) symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  const routes = [];
  const classPrefix = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?class/.exec(code)?.[1] || '';
  for (const m of all(/@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/g, code)) {
    if (m[1] === 'Request' && m[2] === classPrefix) continue;
    routes.push({ method: m[1] === 'Request' ? 'ANY' : m[1].toUpperCase(), path: classPrefix + m[2], var: null, line: at(m.index) });
  }
  const { calls, hosts } = extractCalls(code, at, { skip: /@\w+Mapping/ });
  return { imports, symbols, routes, mounts: [], calls, hosts, pkg };
}

// ---------- PHP ----------

/** Just past the closing quote of the PHP string starting at i (single, double or backtick; may span lines). */
function phpStringEnd(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, s.length);
}

/**
 * PHP with comments blanked and offsets kept. The text outside <?php … ?> is blanked too, so an apostrophe
 * in a template's HTML can't start a "string"; strings stay as written; a heredoc becomes a quoted run of
 * blanks the same size. `#[…]` is an attribute, not a comment.
 */
export function stripPhp(src) {
  let out = '';
  let php = false;
  for (let i = 0; i < src.length;) {
    if (!php) {
      const j = src.indexOf('<?', i);
      out += blank(src.slice(i, j < 0 ? src.length : j));
      if (j < 0) break;
      const tag = /^<\?(?:php\b|=)?/i.exec(src.slice(j, j + 5))[0];
      out += tag; i = j + tag.length; php = true;
      continue;
    }
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { const j = phpStringEnd(src, i); out += src.slice(i, j); i = j; continue; }
    if (c === '<' && src.startsWith('<<<', i)) {
      const m = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/.exec(src.slice(i, i + 100));
      if (m) {
        const close = new RegExp(`\\n[ \\t]*${m[2]}\\b`, 'g');
        close.lastIndex = i + m[0].length - 1;
        const cm = close.exec(src);
        const end = cm ? cm.index + cm[0].length : src.length;
        out += "'" + blank(src.slice(i + 1, end - 1)) + "'";
        i = end;
        continue;
      }
    }
    if (c === '?' && src[i + 1] === '>') { out += '?>'; i += 2; php = false; continue; }
    let end = -1;
    if (c === '/' && src[i + 1] === '*') { end = src.indexOf('*/', i + 2); end = end < 0 ? src.length : end + 2; }
    else if ((c === '/' && src[i + 1] === '/') || (c === '#' && src[i + 1] !== '[')) {
      end = i;
      while (end < src.length && src[end] !== '\n' && !(src[end] === '?' && src[end + 1] === '>')) end++;
    }
    if (end >= 0) { out += blank(src.slice(i, end)); i = end; continue; }
    out += c;
    i++;
  }
  return out;
}

/** Just past the bracket that closes the one at `open`, in comment-free PHP (strings are stepped over). */
export function phpClose(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') { i = phpStringEnd(code, i) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i + 1;
  }
  return code.length;
}

/** The top-level comma-separated parts of text (an argument list or an array's inside). */
export function phpSplit(text) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i = phpStringEnd(text, i) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(from, i).trim()); from = i + 1; }
  }
  const last = text.slice(from).trim();
  if (last) out.push(last);
  return out;
}

/** A plain PHP string literal's value, or null (a double-quoted string with variables in it isn't plain). */
export function phpStr(t) {
  const m = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/s.exec((t || '').trim());
  if (!m || (m[1] === '"' && /\$[{A-Za-z_]/.test(m[2]))) return null;
  return m[2].replace(/\\(['"\\$])/g, '$1');
}
/** The inside of an array literal ([…] or array(…)), or null. */
export const phpArrayBody = (t) => /^(?:\[([\s\S]*)\]|array\s*\(([\s\S]*)\))$/i.exec((t || '').trim())?.slice(1).find((x) => x != null) ?? null;
/** A named argument (`apiPrefix: 'v1'`) as [name, value], or [null, text]. */
export const phpNamed = (t) => { const m = /^([A-Za-z_]\w*)\s*:(?!:)\s*([\s\S]*)$/.exec(t); return m ? [m[1], m[2]] : [null, t]; };
/** `key => value` pairs of an array literal. */
export function phpPairs(t) {
  const body = phpArrayBody(t);
  if (body == null) return [];
  return phpSplit(body).map((part) => {
    let depth = 0;
    for (let i = 0; i < part.length - 1; i++) {
      const c = part[i];
      if (c === "'" || c === '"') { i = phpStringEnd(part, i) - 1; continue; }
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
      else if (depth === 0 && c === '=' && part[i + 1] === '>') return [phpStr(part.slice(0, i)), part.slice(i + 2).trim()];
    }
    return [null, part];
  });
}

const PHP_NOT_CLASS = new Set('self static parent array string int integer float double bool boolean void mixed never null false true iterable callable object resource fn function new return use namespace class interface trait enum extends implements instanceof insteadof as list print echo yield match case default if else elseif while for foreach do switch try catch finally throw clone include require include_once require_once global const var isset unset empty eval exit die declare abstract final readonly public protected private'.split(' '));
const PHP_NAME = String.raw`\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*`;
const PHP_REFS = [
  new RegExp(String.raw`\bnew\s+(${PHP_NAME})`, 'g'),
  new RegExp(String.raw`(?<![\w$\\>:])(${PHP_NAME})\s*::`, 'g'),
  new RegExp(String.raw`\binstanceof\s+(${PHP_NAME})`, 'g'),
  new RegExp(String.raw`\b(?:implements|extends)\s+(${PHP_NAME}(?:\s*,\s*${PHP_NAME})*)`, 'g'),
  new RegExp(String.raw`\bcatch\s*\(\s*(${PHP_NAME}(?:\s*\|\s*${PHP_NAME})*)`, 'g'),
  // parameter types (Foo $x, ?Bar $y, A|B $z, promoted `private readonly Repo $repo`) and return types `): ?Foo`
  new RegExp(String.raw`[(,]\s*(?:(?:public|protected|private|readonly)\s+)*\??(${PHP_NAME}(?:\s*[|&]\s*\??${PHP_NAME})*)\s+&?(?:\.\.\.)?\$`, 'g'),
  new RegExp(String.raw`\)\s*:\s*\??(${PHP_NAME}(?:\s*[|&]\s*\??${PHP_NAME})*)`, 'g'),
  new RegExp(String.raw`\b(?:public|protected|private|var)\s+(?:(?:static|readonly)\s+)*\??(${PHP_NAME})\s+\$`, 'g'),
  new RegExp(String.raw`#\[\s*(${PHP_NAME})`, 'g'),
];

/** Resolves a class name written in this file to its full name, the way PHP does: `use` aliases, then the namespace. */
function phpClassResolver(ns, uses) {
  return (name) => {
    if (!name) return null;
    name = name.trim();
    if (name.startsWith('\\')) return name.slice(1);
    const [head, ...rest] = name.split('\\');
    if (PHP_NOT_CLASS.has(head.toLowerCase()) && !rest.length) return null;
    const alias = uses.get(head.toLowerCase());
    if (alias) return [alias, ...rest].join('\\');
    if (head.toLowerCase() === 'namespace') return [ns, ...rest].filter(Boolean).join('\\');
    return ns ? `${ns}\\${name}` : name;
  };
}

/**
 * A path written in PHP (`__DIR__.'/api/v2.php'`, `base_path('routes/web.php')`, `dirname(__DIR__).'/x.php'`,
 * with loop variables filled in from vars) as an import spec: './…' relative to this file, '@base/…' relative
 * to the app's root (the folder holding composer.json). Null when it can't be worked out without running it.
 */
function phpPath(text, vars = {}) {
  const parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') { i = phpStringEnd(text, i) - 1; continue; }
    if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--;
    else if (c === '.' && depth === 0 && text[i + 1] !== '.' && text[i - 1] !== '.') { parts.push(text.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(text.slice(from).trim());
  let base = null, out = '';
  for (const [k, p] of parts.entries()) {
    let m;
    const s = phpStr(p);
    if (s != null) { out += s; continue; }
    if (/^\$\w+$/.test(p) && typeof vars[p.slice(1)] === 'string') { out += vars[p.slice(1)]; continue; }
    if (k > 0) return null;
    if (/^(__DIR__|dirname\(\s*__FILE__\s*\))$/.test(p)) base = '.';
    else if ((m = /^dirname\(\s*__DIR__\s*(?:,\s*(\d+)\s*)?\)$/.exec(p))) base = Array(Number(m[1] || 1)).fill('..').join('/');
    else if ((m = /^(base|app)_path\(\s*(?:(['"])([^'"]*)\2)?\s*\)$/.exec(p))) base = '@base' + (m[1] === 'app' ? '/app' : '') + (m[3] ? '/' + m[3].replace(/^\/+/, '') : '');
    else return null;
  }
  if (base == null) return out ? (out.startsWith('/') ? '.' + out : out) : null;
  return (base + '/' + out.replace(/^\/+/, '')).replace(/\/+$/, '');
}

const ROUTE_METHODS = { get: ['GET'], post: ['POST'], put: ['PUT'], patch: ['PATCH'], delete: ['DELETE'], options: ['OPTIONS'], any: ['ANY'] };
const RESOURCE_ACTIONS = [
  ['index', 'GET', ''], ['create', 'GET', '/create'], ['store', 'POST', ''], ['show', 'GET', '/{id}'],
  ['edit', 'GET', '/{id}/edit'], ['update', 'PUT', '/{id}'], ['update', 'PATCH', '/{id}'], ['destroy', 'DELETE', '/{id}'],
];
const SINGLETON_ACTIONS = [['create', 'GET', '/create'], ['store', 'POST', ''], ['show', 'GET', ''], ['edit', 'GET', '/edit'], ['update', 'PUT', ''], ['update', 'PATCH', ''], ['destroy', 'DELETE', '']];
const joinUri = (...parts) => parts.map((p) => (p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
// What a closure endpoint could hand out that isn't public: the database, the signed-in user, the request, the session, config…
const PHP_READS_PRIVATE = /\bDB\s*::|\b[A-Z]\w*\s*::\s*(?:query|where\w*|find\w*|all|first\w*|with|latest|oldest|paginate|get|pluck|count|select)\s*\(|->\s*(?:get|first|find\w*|paginate|pluck|count|sum|exists)\s*\(|\$request\b|\brequest\s*\(|\bauth\s*\(|\bAuth\s*::|\bsession\s*\(|\bcache\s*\(|\bCache\s*::|\bStorage\s*::|\bconfig\s*\(|\benv\s*\(|\bfile_get_contents\s*\(|\bview\s*\(|\bInertia\b|\binertia\s*\(/;
const ONLY_REDIRECT = /^(?:redirect\s*\(|Redirect\s*::|to_route\s*\(|back\s*\(|new\s+\\?(?:[\w\\]*\\)?RedirectResponse\b)/;
/** A closure endpoint that only redirects, or touches nothing private (a fixed answer): nothing to protect. */
function quietClosure(text) {
  if (!text) return false;
  const arrow = /^(?:static\s+)?fn\b[^=]*=>\s*([\s\S]*)$/.exec(text);
  const returns = arrow ? [arrow[1]] : [...text.matchAll(/\breturn\s+([^;]+);/g)].map((m) => m[1]);
  if (returns.length && returns.every((r) => ONLY_REDIRECT.test(r.trim()))) return true;
  return !PHP_READS_PRIVATE.test(text);
}
const singular = (w) => w.replace(/-/g, '_').replace(/ies$/, 'y').replace(/(ss|sh|ch|x)es$/, '$1').replace(/([^s])s$/, '$1');

/**
 * Laravel's routes in one file: Route::get/post/…/match/any, resource and apiResource (with only/except),
 * Route::inertia and Route::view, under prefix / name / middleware / controller groups (chained or the
 * older Route::group([...]) form), plus the route files this one loads inside a group: require __DIR__.'/x.php',
 * ->group(base_path('routes/x.php')), files required in a loop over a fixed list, and bootstrap/app.php's
 * withRouting(web:, api:). Groups' prefixes, names and middleware are applied to each route here; a loaded
 * file becomes a mount, so routes.mjs carries them into it.
 */
function laravelRoutes(code, at, cls) {
  const routes = [], mounts = [], groups = [], includes = [];
  const strList = (t) => { const s = phpStr(t); if (s != null) return [s]; const b = phpArrayBody(t); return b == null ? [] : phpSplit(b).map(phpStr).filter((x) => x != null); };
  // middleware names: 'auth:sanctum', ['auth', 'verified'], EnsureStaff::class (kept as its class name)
  const mwList = (args) => args.flatMap((a) => { const b = phpArrayBody(a); return b != null ? phpSplit(b) : [a]; })
    .map((t) => { const s = phpStr(t); if (s != null) return s; const m = /^(\\?[\w\\]+)::class/.exec(t.trim()); return m ? m[1].split('\\').pop() : null; }).filter(Boolean);
  const classOf = (t) => { const m = /^(\\?[\w\\]+)\s*::\s*class$/.exec((t || '').trim()); return m ? cls(m[1]) : null; };
  const action = (t, attrs) => {
    t = (t || '').trim();
    let m;
    if ((m = /^\[\s*(\\?[\w\\]+)\s*::\s*class\s*,\s*(['"])(\w+)\2\s*,?\s*\]$/.exec(t))) return { cls: cls(m[1]), fn: m[3] };
    const c = classOf(t);
    if (c) return { cls: c, fn: '__invoke' };
    const s = phpStr(t);
    if (s != null && (m = /^([\w\\]+)@(\w+)$/.exec(s))) return { cls: m[1].includes('\\') ? m[1].replace(/^\\/, '') : `${attrs.ns || 'App\\Http\\Controllers'}\\${m[1]}`, fn: m[2] };
    if (s != null && /^\w+$/.test(s) && attrs.controller) return { cls: attrs.controller, fn: s };
    return null; // a closure, a variable or something only running the app would tell
  };
  const fresh = () => ({ prefix: '', as: '', mw: [], without: [], controller: null, ns: null });
  const merge = (a, b) => ({ prefix: joinUri(a.prefix, b.prefix), as: a.as + b.as, mw: [...a.mw, ...b.mw], without: [...a.without, ...b.without], controller: b.controller || a.controller, ns: b.ns ? (a.ns && !b.ns.startsWith('\\') ? `${a.ns}\\${b.ns}` : b.ns.replace(/^\\/, '')) : a.ns });
  const applyAttr = (attrs, name, args) => {
    switch (name) {
      case 'prefix': attrs.prefix = joinUri(attrs.prefix, phpStr(args[0]) || ''); return true;
      case 'name': case 'as': attrs.as += phpStr(args[0]) || ''; return true;
      case 'middleware': attrs.mw.push(...mwList(args)); return true;
      case 'withoutMiddleware': attrs.without.push(...mwList(args)); return true;
      case 'controller': attrs.controller = classOf(args[0]) || attrs.controller; return true;
      case 'namespace': attrs.ns = phpStr(args[0]) || attrs.ns; return true;
      case 'can': attrs.mw.push('can:' + args.map((a) => phpStr(a) ?? a).join(',')); return true;
      default: return /^(domain|where\w*|scopeBindings|withoutScopedBindings|withTrashed|missing|defaults)$/.test(name);
    }
  };
  const arrayAttrs = (t) => {
    const attrs = fresh();
    for (const [k, v] of phpPairs(t)) {
      if (k === 'prefix') attrs.prefix = phpStr(v) || '';
      else if (k === 'as') attrs.as = phpStr(v) || '';
      else if (k === 'middleware') attrs.mw = mwList([v]);
      else if (k === 'excluded_middleware' || k === 'withoutMiddleware') attrs.without = mwList([v]);
      else if (k === 'controller') attrs.controller = classOf(v);
      else if (k === 'namespace') attrs.ns = phpStr(v);
    }
    return attrs;
  };
  /** The body of a closure argument: function (…) use (…): T { body } or fn (…) => body. */
  const closureBody = (start, end) => {
    const t = code.slice(start, end);
    const fnm = /^\s*(?:static\s+)?function\b/.exec(t);
    if (fnm) {
      const open = code.indexOf('{', code.indexOf(')', start + fnm[0].length));
      return open >= 0 && open < end ? [open + 1, phpClose(code, open) - 1] : null;
    }
    const arrow = /^\s*(?:static\s+)?fn\b[^=]*=>/.exec(t);
    return arrow ? [start + arrow[0].length, end] : null;
  };
  const argsOf = (c) => phpSplit(code.slice(c.open + 1, c.close - 1));
  /** An inline closure's text, or the closure a variable holds ($legacy = static fn () => …;). */
  const closureText = (t) => {
    t = (t || '').trim();
    const v = /^\$(\w+)$/.exec(t);
    if (!v) return /^(?:static\s+)?(?:fn|function)\b/.test(t) ? t : null;
    const m = new RegExp(String.raw`\$${v[1]}\s*=\s*(?=(?:static\s+)?(?:fn|function)\b)`).exec(code);
    if (!m) return null;
    let depth = 0, j = m.index + m[0].length;
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === "'" || c === '"') { j = phpStringEnd(code, j) - 1; continue; }
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
      else if (c === ';' && depth === 0) break;
    }
    return code.slice(m.index + m[0].length, j).trim();
  };
  /** One `Route::…` chain: a list of calls joined by -> (or the first by ::). */
  const chainAt = (i) => {
    const calls = [];
    const head = /([A-Za-z_]\w*)\s*\(/y, arrow = /\s*\??->\s*/y;
    for (;;) {
      head.lastIndex = i;
      const m = head.exec(code);
      if (!m) break;
      const open = i + m[0].length - 1, close = phpClose(code, open);
      calls.push({ name: m[1], open, close });
      arrow.lastIndex = close;
      const a = arrow.exec(code);
      if (!a) break;
      i = close + a[0].length;
    }
    return calls;
  };

  const chains = [];
  for (const m of code.matchAll(/(?<![\w$\\>])\\?(?:Illuminate\\Support\\Facades\\)?Route\s*::\s*/g)) chains.push({ at: m.index, line: at(m.index), calls: chainAt(m.index + m[0].length) });
  // groups first (any order of files works, nesting is by position)
  for (const ch of chains) {
    const pre = fresh();
    for (const c of ch.calls) {
      if (c.name === 'group') {
        const args = argsOf(c);
        let attrs = pre, target = args[0];
        if (args.length > 1 && phpArrayBody(args[0]) != null) { attrs = merge(pre, arrayAttrs(args[0])); target = args[1]; }
        const tStart = code.indexOf(target, c.open);
        const body = target ? closureBody(tStart, tStart + target.length) : null;
        if (body) groups.push({ start: body[0], end: body[1], attrs });
        else { const spec = target && phpPath(target); if (spec) includes.push({ spec, at: ch.at, line: ch.line, attrs }); }
        break;
      }
      if (ROUTE_METHODS[c.name] || /^(match|view|inertia|resources?|apiResources?|singleton|apiSingleton|redirect|permanentRedirect|fallback)$/.test(c.name)) break;
      applyAttr(pre, c.name, argsOf(c));
    }
  }
  groups.sort((a, b) => a.start - b.start);
  const contextAt = (pos) => groups.filter((g) => g.start <= pos && pos < g.end).reduce((acc, g) => merge(acc, g.attrs), fresh());
  const finalMw = (attrs) => attrs.mw.filter((x) => !attrs.without.includes(x) && !attrs.without.includes(x.split(':')[0]));

  for (const ch of chains) {
    const ctx = contextAt(ch.at);
    const pre = fresh();
    let i = 0;
    for (; i < ch.calls.length; i++) {
      const c = ch.calls[i];
      if (c.name === 'group') { i = ch.calls.length; break; }
      if (ROUTE_METHODS[c.name] || /^(match|view|inertia|resources?|apiResources?|singleton|apiSingleton)$/.test(c.name)) break;
      if (!applyAttr(pre, c.name, argsOf(c))) { i = ch.calls.length; break; }
    }
    const reg = ch.calls[i];
    if (!reg) continue;
    const args = argsOf(reg);
    // what follows the registration: ->name('x'), ->middleware(…), ->only([...]) …
    const own = fresh();
    let only = null, except = null;
    for (const c of ch.calls.slice(i + 1)) {
      const a = argsOf(c);
      if (c.name === 'only') only = a.flatMap(strList);
      else if (c.name === 'except') except = a.flatMap(strList);
      else applyAttr(own, c.name, a);
    }
    const attrs = merge(merge(ctx, pre), own);
    const base = merge(ctx, pre);
    const push = (method, uri, act, name, extra = {}) => routes.push({
      method, path: '/' + joinUri(base.prefix, uri), var: null, line: ch.line, framework: 'laravel',
      ...(name ? { routeName: base.as + name } : {}), ...(finalMw(attrs).length ? { mw: finalMw(attrs) } : {}), ...(act?.cls ? { action: act } : {}), ...extra,
    });
    if (ROUTE_METHODS[reg.name] || reg.name === 'match') {
      const [methods, uriT, actT] = reg.name === 'match' ? [strList(args[0]).map((x) => x.toUpperCase()), args[1], args[2]] : [ROUTE_METHODS[reg.name], args[0], args[1]];
      const uri = phpStr(uriT);
      if (uri == null) continue;
      const act = action(actT, attrs);
      const quiet = !act && quietClosure(closureText(actT));
      for (const method of methods) if (method !== 'HEAD') push(method, uri, act, own.as || null, quiet ? { quiet: true } : {});
    } else if (reg.name === 'view' || reg.name === 'inertia') {
      const uri = phpStr(args[0]), page = phpStr(args[1]);
      if (uri == null) continue;
      // a page or view with no controller of its own: a fixed page
      push('GET', uri, null, own.as || null, { ...(reg.name === 'inertia' && page ? { page } : {}), quiet: true });
    } else if (/^(api)?(resource|singleton)s?$/i.test(reg.name)) {
      const api = reg.name.startsWith('api');
      const single = /singleton/i.test(reg.name);
      const list = /s$/.test(reg.name) ? phpPairs(args[0]).map(([k, v]) => [k, v]) : [[phpStr(args[0]), args[1]]];
      for (const [name, ctrlT] of list) {
        if (!name) continue;
        const ctrl = classOf(ctrlT);
        // photos.comments → photos/{photo}/comments/{comment}
        const segs = name.split('.');
        const uriBase = segs.map((s, k) => k < segs.length - 1 ? `${s}/{${singular(s)}}` : s).join('/');
        for (const [fn, method, tail] of single ? SINGLETON_ACTIONS : RESOURCE_ACTIONS) {
          if (api && (fn === 'create' || fn === 'edit')) continue;
          if ((only && !only.includes(fn)) || (except && except.includes(fn))) continue;
          push(method, uriBase + tail.replace('{id}', `{${singular(segs[segs.length - 1])}}`), ctrl ? { cls: ctrl, fn } : null, `${name}.${fn}`);
        }
      }
    }
  }

  // route files loaded from this one: require/include inside (or outside) a group, and files required in a loop
  for (const m of code.matchAll(/\b(?:require|include)(?:_once)?\b\s*\(?\s*([^;]+?)\s*\)?\s*;/g)) {
    const spec = phpPath(m[1]);
    if (spec && /\.php$/i.test(spec)) includes.push({ spec, at: m.index, line: at(m.index), attrs: fresh() });
  }
  for (const m of code.matchAll(/\bforeach\s*\(\s*(\[[^\]]*\]|array\s*\([^)]*\))\s+as\s+\$(\w+)\s*\)\s*\{/g)) {
    const items = strList(m[1]);
    const bodyEnd = phpClose(code, m.index + m[0].length - 1);
    const body = code.slice(m.index + m[0].length, bodyEnd);
    // the path built from the loop variable: required directly, or kept in a variable first
    const exprs = [...body.matchAll(new RegExp(String.raw`([^;=(]*\$${m[2]}\b[^;)]*\.php['"])`, 'g'))].map((x) => x[1].trim());
    if (!items.length || !exprs.length || !/\b(require|include)(_once)?\b/.test(body)) continue;
    for (const it of items) for (const e of exprs) {
      const spec = phpPath(e, { [m[2]]: it });
      if (spec) includes.push({ spec, at: m.index, line: at(m.index), attrs: fresh() });
    }
  }
  // bootstrap/app.php: ->withRouting(web: …, api: …, apiPrefix: 'api')
  for (const m of code.matchAll(/\bwithRouting\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const named = Object.fromEntries(phpSplit(code.slice(open + 1, phpClose(code, open) - 1)).map(phpNamed).filter(([k]) => k));
    const files = (t) => { const b = phpArrayBody(t); return (b != null ? phpSplit(b) : t ? [t] : []).map((x) => phpPath(x)).filter(Boolean); };
    for (const spec of files(named.web)) includes.push({ spec, at: m.index, line: at(m.index), attrs: { ...fresh(), mw: ['web'] } });
    for (const spec of files(named.api)) includes.push({ spec, at: m.index, line: at(m.index), attrs: { ...fresh(), prefix: phpStr(named.apiPrefix) ?? 'api', mw: ['api'] } });
  }
  const seen = new Set();
  for (const inc of includes) {
    const a = merge(contextAt(inc.at), inc.attrs);
    const key = `${inc.spec}|${a.prefix}|${a.as}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mounts.push({ spec: inc.spec, prefix: a.prefix, line: inc.line, ...(a.as ? { as: a.as } : {}), ...(finalMw(a).length ? { mw: finalMw(a) } : {}) });
  }
  return { routes, mounts };
}

function extractPhp(src, filePath) {
  const code = stripPhp(src);
  const at = lineIndex(code);
  const lines = src.split('\n');
  // strings blanked too, for finding class names in code
  let bare = '';
  for (let i = 0; i < code.length;) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') { const j = phpStringEnd(code, i); bare += c + blank(code.slice(i + 1, j - 1)) + (j - i > 1 ? c : ''); i = j; continue; }
    bare += c; i++;
  }
  const ns = /^\s*namespace\s+([\w\\]+)\s*[;{]/m.exec(bare)?.[1] || null;

  // class-like bodies, to tell `use Trait;` inside a class from a top-level `use Some\Class;`
  const symbols = [];
  const bodies = [];
  for (const m of bare.matchAll(/^[ \t]*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)[^{;]*\{/gm)) {
    symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
    bodies.push([m.index + m[0].length, phpClose(bare, m.index + m[0].length - 1)]);
  }
  for (const m of bare.matchAll(/^function\s+&?([A-Za-z_]\w*)\s*\(/gm)) symbols.push({ name: m[1], kind: 'function', line: at(m.index) });
  const inBody = (pos) => bodies.some(([a, b]) => pos >= a && pos < b);

  const uses = new Map(); // alias (lower-case) -> full name
  const imports = [];
  const seenSpec = new Set();
  const addImport = (spec, line, extra = {}) => { if (!spec || seenSpec.has(spec)) return; seenSpec.add(spec); imports.push({ spec, names: [], line, ...extra }); };
  for (const m of bare.matchAll(/(?<=^|[;{}]|<\?php)\s*use\s+(?!\()(function\s+|const\s+)?([^;{(]+(?:\{[^}]*\})?)\s*;/gi)) {
    if (m[1]) continue; // use function / use const: no class to link
    const pos = m.index + m[0].indexOf('use');
    const line = at(pos);
    if (inBody(pos)) { // traits used by a class: resolved like any other class name, below
      for (const t of m[2].split(',')) if (t.trim()) imports.push({ trait: t.trim(), line });
      continue;
    }
    const group = /^([\w\\]+)\\\{([^}]*)\}$/.exec(m[2].trim());
    const items = group ? group[2].split(',').map((x) => x.trim() && `${group[1]}\\${x.trim()}`).filter(Boolean) : m[2].split(',');
    for (const item of items) {
      const [full, alias] = item.trim().replace(/^\\/, '').split(/\s+as\s+/i);
      if (!full) continue;
      uses.set((alias || full.split('\\').pop()).toLowerCase(), full);
      addImport(full, line, { kind: 'class' });
    }
  }
  const cls = phpClassResolver(ns, uses);
  // traits, then every other class this file names: new X, X::y, extends / implements, types, attributes
  for (let k = imports.length - 1; k >= 0; k--) if (imports[k].trait) { const t = imports.splice(k, 1)[0]; addImport(cls(t.trait), t.line, { kind: 'class' }); }
  for (const re of PHP_REFS) for (const m of bare.matchAll(re)) {
    for (const name of m[1].split(/\s*[|&,]\s*/)) {
      const n = name.replace(/^\?/, '').trim();
      if (!n || (PHP_NOT_CLASS.has(n.toLowerCase()) && !n.includes('\\'))) continue;
      addImport(cls(n), at(m.index), { kind: 'class' });
    }
  }

  // methods: where a route's controller action starts, and its doc comment
  const methods = [];
  for (const m of bare.matchAll(/^[ \t]+((?:(?:public|protected|private|static|final|abstract)\s+)*)function\s+&?([A-Za-z_]\w*)\s*\(/gm)) {
    const line = at(m.index);
    let k = line - 1;
    while (k > 0 && /^\s*#\[/.test(lines[k - 1])) k--; // PHP 8 attributes sit between the docblock and the method
    const doc = commentBefore(lines, k);
    // the classes its parameters are typed with (a form request among them checks who may call)
    const open = m.index + m[0].length - 1;
    const types = [...new Set(phpSplit(bare.slice(open + 1, phpClose(bare, open) - 1))
      .map((p) => /^(?:#\[[^\]]*\]\s*)*(?:(?:public|protected|private|readonly)\s+)*\??([\\\w]+)\s+&?(?:\.\.\.)?\$/.exec(p)?.[1])
      .filter((t) => t && !PHP_NOT_CLASS.has(t.toLowerCase())).map(cls).filter(Boolean))];
    methods.push({ name: m[2], line, ...(/\b(protected|private)\b/.test(m[1]) ? { hidden: true } : {}), ...(doc ? { doc } : {}), ...(types.length ? { types } : {}) });
  }
  const methodAt = (line) => { let best = null; for (const mt of methods) if (mt.line <= line) best = mt; return best?.name || null; };

  // require/include of another file by path
  for (const m of code.matchAll(/\b(?:require|include)(?:_once)?\b\s*\(?\s*([^;]+?)\s*\)?\s*;/g)) {
    const spec = phpPath(m[1]);
    if (spec) addImport(spec, at(m.index), { kind: 'include' });
  }

  let routes = [], mounts = [];
  if (/\bRoute\s*::|\bwithRouting\s*\(/.test(bare)) {
    ({ routes, mounts } = laravelRoutes(code, at, cls));
    for (const mt of mounts) addImport(mt.spec, mt.line, { kind: 'include' });
  }
  // Inertia pages this file renders, and from which method: Inertia::render('orders/index'), inertia('Dashboard')
  const inertia = [];
  for (const m of code.matchAll(/(?:\bInertia\s*::\s*render|(?<![\w$>:\\])inertia)\s*\(\s*(?:component\s*:\s*)?(['"])([^'"]+)\1/g)) {
    const line = at(m.index);
    inertia.push({ page: m[2], line, ...(methodAt(line) ? { fn: methodAt(line) } : {}) });
  }

  const { calls, hosts } = extractCalls(code, at, { skip: /\bRoute\s*::|->(?:prefix|group|middleware)\(/ });
  const classes = symbols.filter((s) => s.kind !== 'function').map((s) => (ns ? `${ns}\\${s.name}` : s.name));
  return {
    imports, symbols, routes, mounts, calls, hosts,
    ...(classes.length ? { classes } : {}), ...(methods.length ? { methods } : {}), ...(inertia.length ? { inertia } : {}),
  };
}

// ---------- small ones ----------

function extractSimple(src, lang) {
  const code = lang === 'ruby' ? stripHash(src) : stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  if (lang === 'ruby') for (const m of all(/\brequire_relative\s*\(?\s*["']([^"']+)["']/g, code)) imports.push({ spec: './' + m[1].replace(/^\.\//, ''), names: [], line: at(m.index) });
  if (lang === 'c' || lang === 'cpp' || lang === 'objc') for (const m of all(/^\s*#\s*(?:include|import)\s+"([^"]+)"/gm, code)) imports.push({ spec: m[1], names: [], kind: 'include', line: at(m.index) });
  if (lang === 'php') for (const m of all(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']([^"']+)["']/g, code)) imports.push({ spec: m[1].startsWith('/') ? '.' + m[1] : m[1], names: [], line: at(m.index) });
  if (lang === 'css') for (const m of all(/@(?:import|use|forward)\s+(?:url\()?["']([^"']+)["']/g, code)) imports.push({ spec: m[1].startsWith('.') ? m[1] : './' + m[1], names: [], line: at(m.index) });
  const symbols = [];
  if (lang === 'ruby') for (const m of all(/^\s*(class|module)\s+([A-Z][\w:]*)/gm, code)) symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  if (lang === 'csharp') for (const m of all(/^\s*public\s+(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(class|interface|enum|record|struct)\s+(\w+)/gm, code)) symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  const { calls, hosts } = ['ruby', 'php', 'csharp', 'swift', 'dart', 'kotlin'].includes(lang) ? extractCalls(code, at) : { calls: [], hosts: [] };
  return { imports, symbols, routes: [], mounts: [], calls, hosts };
}

function extractByLang(src, lang, filePath) {
  switch (lang) {
    case 'typescript': case 'javascript': case 'vue': case 'svelte': case 'astro': return extractJs(src, filePath);
    case 'python': return extractPy(src);
    case 'php': return /\.blade\.php$/i.test(filePath || '') ? extractSimple(src, lang) : extractPhp(src, filePath);
    case 'go': return extractGo(src);
    case 'rust': return extractRust(src);
    case 'java': case 'kotlin': case 'scala': case 'groovy': return extractJvm(src);
    default: return extractSimple(src, lang);
  }
}

export function extract(src, lang, filePath) {
  const r = extractByLang(src, lang, filePath);
  addDocs(src, lang, r);
  return r;
}

// ---------- docs: file headers, docstrings, JSDoc, route handlers ----------

const HASH_LANGS = new Set(['python', 'ruby', 'shell', 'powershell', 'r', 'elixir', 'perl']);
const LICENSE = /copyright|license|spdx|eslint-disable|@ts-nocheck|prettier-ignore|^-\*-|coding[:=]|generated by|do not edit/i;

export function cleanDoc(text) {
  if (!text) return null;
  const lines = text.split('\n')
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#+|"""|''')\s?/, '').replace(/(\*\/|"""|''')\s*$/, '').trim())
    .filter((l) => l && !/^@\w+/.test(l) && !/^[-=*_]{3,}$/.test(l));
  // first paragraph only
  const para = [];
  for (const l of lines) { if (!l && para.length) break; para.push(l); }
  let s = para.join(' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length < 8 || LICENSE.test(s)) return null;
  const sentence = /^(.{20,220}?[.!?])(\s|$)/.exec(s);
  s = sentence ? sentence[1] : s.length > 220 ? s.slice(0, 217).replace(/\s+\S*$/, '') + '…' : s;
  return s;
}

function pyDocAfter(lines, idx) {
  // idx: 0-based line of the def/class (or -1 for module). Find the end of the signature, then a string literal.
  let i = idx;
  if (idx >= 0) {
    while (i < lines.length && i < idx + 20 && !/:\s*(#.*)?$/.test(lines[i])) i++;
    i++;
  } else i = 0;
  while (i < lines.length && (!lines[i].trim() || (idx < 0 && /^\s*(#|from __future__)/.test(lines[i])))) i++;
  const first = lines[i];
  if (!first) return null;
  const m = /^\s*[rRbBuUfF]?("""|''')(.*)$/.exec(first);
  if (!m) return idx < 0 ? hashHeader(lines) : null;
  const q = m[1];
  if (m[2].includes(q)) return cleanDoc(m[2].slice(0, m[2].indexOf(q)));
  const buf = [m[2]];
  for (let j = i + 1; j < lines.length && j < i + 40; j++) {
    const k = lines[j].indexOf(q);
    if (k >= 0) { buf.push(lines[j].slice(0, k)); break; }
    buf.push(lines[j]);
  }
  return cleanDoc(buf.join('\n'));
}

function hashHeader(lines) {
  const buf = [];
  for (const l of lines) {
    if (/^#!/.test(l)) continue;
    if (/^\s*#/.test(l)) { buf.push(l); continue; }
    if (!l.trim() && !buf.length) continue;
    break;
  }
  return cleanDoc(buf.join('\n'));
}

function commentBefore(lines, idx) {
  // idx: 0-based line of the declaration. Skip decorators/annotations, then read a /** */ block or // run.
  let i = idx - 1;
  while (i >= 0 && /^\s*@/.test(lines[i])) i--;
  if (i < 0) return null;
  if (/\*\/\s*$/.test(lines[i])) {
    const end = i;
    while (i >= 0 && !/\/\*/.test(lines[i])) i--;
    return i >= 0 ? cleanDoc(lines.slice(i, end + 1).join('\n')) : null;
  }
  const buf = [];
  while (i >= 0 && /^\s*(\/\/|#(?!!))/.test(lines[i])) buf.unshift(lines[i--]);
  return buf.length ? cleanDoc(buf.join('\n')) : null;
}

function headerComment(lines) {
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^\s*['"]use (client|server|strict)['"];?\s*$/.test(lines[i]) || /^#!/.test(lines[i]))) i++;
  const l = lines[i] || '';
  if (/^\s*\/\*/.test(l)) {
    const start = i;
    while (i < lines.length && !/\*\//.test(lines[i])) i++;
    return cleanDoc(lines.slice(start, i + 1).join('\n'));
  }
  const buf = [];
  while (i < lines.length && /^\s*\/\//.test(lines[i])) buf.push(lines[i++]);
  return cleanDoc(buf.join('\n'));
}

/** A PHP file's description: the comment after <?php, declare, namespace and use lines, else the docblock of its class. */
function phpHeader(lines, r) {
  let i = 0;
  while (i < lines.length && /^\s*(<\?php|declare\s*\(|namespace\s|use\s|$)/i.test(lines[i])) i++;
  // Laravel's banner comments draw a margin with | and rules with |-----
  const top = headerComment(lines.slice(i).map((l) => l.replace(/^(\s*\*?\s*)\|\s?/, '$1')));
  if (top) return top;
  const cls = (r.symbols || []).find((s) => s.kind !== 'function');
  if (!cls) return null;
  let k = cls.line - 1;
  while (k > 0 && /^\s*#\[/.test(lines[k - 1])) k--;
  return commentBefore(lines, k);
}

function addDocs(src, lang, r) {
  const lines = src.split('\n');
  r.doc = lang === 'python' ? pyDocAfter(lines, -1) : lang === 'php' ? phpHeader(lines, r) : HASH_LANGS.has(lang) ? hashHeader(lines) : headerComment(lines);
  for (const s of r.symbols || []) {
    const d = lang === 'python' ? pyDocAfter(lines, s.line - 1) : commentBefore(lines, s.line - 1);
    if (d) s.doc = d;
  }
  // A route's handler is the first declaration after it (decorator-style frameworks).
  // (a Firebase function's export isn't the handler of the Express routes above it)
  const fbNames = new Set((r.routes || []).filter((rt) => rt.framework === 'firebase').map((rt) => rt.handler));
  const syms = (r.symbols || []).filter((s) => !fbNames.has(s.name)).sort((a, b) => a.line - b.line);
  for (const rt of r.routes || []) {
    if (rt.framework === 'laravel') continue; // its handler is a controller method in another file (routes.mjs)
    if (rt.framework === 'next') { rt.handler = rt.method; continue; }
    if (rt.framework === 'table') { const d = r.symbols?.find((s) => s.name === rt.handler)?.doc; if (d) rt.doc = d; continue; }
    if (rt.framework === 'firebase') { const d = r.symbols.find((s) => s.name === rt.handler)?.doc || commentBefore(lines, rt.line - 1); if (d) rt.doc = d; continue; }
    const h = syms.find((s) => s.line >= rt.line && s.line - rt.line <= 12);
    if (h) { rt.handler = h.name; if (h.doc) rt.doc = h.doc; }
    else if (lang === 'python') {
      const m = lines.slice(rt.line, rt.line + 12).findIndex((l) => /^\s*(async\s+)?def\s+\w+/.test(l));
      if (m >= 0) {
        rt.handler = /def\s+(\w+)/.exec(lines[rt.line + m])[1];
        const d = pyDocAfter(lines, rt.line + m);
        if (d) rt.doc = d;
      }
    }
  }
}
