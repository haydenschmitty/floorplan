// Per-language, regex-based extraction of imports, exported symbols, HTTP routes and HTTP calls.
// Deliberately approximate: good enough to draw the map, cheap enough to run on any repo.
import { forwardIndexOf, importStatements, callArgs } from './common.mjs';
import { dataRoutes } from './route-tables.mjs';

import path from 'node:path';

const P = path.posix;

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
    // an unclosed /* runs to the end (looking for */ again from every later /* would take quadratic time)
    if (c === '/' && src[i + 1] === '*') { end = src.indexOf('*/', i + 2); end = end < 0 ? src.length : end + 2; }
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
    const call = [...inline[1].matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)].map((m) => last(m[1])).find((n) => !NOT_A_HANDLER.test(n));
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

// withUrl: a SignalR connection to a hub (new HubConnectionBuilder().withUrl('/hubs/chat'))
const HTTP_CONTEXT = /\b(fetch|axios|ky|got|request|requests|httpx|aiohttp|session|client|http|https|api|Api|API|endpoint|Endpoint|url|Url|URL|BASE|base|withUrl|WithUrl)\b|\.(get|post|put|patch|delete|head)\s*(<[^>]*>)?\s*\(|(?<![.\w$])(get|post|put|patch|delete)\s*\(\s*[rf]?["'`]\/|\b(?:api[A-Z]\w*|(?:http|fetch|request)(?:Get|Post|Put|Patch|Delete|Send|Json|Data|Api)\w*)\s*(?:<[^()]*>)?\s*\(/;
// An app's own API helpers: apiGet('/tasks'), httpPost('/orders', body), apiSend('PATCH', `/tasks/${id}`, body)
const HELPER_VERB = /\b(?:api|http|fetch|request)(Get|Post|Put|Patch|Delete)\w*\s*(?:<[^()]*>)?\s*\(/;
// A helper taking the method first is named in camelCase (apiSend, not requestedBy); the method may be either case
const HELPER_ARG_VERB = /\b(?:api|http|fetch|request)[A-Z]\w*\s*(?:<[^()]*>)?\s*\(\s*["'`](GET|POST|PUT|PATCH|DELETE|get|post|put|patch|delete)["'`]\s*,/;
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
    if (lines[j].length > 500) continue; // as in extractCalls: long lines are minified code or data
    const m = use.exec(lines[j]);
    if (!m) continue;
    const verb = (m[1] && m[1].toLowerCase() !== 'request' ? m[1] : m[2]) || METHOD_OPT.exec(lines.slice(j, j + 4).join(' '))?.[1] || '';
    return { method: verb.toUpperCase() || null };
  }
  return null;
}

/**
 * The method in a call's options when they start on the lines below it, as in fetch(`/api/users/${id}`, {
 * then method: "PATCH" a line or two down. Read only while the call's brackets are still open, for a few lines.
 */
function methodBelow(lines, i) {
  const depthOf = (l, d) => { for (const c of l) d += c === '(' ? 1 : c === ')' ? -1 : 0; return d; };
  let depth = lines[i].length <= 500 ? depthOf(lines[i], 0) : 0;
  for (let j = i + 1; depth > 0 && j < Math.min(lines.length, i + 12); j++) {
    if (lines[j].length > 500) return null;
    const m = METHOD_OPT.exec(lines[j]);
    if (m) return /^(get|post|put|patch|delete|head|options)$/i.test(m[1]) ? m[1] : null;
    depth = depthOf(lines[j], depth);
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
    // a call whose URL wraps onto its own line: `this.http.post<Order>(` with the template on the line below
    const wrapped = i > 0 && /^\s*["'`]/.test(line) && lines[i - 1].length <= 500 ? WRAPPED_CALL.exec(lines[i - 1])?.[1] : null;
    if (!HTTP_CONTEXT.test(line) && !use && !wrapped) continue;
    const method = (METHOD_CALL.exec(line)?.[1] || HELPER_ARG_VERB.exec(line)?.[1] || HELPER_VERB.exec(line)?.[1] || METHOD_OPT.exec(line)?.[1] || use?.method || wrapped || methodBelow(lines, i) || '').toUpperCase() || null;
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

/**
 * `export * from '…'`, `export * as ns from '…'` and `export { … } from '…'` (also `export type`), as
 * { index, what, spec }: what /\bexport\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g
 * matches, with the "}" that ends each list found by reading forward once.
 */
function reexports(code) {
  const out = [];
  const nextClose = forwardIndexOf(code, '}');
  const star = /(\*(?:\s+as\s+\w+)?)\s+from\s+["']([^"'\n]+)["']/y;
  const from = /\s+from\s+["']([^"'\n]+)["']/y;
  let end = 0, memoAt = -1, memo = null;
  for (const h of code.matchAll(/\bexport\s+(?:type\s+)?(?=[*{])/g)) {
    if (h.index < end) continue;
    const p = h.index + h[0].length;
    if (code[p] === '*') {
      star.lastIndex = p;
      const m = star.exec(code);
      if (m) { out.push({ index: h.index, what: m[1], spec: m[2] }); end = star.lastIndex; }
      continue;
    }
    const close = nextClose(p);
    if (close < 0) break;
    // lists that start further back but end at the same "}" share what follows it
    if (close !== memoAt) { memoAt = close; from.lastIndex = close + 1; const m = from.exec(code); memo = m && { spec: m[1], end: from.lastIndex }; }
    if (!memo) continue;
    out.push({ index: h.index, what: code.slice(p, close + 1), spec: memo.spec, end: memo.end });
    end = memo.end;
  }
  return out;
}

/**
 * The name or { … } a require() at `i` is assigned to, as in /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/
 * on the text from `floor` up to it, or null. Read backwards from the require, so its cost is the length of
 * what it reads, however long the list.
 */
function requireBinding(code, i, floor) {
  const space = (k) => k > floor && /\s/.test(code[k - 1]);
  const keywordBefore = (k) => { // `const`, `let` or `var`, then whitespace, end at k
    let v = k;
    while (space(v)) v--;
    return v < k && ((v - 5 >= floor && code.slice(v - 5, v) === 'const') || (v - 3 >= floor && /^(?:let|var)$/.test(code.slice(v - 3, v))));
  };
  let k = i;
  while (space(k)) k--;
  if (k < i && k - 5 >= floor && code.slice(k - 5, k) === 'await') { k -= 5; while (space(k)) k--; }
  if (k <= floor || code[k - 1] !== '=') return null;
  let b = k - 1;
  while (space(b)) b--;
  if (b > floor && code[b - 1] === '}') {
    // the first "{" after the "}" before this one that follows const, let or var
    const opens = [];
    for (let j = b - 2; j >= floor && code[j] !== '}'; j--) if (code[j] === '{') opens.push(j);
    for (let o = opens.length - 1; o >= 0; o--) if (keywordBefore(opens[o])) return code.slice(opens[o], b);
    return null;
  }
  let w = b;
  while (w > floor && /[\w$]/.test(code[w - 1])) w--;
  return w < b && /[A-Za-z_$]/.test(code[w]) && keywordBefore(w) ? code.slice(w, b) : null;
}

// What makes a router or app: express(), express.Router(), Router(), new Hono(), new Koa(), new Router() (koa-router), fastify()
const ROUTER_MAKER = /^(?:express|Router|Hono|OpenAPIHono|Koa|KoaRouter|fastify|Fastify|polka|createRouter)$/;
// Code that runs a server itself: Bun.serve, Deno.serve, createServer, listen(port), `export default { fetch }`
const SERVES = /\b(?:Bun|Deno)\.serve\s*(?:<[^;()]{0,200}?>\s*)?\(|\bcreateServer\s*\(|\.listen\s*\(\s*(?:\d|process\.env|PORT\b|port\b)|^[ \t]*export\s+default\s*\{[^}]{0,300}?\bfetch\b/m;
// Names that read as a router when this file didn't make it (one passed in as a parameter)
const ROUTER_NAME = /^(?:app|server|fastify|hono|routes?|router|[a-z][\w$]*(?:Router|Routes))$/;
/** One argument of app.use(…): { spec } for require('./x'), { name } for a name, { name, call } for a call, {} otherwise. */
function mountArg(arg) {
  const t = arg.trim();
  const req = /^require\(\s*["']([^"'\n]+)["']\s*\)$/.exec(t);
  if (req) return { spec: req[1] };
  const m = /^(?:await\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(\(|<)?/.exec(t);
  if (!m || /^(?:async|function|new|class|await|typeof|void)$/.test(m[1])) return {};
  const name = m[1].replace(/\s+/g, '');
  if (m[2]) return { name, call: true };
  return m[0].length === t.length ? { name } : {};
}

function extractJs(src, filePath) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  // (patterns here start at a line, ; or } and keep their gaps bounded: an unbounded \s* or [^…]* tried from
  // every blank line or every "{" of a large file takes quadratic time. A list of names has no length limit:
  // generated API clients import and re-export thousands of characters of them, so the end of a list is found
  // by reading forward once, never by a pattern tried from every "import" or "{")
  for (const s of importStatements(code, /(?:^|[;\n}])[ \t]*import\b(?=\s)/g)) imports.push({ spec: s.spec, ...parseImportClause(s.clause), line: at(s.index) });
  for (const m of all(/(?:^|[;\n])[ \t]*import\s+["']([^"'\n]+)["']/g, code)) imports.push({ spec: m[1], names: [], line: at(m.index) });
  for (const m of reexports(code)) {
    // `export { a as b } from` → exported { b: 'a' }, the names this file passes on
    const clause = m.what.startsWith('{') ? parseImportClause(m.what) : null;
    imports.push({ spec: m.spec, names: clause ? clause.names : [], ...(clause ? { exported: clause.locals } : {}), line: at(m.index), reexport: true });
  }
  let lineStart = 0, read = 0, prevEnd = 0;
  for (const m of all(/\brequire\(\s*["']([^"'\n]+)["']\s*\)/g, code)) {
    // `const usersRouter = require('./users')` / `const { a, b: c } = require(…)` bind local names
    for (; read < m.index; read++) if (code.charCodeAt(read) === 10) lineStart = read + 1;
    const bind = requireBinding(code, m.index, Math.max(lineStart, prevEnd));
    prevEnd = m.index + m[0].length;
    const locals = {};
    if (bind?.startsWith('{')) for (const part of bind.slice(1, -1).split(',')) { const [orig, alias] = part.trim().split(/\s*:\s*/); if (orig) locals[(alias || orig).trim()] = orig.trim(); }
    else if (bind) locals[bind] = 'default';
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
  // Routers under any variable name (#98, #71): `const frentes = new Hono<Env>()`, `export const profileRoutes =
  // Router()`, `const app: Express = express()`, `new Koa()`. A module's own router can be called anything, so
  // the names below only cover routers this file didn't make (one passed in as a parameter). A variable made
  // by any other call (`const billingRoutes = createBillingRoutes()`) remembers that call, so a mount of it can
  // follow the factory to the file it comes from.
  const routerVars = new Set(), madeBy = new Map();
  for (const m of all(/(?<![\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]{1,200}?)?=\s*(?:await\s+)?(new\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*){0,4})\s*(?:<[^;()]{0,200}?>\s*)?\(/g, code)) {
    const callee = m[3].replace(/\s+/g, '');
    if (ROUTER_MAKER.test(callee.split('.').pop())) routerVars.add(m[1]);
    else if (!m[2] && !madeBy.has(m[1])) madeBy.set(m[1], callee);
  }
  for (const m of all(/(?<![\w$])([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|options|head)\(\s*["'`](\/[^"'`]*)["'`]/g, code)) {
    if (!ROUTER_NAME.test(m[1]) && !routerVars.has(m[1])) continue;
    routes.push({ method: m[2].toUpperCase(), path: m[3], var: m[1], line: at(m.index) });
  }
  // Mounts and middleware: app.use('/api', requireAuth, orders), app.route('/api', api), app.use('/billing',
  // createBillingRoutes()), app.use('/api/*', auth), app.use(requireAuth), app.use(router). Each records the
  // receiver (`on`), so routers nested in one file compose; resolveRoutes tells a router from middleware.
  for (const m of all(/(?<![\w$])([A-Za-z_$][\w$]*)\.(use|route)\(\s*(?:["'`](\/[^"'`]*|\*)["'`]\s*,)?/g, code)) {
    // without a path, only on what reads as a server or router (not i18n.use(plugin) in a website)
    if (m[3] == null && (m[2] !== 'use' || !(ROUTER_NAME.test(m[1]) || routerVars.has(m[1])))) continue;
    if (m[3] === '*' && m[2] !== 'use') continue;
    const args = callArgs(code, m.index + m[0].length);
    if (!args?.length || (m[3] == null && /^\s*["'`]/.test(args[0]))) continue;
    const parts = args.map(mountArg);
    const last = parts[parts.length - 1];
    const mw = parts.slice(0, -1).filter((p) => p.name).map((p) => p.name.split('.').pop());
    // Hono's '/api/*' (and '*') is everything under /api
    const base = { prefix: m[2] === 'use' ? (m[3] || '').replace(/\/?\*$/, '') : m[3], on: m[1], line: at(m.index), ...(mw.length ? { mw } : {}) };
    if (last.spec) mounts.push({ ...base, spec: last.spec });
    else if (last.name) {
      const via = !last.call && madeBy.get(last.name);
      mounts.push({ ...base, var: last.name, ...(last.call ? { call: true } : via ? { via } : {}) });
    } else if (mw.length) mounts.push(base); // an inline handler last: only the middleware before it
  }
  let importedLocals = null; // the names this file imports, built when first needed
  // Fastify plugins: app.register(ticketRoutes, { prefix: '/api/tickets' }), or register(import('./x.js'), …).
  // A plugin registered with no prefix still sits under its parent's, so it's a mount with an empty one.
  // Only an imported plugin counts: one defined in this file would put its prefix on every route here.
  for (const m of all(/\.register\(\s*(?:await\s+)?(?:(?:import|require)\(\s*["']([^"'\n]+)["']\s*\)|([A-Za-z_$][\w$]*))\s*(?:,\s*\{([^{}]*)\}\s*)?\)/g, code)) {
    const opts = m[3] || '';
    const prefix = /\bprefix\s*:\s*["'`](\/[^"'`$]*)["'`]/.exec(opts)?.[1] ?? (/\bprefix\s*:/.test(opts) ? null : '');
    if (prefix == null) continue;
    if (m[1]) mounts.push({ prefix, spec: m[1], line: at(m.index) });
    else if ((importedLocals ??= new Set(imports.flatMap((i) => (i.locals ? Object.keys(i.locals) : [])))).has(m[2])) mounts.push({ prefix, var: m[2], line: at(m.index) });
  }

  // Fastify route({ method, url, handler, schema, ... }): only literal method(s) and URL.
  // Flatten nested option objects so a schema's own keys cannot be mistaken for route options.
  // The receiver is any router this file made (`const api = Fastify()`) or one named like a router.
  const objectRoutes = []; // [first line, last line, url, offset of its {]: the url inside isn't a request
  for (const m of all(/(?<![\w$])([A-Za-z_$][\w$]*)\.route\(\s*\{/g, code)) {
    if (!ROUTER_NAME.test(m[1]) && !routerVars.has(m[1])) continue;
    const start = m.index + m[0].length;
    let depth = 0, quote = '', escaped = false, close = -1, top = '';
    for (let i = start; i < Math.min(code.length, start + 4000); i++) {
      const c = code[i];
      if (quote) {
        if (depth === 0) top += c;
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'" || c === '\x60') { quote = c; if (depth === 0) top += c; continue; }
      if (c === '{') { depth++; top += ' '; continue; }
      if (c === '}') {
        if (depth === 0) { close = i; break; }
        depth--; top += ' '; continue;
      }
      top += depth === 0 ? c : ' ';
    }
    if (close < 0 || !/^\s*\)/.test(code.slice(close + 1))) continue;
    const url = /(?:^|,)\s*(?:url|path)\s*:\s*(["'\x60])(\/[^"'\x60\n$]*)\1/.exec(top)?.[2];
    if (url == null) continue;
    const single = /(?:^|,)\s*method\s*:\s*(["'\x60])([A-Za-z-]+)\1/.exec(top)?.[2];
    const list = /(?:^|,)\s*method\s*:\s*\[([^\]]*)\]/.exec(top)?.[1];
    const methods = single ? [single] : list == null ? [] : [...list.matchAll(/(["'\x60])([A-Za-z-]+)\1/g)].map((x) => x[2]);
    if (list != null && list.replace(/(["'\x60])[A-Za-z-]+\1/g, '').replace(/[\s,]/g, '') !== '') continue;
    // Only top-level lifecycle options count; nested schema keys are blanked above.
    const guardOptions = [...top.matchAll(/(?:^|,)\s*(?:preHandler|onRequest|preValidation)\s*:\s*(\[[^\]]*\]|[^,\n}]+)/g)]
      .map((match) => match[1]);
    for (const method of methods) routes.push({
      method: method.toUpperCase(), path: url, var: m[1], line: at(m.index),
      ...(guardOptions.length ? { guardOptions } : {}),
    });
    if (methods.length) objectRoutes.push([at(m.index), at(close), url, start - 1]);
  }

  // Next.js app/pages API routes, derived from the file path
  // (the file is exactly route.ts: Angular's `orders.route.ts` and `app.routes.ts` are screen routing, not endpoints)
  const next = /(?:^|\/)(?:src\/)?app\/(?:(.*?)\/)?route\.(?:t|j)sx?$/.exec(filePath) || /(?:^|\/)(?:src\/)?pages\/(api\/.*?)(?:\/index)?\.(?:t|j)sx?$/.exec(filePath);
  if (next) {
    const p = '/' + (next[1] || '').split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/');
    const methods = all(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g, code).map((m) => m[1]);
    for (const method of methods.length ? methods : ['ANY']) routes.push({ method, path: p, var: null, line: 1, framework: 'next' });
  }
  // Endpoints listed as data: `[{ method: 'GET', path: /^\/api\/items$/, handle: listItems }]` and Bun.serve({ routes })
  // (route-tables.mjs). A route object Fastify's reading above already took isn't counted again.
  const dataAt = routes.length;
  routes.push(...dataRoutes(code, at, { handlerOf: tableHandler, serves: dataAt > 0 || routerVars.size > 0 || SERVES.test(code), skip: objectRoutes.map((o) => o[3]) }));
  for (const r of routes.slice(dataAt)) objectRoutes.push([r.line, r.line, r.path]);

  routes.push(...keyedRouteTable(code, at));
  if (/@nestjs\/common/.test(code) && /@Controller\s*\(/.test(code)) routes.push(...nestRoutes(code, at));

  const triggers = /firebase-functions/.test(code) ? firebaseFunctions(code, at, routes, mounts) : [];

  // a mount's prefix (including Fastify's `prefix: '/api'` option, often on a line of its own) isn't a request
  const serverLine = /\b\w+\.(use|route)\(\s*["'`]\/|\b(?:app|server|fastify|hono|routes?|router|[a-z][\w$]*(?:Router|Routes))\.(?:get|post|put|patch|delete|all|options|head)\(\s*["'`]\/|\bprefix\s*:\s*["'`]\//;
  // nor is a route on a router this file made, whatever it's called (frentes.get('/lista', …))
  const routeOnVar = routerVars.size && routes.some((r) => r.var && !ROUTER_NAME.test(r.var))
    ? new RegExp(`(?<![\\w$])(?:${[...routerVars].slice(0, 200).map((v) => v.replace(/\$/g, '\\$')).join('|')})\\.(?:get|post|put|patch|delete|all|options|head)\\(\\s*["'\`]\\/`)
    : null;
  const { calls, hosts } = extractCalls(code, at, { skip: routeOnVar ? { test: (line) => serverLine.test(line) || routeOnVar.test(line) } : serverLine });
  // a route object's own `url: '/api/x'` reads like a request (because of `url`), and so can a route listed as
  // data (`"/api/carts": {` in Bun.serve, `fetch: …` beside its path), but each is the route
  if (objectRoutes.length) for (let i = calls.length - 1; i >= 0; i--) {
    if (objectRoutes.some(([a, b, url]) => calls[i].line >= a && calls[i].line <= b && calls[i].path === url)) calls.splice(i, 1);
  }
  const seenCall = new Set(calls.map((c) => `${c.line}|${c.path}`));
  for (const c of wrapperCalls(code, at)) if (!seenCall.has(`${c.line}|${c.path}`)) calls.push(c);
  const built = urlBuilderCalls(code, at);
  if (built.calls.length || built.bodies.size) {
    // a line with a built URL may also hold a partial guess from its literal argument (`/ship`): the full path
    // replaces it. And a URL-building method's own template is not a request.
    const builtLines = new Set(built.calls.map((c) => c.line));
    const kept = calls.filter((c) => !builtLines.has(c.line) && !built.bodies.has(c.line));
    calls.length = 0;
    for (const c of [...kept, ...built.calls]) calls.push(c);
  }
  const callables = /\bhttpsCallable\b/.test(code) ? callableCalls(code, at) : { calls: [], wrappers: [] };
  calls.push(...callables.calls);
  if (/\.functions\s*\.\s*invoke\b/.test(code)) calls.push(...edgeInvokeCalls(code, at));
  return { imports, symbols, routes, mounts, calls, hosts, ...(routerVars.size ? { routerVars: [...routerVars] } : {}), ...(triggers.length ? { triggers } : {}), ...(callables.wrappers.length ? { callableWrappers: callables.wrappers } : {}) };
}

// ---------- Supabase Edge Functions ----------

const EDGE_INVOKE = /\.functions\s*\.\s*invoke\s*(?:<[^()]{0,200}>)?\s*\(\s*(["'`])([A-Za-z0-9][\w-]*(?:\/[\w-]+)*)\1/g;
/**
 * supabase.functions.invoke('send-invite', { body }) is a request to /functions/v1/send-invite: a POST unless its
 * options (read up to the call's closing bracket, a few hundred characters at most) give another method.
 */
function edgeInvokeCalls(code, at) {
  const out = [];
  for (const m of code.matchAll(EDGE_INVOKE)) {
    const rest = code.slice(m.index + m[0].length, m.index + m[0].length + 600);
    let depth = 1, end = 0;
    for (; end < rest.length && depth; end++) depth += rest[end] === '(' ? 1 : rest[end] === ')' ? -1 : 0;
    const method = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(rest.slice(0, end))?.[1]?.toUpperCase() || 'POST';
    out.push({ path: '/functions/v1/' + m[2], method, line: at(m.index) });
  }
  return out;
}

// ---------- Firebase Cloud Functions ----------

// `export const approveItem = onCall(…)`, `exports.sign = functions.region('eu').https.onRequest(…)`,
// `export const nightly = onSchedule('every day 03:00', …)`: the exported name, the chain before the
// trigger (v1 style `functions.firestore.document('x')`), and the trigger itself
const FIREBASE_FN = /(?:\bexport\s+(?:const|let|var)\s+|(?:^|[;\n])[ \t]*(?:const|let|var)\s+|\b(?:module\.)?exports\.)([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,300})?=\s*((?:[A-Za-z_$][\w$]*(?:\([^()]*\))?\s*\.\s*)*)((?:on|before)[A-Z]\w*)\s*(?:<[^;]{0,300}?>)?\s*\(/g;
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
const DEFS = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]{0,300}>)?\s*\(([^)]{0,1000})\)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]{0,300}>\s*)?\(([^)]{0,1000})\)\s*(?::\s*[^=]{1,300}?)?=>/g;
// helpers that wrap fetch or httpsCallable: past this many in one file, the rest are left out (each is
// followed through the whole file)
const MAX_WRAPPERS = 40;
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
    calls.push(...callsVia(code, name, at(m.index), at));
    if (wrappers.length >= MAX_WRAPPERS) break;
  }
  return { calls, wrappers };
}

/** Uses of a callable helper: `callFunction('approveItem', data)` → CALL /approveItem. */
function callsVia(code, name, skipLine = 0, at = lineIndex(code)) {
  const out = [];
  const re = new RegExp(`(?<![\\w$.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:<[^;]{0,300}?>)?\\s*\\(\\s*(["'\`])([\\w-]+)\\1`, 'g');
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
  let flat = null, found = 0; // the file's lines, flattened once for every helper
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
    if (++found > MAX_WRAPPERS) break;
    flat ??= code.split('\n').map((raw) => (raw.length > 2000 ? '' : flattenTemplates(raw)));
    if (!code.includes(name)) continue;
    flat.forEach((line, i) => {
      if (i + 1 === defLine || !line.includes(name)) return; // the definition itself, or no call on this line
      for (const c of line.matchAll(callRe)) {
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

// ---------- URL-building methods (Angular services and the like) ----------

// A service class often builds its URLs in a method and passes the result to the HTTP call:
//   private url(id: string, suffix = ''): string { return `${this.base}/orders/${encodeURIComponent(id)}${suffix}`; }
//   ship(id: string) { return this.http.post(this.url(id, '/ship'), {}); }
// is POST /orders/${x}/ship. A method that returns another builder's call counts too:
//   private itemUrl(id: string, itemId: string, suffix = ''): string { return this.url(id, `/items/${itemId}${suffix}`); }
// Parameters and templates are read on one line, up to a length, so a file full of unclosed `f(` costs one pass.
const URL_BUILDER = /^[ \t]*(?:(?:private|protected|public|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\(([^)\n]{0,300})\)\s*(?::\s*string\s*)?\{\s*return\s+`([^`\n]{0,500})`\s*;?\s*\}/gm;
const URL_BUILDER_CHAIN = /^[ \t]*(?:(?:private|protected|public|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\(([^)\n]{0,300})\)\s*(?::\s*string\s*)?\{\s*return\s+this\.([A-Za-z_$][\w$]*)\s*\(/gm;
// `.post<Order>(` at the end of a line: the call's arguments start on the next one
const WRAPPED_CALL = /\.(get|post|put|patch|delete)\s*(?:<[^\n]{0,200}>)?\s*\(\s*$/i;
const paramNames = (s) => s.split(',').map((p) => /^[A-Za-z_$][\w$]*/.exec(p.trim())?.[0]).filter(Boolean);
const usesParam = (expr, p) => new RegExp(`(?<![\\w$.])${p.replace(/\$/g, '\\$')}(?![\\w$])`).test(expr);

/** Top-level arguments of the call whose `(` is at code[open], trimmed, or null when it doesn't close nearby; `end` is its `)`. */
const argsAt = (code, open) => { const a = callArgs(code, open + 1, 800); return a && Object.assign(a.map((x) => x.trim()), { end: a.end }); };

/** A builder's template with the arguments put in: a literal goes in as text, anything else as `other` says. */
function fillTemplate(tpl, pnames, args, other) {
  return tpl.replace(/\$\{([^}]*)\}/g, (all, expr) => {
    const i = pnames.findIndex((p) => usesParam(expr, p));
    if (i < 0) return '${x}';
    const a = args[i];
    if (a == null) return ''; // left to its default, usually ''
    const lit = /^(["'`])([\s\S]*)\1$/.exec(a);
    return lit ? lit[2] : other(a);
  });
}

function urlBuilderCalls(code, at) {
  const builders = new Map(); // name -> { pnames, tpl }
  const bodies = new Set(); // lines of the builders themselves
  const mark = (from, to) => { for (let l = at(from); l <= at(to); l++) bodies.add(l); };
  for (const m of code.matchAll(URL_BUILDER)) {
    if (/^(get|post|put|patch|delete|request|fetch|constructor)$/i.test(m[1])) continue;
    const pnames = paramNames(m[2]);
    if (pnames.length && /\/[A-Za-z]/.test(m[3])) { builders.set(m[1], { pnames, tpl: m[3] }); mark(m.index, m.index + m[0].length - 1); }
  }
  // a delegating builder, written in its own parameters (one passed straight through stays `${p}`)
  if (builders.size) for (const m of code.matchAll(URL_BUILDER_CHAIN)) {
    const inner = builders.get(m[3]);
    if (!inner || builders.has(m[1])) continue;
    const args = argsAt(code, m.index + m[0].length - 1);
    if (!args) continue;
    builders.set(m[1], { pnames: paramNames(m[2]), tpl: fillTemplate(inner.tpl, inner.pnames, args, (a) => '${' + a + '}') });
    // its body runs to the end of the call it returns, which may wrap onto the lines below
    mark(m.index, args.end);
  }
  const out = [];
  if (!builders.size) return { calls: out, bodies };
  // one pass over the file's this.name( calls, however many builders there are
  for (const c of code.matchAll(/(?<![\w$])this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const b = builders.get(c[1]);
    if (!b) continue;
    const line = at(c.index);
    if (bodies.has(line)) continue; // a delegating builder's own body
    const args = argsAt(code, c.index + c[0].length - 1);
    if (!args) continue;
    const n = normalizeCallLiteral(flattenTemplates('`' + fillTemplate(b.tpl, b.pnames, args, () => '${x}') + '`').slice(1, -1));
    if (!n?.path || n.host) continue;
    // only a URL handed to an HTTP call counts (not one used for a link or a download address); the
    // call is on the same line, or on the line before when the arguments wrap. Only the last few hundred
    // characters before the builder are read, so a long line costs no more than a short one.
    const before = code.slice(Math.max(0, c.index - 600), c.index).split('\n');
    const head = before[before.length - 1], prev = before.length > 1 ? before[before.length - 2] : '';
    const verb = WRAPPED_CALL.exec(head)?.[1] || (!head.trim() ? WRAPPED_CALL.exec(prev)?.[1] : null);
    if (!verb) continue;
    out.push({ path: n.path, method: verb.toUpperCase(), line });
  }
  return { calls: out, bodies };
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
  // `from x import (a, b, …)` may list any number of names over many lines; the ")" is found by reading forward
  // once (as /^[ \t]*from[ \t]+([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm would match). The module is
  // ([\w.]*), the same text as (\.*[\w.]*), which tried every way of splitting a long run of dots between its parts.
  const nextParen = forwardIndexOf(code, ')');
  let fromEnd = 0;
  for (const h of all(/^[ \t]*from[ \t]+([\w.]*)[ \t]+import\b([ \t]+)/gm, code)) {
    if (h.index < fromEnd) continue;
    const p = h.index + h[0].length;
    const close = code[p] === '(' ? nextParen(p) : -1;
    let what;
    if (close >= 0) { what = code.slice(p, close + 1); fromEnd = close + 1; }
    else if (p < code.length && code[p] !== '\n') { const e = code.indexOf('\n', p); what = code.slice(p, e < 0 ? code.length : e); }
    else if (h[2].length > 1) what = h[2].slice(-1); // nothing after `import ` but spaces
    else continue;
    const m = Object.assign([h[0], h[1], what], { index: h.index });
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
  for (const m of all(/^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:\w+\.)?(Blueprint|APIRouter|Router)\(([^)]{0,2000})\)/gm, code)) {
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

  const routeLine = /^[ \t]*@\w+\.(route|get|post|put|patch|delete)\(/;
  const { calls, hosts } = extractCalls(code, at, { skip: routeLine });
  return { imports, symbols, routes, mounts, calls, hosts, routers };
}

// ---------- NestJS ----------

/**
 * NestJS controllers: `@Controller('api/crm')` (or `@Controller({ path: 'api/crm' })`) gives a prefix,
 * `@Get('wallet/:id')`, `@Post()`… on its methods give the endpoints. Nest paths have no leading slash
 * and join with one. Each method belongs to the nearest @Controller above it. A global prefix set at
 * run time (`app.setGlobalPrefix`) isn't seen. Only files importing '@nestjs/common' are read, so other
 * decorator libraries with a @Get aren't mistaken for routes.
 */
function nestRoutes(code, at) {
  const ctrls = all(/@Controller\s*\(\s*(?:["'`]([^"'`$]*)["'`]|\{[^{}]{0,300}?\bpath\s*:\s*["'`]([^"'`$]*)["'`][^{}]{0,300}\})?\s*\)/g, code)
    .map((m) => ({ index: m.index, prefix: m[1] ?? m[2] ?? '' }));
  if (!ctrls.length) return [];
  const clean = (s) => s.replace(/^\/+|\/+$/g, '');
  const out = [];
  for (const m of all(/@(Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(\s*(?:["'`]([^"'`$]*)["'`]\s*)?\)/g, code)) {
    let ctrl = null;
    for (const c of ctrls) if (c.index < m.index) ctrl = c;
    if (!ctrl) continue;
    const p = '/' + [clean(ctrl.prefix), clean(m[2] || '')].filter(Boolean).join('/');
    // the handler: the first `name(` that starts a line after this decorator (other decorators start with @)
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 2000);
    const handler = /^[ \t]*(?:(?:public|private|protected|static|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\(/m.exec(after)?.[1] || null;
    out.push({ method: m[1] === 'All' ? 'ANY' : m[1].toUpperCase(), path: p, var: null, line: at(m.index), framework: 'nest', ...(handler ? { handler } : {}) });
  }
  return out;
}

// ---------- Go ----------

function extractGo(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm, code)) imports.push({ spec: m[1], names: [], line: at(m.index) });
  // import ( … ) blocks of any length, each ")" found by reading forward once
  const nextParen = forwardIndexOf(code, ')');
  let blockEnd = 0;
  for (const block of all(/^import\s*\(/gm, code)) {
    if (block.index < blockEnd) continue;
    const close = nextParen(block.index + block[0].length);
    if (close < 0) break;
    blockEnd = close + 1;
    for (const m of all(/(?:(?<![\w.])[\w.]+\s+)?"([^"]+)"/g, code.slice(block.index + block[0].length, close))) imports.push({ spec: m[1], names: [], line: at(block.index) });
  }
  const symbols = [];
  for (const m of all(/^func\s+(?:\([^)\n]{0,300}\)\s*)?([A-Z]\w*)/gm, code)) symbols.push({ name: m[1], kind: 'function', line: at(m.index) });
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

// ---------- Swift ----------

// Swift imports name a module, not a file: `import Core`, `@testable import Core`,
// `import struct Core.Settings`. The resolver maps the module to its Swift package target.
const SWIFT_ATTRS = String.raw`(?:@\w+(?:\([^)\n]{0,300}\))?[ \t]+){0,10}`;
const SWIFT_MODS = String.raw`(?:(?:public|open|internal|package|fileprivate|private|final|indirect|nonisolated|static|(?:private|fileprivate|internal|public)\(set\))[ \t]+){0,10}`;
const SWIFT_IMPORT = new RegExp(String.raw`^[ \t]*${SWIFT_ATTRS}import[ \t]+(?:(?:typealias|struct|class|enum|protocol|let|var|func|actor)[ \t]+)?([A-Za-z_]\w*)`, 'gm');
const SWIFT_TYPE = new RegExp(String.raw`^[ \t]*${SWIFT_ATTRS}${SWIFT_MODS}(class|struct|enum|protocol|actor)[ \t]+([A-Za-z_]\w*)`, 'gm');
// Top-level declarations other files of the module (and of the modules importing it) can use: written
// at the start of a line, so a type's members and nested types (Kind, State, Row…) aren't among them
const SWIFT_TOP = new RegExp(String.raw`^${SWIFT_ATTRS}(${SWIFT_MODS})(class|struct|enum|protocol|actor|typealias|func|let|var)[ \t]+([A-Za-z_]\w*)`, 'gm');

function extractSwift(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = all(SWIFT_IMPORT, code).map((m) => ({ spec: m[1], names: [], line: at(m.index) }));
  // Files of one module use each other's code without importing it, as if each imported its own module
  imports.push({ spec: '.', names: [], line: 1, implicit: true });
  const symbols = [];
  for (const m of all(SWIFT_TYPE, code)) {
    if (m[1] === 'class' && /^(func|var|let)$/.test(m[2])) continue; // `class func`, `class var`
    symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  }
  const decls = [];
  for (const m of all(SWIFT_TOP, code)) {
    if (/\b(?:private|fileprivate)[ \t]/.test(m[1])) continue; // can't be seen from other files
    if (!decls.includes(m[3])) decls.push(m[3]);
  }
  const { calls, hosts } = extractCalls(code, at);
  return { imports, symbols, routes: [], mounts: [], calls, hosts, decls, mentions: swiftMentions(code) };
}

/** Every name the file's code mentions outside strings and import lines, as one space-separated string, minus the names it declares itself. */
function swiftMentions(code) {
  const text = stripJvmStrings(code).replace(/^[ \t]*(?:@\w+[ \t]+)*import[ \t][^\n]*/gm, '');
  const own = new Set();
  for (const m of text.matchAll(/\b(?:class|struct|enum|protocol|actor|typealias|associatedtype|func|let|var|case)[ \t]+`?([A-Za-z_]\w*)/g)) own.add(m[1]);
  const seen = new Set();
  for (const m of text.matchAll(/[A-Za-z_]\w{0,99}/g)) {
    if (seen.size >= 20000) break;
    if (!own.has(m[0])) seen.add(m[0]);
  }
  return [...seen].join(' ');
}

// ---------- Rust ----------

function extractRust(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/^[ \t]*(?:pub(?:\([^)\n]{0,60}\))?\s+)?mod\s+(\w+)\s*;/gm, code)) imports.push({ spec: m[1], kind: 'mod', names: [], line: at(m.index) });
  for (const m of all(/^[ \t]*(?:pub(?:\([^)\n]{0,60}\))?\s+)?use\s+([\w:]+)/gm, code)) imports.push({ spec: m[1], kind: 'use', names: [], line: at(m.index) });
  const symbols = [];
  for (const m of all(/^[ \t]*pub\s+(?:async\s+)?(fn|struct|enum|trait|type|const|static)\s+(\w+)/gm, code)) symbols.push({ name: m[2], kind: m[1] === 'fn' ? 'function' : m[1], line: at(m.index) });
  const routes = [];
  for (const m of all(/#\[(get|post|put|patch|delete)\(\s*"([^"]+)"/g, code)) routes.push({ method: m[1].toUpperCase(), path: m[2], var: null, line: at(m.index) });
  for (const m of all(/\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)/g, code)) routes.push({ method: m[2].toUpperCase(), path: m[1], var: null, line: at(m.index) });
  const { calls, hosts } = extractCalls(code, at);
  return { imports, symbols, routes, mounts: [], calls, hosts };
}

// ---------- JVM ----------

// A declaration at the start of a line: the file's top level, where other files can see it. Kotlin files
// often hold several classes, functions and values, and Java files package-private classes beside the
// public one, none of them named after the file.
const JVM_TOP = /^(?:@[\w.]+(?:\([^)\n]{0,300}\))?[ \t]+){0,10}((?:(?:public|internal|protected|private|abstract|final|open|sealed|data|enum|annotation|value|inline|inner|const|lateinit|suspend|tailrec|operator|infix|external|expect|actual|static|strictfp|non-sealed|case|implicit)[ \t]+){0,10})(fun[ \t]+interface|@interface|class|interface|object|trait|record|enum|typealias|fun|val|var)[ \t]+([^\n]{1,400})/gm;
const ANGLES = /<[^<>\n]{0,200}>/g;

/** The name a top-level declaration gives other files: `Foo` in `class Foo<T>`, `goes` in `fun <T> List<T>.goes(`. */
function jvmTopName(kind, rest) {
  let head = rest;
  if (kind === 'fun') head = rest.split('(')[0];
  else if (kind === 'val' || kind === 'var') head = rest.split(/[:=]|[ \t]by[ \t]/)[0];
  else return /^`?(\w+)/.exec(rest)?.[1] || null;
  for (let i = 0; i < 4 && head.includes('<'); i++) head = head.replace(ANGLES, '');
  const name = head.trim().split(/[ \t]/)[0].split('.').pop().replace(/`/g, '');
  return /^[A-Za-z_]\w*$/.test(name) ? name : null;
}

// Blank string and character literals (Kotlin raw strings included), so names quoted in them aren't uses.
// One pass: an unclosed quote ends at its line's end, an unclosed """ at the file's.
const stripJvmStrings = (code) => {
  let out = '';
  let from = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c !== '"' && c !== "'") continue;
    let j;
    if (c === '"' && code.startsWith('"""', i)) { j = code.indexOf('"""', i + 3); j = j < 0 ? code.length : j + 3; }
    else {
      j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, code.length);
    }
    out += code.slice(from, i) + blank(code.slice(i, j));
    from = i = j;
    i--;
  }
  return out + code.slice(from);
};

/** Every name the file's code mentions (not its package and import lines), as one space-separated string, minus the names it declares itself. */
function jvmMentions(code) {
  const text = stripJvmStrings(code).replace(/^[ \t]*(?:package|import)[ \t][^\n]*/gm, '');
  const own = new Set();
  for (const m of text.matchAll(/\b(?:val|var|fun|class|interface|object|enum|record|typealias)[ \t]+`?(\w+)/g)) own.add(m[1]);
  const seen = new Set();
  for (const m of text.matchAll(/[A-Za-z_]\w{0,99}/g)) {
    if (seen.size >= 20000) break;
    if (!own.has(m[0])) seen.add(m[0]);
  }
  return [...seen].join(' ');
}

function extractJvm(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const pkgMatch = /^[ \t]*package\s+([\w.]+)/m.exec(code);
  const pkg = pkgMatch?.[1] || null;
  const imports = all(/^[ \t]*import\s+(?:static\s+)?([\w.*]+)/gm, code).map((m) => ({ spec: m[1], names: [], line: at(m.index) }));
  // Kotlin and Java see the rest of their own package without an import, as if it were `import <pkg>.*`
  if (pkg) imports.push({ spec: `${pkg}.*`, names: [], line: at(pkgMatch.index), implicit: true });
  const symbols = [];
  for (const m of all(/^[ \t]*(?:public\s+|internal\s+)?(?:abstract\s+|final\s+|data\s+|sealed\s+|open\s+)*(class|interface|enum|record|object)\s+(\w+)/gm, code)) symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  // Top-level names other files can use (private ones are the file's own), and the names this file uses
  const decls = [];
  if (pkg) {
    for (const m of all(JVM_TOP, code)) {
      if (/\bprivate\b/.test(m[1])) continue;
      const kind = m[2].startsWith('fun') && m[2] !== 'fun' ? 'interface' : m[2].replace('@', '');
      const name = jvmTopName(kind, m[3]);
      if (name && !decls.includes(name)) decls.push(name);
    }
  }
  const routes = [];
  const classPrefix = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]{0,500}\)\s*(?:@\w+(?:\([^)]{0,500}\))?\s*){0,20}(?:public\s+)?class/.exec(code)?.[1] || '';
  for (const m of all(/@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/g, code)) {
    if (m[1] === 'Request' && m[2] === classPrefix) continue;
    routes.push({ method: m[1] === 'Request' ? 'ANY' : m[1].toUpperCase(), path: classPrefix + m[2], var: null, line: at(m.index) });
  }
  const { calls, hosts } = extractCalls(code, at, { skip: /@\w+Mapping/ });
  return { imports, symbols, routes, mounts: [], calls, hosts, pkg, ...(pkg ? { decls, mentions: jvmMentions(code) } : {}) };
}

// ---------- C# / ASP.NET Core ----------
// Code you didn't write can be built to make pattern matching slow, so nothing here scans from every
// match to the end of the file: brackets are matched once per file (csIndex), patterns stop at a line's
// end or a few hundred characters, and work that could repeat over the same text has a budget.

const CS_VERB = /\bHttp(Get|Post|Put|Patch|Delete|Head|Options)(?:Attribute)?\b(?:\s*\(\s*(?:template\s*:\s*)?"([^"\n]{0,500})")?/g;
const CS_ROUTE = /\bRoute(?:Attribute)?\s*\(\s*(?:template\s*:\s*)?"([^"\n]{0,500})"/g;
// A type declaration at the start of a line or right after an attribute section: its modifiers, kind, name and header
const CS_TYPE = /(^|\])([ \t]*)((?:(?:public|internal|private|protected|static|abstract|sealed|partial|readonly|ref|file|unsafe|new)\s+)*)(class|interface|enum|record|struct)\s+(\w+)([^{;]{0,500})/gm;
// Minimal APIs: app.MapGet("/orders/{id}", GetOrder), route groups: var api = app.MapGroup("/api"),
// and SignalR hubs: app.MapHub<ChatHub>("/hubs/chat")
const CS_MAP = /\b(\w+)\s*\.\s*Map(Get|Post|Put|Patch|Delete|Methods)\s*\(\s*(?:pattern\s*:\s*)?@?"([^"\n]{0,500})"\s*,\s*([\w.]+(?=\s*[,)]))?(?:\s*,\s*([\w.]+(?=\s*[,)])))?/g;
const CS_HUB = /\b(\w+)\s*\.\s*MapHub\s*<\s*(\w+)\s*>\s*\(\s*(?:pattern\s*:\s*)?@?"([^"\n]{0,500})"/g;
const CS_GROUP = /\b(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(\s*(?:prefix\s*:\s*)?@?"([^"\n]{0,500})"/g;
// Conventional routing, for controllers without route attributes: app.MapControllerRoute(…, "{controller=Home}/{action=Index}/{id?}")
const CS_CONVENTION = /\bMapControllerRoute\s*\(|\bMapDefaultControllerRoute\s*\(/g;
const CS_DEFAULT_CONVENTION = '{controller=Home}/{action=Index}/{id?}';
// Who may call an endpoint: [Authorize], [AllowAnonymous], .RequireAuthorization(), .AllowAnonymous()
const CS_AUTHORIZE = /\bAuthorize(?:Attribute)?\b(\s*\([^)]{0,300}\))?/;
const CS_ANONYMOUS = /\bAllowAnonymous(?:Attribute)?\b/;
const CS_ATTR_NAMES = /(?:^|,)\s*(\w+)(?=\s*(?:\(|,|$))/g;

/**
 * One pass over a file's code with strings and comments blanked (`flat`): where each { closes, and the
 * next {, ; and ] after each place. Everything that follows brackets uses these, so a file of unclosed
 * brackets is read once rather than once per bracket.
 */
function csIndex(flat) {
  const n = flat.length;
  const close = new Int32Array(n).fill(-1);
  const nextOpen = new Int32Array(n + 1).fill(-1); // next { or ;
  const nextBracket = new Int32Array(n + 1).fill(-1); // next ]
  const stack = [];
  for (let i = 0; i < n; i++) {
    const c = flat.charCodeAt(i);
    if (c === 123) stack.push(i);
    else if (c === 125 && stack.length) close[stack.pop()] = i;
  }
  for (let i = n - 1; i >= 0; i--) {
    const c = flat.charCodeAt(i);
    nextOpen[i] = c === 123 || c === 59 ? i : nextOpen[i + 1];
    nextBracket[i] = c === 93 ? i : nextBracket[i + 1];
  }
  return { flat, close, nextOpen, nextBracket };
}

/** Where a type's or method's body closes: its matching }, the ; of one without a body, or the end of the file. */
function csBodyEnd(idx, from) {
  const j = from < idx.flat.length ? idx.nextOpen[from] : -1;
  if (j < 0) return idx.flat.length;
  if (idx.flat[j] === ';') return j; // `record Refund(Guid Id);` has no body
  return idx.close[j] >= 0 ? idx.close[j] : idx.flat.length;
}

/** The name a declaration head ends with, past a generic list: `Task<IActionResult> GetAsync<T>` -> GetAsync. */
export function csLastName(head) {
  let end = head.length;
  while (end > 0 && /\s/.test(head[end - 1])) end--;
  if (head[end - 1] === '>') {
    let depth = 0;
    let k = end - 1;
    for (; k >= 0; k--) { if (head[k] === '>') depth++; else if (head[k] === '<' && --depth === 0) break; }
    if (k < 0) return null;
    end = k;
    while (end > 0 && /\s/.test(head[end - 1])) end--;
  }
  let start = end;
  while (start > 0 && /\w/.test(head[start - 1])) start--;
  return start < end ? { name: head.slice(start, end), before: head.slice(0, start) } : null;
}

/** Is the [ at i an attribute section: at the start of a line, or right after another one? */
function csAttrStart(flat, i) {
  let k = i - 1;
  while (k >= 0 && (flat[k] === ' ' || flat[k] === '\t')) k--;
  return k < 0 || flat[k] === '\n' || flat[k] === ']';
}

/**
 * Consecutive attribute sections merged per declaration, with the declaration they decorate:
 * `[Route("api/[controller]")]`, `[HttpGet("{id}"), Authorize]`, possibly over several lines. Brackets
 * inside strings don't count, because `flat` has its strings blanked.
 */
function csAttributeGroups(code, idx) {
  const { flat, nextBracket } = idx;
  const groups = [];
  for (let i = flat.indexOf('['); i >= 0; i = flat.indexOf('[', i + 1)) {
    if (!csAttrStart(flat, i)) continue;
    const end = nextBracket[i + 1];
    if (end < 0) break; // no ] anywhere after it, so none after any later [ either
    const attrs = code.slice(i + 1, end);
    const prev = groups[groups.length - 1];
    if (prev && !code.slice(prev.end, i).trim()) { prev.attrs += ', ' + attrs; prev.end = end + 1; }
    else groups.push({ start: i, end: end + 1, attrs });
    i = end;
  }
  for (const g of groups) {
    // comments are blanked to spaces, so a long one between the attributes and the declaration is only whitespace
    const space = /\s*/y;
    space.lastIndex = g.end;
    space.exec(code);
    g.declAt = space.lastIndex;
    const head = /^[^{;(=]*/.exec(code.slice(g.declAt, g.declAt + 400))[0];
    const type = /\b(?:class|interface|record|struct)\s+(\w+)/.exec(head);
    g.decl = type ? { kind: 'type', name: type[1] } : { kind: 'member', name: csLastName(head)?.name || null };
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

/** Attribute names, short form: `[Feature("x"), HttpGet]` -> ['Feature', 'HttpGet'] (the first 50; real lists are short) */
export const csAttrNames = (attrs) => all(CS_ATTR_NAMES, attrs).slice(0, 50).map((m) => m[1].replace(/Attribute$/, ''));

/** Fill in [controller], [action] and [area], and put the action's template under its controller's. */
export function csRoutePath(prefix, template, tokens) {
  const raw = /^~?\//.test(template) ? template.replace(/^~/, '') : [prefix, template].filter(Boolean).join('/');
  // no template at all: conventional routing, which csConventionalActions picks up
  if (!raw) return null;
  const path = raw.replace(/\[(controller|action|area)\]/gi, (m, k) => tokens[k.toLowerCase()] ?? m);
  return '/' + path.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

/** A type's own access and attribute names, read once however many actions it has. */
const csTypeAccess = (t) => (t.access ??= { access: csAccess(t.attrs), names: csAttrNames(t.attrs) });

/** Who may call an action: its own attributes first, then its controller's, then a base controller's. */
function csActionAccess(g, owner) {
  const own = csAccess(g.attrs);
  const inherited = owner ? csTypeAccess(owner) : { access: {}, names: [] };
  const access = own.anonymous || own.guard ? own : inherited.access;
  const decos = [...csAttrNames(g.attrs), ...inherited.names, ...(owner?.bases || [])];
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

// A public method at the start of a line or after an attribute section: what comes before its ( on that line
const CS_PUBLIC_METHOD = /(^|\])([ \t]*)public[ \t]+(?!(?:static|class|record|interface|enum|struct|const|event|delegate)\b)([^\n(;={}]{1,300})\(/gm;

/**
 * Public actions of a controller with no route attributes. They are reached only through a
 * MapControllerRoute pattern, which resolveRoutes applies; on their own they are not endpoints.
 */
function csConventionalActions(code, at, t, groupAt, budget) {
  if (!/Controller$/.test(t.name) || t.prefixes.some(Boolean) || t.kind !== 'class' || /\babstract\b/.test(t.mods)) return [];
  // controllers don't nest, so their bodies add up to the file at most; nested look-alikes stop here
  budget.left -= t.end - t.at;
  if (budget.left < 0) return [];
  const body = code.slice(t.at, t.end);
  const actions = [];
  for (const m of all(CS_PUBLIC_METHOD, body)) {
    // a return type, then the name: constructors and calls have no return type
    const head = csLastName(m[3].replace(/^(?:(?:async|virtual|override|new|sealed)\s+)+/, ''));
    if (!head || !head.before.trim() || head.name === t.name) continue;
    const offset = t.at + m.index + m[1].length + m[2].length;
    const found = groupAt.get(offset);
    const g = found?.decl.name === head.name ? found : null;
    const attrs = g?.attrs || '';
    if (/\bNonAction\b/.test(attrs) || all(CS_ROUTE, attrs).length || all(CS_VERB, attrs).some((v) => v[2] != null)) continue;
    const verbs = all(CS_VERB, attrs).map((v) => v[1].toUpperCase());
    const auth = csActionAccess(g || { attrs: '' }, t);
    actions.push({ controller: t.name.replace(/Controller$/, ''), action: head.name.replace(/Async$/, ''), area: t.area, methods: verbs.length ? verbs : ['ANY'], line: at(g ? g.start : offset), handler: head.name, auth });
  }
  return actions;
}

/** Actions of an inheritable base controller, kept as templates for its subclasses. */
function csBaseActions(g, owner, line) {
  const own = csAccess(g.attrs);
  return csActionPairs(g.attrs).map(([method, template]) => ({
    base: owner.name, method, template, line, handler: g.decl.name, action: g.decl.name?.replace(/Async$/, ''),
    auth: { ...own, decos: csAttrNames(g.attrs) },
  }));
}

/** The first type named `name` declared at or after `from` (types of one name are in file order). */
function csTypeAfter(byName, name, from) {
  const list = byName.get(name);
  if (!list) return null;
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].at >= from) hi = mid; else lo = mid + 1; }
  return list[lo] || null;
}

/** Attribute-routed controller actions, under the [Route] and [Area] of the class they sit in. */
function csControllerRoutes(code, at, types, idx) {
  const groups = csAttributeGroups(code, idx);
  const byName = new Map();
  for (const t of types) { if (!byName.has(t.name)) byName.set(t.name, []); byName.get(t.name).push(t); }
  for (const g of groups) {
    if (g.decl.kind !== 'type') continue;
    const t = csTypeAfter(byName, g.decl.name, g.end);
    if (!t) continue;
    const prefixes = all(CS_ROUTE, g.attrs).map((m) => m[1]);
    if (prefixes.length) t.prefixes = prefixes;
    t.area = /\bArea(?:Attribute)?\s*\(\s*"([^"\n]{0,500})"/.exec(g.attrs)?.[1] ?? null;
    t.attrs = g.attrs;
  }
  for (const t of types) t.end = csBodyEnd(idx, t.at);
  // the class around each attribute group: the innermost type whose body holds it (types and groups are both in file order)
  const open = [];
  let next = 0;
  const members = [];
  for (const g of groups) {
    while (next < types.length && types[next].at < g.start) open.push(types[next++]);
    while (open.length && open[open.length - 1].end <= g.start) open.pop();
    if (g.decl.kind === 'member') members.push({ g, owner: open[open.length - 1] });
  }
  const routes = members.filter((x) => !csInheritable(x.owner)).flatMap(({ g, owner }) => csActionRoutes(g, owner, at(g.start)));
  const baseActions = members.filter((x) => csInheritable(x.owner)).flatMap(({ g, owner }) => csBaseActions(g, owner, at(g.start)));
  const groupAt = new Map(groups.filter((g) => g.decl.kind === 'member').map((g) => [g.declAt, g]));
  const budget = { left: 2 * code.length + 100000 };
  const conventional = types.flatMap((t) => csConventionalActions(code, at, t, groupAt, budget));
  return { routes, baseActions, conventional };
}

/**
 * The statement a Map… call starts, up to the semicolon that ends it, for the calls chained onto it.
 * A lambda handler has semicolons of its own, so only one outside every bracket counts; `flat` has its
 * strings blanked so a bracket inside one doesn't count. A statement is read up to 8,000 characters, and
 * all of a file's statements up to a few times the file's length, after which each gets 400.
 */
function csStatement(code, idx, from, budget) {
  const { flat } = idx;
  let depth = 0;
  const limit = Math.min(flat.length, from + Math.min(8000, Math.max(400, budget.left)));
  budget.left -= limit - from;
  for (let i = from; i < limit; i++) {
    const c = flat[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth <= 0) { budget.left += limit - i; return code.slice(from, i); }
  }
  return code.slice(from, limit);
}

// An extension method that maps endpoints onto whatever it is called on:
// public static RouteGroupBuilder MapOrders(this RouteGroupBuilder group) { group.MapGet(…) }
const CS_MAPPER = /\bstatic\s+[\w<>?.]+\s+(Map\w+)\s*\(\s*this\s+[\w<>?.]+\s+(\w+)/g;
// …and its call sites: api.MapOrders(), app.MapGroup("/api").RequireAuthorization().MapOrders()
const CS_MAPPER_CALL = /\b(\w+)((?:\s*\.\s*MapGroup\s*\(\s*(?:prefix\s*:\s*)?@?"([^"\n]{0,500})"\s*\))?(?:\s*\.\s*(?:RequireAuthorization|AllowAnonymous|WithTags|WithName|WithOpenApi|WithGroupName|RequireCors|RequireRateLimiting|DisableAntiforgery)\s*\([^()]*\))*)\s*\.\s*(Map\w+)\s*\(\s*\)/g;
// ASP.NET Core's own parameterless Map… calls, which aren't project mappers
const CS_BUILTIN_MAPS = /^Map(Controllers|DefaultControllerRoute|RazorPages|StaticAssets|OpenApi|BlazorHub|FallbackToPage|Group|Hub)$/;

/** The project mappers this file defines (name, parameter, body span), so the routes inside them can be moved under each caller's prefix. */
function csMappers(code, idx) {
  return all(CS_MAPPER, code).map((m) => ({ name: m[1], param: m[2], start: m.index, end: csBodyEnd(idx, m.index + m[0].length) }));
}

/** The mapper whose body holds `index` and whose parameter is `v` (mappers are in file order and don't nest). */
function csMapperAt(mappers, v, index) {
  let lo = 0, hi = mappers.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (mappers[mid].start < index) lo = mid + 1; else hi = mid; }
  for (let k = lo - 1, n = 0; k >= 0 && n < 20; k--, n++) if (mappers[k].param === v && index < mappers[k].end) return mappers[k].name;
  return undefined;
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
function csMinimalRoutes(code, at, idx) {
  const routers = Object.create(null);
  const groupAccess = Object.create(null);
  const budget = { left: 4 * code.length + 100000 };
  for (const m of all(CS_GROUP, code)) {
    // a prefix stops growing at 1,000 characters: `g = g.MapGroup("/a")` over and over would make each one longer
    const prefix = [routers[m[2]], m[3]].filter(Boolean).join('/').replace(/\/{2,}/g, '/');
    routers[m[1]] = prefix.length > 1000 ? routers[m[2]] : prefix;
    const access = csChainAccess(csStatement(code, idx, m.index, budget));
    groupAccess[m[1]] = access.guard || access.anonymous ? access : groupAccess[m[2]] || {};
  }
  // `api.RequireAuthorization();` on its own line, after the group is made
  for (const m of all(/\b(\w+)\s*\.\s*(RequireAuthorization\s*\([^;]{0,300}|AllowAnonymous\s*\(\s*\))\s*;/g, code)) {
    if (routers[m[1]] !== undefined) groupAccess[m[1]] = csChainAccess(m[0]);
  }
  const mappers = csMappers(code, idx);
  const endpoint = (m, method, path, handlerRef, decos = []) => {
    const own = csChainAccess(csStatement(code, idx, m.index, budget));
    const auth = own.guard || own.anonymous ? own : groupAccess[m[1]] || {};
    const mapper = csMapperAt(mappers, m[1], m.index);
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
  return { routes, routers: { ...routers }, mapperCalls: csMapperCalls(code, at, routers, groupAccess) };
}

/** `.RequireAuthorization("Admin")` or `.AllowAnonymous()` chained onto a Map… or MapGroup call. */
function csChainAccess(stmt) {
  if (/\.\s*AllowAnonymous\s*\(\s*\)/.test(stmt)) return { anonymous: true };
  const m = /\.\s*RequireAuthorization\s*\(([^)]{0,300})\)/.exec(stmt);
  if (m) return { guard: `.RequireAuthorization(${m[1].replace(/\s+/g, ' ').trim()})` };
  return {};
}

/** Route patterns from MapControllerRoute / MapDefaultControllerRoute, for controllers without route attributes. */
function csConventions(code) {
  const out = [];
  let semi = -2; // the next ; after the call, searched for again only once passed (-1: there is none)
  for (const m of all(CS_CONVENTION, code)) {
    if (m[0].startsWith('MapDefault')) { out.push(CS_DEFAULT_CONVENTION); continue; }
    // the call's own arguments, up to its semicolon: the pattern is the string with {controller in it
    const from = m.index + m[0].length;
    if (semi === -2 || (semi >= 0 && semi < from)) semi = code.indexOf(';', from);
    const args = code.slice(from, Math.min(semi < 0 ? code.length : semi, from + 600));
    const pattern = all(/"([^"\n]{0,300})"/g, args).map((s) => s[1]).find((s) => s.includes('{controller'));
    if (pattern) out.push(pattern);
  }
  return out;
}

function extractCSharp(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const namespaces = all(/^[ \t]*namespace\s+([\w.]+)/gm, code).map((m) => ({ name: m[1], line: at(m.index) }));
  const imports = all(/^[ \t]*(global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm, code)
    .map((m) => ({ spec: m[2], names: [], line: at(m.index), ...(m[1] ? { global: true } : {}) }));
  // a file's own namespace and the ones enclosing it are in scope without a using
  for (const ns of namespaces) {
    const parts = ns.name.split('.');
    for (let k = parts.length; k >= 1; k--) imports.push({ spec: parts.slice(0, k).join('.'), names: [], line: ns.line, implicit: true });
  }
  const types = all(CS_TYPE, code).map((m) => {
    const header = m[6].replace(/\([^()]*\)/g, ''); // a primary constructor's parameters
    const colon = header.indexOf(':');
    const where = colon < 0 ? -1 : header.slice(colon).search(/\bwhere\b/);
    const baseList = colon < 0 ? '' : header.slice(colon + 1, where < 0 ? undefined : colon + where);
    return {
      at: m.index + m[1].length + m[2].length, name: m[5], kind: m[4], mods: m[3], nested: /\b(private|protected)\b/.test(m[3]), prefixes: [''], area: null, attrs: '',
      generic: /^\s*</.test(m[6]),
      // `class OrdersController : SecureControllerBase` -> ['SecureControllerBase']
      bases: baseList.split(',').map((b) => { const lt = b.indexOf('<'); return (lt < 0 ? b : b.slice(0, lt)).trim(); }).filter(Boolean),
    };
  });
  const symbols = types.filter((t) => !t.nested).map((t) => ({ name: t.name, kind: t.kind, line: at(t.at) }));
  // type names this file mentions, so a `using` links only the files that declare one of them
  const typeRefs = new Set(code.replace(STR_LITERAL, ' ').match(/\b[A-Z]\w*\b/g) || []);
  const idx = csIndex(code.replace(STR_LITERAL, blank));
  const minimal = csMinimalRoutes(code, at, idx);
  const controllers = csControllerRoutes(code, at, types, idx);
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

/** PHP from stripPhp with the inside of every string blanked too (quotes and offsets kept), for finding code in it. */
export function phpBare(code) {
  let bare = '';
  for (let i = 0; i < code.length;) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') { const j = phpStringEnd(code, i); bare += c + blank(code.slice(i + 1, j - 1)) + (j - i > 1 ? c : ''); i = j; continue; }
    bare += c; i++;
  }
  return bare;
}

/**
 * Where the brackets of bare PHP (phpBare) close, found in one pass: close(open) is just past the bracket that
 * closes the one at `open`, or the end of the text when none does. (Counting afresh from every bracket would read
 * a file of unclosed brackets once per bracket.) The offsets are the same in the code phpBare was made from.
 */
export function phpBrackets(bare) {
  const ends = new Int32Array(bare.length);
  const open = [];
  for (let i = 0; i < bare.length; i++) {
    const c = bare.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) open.push(i);
    else if ((c === 41 || c === 93 || c === 125) && open.length) ends[open.pop()] = i + 1;
  }
  return (at) => ends[at] || bare.length;
}

/**
 * How much of a PHP file may be read again. Nested route groups, closures and lists are read once for every
 * level they sit in: a few times over in real code, but thousands of times in a file built of thousands of
 * unclosed levels. spend(n) answers false once the allowance is used up, and the caller then treats what it
 * wanted to read as unknown (a closure isn't "only redirects", a list is empty), never as safe.
 */
export function phpBudget(size) {
  let left = 8 * size + 2_000_000;
  const spend = (n) => (left -= n) >= 0;
  spend.left = () => Math.max(0, left);
  return spend;
}

/** The top-level comma-separated parts of an argument list or array's inside (text), each trimmed. */
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

/**
 * phpSplit for code[from, to), stepping over brackets with close (phpBrackets) instead of reading inside them,
 * so an argument list costs its own length however much is nested in it. `.starts` holds where each part starts.
 */
export function phpParts(code, bare, close, from, to) {
  const out = [];
  out.starts = [];
  const push = (a, b, last) => {
    const raw = code.slice(a, b), t = raw.trim();
    if (t || !last) { out.push(t); out.starts.push(a + raw.length - raw.trimStart().length); }
  };
  let start = from;
  for (let i = from; i < to; i++) {
    const c = bare.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) i = close(i) - 1;
    else if (c === 44) { push(start, i, false); start = i + 1; }
  }
  push(start, Math.min(to, code.length), true);
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
/** Looks like an array literal, without reading it. */
const phpIsArray = (t) => (t.startsWith('[') && t.endsWith(']')) || (/^array\s*\(/i.test(t) && t.endsWith(')'));

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
// a path is a short expression: anything longer isn't one (and reading it would cost its length)
const PHP_PATH_MAX = 2000;

/**
 * Files this one loads by path, `require __DIR__.'/x.php';` and the like, as [{ at, spec }]. Each statement runs
 * to the next `;`, found by a search that only moves forward, so a file of `require` with no `;` is read once.
 */
function phpRequires(code, bare, close) {
  const out = [];
  const semi = forwardIndexOf(bare, ';');
  for (const m of bare.matchAll(/\b(?:require|include)(?:_once)?\b/g)) {
    let from = m.index + m[0].length;
    const end = semi(from);
    if (end < 0 || end - from > PHP_PATH_MAX) continue;
    while (from < end && /\s/.test(bare[from])) from++;
    let to = end;
    while (to > from && /\s/.test(bare[to - 1])) to--;
    // require(…); the parentheses around the whole path aren't part of it
    if (bare[from] === '(' && close(from) === to) { from++; to--; }
    const spec = phpPath(code.slice(from, to));
    if (spec) out.push({ at: m.index, spec });
  }
  return out;
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
  // what each return starts with is enough to tell a redirect
  const returns = arrow ? [arrow[1]] : [...text.matchAll(/\breturn\s+([^;]{1,80})/g)].map((m) => m[1]);
  if (returns.length && returns.every((r) => ONLY_REDIRECT.test(r.trim()))) return true;
  return !PHP_READS_PRIVATE.test(text);
}
const singular = (w) => w.replace(/-/g, '_').replace(/ies$/, 'y').replace(/(ss|sh|ch|x)es$/, '$1').replace(/([^s])s$/, '$1');
// route groups nested deeper than this add nothing more to the routes inside (real route files nest a few deep)
const MAX_GROUP_DEPTH = 64;
// and a route file loads at most this many others
const MAX_ROUTE_FILES = 1000;

/**
 * Laravel's routes in one file: Route::get/post/…/match/any, resource and apiResource (with only/except),
 * Route::inertia and Route::view, under prefix / name / middleware / controller groups (chained or the
 * older Route::group([...]) form), plus the route files this one loads inside a group: require __DIR__.'/x.php',
 * ->group(base_path('routes/x.php')), files required in a loop over a fixed list, and bootstrap/app.php's
 * withRouting(web:, api:). Groups' prefixes, names and middleware are applied to each route here; a loaded
 * file becomes a mount, so routes.mjs carries them into it.
 * Patterns run on bare (strings blanked), values are read from code; close and spend are phpBrackets and phpBudget.
 */
function laravelRoutes(code, bare, close, spend, at, cls, requires) {
  const routes = [], mounts = [], groups = [], includes = [];
  const arrayBody = (t) => (t && spend(t.length) ? phpArrayBody(t) : null);
  const strList = (t) => { const s = phpStr(t); if (s != null) return [s]; const b = arrayBody(t); return b == null ? [] : phpSplit(b).map(phpStr).filter((x) => x != null); };
  // middleware names: 'auth:sanctum', ['auth', 'verified'], EnsureStaff::class (kept as its class name)
  const mwList = (args) => args.flatMap((a) => { const b = phpIsArray(a) ? arrayBody(a) : null; return b != null ? phpSplit(b) : [a]; })
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
      case 'can': attrs.mw.push('can:' + args.map((a) => phpStr(a) ?? (a.length <= 200 ? a : '…')).join(',')); return true;
      default: return /^(domain|where\w*|scopeBindings|withoutScopedBindings|withTrashed|missing|defaults)$/.test(name);
    }
  };
  const arrayAttrs = (t) => {
    const attrs = fresh();
    if (!spend(t.length)) return attrs;
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
  /** The body of a closure argument in code[start, end) as [from, to]: function (…) use (…): T { body } or fn (…) => body. */
  const closureBody = (start, end) => {
    const head = /\s*(?:static\s+)?(function|fn)\s*&?\s*\(/y;
    head.lastIndex = start;
    const m = head.exec(bare);
    if (!m || head.lastIndex > end) return null;
    const next = (re, from) => { re.lastIndex = from; return re.exec(bare) && re.lastIndex <= end ? re.lastIndex : -1; };
    let p = close(head.lastIndex - 1);
    if (m[1] === 'fn') { const body = next(/\s*(?::[\s\w\\|&?]{1,300})?=>/y, p); return body < 0 ? null : [body, end]; }
    const use = next(/\s*use\s*\(/y, p);
    if (use >= 0) p = close(use - 1);
    const brace = next(/\s*(?::[\s\w\\|&?]{1,300})?\{/y, p);
    return brace < 0 ? null : [brace, close(brace - 1) - 1];
  };
  const argsOf = (c) => phpParts(code, bare, close, c.open + 1, c.close - 1);
  // closures kept in a variable ($legacy = static fn () => …;): where each variable's first one starts
  const varClosures = new Map();
  for (const m of bare.matchAll(/\$(\w+)\s*=\s*(?=(?:static\s+)?(?:fn|function)\b)/g)) if (!varClosures.has(m[1])) varClosures.set(m[1], m.index + m[0].length);
  const varText = new Map();
  /** An inline closure's text, or the closure a variable holds, within the file's allowance; null when unknown. */
  const closureText = (t) => {
    t = (t || '').trim();
    const v = /^\$(\w+)$/.exec(t);
    if (!v) return /^(?:static\s+)?(?:fn|function)\b/.test(t) && spend(t.length) ? t : null;
    if (varText.has(v[1])) return varText.get(v[1]);
    const from = varClosures.get(v[1]);
    let text = null;
    if (from != null) {
      // to the `;` that ends the assignment, stepping over brackets, and no further than the allowance left
      const stop = Math.min(bare.length, from + spend.left());
      let j = from;
      for (; j < stop && bare[j] !== ';'; j++) if ('([{'.includes(bare[j])) j = close(j) - 1;
      if (spend(j - from) && j < stop) text = code.slice(from, j).trim();
    }
    varText.set(v[1], text);
    return text;
  };
  /** One `Route::…` chain: a list of calls joined by -> (or the first by ::). */
  const chainAt = (i) => {
    const calls = [];
    const head = /([A-Za-z_]\w*)\s*\(/y, arrow = /\s*\??->\s*/y;
    for (;;) {
      head.lastIndex = i;
      const m = head.exec(bare);
      if (!m) break;
      const open = i + m[0].length - 1;
      calls.push({ name: m[1], open, close: close(open) });
      arrow.lastIndex = calls[calls.length - 1].close;
      const a = arrow.exec(bare);
      if (!a) break;
      i = arrow.lastIndex;
    }
    return calls;
  };

  const chains = [];
  for (const m of bare.matchAll(/(?<![\w$\\>])\\?(?:Illuminate\\Support\\Facades\\)?Route\s*::\s*/g)) chains.push({ at: m.index, line: at(m.index), calls: chainAt(m.index + m[0].length) });
  // groups first (any order of files works, nesting is by position)
  for (const ch of chains) {
    const pre = fresh();
    for (const c of ch.calls) {
      if (c.name === 'group') {
        const args = argsOf(c);
        let attrs = pre, k = 0;
        if (args.length > 1 && phpIsArray(args[0])) { attrs = merge(pre, arrayAttrs(args[0])); k = 1; }
        const target = args[k], tStart = args.starts[k];
        const body = target ? closureBody(tStart, tStart + target.length) : null;
        if (body) groups.push({ start: body[0], end: body[1], attrs });
        else { const spec = target && target.length <= PHP_PATH_MAX && phpPath(target); if (spec) includes.push({ spec, at: ch.at, line: ch.line, attrs }); }
        break;
      }
      if (ROUTE_METHODS[c.name] || /^(match|view|inertia|resources?|apiResources?|singleton|apiSingleton|redirect|permanentRedirect|fallback)$/.test(c.name)) break;
      applyAttr(pre, c.name, argsOf(c));
    }
  }
  // Groups nest the way their brackets do, so each has a parent, and its context (its own attributes on top of its
  // parents') is worked out once. A position's context is that of the innermost group around it.
  groups.sort((a, b) => a.start - b.start || b.end - a.end);
  const around = [];
  for (const g of groups) {
    while (around.length && around[around.length - 1].end <= g.start) around.pop();
    g.parent = around[around.length - 1] || null;
    g.depth = g.parent ? g.parent.depth + 1 : 0;
    g.ctx = g.depth >= MAX_GROUP_DEPTH ? g.parent.ctx : merge(g.parent ? g.parent.ctx : fresh(), g.attrs);
    around.push(g);
  }
  const contextAt = (pos) => {
    let lo = 0, hi = groups.length - 1, g = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (groups[mid].start <= pos) { g = groups[mid]; lo = mid + 1; } else hi = mid - 1; }
    for (let up = 0; g && pos >= g.end && up < MAX_GROUP_DEPTH; up++) g = g.parent;
    return g && pos < g.end ? g.ctx : fresh();
  };
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
      const list = /s$/.test(reg.name) ? (args[0] && spend(args[0].length) ? phpPairs(args[0]) : []) : [[phpStr(args[0]), args[1]]];
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
  for (const r of requires) if (/\.php$/i.test(r.spec)) includes.push({ spec: r.spec, at: r.at, line: at(r.at), attrs: fresh() });
  // (the list can't hold brackets, so each look for its end stops at the next one: a file of `foreach ([` is read once)
  for (const m of bare.matchAll(/\bforeach\s*\(\s*(\[[^\]()]*\]|array\s*\([^()]*\))\s+as\s+\$(\w+)\s*\)\s*\{/dg)) {
    const brace = m.index + m[0].length - 1, end = close(brace);
    // a loop that loads route files is a few lines long; a longer one is doing something else
    if (end - brace > 4000 || !spend(end - brace)) continue;
    const items = strList(code.slice(...m.indices[1]));
    if (!items.length) continue;
    const body = code.slice(brace + 1, end - 1);
    if (!/\b(require|include)(_once)?\b/.test(body)) continue;
    // the path built from the loop variable: required directly, or kept in a variable first
    const exprs = [...body.matchAll(new RegExp(String.raw`([^;=(\n]{0,300}\$${m[2]}\b[^;)\n]{0,300}\.php['"])`, 'g'))].map((x) => x[1].trim());
    for (const it of items) for (const e of exprs) {
      const spec = phpPath(e, { [m[2]]: it });
      if (spec) includes.push({ spec, at: m.index, line: at(m.index), attrs: fresh() });
    }
  }
  // bootstrap/app.php: ->withRouting(web: …, api: …, apiPrefix: 'api')
  for (const m of bare.matchAll(/\bwithRouting\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const named = Object.fromEntries(phpParts(code, bare, close, open + 1, close(open) - 1).map(phpNamed).filter(([k]) => k));
    const files = (t) => { const b = t && phpIsArray(t) ? arrayBody(t) : null; return (b != null ? phpSplit(b) : t ? [t] : []).filter((x) => x.length <= PHP_PATH_MAX).map((x) => phpPath(x)).filter(Boolean); };
    for (const spec of files(named.web)) includes.push({ spec, at: m.index, line: at(m.index), attrs: { ...fresh(), mw: ['web'] } });
    for (const spec of files(named.api)) includes.push({ spec, at: m.index, line: at(m.index), attrs: { ...fresh(), prefix: phpStr(named.apiPrefix) ?? 'api', mw: ['api'] } });
  }
  const seen = new Set();
  for (const inc of includes) {
    if (mounts.length >= MAX_ROUTE_FILES) break;
    const a = merge(contextAt(inc.at), inc.attrs);
    const key = `${inc.spec}|${a.prefix}|${a.as}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mounts.push({ spec: inc.spec, prefix: a.prefix, line: inc.line, ...(a.as ? { as: a.as } : {}), ...(finalMw(a).length ? { mw: finalMw(a) } : {}) });
  }
  return { routes, mounts };
}

// The folder a web server serves PHP files from: each script there answers at its own address
const PHP_DOC_ROOT = /^((?:.*\/)?(?:public|public_html|www|htdocs))\//;
/**
 * Plain PHP sites, with no framework routing: a script under the document root (public/, public_html/, www/,
 * htdocs/) answers requests at its own address, public/orders/save.php at /orders/save.php and an index.php at
 * its folder's. Scripts other scripts include are parts of pages, not pages, and so are files and folders
 * starting with _ or a dot. A document root whose index.php loads Composer's vendor/autoload.php is a framework's
 * front controller (Laravel, Symfony, Slim), whose routes are read elsewhere, so it's left alone.
 * Adds the endpoints to each file's routes; call it after imports are resolved (imp.files).
 * After @maccydee's document-root rule in #13.
 */
export function phpPages(files) {
  const php = files.filter((f) => f.lang === 'php' && f.category === 'code' && !f.tooLarge);
  if (!php.length) return 0;
  const included = new Set(php.flatMap((f) => (f.imports || []).flatMap((imp) => imp.files || [])));
  const byPath = new Map(php.map((f) => [f.path, f]));
  const frontController = new Map();
  let added = 0;
  for (const f of php) {
    const m = PHP_DOC_ROOT.exec(f.path);
    if (!m || f.routes?.length || included.has(f.path)) continue;
    const root = m[1];
    if (!frontController.has(root)) {
      const index = byPath.get(`${root}/index.php`);
      frontController.set(root, !!index?.imports?.some((imp) => /(^|\/)vendor\/autoload\.php$/.test(imp.spec || '')));
    }
    if (frontController.get(root)) continue;
    const rel = f.path.slice(root.length + 1);
    if (rel.split('/').some((part) => /^[_.]/.test(part)) || !/\.php$/i.test(rel) || /\.blade\.php$/i.test(rel)) continue;
    const page = '/' + rel.replace(/(^|\/)index\.php$/i, '');
    (f.routes ||= []).push({ method: 'ANY', path: page.length > 1 ? page.replace(/\/$/, '') : '/', var: null, line: f.phpStart || 1, framework: 'php' });
    added++;
  }
  return added;
}

function extractPhp(src, filePath) {
  const code = stripPhp(src);
  const at = lineIndex(code);
  const lines = src.split('\n');
  // strings blanked too, for finding class names in code
  const bare = phpBare(code);
  const close = phpBrackets(bare);
  const spend = phpBudget(code.length);
  const ns = /^[ \t]*namespace\s+([\w\\]+)\s*[;{]/m.exec(bare)?.[1] || null;

  // class-like bodies, to tell `use Trait;` inside a class from a top-level `use Some\Class;`
  const symbols = [];
  const bodies = [];
  const nextBrace = forwardIndexOf(bare, '{'), nextSemi = forwardIndexOf(bare, ';');
  for (const m of bare.matchAll(/^[ \t]*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm)) {
    // the body starts at the next {, unless a ; comes first
    const from = m.index + m[0].length, brace = nextBrace(from), semi = nextSemi(from);
    if (brace < 0 || (semi >= 0 && semi < brace)) continue;
    symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
    bodies.push([brace + 1, close(brace)]);
  }
  for (const m of bare.matchAll(/^function\s+&?([A-Za-z_]\w*)\s*\(/gm)) symbols.push({ name: m[1], kind: 'function', line: at(m.index) });
  // bodies nest or sit apart, so the outermost ones, in order, say whether a position is inside any
  const outer = [];
  for (const b of [...bodies].sort((x, y) => x[0] - y[0])) if (!outer.length || b[0] >= outer[outer.length - 1][1]) outer.push(b);
  const inBody = (pos) => {
    let lo = 0, hi = outer.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (outer[mid][0] <= pos) { if (pos < outer[mid][1]) return true; lo = mid + 1; } else hi = mid - 1; }
    return false;
  };

  const uses = new Map(); // alias (lower-case) -> full name
  const imports = [];
  const seenSpec = new Set();
  const addImport = (spec, line, extra = {}) => { if (!spec || seenSpec.has(spec)) return; seenSpec.add(spec); imports.push({ spec, names: [], line, ...extra }); };
  // (none of ; { } ( ? can be inside a use statement, so each look for its end stops at the next of them, and the
  // names start after the spaces and end right before a ; or {, so they aren't tried again from every character)
  for (const m of bare.matchAll(/(?<=^|[;{}]|<\?php)\s*use\s+(?!\()(function\s+|const\s+)?([^;{}(?\s][^;{}(?]*(?=[;{])(?:\{[^;{}?]*\})?)\s*;/gi)) {
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
    const types = [...new Set(phpParts(bare, bare, close, open + 1, close(open) - 1)
      .map((p) => /^(?:#\[[^\]]{0,500}\]\s*)*(?:(?:public|protected|private|readonly)\s+)*\??([\\\w]+)\s+&?(?:\.\.\.)?\$/.exec(p)?.[1])
      .filter((t) => t && !PHP_NOT_CLASS.has(t.toLowerCase())).map(cls).filter(Boolean))];
    methods.push({ name: m[2], line, ...(/\b(protected|private)\b/.test(m[1]) ? { hidden: true } : {}), ...(doc ? { doc } : {}), ...(types.length ? { types } : {}) });
  }
  // the method a line is in: the last one starting at or before it (methods are in line order)
  const methodAt = (line) => {
    let lo = 0, hi = methods.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (methods[mid].line <= line) { best = methods[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best?.name || null;
  };

  // require/include of another file by path
  const requires = phpRequires(code, bare, close);
  for (const r of requires) addImport(r.spec, at(r.at), { kind: 'include' });

  let routes = [], mounts = [];
  if (/\bRoute\s*::|\bwithRouting\s*\(/.test(bare)) {
    ({ routes, mounts } = laravelRoutes(code, bare, close, spend, at, cls, requires));
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
    // where the PHP starts, for a page's endpoint (phpPages)
    ...(/<\?(?:php\b|=)/i.test(src) ? { phpStart: at(src.search(/<\?(?:php\b|=)/i)) } : {}),
  };
}

// ---------- small ones ----------

function extractSimple(src, lang) {
  const code = lang === 'ruby' ? stripHash(src) : stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  if (lang === 'ruby') for (const m of all(/\brequire_relative\s*\(?\s*["']([^"']+)["']/g, code)) imports.push({ spec: './' + m[1].replace(/^\.\//, ''), names: [], line: at(m.index) });
  if (lang === 'c' || lang === 'cpp' || lang === 'objc') for (const m of all(/^[ \t]*#\s*(?:include|import)\s+"([^"]+)"/gm, code)) imports.push({ spec: m[1], names: [], kind: 'include', line: at(m.index) });
  if (lang === 'php') for (const m of all(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']([^"']+)["']/g, code)) imports.push({ spec: m[1].startsWith('/') ? '.' + m[1] : m[1], names: [], line: at(m.index) });
  if (lang === 'css') for (const m of all(/@(?:import|use|forward)\s+(?:url\()?["']([^"']+)["']/g, code)) imports.push({ spec: m[1].startsWith('.') ? m[1] : './' + m[1], names: [], line: at(m.index) });
  const symbols = [];
  if (lang === 'ruby') for (const m of all(/^[ \t]*(class|module)\s+([A-Z][\w:]*)/gm, code)) symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  const { calls, hosts } = ['ruby', 'php', 'dart', 'kotlin'].includes(lang) ? extractCalls(code, at) : { calls: [], hosts: [] };
  return { imports, symbols, routes: [], mounts: [], calls, hosts };
}

// ---------- Shopify themes (Liquid) ----------
// Theme files reach each other by name ({% render 'price' %} is snippets/price.liquid), turned here into relative paths.

const THEME_ROOT = /^((?:.*\/)?)(?:layout|templates|sections|snippets|blocks|assets|config|locales)\//;
/**
 * The {% comment %}, {% raw %} and {% doc %} blocks (a doc's @example renders aren't real) and {% # … %}
 * comments of a Liquid file, in order, as { kind, start, body, close, end }. One pass: an opener whose
 * closing tag never comes is left as it is, and so is every later opener of its kind, without looking again.
 */
function* liquidBlocks(src) {
  const OPEN = /\{%-?\s*(?:(comment|raw|doc)\s*-?%\}|#)/g;
  const CLOSE = { comment: /\{%-?\s*endcomment\s*-?%\}/g, raw: /\{%-?\s*endraw\s*-?%\}/g, doc: /\{%-?\s*enddoc\s*-?%\}/g };
  const unclosed = new Set();
  for (let m; (m = OPEN.exec(src));) {
    const kind = m[1] || '#';
    if (unclosed.has(kind)) continue;
    const body = OPEN.lastIndex;
    let close = -1, end = -1;
    if (kind === '#') { close = src.indexOf('%}', body); end = close + 2; }
    else {
      CLOSE[kind].lastIndex = body;
      const c = CLOSE[kind].exec(src);
      if (c) { close = c.index; end = CLOSE[kind].lastIndex; }
    }
    if (close < 0) { unclosed.add(kind); continue; }
    yield { kind, start: m.index, body, close, end };
    OPEN.lastIndex = end;
  }
}
/** A Liquid file with its comments, raw and doc blocks blanked out, line numbers kept. */
function skipLiquid(src) {
  let out = '', from = 0;
  for (const b of liquidBlocks(src)) { out += src.slice(from, b.start) + blank(src.slice(b.start, b.end)); from = b.end; }
  return out + src.slice(from);
}
const LIQUID_TAG = /(?:\{%-?\s*|\n[ \t]*)(render|include|section|sections|content_for)\s+(['"])([^'"\n]+)\2(?:\s*,\s*type:\s*(['"])([^'"\n]+)\4)?/g;
const LIQUID_ASSET = /(['"])([^'"\n{}]+\.(?:js|css|scss)(?:\.liquid)?)\1\s*\|\s*asset_url/g;
const LIQUID_REQUEST = /\bfetch\s*\(|\$\.(ajax|get|post|getJSON)\s*\(|\bXMLHttp\w+|\baxios\b/;
const APP_BLOCK = /shopify:(?:\\?\/){2}apps(?:\\?\/)([\w-]+)/g;

function extractLiquid(src, filePath) {
  const root = THEME_ROOT.exec(filePath)?.[1] ?? '';
  const dir = P.dirname(filePath);
  const rel = (target) => { const r = P.relative(dir, root + target); return r.startsWith('.') ? r : './' + r; };
  const imports = [], symbols = [];
  const seen = new Set();
  const add = (spec, line, kind) => { if (seen.has(spec)) return; seen.add(spec); imports.push({ spec, names: [], line, ...(kind ? { kind } : {}) }); };
  const at = lineIndex(src);
  const addTags = (code, at) => {
    for (const m of all(LIQUID_TAG, code)) {
      const [, tag, , name, , type] = m;
      const line = at(m.index + (m[0].startsWith('\n') ? 1 : 0));
      if (tag === 'render' || tag === 'include') add(rel(`snippets/${name}.liquid`), line);
      else if (tag === 'section') add(rel(`sections/${name}.liquid`), line);
      else if (tag === 'sections') add(rel(`sections/${name}.json`), line);
      else if (name === 'block' && type) add(rel(`blocks/${type}.liquid`), line);
    }
  };
  // an app's block, a file in blocks/, or a block defined in its section's schema
  const addBlock = (type, line) => {
    if (!type || type.startsWith('@')) return;
    const app = /^shopify:\/\/apps\/([\w-]+)/.exec(type);
    if (app) add(`shopify://apps/${app[1]}`, line);
    else add(rel(`blocks/${type}.liquid`), line, 'theme-block');
  };

  if (filePath.endsWith('.json')) {
    for (const m of all(APP_BLOCK, src)) add(`shopify://apps/${m[1]}`, at(m.index));
    if (/(^|\/)config\//.test(filePath)) return { imports, symbols, routes: [], mounts: [], calls: [], hosts: [] };
    let data = null;
    try { data = JSON.parse(src.replace(/^\s*\/\*[\s\S]*?\*\//, '')); } catch {}
    // the line where each "type" value first appears, found in one pass
    const typeAt = new Map();
    for (const m of all(/"type"[ \t\r\n]*:[ \t\r\n]*("(?:[^"\\\n]|\\.){0,500}")/g, src)) {
      let v;
      try { v = JSON.parse(m[1]); } catch { continue; }
      if (!typeAt.has(v)) typeAt.set(v, at(m.index));
    }
    const lineOf = (type) => typeAt.get(type) ?? 1;
    const walkBlocks = (blocks, depth = 0) => {
      if (depth > 20 || !blocks || typeof blocks !== 'object') return;
      for (const b of Object.values(blocks)) { addBlock(b?.type, lineOf(b?.type)); walkBlocks(b?.blocks, depth + 1); }
    };
    for (const s of Object.values(data?.sections || {})) {
      if (typeof s?.type !== 'string') continue;
      if (s.type.startsWith('shopify://')) { addBlock(s.type, 1); continue; }
      const line = lineOf(s.type);
      // Shopify supplies _-prefixed sections like _blocks when the theme doesn't
      add(rel(`sections/${s.type}.liquid`), line, s.type.startsWith('_') ? 'theme-block' : undefined);
      if (!symbols.some((x) => x.name === s.type)) symbols.push({ name: s.type, kind: 'section', line });
      walkBlocks(s.blocks);
    }
    // Liquid typed into custom-code settings, JSON-escaped
    const settings = skipLiquid(src.replace(/\\"/g, '"'));
    addTags(settings, lineIndex(settings));
    return { imports, symbols, routes: [], mounts: [], calls: [], hosts: [] };
  }

  const code = skipLiquid(src);
  addTags(code, at);
  for (const m of all(LIQUID_ASSET, code)) add(rel(`assets/${m[2]}`), at(m.index));
  for (const m of all(APP_BLOCK, code)) add(`shopify://apps/${m[1]}`, at(m.index));

  // the first {% schema %} and the {% endschema %} after it, each looked for once
  const open = /\{%-?\s*schema\s*-?%\}/.exec(code);
  const CLOSE = /\{%-?\s*endschema\s*-?%\}/g;
  if (open) CLOSE.lastIndex = open.index + open[0].length;
  const close = open && CLOSE.exec(code);
  if (close) {
    let s = null;
    try { s = JSON.parse(code.slice(open.index + open[0].length, close.index)); } catch {}
    const line = at(open.index);
    if (typeof s?.name === 'string' && !s.name.startsWith('t:')) symbols.push({ name: s.name, kind: 'section', line });
    for (const b of Array.isArray(s?.blocks) ? s.blocks : []) if (typeof b?.type === 'string' && !b.type.startsWith('@')) symbols.push({ name: b.type, kind: 'block', line });
  }
  for (const m of all(/@param[ \t]+(?:\{[^}\n]{0,200}\}[ \t]+)?\[?([\w-]+)/g, src)) symbols.push({ name: m[1], kind: 'param', line: at(m.index) });
  // the "Accepts:" list of the first comment that has one
  for (const b of liquidBlocks(src)) {
    if (b.kind !== 'comment') continue;
    const body = src.slice(b.body, b.close);
    const head = /\b(?:Accepts|Arguments|Receives|Parameters|Params):?[ \t]*\r?\n/i.exec(body);
    if (!head) continue;
    for (const m of all(/^[ \t]*-[ \t]*([\w-]+)[ \t]*:/gm, body.slice(head.index + head[0].length))) symbols.push({ name: m[1], kind: 'param', line: at(b.start) });
    break;
  }

  // a theme is full of page links and SVG namespaces, so only real requests count
  const lines = code.split('\n');
  const requestLine = new Map(); // each line tested once, however many calls it holds
  const isRequest = (n) => { if (!requestLine.has(n)) requestLine.set(n, LIQUID_REQUEST.test(lines[n - 1] || '')); return requestLine.get(n); };
  const { calls, hosts } = extractCalls(code, at);
  return {
    imports, symbols, routes: [], mounts: [],
    calls: calls.filter((c) => !c.path.includes('{{') && isRequest(c.line)),
    hosts: hosts.filter((h) => !/(^|\.)(w3|schema)\.org$/.test(h.host)),
  };
}

/** A Liquid file's description: its leading {% comment %} or {% doc %}, up to its parameter list. */
function liquidDoc(src) {
  const m = /^(?:\s|\{%-?\s*#[^%]*%\})*\{%-?\s*(comment|doc)\s*-?%\}([\s\S]*?)\{%-?\s*end\1\s*-?%\}/.exec(src);
  if (!m || /theme-check|prettier-ignore/i.test(m[2])) return null;
  const head = m[2].split(/\n[ \t]*(?:-\s|(?:snippet\s+)?(?:accepts|arguments|receives|usage|parameters|params|example)\b)|@param\b/i)[0];
  return cleanDoc(head);
}

function extractByLang(src, lang, filePath) {
  switch (lang) {
    case 'liquid': return extractLiquid(src, filePath);
    case 'typescript': case 'javascript': case 'vue': case 'svelte': case 'astro': return extractJs(src, filePath);
    case 'python': return extractPy(src);
    case 'php': return /\.blade\.php$/i.test(filePath || '') ? extractSimple(src, lang) : extractPhp(src, filePath);
    case 'go': return extractGo(src);
    case 'rust': return extractRust(src);
    case 'swift': return extractSwift(src);
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
const CS_XML_DOC = /^[ \t]*\/\/\/[ \t]*</m;
function csXmlDoc(text) {
  // found with indexOf, so a file of unclosed <summary> tags isn't searched once per tag
  const lower = text.toLowerCase();
  const open = lower.indexOf('<summary>');
  const close = open < 0 ? -1 : lower.indexOf('</summary>', open + 9);
  const summary = close < 0 ? text : text.slice(open + 9, close);
  return summary
    .replace(/<(?:see|seealso|paramref|typeparamref)\s+(?:cref|name|langword|href)\s*=\s*"(?:\w:)?([^"\n]{0,300})"\s*\/>/gi, (m, n) => n.split('.').pop())
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
    while (i < lines.length && i < idx + 20 && !(lines[i].length <= 500 && /:\s*(#.*)?$/.test(lines[i]))) i++;
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
  // C# attribute lines are skipped at most 60 lines up, like the comment itself below
  const floor = lang === 'csharp' ? idx - 61 : -1;
  while (i >= 0 && i > floor && annotation.test(lines[i])) i--;
  if (i < 0 || i === floor) return null;
  // (a doc comment is read back at most 60 lines: walking further for every declaration of a large file
  // would take quadratic time)
  if (/\*\/\s*$/.test(lines[i])) {
    const end = i;
    while (i >= 0 && i > end - 60 && !/\/\*/.test(lines[i])) i--;
    return i >= 0 && /\/\*/.test(lines[i]) ? cleanDoc(lines.slice(i, end + 1).join('\n')) : null;
  }
  const buf = [];
  while (i >= 0 && buf.length < 60 && /^\s*(\/\/|#(?!!))/.test(lines[i])) buf.unshift(lines[i--]);
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
  r.doc = lang === 'python' ? pyDocAfter(lines, -1) : lang === 'liquid' ? liquidDoc(src) : lang === 'php' ? phpHeader(lines, r) : HASH_LANGS.has(lang) ? hashHeader(lines) : headerComment(lines);
  if (lang === 'liquid') return;
  for (const s of r.symbols || []) {
    const d = lang === 'python' ? pyDocAfter(lines, s.line - 1) : commentBefore(lines, s.line - 1, lang);
    if (d) s.doc = d;
  }
  // A route's handler is the first declaration after it (decorator-style frameworks).
  // (a Firebase function's export isn't the handler of the Express routes above it)
  const fbNames = new Set((r.routes || []).filter((rt) => rt.framework === 'firebase').map((rt) => rt.handler));
  const syms = (r.symbols || []).filter((s) => !fbNames.has(s.name)).sort((a, b) => a.line - b.line);
  const aspnetDocs = new Map();
  for (const rt of r.routes || []) {
    if (rt.framework === 'laravel') continue; // its handler is a controller method in another file (routes.mjs)
    if (rt.framework === 'next') { rt.handler = rt.method; continue; }
    // a Nest handler is a class method, not a symbol: keep the name found after the decorators
    // (the first symbol below could be the next controller class, or a DTO, in the same file)
    if (rt.framework === 'nest') { const d = commentBefore(lines, rt.line - 1); if (d) rt.doc = d; continue; }
    if (rt.framework === 'table') { const d = r.symbols?.find((s) => s.name === rt.handler)?.doc; if (d) rt.doc = d; continue; }
    // the extractor already named the action; its doc sits above the attributes, where rt.line points
    if (rt.framework === 'aspnet') {
      // read once per line: one action can declare many routes
      if (!aspnetDocs.has(rt.line)) aspnetDocs.set(rt.line, commentBefore(lines, rt.line - 1, lang));
      const d = aspnetDocs.get(rt.line);
      if (d) rt.doc = d;
      continue;
    }
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
