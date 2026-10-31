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
// Strip comments while keeping offsets (so line numbers stay right).
const stripCStyle = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
const stripHash = (src) => src.replace(/(^|\s)#[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));

const all = (re, s) => [...s.matchAll(re)];

// ---------- HTTP call literals ----------

// withUrl: a SignalR connection to a hub (new HubConnectionBuilder().withUrl('/hubs/chat'))
const HTTP_CONTEXT = /\b(fetch|axios|ky|got|request|requests|httpx|aiohttp|session|client|http|https|api|Api|API|endpoint|Endpoint|url|Url|URL|BASE|base|withUrl|WithUrl)\b|\.(get|post|put|patch|delete|head)\s*(<[^>]*>)?\s*\(|(?<![.\w$])(get|post|put|patch|delete)\s*\(\s*[rf]?["'`]\//;
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

  // Next.js app/pages API routes, derived from the file path
  const next = /(?:^|\/)(?:src\/)?app\/(.*?)\/?route\.(?:t|j)sx?$/.exec(filePath) || /(?:^|\/)(?:src\/)?pages\/(api\/.*?)(?:\/index)?\.(?:t|j)sx?$/.exec(filePath);
  if (next) {
    const p = '/' + next[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/');
    const methods = all(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g, code).map((m) => m[1]);
    for (const method of methods.length ? methods : ['ANY']) routes.push({ method, path: p, var: null, line: 1, framework: 'next' });
  }

  const triggers = /firebase-functions/.test(code) ? firebaseFunctions(code, at, routes, mounts) : [];

  const serverLine = /\b\w+\.(use|route)\(\s*["'`]\/|\b(?:app|server|fastify|hono|routes?|router|[a-z]+Router)\.(?:get|post|put|patch|delete|all|options|head)\(\s*["'`]\//;
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
  // Django urls.py
  for (const m of all(/\b(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*(?!include)/g, code)) routes.push({ method: 'ANY', path: '/' + m[1].replace(/^\^|\$$/g, ''), var: null, line: at(m.index), framework: 'django' });

  const mounts = [];
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

// ---------- C# / ASP.NET Core ----------

// One attribute section at the start of a line or right after another: `[Route("api/[controller]")]`,
// `[HttpGet("{id}"), Authorize]`, possibly over several lines. Strings are taken whole, so brackets
// inside a template don't end it.
const CS_ATTR_SECTION = /(?<=^[ \t]*|\][ \t]*)\[((?:"(?:[^"\\\n]|\\.)*"|[^\]"])*)\]/gm;
const CS_VERB = /\bHttp(Get|Post|Put|Patch|Delete|Head|Options)(?:Attribute)?\b(?:\s*\(\s*(?:template\s*:\s*)?"([^"]*)")?/g;
const CS_ROUTE = /\bRoute(?:Attribute)?\s*\(\s*(?:template\s*:\s*)?"([^"]*)"/g;
const CS_TYPE = /(?<=^[ \t]*|\][ \t]*)((?:(?:public|internal|private|protected|static|abstract|sealed|partial|readonly|ref|file|unsafe|new)\s+)*)(class|interface|enum|record|struct)\s+(\w+)([^{;]*)/gm;
// Minimal APIs: app.MapGet("/orders/{id}", GetOrder), route groups: var api = app.MapGroup("/api"),
// and SignalR hubs: app.MapHub<ChatHub>("/hubs/chat")
const CS_MAP = /\b(\w+)\s*\.\s*Map(Get|Post|Put|Patch|Delete|Methods)\s*\(\s*(?:pattern\s*:\s*)?@?"([^"]*)"\s*,\s*([\w.]+(?=\s*[,)]))?(?:\s*,\s*([\w.]+(?=\s*[,)])))?/g;
const CS_HUB = /\b(\w+)\s*\.\s*MapHub\s*<\s*(\w+)\s*>\s*\(\s*(?:pattern\s*:\s*)?@?"([^"]*)"/g;
const CS_GROUP = /\b(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(\s*(?:prefix\s*:\s*)?@?"([^"]*)"/g;
// Conventional routing, for controllers without route attributes: app.MapControllerRoute(…, "{controller=Home}/{action=Index}/{id?}")
const CS_CONVENTION = /\bMapControllerRoute\s*\([^;]*?(?:pattern\s*:\s*)?"([^"]*\{controller[^"]*)"|\bMapDefaultControllerRoute\s*\(/g;
const CS_DEFAULT_CONVENTION = '{controller=Home}/{action=Index}/{id?}';
// Who may call an endpoint: [Authorize], [AllowAnonymous], .RequireAuthorization(), .AllowAnonymous()
const CS_AUTHORIZE = /\bAuthorize(?:Attribute)?\b(\s*\([^)]*\))?/;
const CS_ANONYMOUS = /\bAllowAnonymous(?:Attribute)?\b/;
const CS_ATTR_NAMES = /(?:^|,)\s*(\w+)(?=\s*(?:\(|,|$))/g;

/** Consecutive attribute sections merged per declaration, with the declaration they decorate. */
function csAttributeGroups(code) {
  const groups = [];
  for (const m of all(CS_ATTR_SECTION, code)) {
    const prev = groups[groups.length - 1];
    if (prev && !code.slice(prev.end, m.index).trim()) { prev.attrs += ', ' + m[1]; prev.end = m.index + m[0].length; continue; }
    groups.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] });
  }
  for (const g of groups) {
    // comments are blanked to spaces, so a long one between the attributes and the declaration is only whitespace
    const space = /\s*/y;
    space.lastIndex = g.end;
    space.exec(code);
    const head = /^[^{;(=]*/.exec(code.slice(space.lastIndex, space.lastIndex + 400))[0];
    const type = /\b(?:class|interface|record|struct)\s+(\w+)/.exec(head);
    g.decl = type ? { kind: 'type', name: type[1] } : { kind: 'member', name: /(\w+)\s*(?:<[^>]*>)?\s*$/.exec(head)?.[1] || null };
  }
  return groups;
}

/** The access an attribute list grants: a named check, deliberately public, or nothing said. */
export function csAccess(attrs) {
  if (CS_ANONYMOUS.test(attrs)) return { anonymous: true };
  const m = CS_AUTHORIZE.exec(attrs);
  if (m) return { guard: `[Authorize${m[1] ? m[1].replace(/\s+/g, ' ').trim() : ''}]` };
  return {};
}

/** Attribute names, short form: `[Feature("x"), HttpGet]` -> ['Feature', 'HttpGet'] */
export const csAttrNames = (attrs) => all(CS_ATTR_NAMES, attrs).map((m) => m[1].replace(/Attribute$/, ''));

/** Fill in [controller], [action] and [area], and put the action's template under its controller's. */
export function csRoutePath(prefix, template, tokens) {
  const raw = /^~?\//.test(template) ? template.replace(/^~/, '') : [prefix, template].filter(Boolean).join('/');
  // no template at all: conventional routing, which csConventionalActions picks up
  if (!raw) return null;
  const path = raw.replace(/\[(controller|action|area)\]/gi, (m, k) => tokens[k.toLowerCase()] ?? m);
  return '/' + path.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

/** Who may call an action: its own attributes first, then its controller's, then a base controller's. */
function csActionAccess(g, owner) {
  const own = csAccess(g.attrs);
  const inherited = owner ? csAccess(owner.attrs) : {};
  const access = own.anonymous || own.guard ? own : inherited;
  const decos = [...csAttrNames(g.attrs), ...(owner ? csAttrNames(owner.attrs) : []), ...(owner?.bases || [])];
  return { ...access, decos };
}

/** [method, template] for each endpoint an action's attributes declare. */
function csActionPairs(attrs) {
  const verbs = all(CS_VERB, attrs).map((m) => ({ method: m[1].toUpperCase(), template: m[2] }));
  const templates = all(CS_ROUTE, attrs).map((m) => m[1]);
  const pairs = verbs.filter((v) => v.template != null).map((v) => [v.method, v.template]);
  const bare = verbs.filter((v) => v.template == null).map((v) => v.method);
  // [Route] on an action takes the verbs written without a template, or any verb when there are none
  for (const t of templates) for (const method of bare.length ? bare : ['ANY']) pairs.push([method, t]);
  if (!templates.length) for (const method of bare) pairs.push([method, '']);
  return pairs;
}

/**
 * A base controller with no [Route] of its own (abstract, or generic like ControllerBase<T>) only
 * declares actions: each subclass serves them under its own [Route]. resolveRoutes places them there.
 */
const csInheritable = (owner) => owner && !owner.prefixes.some(Boolean) && (/\babstract\b/.test(owner.mods) || owner.generic);

/** The endpoints one controller action declares: each verb's own template, or its [Route]s, under each controller prefix. */
function csActionRoutes(g, owner, line) {
  const pairs = csActionPairs(g.attrs);
  if (!pairs.length) return [];
  const tokens = { controller: owner?.name.replace(/Controller$/, ''), action: g.decl.name?.replace(/Async$/, ''), area: owner?.area };
  const auth = csActionAccess(g, owner);
  const routes = [];
  for (const [method, template] of pairs) for (const prefix of owner?.prefixes || ['']) {
    const path = csRoutePath(prefix, template, tokens);
    if (path) routes.push({ method, path, var: null, line, handler: g.decl.name, framework: 'aspnet', caseInsensitive: true, auth });
  }
  return routes;
}

/** Where a type's body closes, so an action is placed in the class around it and not a record declared above it. */
function csBodyEnd(flat, from) {
  const start = /[{;]/g;
  start.lastIndex = from;
  const m = start.exec(flat);
  if (!m || m[0] === ';') return m ? m.index : flat.length; // `record Refund(Guid Id);` has no body
  let depth = 0;
  for (let i = m.index; i < flat.length; i++) {
    if (flat[i] === '{') depth++;
    else if (flat[i] === '}' && --depth === 0) return i;
  }
  return flat.length;
}

const CS_PUBLIC_METHOD = /(?<=^[ \t]*|\][ \t]*)public\s+(?!static\b|class\b|record\b|interface\b|enum\b|struct\b|const\b|event\b|delegate\b)(?:(?:async|virtual|override|new|sealed)\s+)*[\w<>[\],.?() ]+?\s+(\w+)\s*(?:<[^>]*>)?\s*\(/gm;

/**
 * Public actions of a controller with no route attributes. They are reached only through a
 * MapControllerRoute pattern, which resolveRoutes applies; on their own they are not endpoints.
 */
function csConventionalActions(code, at, t, groups) {
  if (!/Controller$/.test(t.name) || t.prefixes.some(Boolean) || t.kind !== 'class' || /\babstract\b/.test(t.mods)) return [];
  const body = code.slice(t.at, t.end);
  const actions = [];
  for (const m of all(CS_PUBLIC_METHOD, body)) {
    const offset = t.at + m.index;
    if (m[1] === t.name) continue; // a constructor
    const g = groups.find((x) => x.decl.kind === 'member' && x.decl.name === m[1] && x.end <= offset && !code.slice(x.end, offset).trim());
    const attrs = g?.attrs || '';
    if (/\bNonAction\b/.test(attrs) || all(CS_ROUTE, attrs).length || all(CS_VERB, attrs).some((v) => v[2] != null)) continue;
    const verbs = all(CS_VERB, attrs).map((v) => v[1].toUpperCase());
    const auth = csActionAccess(g || { attrs: '' }, t);
    actions.push({ controller: t.name.replace(/Controller$/, ''), action: m[1].replace(/Async$/, ''), area: t.area, methods: verbs.length ? verbs : ['ANY'], line: at(g ? g.start : offset), handler: m[1], auth });
  }
  return actions;
}

/** Attribute-routed controller actions, under the [Route] and [Area] of the class they sit in. */
/** Actions of an inheritable base controller, kept as templates for its subclasses. */
function csBaseActions(g, owner, line) {
  const own = csAccess(g.attrs);
  return csActionPairs(g.attrs).map(([method, template]) => ({
    base: owner.name, method, template, line, handler: g.decl.name, action: g.decl.name?.replace(/Async$/, ''),
    auth: { ...own, decos: csAttrNames(g.attrs) },
  }));
}

function csControllerRoutes(code, at, types, flat) {
  const groups = csAttributeGroups(code);
  for (const g of groups) {
    if (g.decl.kind !== 'type') continue;
    const t = types.find((x) => x.at >= g.end && x.name === g.decl.name);
    if (!t) continue;
    const prefixes = all(CS_ROUTE, g.attrs).map((m) => m[1]);
    if (prefixes.length) t.prefixes = prefixes;
    t.area = /\bArea(?:Attribute)?\s*\(\s*"([^"]*)"/.exec(g.attrs)?.[1] ?? null;
    t.attrs = g.attrs;
  }
  for (const t of types) t.end = csBodyEnd(flat, t.at);
  const owner = (g) => types.findLast((t) => t.at < g.start && g.start < t.end);
  const members = groups.filter((g) => g.decl.kind === 'member').map((g) => ({ g, owner: owner(g) }));
  const routes = members.filter((x) => !csInheritable(x.owner)).flatMap(({ g, owner }) => csActionRoutes(g, owner, at(g.start)));
  const baseActions = members.filter((x) => csInheritable(x.owner)).flatMap(({ g, owner }) => csBaseActions(g, owner, at(g.start)));
  const conventional = types.flatMap((t) => csConventionalActions(code, at, t, groups));
  return { routes, baseActions, conventional };
}

/**
 * The statement a Map… call starts, up to the semicolon that ends it, for the calls chained onto it.
 * A lambda handler has semicolons of its own, so only one outside every bracket counts; `flat` has its
 * strings blanked so a bracket inside one doesn't count.
 */
function csStatement(code, flat, from) {
  let depth = 0;
  const limit = Math.min(flat.length, from + 8000);
  for (let i = from; i < limit; i++) {
    const c = flat[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth <= 0) return code.slice(from, i);
  }
  return code.slice(from, limit);
}

// An extension method that maps endpoints onto whatever it is called on:
// public static RouteGroupBuilder MapOrders(this RouteGroupBuilder group) { group.MapGet(…) }
const CS_MAPPER = /\bstatic\s+[\w<>?.]+\s+(Map\w+)\s*\(\s*this\s+[\w<>?.]+\s+(\w+)/g;
// …and its call sites: api.MapOrders(), app.MapGroup("/api").RequireAuthorization().MapOrders()
const CS_MAPPER_CALL = /\b(\w+)((?:\s*\.\s*MapGroup\s*\(\s*(?:prefix\s*:\s*)?@?"([^"]*)"\s*\))?(?:\s*\.\s*(?:RequireAuthorization|AllowAnonymous|WithTags|WithName|WithOpenApi|WithGroupName|RequireCors|RequireRateLimiting|DisableAntiforgery)\s*\([^()]*\))*)\s*\.\s*(Map\w+)\s*\(\s*\)/g;
// ASP.NET Core's own parameterless Map… calls, which aren't project mappers
const CS_BUILTIN_MAPS = /^Map(Controllers|DefaultControllerRoute|RazorPages|StaticAssets|OpenApi|BlazorHub|FallbackToPage|Group|Hub)$/;

/** The project mappers this file defines (name, parameter, body span), so the routes inside them can be moved under each caller's prefix. */
function csMappers(code, flat) {
  return all(CS_MAPPER, code).map((m) => ({ name: m[1], param: m[2], start: m.index, end: csBodyEnd(flat, m.index + m[0].length) }));
}

/** Where this file calls a project mapper, with the prefix and access of the group it calls it on. */
function csMapperCalls(code, at, routers, groupAccess) {
  return all(CS_MAPPER_CALL, code).filter((m) => !CS_BUILTIN_MAPS.test(m[4])).map((m) => {
    const prefix = [routers[m[1]], m[3]].filter(Boolean).join('/').replace(/\/{2,}/g, '/');
    const own = csChainAccess(m[2]);
    const access = own.guard || own.anonymous ? own : groupAccess[m[1]] || {};
    return { name: m[4], prefix, line: at(m.index), ...(access.guard || access.anonymous ? { access } : {}) };
  });
}

/** Minimal-API endpoints and hubs, with route groups as named prefixes (`routers`, as for Flask blueprints). */
function csMinimalRoutes(code, at, flat) {
  const routers = {};
  const groupAccess = {};
  for (const m of all(CS_GROUP, code)) {
    routers[m[1]] = [routers[m[2]], m[3]].filter(Boolean).join('/').replace(/\/{2,}/g, '/');
    const access = csChainAccess(csStatement(code, flat, m.index));
    groupAccess[m[1]] = access.guard || access.anonymous ? access : groupAccess[m[2]] || {};
  }
  // `api.RequireAuthorization();` on its own line, after the group is made
  for (const m of all(/\b(\w+)\s*\.\s*(RequireAuthorization\s*\([^;]*|AllowAnonymous\s*\(\s*\))\s*;/g, code)) {
    if (routers[m[1]] !== undefined) groupAccess[m[1]] = csChainAccess(m[0]);
  }
  const mappers = csMappers(code, flat);
  const endpoint = (m, method, path, handlerRef, decos = []) => {
    const own = csChainAccess(csStatement(code, flat, m.index));
    const auth = own.guard || own.anonymous ? own : groupAccess[m[1]] || {};
    const mapper = mappers.find((x) => x.param === m[1] && x.start < m.index && m.index < x.end)?.name;
    return {
      method, path, var: m[1], line: at(m.index), ...(handlerRef ? { handler: handlerRef.split('.').pop(), handlerRef } : {}),
      framework: 'aspnet', caseInsensitive: true, auth: { ...auth, decos }, ...(mapper ? { mapper } : {}),
    };
  };
  const routes = [
    // MapMethods(pattern, methods, handler): the handler is the third argument
    ...all(CS_MAP, code).map((m) => (m[2] === 'Methods' ? endpoint(m, 'ANY', m[3], m[5]) : endpoint(m, m[2].toUpperCase(), m[3], m[4]))),
    // a hub's [Authorize] sits on its class, usually in another file
    ...all(CS_HUB, code).map((m) => endpoint(m, 'ANY', m[3], m[2], [m[2]])),
  ];
  return { routes, routers, mapperCalls: csMapperCalls(code, at, routers, groupAccess) };
}

/** `.RequireAuthorization("Admin")` or `.AllowAnonymous()` chained onto a Map… or MapGroup call. */
function csChainAccess(stmt) {
  if (/\.\s*AllowAnonymous\s*\(\s*\)/.test(stmt)) return { anonymous: true };
  const m = /\.\s*RequireAuthorization\s*\(([^)]*)\)/.exec(stmt);
  if (m) return { guard: `.RequireAuthorization(${m[1].replace(/\s+/g, ' ').trim()})` };
  return {};
}

/** Route patterns from MapControllerRoute / MapDefaultControllerRoute, for controllers without route attributes. */
const csConventions = (code) => all(CS_CONVENTION, code).map((m) => m[1] || CS_DEFAULT_CONVENTION);

function extractCSharp(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const namespaces = all(/^\s*namespace\s+([\w.]+)/gm, code).map((m) => ({ name: m[1], line: at(m.index) }));
  const imports = all(/^[ \t]*(global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm, code)
    .map((m) => ({ spec: m[2], names: [], line: at(m.index), ...(m[1] ? { global: true } : {}) }));
  // a file's own namespace and the ones enclosing it are in scope without a using
  for (const ns of namespaces) {
    const parts = ns.name.split('.');
    for (let k = parts.length; k >= 1; k--) imports.push({ spec: parts.slice(0, k).join('.'), names: [], line: ns.line, implicit: true });
  }
  const types = all(CS_TYPE, code).map((m) => ({
    at: m.index, name: m[3], kind: m[2], mods: m[1], nested: /\b(private|protected)\b/.test(m[1]), prefixes: [''], area: null, attrs: '',
    generic: /^\s*</.test(m[4]),
    // `class OrdersController : SecureControllerBase` -> ['SecureControllerBase']
    bases: (/:\s*([^{]*?)(?:\bwhere\b|$)/.exec(m[4].replace(/\([^)]*\)/g, ''))?.[1] || '').split(',').map((b) => b.trim().replace(/<.*$/, '')).filter(Boolean),
  }));
  const symbols = types.filter((t) => !t.nested).map((t) => ({ name: t.name, kind: t.kind, line: at(t.at) }));
  // type names this file mentions, so a `using` links only the files that declare one of them
  const typeRefs = new Set(code.replace(STR_LITERAL, ' ').match(/\b[A-Z]\w*\b/g) || []);
  const flat = code.replace(STR_LITERAL, blank);
  const minimal = csMinimalRoutes(code, at, flat);
  const controllers = csControllerRoutes(code, at, types, flat);
  const routes = [...controllers.routes, ...minimal.routes];
  const { calls, hosts } = extractCalls(code, at, { skip: /^\s*\[|\.Map(Get|Post|Put|Patch|Delete|Methods|Group|Hub)\s*[<(]/ });
  const conventions = csConventions(code);
  return {
    imports, symbols, routes, mounts: [], routers: minimal.routers, calls, hosts, pkg: namespaces[0]?.name || null,
    namespaces: namespaces.map((n) => n.name), typeRefs,
    csTypes: types.map((t) => ({
      name: t.name, line: at(t.at), bases: t.bases, attrs: t.attrs, prefixes: t.prefixes.filter(Boolean), area: t.area,
      ...(/\babstract\b/.test(t.mods) ? { abstract: true } : {}),
    })),
    ...(controllers.conventional.length ? { conventionalActions: controllers.conventional } : {}),
    ...(controllers.baseActions.length ? { baseActions: controllers.baseActions } : {}),
    ...(minimal.mapperCalls.length ? { mapperCalls: minimal.mapperCalls } : {}),
    ...(conventions.length ? { controllerConventions: conventions } : {}),
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
  const { calls, hosts } = ['ruby', 'php', 'swift', 'dart', 'kotlin'].includes(lang) ? extractCalls(code, at) : { calls: [], hosts: [] };
  return { imports, symbols, routes: [], mounts: [], calls, hosts };
}

function extractByLang(src, lang, filePath) {
  switch (lang) {
    case 'typescript': case 'javascript': case 'vue': case 'svelte': case 'astro': return extractJs(src, filePath);
    case 'python': return extractPy(src);
    case 'go': return extractGo(src);
    case 'rust': return extractRust(src);
    case 'java': case 'kotlin': case 'scala': case 'groovy': return extractJvm(src);
    case 'csharp': return extractCSharp(src);
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

// C# XML doc comments: keep the <summary>, and turn <see cref="Orders.Refund"/> into its name
const CS_XML_DOC = /^\s*\/\/\/\s*</m;
function csXmlDoc(text) {
  const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(text)?.[1] ?? text;
  return summary
    .replace(/<(?:see|seealso|paramref|typeparamref)\s+(?:cref|name|langword|href)\s*=\s*"(?:\w:)?([^"]*)"\s*\/>/gi, (m, n) => n.split('.').pop())
    .replace(/<\/?(?:para|c|code|b|i|remarks|returns|value|example|inheritdoc)\b[^>]*>/gi, ' ');
}

export function cleanDoc(text) {
  if (!text) return null;
  if (CS_XML_DOC.test(text)) text = csXmlDoc(text);
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

function commentBefore(lines, idx, lang) {
  // idx: 0-based line of the declaration. Skip decorators/annotations (C# attributes too), then read a /** */ block or // run.
  const annotation = lang === 'csharp' ? /^\s*[@[]/ : /^\s*@/;
  let i = idx - 1;
  while (i >= 0 && annotation.test(lines[i])) i--;
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

function addDocs(src, lang, r) {
  const lines = src.split('\n');
  r.doc = lang === 'python' ? pyDocAfter(lines, -1) : HASH_LANGS.has(lang) ? hashHeader(lines) : headerComment(lines);
  for (const s of r.symbols || []) {
    const d = lang === 'python' ? pyDocAfter(lines, s.line - 1) : commentBefore(lines, s.line - 1, lang);
    if (d) s.doc = d;
  }
  // A route's handler is the first declaration after it (decorator-style frameworks).
  // (a Firebase function's export isn't the handler of the Express routes above it)
  const fbNames = new Set((r.routes || []).filter((rt) => rt.framework === 'firebase').map((rt) => rt.handler));
  const syms = (r.symbols || []).filter((s) => !fbNames.has(s.name)).sort((a, b) => a.line - b.line);
  for (const rt of r.routes || []) {
    if (rt.framework === 'next') { rt.handler = rt.method; continue; }
    // the extractor already named the action; its doc sits above the attributes, where rt.line points
    if (rt.framework === 'aspnet') { const d = commentBefore(lines, rt.line - 1, lang); if (d) rt.doc = d; continue; }
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
