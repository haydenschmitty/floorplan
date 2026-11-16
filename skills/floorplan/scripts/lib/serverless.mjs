// Serverless Framework: endpoints declared in serverless.yml rather than in code. Each function's
// `handler: src/orders.create` names a file and an export, and its `events:` list the addresses
// (`http:` for API Gateway REST APIs, `httpApi:` for HTTP APIs) that reach it. The endpoints are placed
// in the handler's file, so the website's requests link to the code that answers them.
//
// YAML is read by a small indentation-aware reader (no dependencies): block maps and lists, flow
// [a, b] and { a: b }, quotes, comments, anchors and aliases. CloudFormation tags (!Ref, !Sub…) and
// variables (${opt:stage}, ${self:custom.x}) are kept as text; ${file(./other.yml)} is read in place.

import path from 'node:path';

const CONFIG_NAME = /(^|\/)serverless[\w.-]*\.ya?ml$/i;
// samples in a test folder describe no real endpoints (the folders whose routes the other frameworks skip too)
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?)\//;
const HANDLER_EXT = ['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.mts', '.cts', '.py'];
const BACKGROUND = ['schedule', 'eventBridge', 'stream', 'sqs', 's3', 'sns', 'cloudwatchEvent', 'cloudwatchLog', 'cognitoUserPool', 'websocket', 'kafka', 'alb', 'iot'];
const MAX_INCLUDE_DEPTH = 8;

/** Is this a Serverless Framework config file (serverless.yml, serverless-api.yml, serverless_users.yaml…)? */
export const isServerlessConfig = (p) => CONFIG_NAME.test(p);

// ---------- a small YAML reader ----------

/** The text of a line without its comment (a # at the start or after a space, outside quotes). */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/** Lines as { indent, text }, with `- item` split into a `-` line and the item one column further in. */
function yamlLines(src) {
  const out = [];
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    if (/^(---|\.\.\.)\s*$/.test(raw)) continue;
    const t = stripComment(raw.replace(/\t/g, '  ')).trimEnd();
    if (!t.trim()) { out.push({ indent: -1, text: '' }); continue; }
    let indent = t.length - t.trimStart().length;
    let text = t.trimStart();
    while (/^-(\s|$)/.test(text)) {
      out.push({ indent, text: '-' });
      const rest = text.slice(1);
      const pad = rest.length - rest.trimStart().length;
      if (!rest.trim()) { text = ''; break; }
      indent += 1 + pad;
      text = rest.trimStart();
    }
    if (text) out.push({ indent, text });
  }
  return out;
}

/**
 * `key: value` as [key, value], or null. One pass along the line (a regular expression here slowed down on long
 * lines). A key may hold colons not followed by a space (Fn::ImportValue:), or be quoted.
 */
function splitKey(text) {
  let end;
  if (text[0] === '"' || text[0] === "'") {
    const close = /^"(?:[^"\\]|\\.)*"|^'(?:[^']|'')*'/.exec(text);
    if (!close) return null;
    end = close[0].length;
    while (text[end] === ' ') end++;
    if (text[end] !== ':') return null;
  } else {
    if (/^[\s{[\]#&*!|>:]|^-(?:[\s:]|$)/.test(text)) return null;
    end = -1;
    for (let i = 0; i < text.length; i++) if (text[i] === ':' && (i + 1 === text.length || text[i + 1] === ' ')) { end = i; break; }
    if (end < 0) return null;
  }
  const after = text.slice(end + 1);
  if (after && after[0] !== ' ') return null;
  return [text.slice(0, end).trimEnd(), after.trim()];
}

function unquote(s) {
  if (/^".*"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"');
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Reads one YAML document; anything it can't make sense of becomes text rather than an error. */
export function parseYaml(src) {
  const lines = yamlLines(src);
  const anchors = new Map();
  let i = 0;
  const skipBlank = () => { while (i < lines.length && lines[i].indent < 0) i++; };

  // a value's own text: tags and anchors taken off, aliases and flow collections read
  const scalar = (text) => {
    let s = text.trim();
    let anchor = null;
    for (;;) {
      const a = /^&([^\s,[\]{}]+)\s*/.exec(s);
      if (a) { anchor = a[1]; s = s.slice(a[0].length); continue; }
      // a CloudFormation tag keeps its value as text ("!Ref OrdersTable"); a type tag (!!str) is dropped
      const t = /^!!\w+\s*/.exec(s);
      if (t) { s = s.slice(t[0].length); continue; }
      break;
    }
    let v;
    const alias = /^\*([^\s,[\]{}]+)$/.exec(s);
    if (alias) v = anchors.get(alias[1]) ?? null;
    else if (/^[[{]/.test(s)) v = flow(s);
    else if (s === '' || s === '~' || s === 'null') v = null;
    else if (s === 'true' || s === 'false') v = s === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(s)) v = Number(s);
    else v = unquote(s);
    if (anchor) anchors.set(anchor, v);
    return v;
  };

  // [a, { b: c }] and { a: b }, nested
  const flow = (s) => {
    let p = 0;
    const ws = () => { while (p < s.length && /\s/.test(s[p])) p++; };
    const item = () => {
      ws();
      // each pass moves forward: a stray ] or } where a value should be is skipped, never read forever
      if (s[p] === '[') { p++; const arr = []; for (ws(); p < s.length && s[p] !== ']'; ws()) { const at = p; arr.push(item()); ws(); if (s[p] === ',') p++; if (p === at) p++; } p++; return arr; }
      if (s[p] === '{') {
        p++; const obj = {};
        for (ws(); p < s.length && s[p] !== '}'; ws()) {
          const at = p;
          const k = atom(true); ws();
          let v = null;
          if (s[p] === ':') { p++; v = item(); }
          obj[k] = v; ws(); if (s[p] === ',') p++;
          if (p === at) p++;
        }
        p++; return obj;
      }
      return scalar(atom(false));
    };
    // text up to the next , ] } (or : for a key), keeping ${…} and quotes whole
    const atom = (key) => {
      ws();
      const q = s[p];
      if (q === '"' || q === "'") { const end = s.indexOf(q, p + 1); const t = s.slice(p, end < 0 ? s.length : end + 1); p += t.length; return key ? unquote(t) : t; }
      let depth = 0, start = p;
      for (; p < s.length; p++) {
        const c = s[p];
        if (c === '$' && s[p + 1] === '{') { depth++; p++; continue; }
        if (c === '}' && depth) { depth--; continue; }
        if (!depth && (c === ',' || c === ']' || c === '}' || (key && c === ':'))) break;
      }
      return s.slice(start, p).trim();
    };
    try { return item(); } catch { return s; }
  };

  // a value written over several lines (a long flow list, or plain text that wraps), joined back up
  const continued = (first, indent) => {
    let text = first;
    while (i < lines.length && (lines[i].indent < 0 || lines[i].indent > indent)) { if (lines[i].indent >= 0) text += ' ' + lines[i].text; i++; }
    return text;
  };

  const block = (indent) => {
    skipBlank();
    if (i >= lines.length || lines[i].indent < indent) return null;
    const at = lines[i].indent;
    if (lines[i].text === '-') return list(at);
    if (splitKey(lines[i].text)) return map(at);
    const first = lines[i++].text;
    return scalar(continued(first, at));
  };

  const list = (indent) => {
    const arr = [];
    for (skipBlank(); i < lines.length && lines[i].indent === indent && lines[i].text === '-'; skipBlank()) {
      i++;
      skipBlank();
      arr.push(i < lines.length && lines[i].indent > indent ? block(indent + 1) : null);
    }
    return arr;
  };

  const map = (indent) => {
    const obj = {};
    for (skipBlank(); i < lines.length && lines[i].indent === indent; skipBlank()) {
      const m = splitKey(lines[i].text);
      if (!m) { // not `key: value`: skip it and what's under it
        i++;
        while (i < lines.length && (lines[i].indent < 0 || lines[i].indent > indent)) i++;
        continue;
      }
      i++;
      const key = unquote(m[0]);
      const rest = m[1];
      let v;
      if (/^[|>][-+\d]*$/.test(rest)) { // a block of text: not needed
        while (i < lines.length && (lines[i].indent < 0 || lines[i].indent > indent)) i++;
        v = '';
      } else {
        // `key: &anchor` or `key: !Tag` with the value on the lines below
        const head = /^((?:&[^\s]+|![^\s]+)\s*)*$/.test(rest) ? rest : null;
        skipBlank();
        const nested = i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text === '-'));
        if (head !== null && nested) {
          v = lines[i].indent === indent ? list(indent) : block(indent + 1);
          const a = /&([^\s]+)/.exec(head);
          if (a) anchors.set(a[1], v);
        } else v = scalar(continued(rest, indent));
      }
      if (key === '<<') {
        for (const src of Array.isArray(v) ? v : [v]) if (src && typeof src === 'object') for (const [k, x] of Object.entries(src)) if (!(k in obj)) obj[k] = x;
      } else obj[key] = v;
    }
    return obj;
  };

  try { return block(0); } catch { return null; }
}

// ---------- Serverless configs ----------

const FILE_REF = /^\$\{file\(\s*['"]?([^'")]+?)['"]?\s*\)(?::([\w.-]+))?(?:\s*,[^}]*)?\}$/;

/**
 * Endpoints and background triggers from every Serverless config in the project.
 * @param files scan files ({ path, repo, symbols, imports })
 * @param read  (path) => file text, '' when it can't be read
 * @returns { routes: [{ file, method, path, line, handler, framework, auth?, config }], triggers, configs, unresolved }
 */
export function serverlessRoutes(files, read) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  // (a config too big for the scan to read is left alone too, rather than read here after all)
  const configs = files.filter((f) => isServerlessConfig(f.path) && !TEST_DIR.test(f.path) && !f.tooLarge);
  if (!configs.length) return { routes: [], triggers: [], configs: [], unresolved: [] };
  const parsed = new Map();
  const load = (p) => { if (!parsed.has(p)) parsed.set(p, byPath.has(p) && !byPath.get(p).tooLarge ? parseYaml(read(p)) : null); return parsed.get(p); };

  // ${file(./x.yml)} and ${file(./x.yml):functions} replaced by what they point at, relative to the file they're in
  const included = new Set();
  const expand = (v, from, depth, seen) => {
    if (typeof v === 'string') {
      const m = FILE_REF.exec(v.trim());
      if (!m || !/\.ya?ml$/i.test(m[1]) || depth >= MAX_INCLUDE_DEPTH) return v;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), m[1].replace(/\\/g, '/')));
      if (seen.has(target)) return null;
      included.add(target);
      let doc = load(target);
      for (const k of m[2] ? m[2].split('.') : []) doc = doc && typeof doc === 'object' ? doc[k] : null;
      return expand(doc, target, depth + 1, new Set(seen).add(target));
    }
    if (Array.isArray(v)) return v.map((x) => expand(x, from, depth, seen));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x, from, depth, seen)]));
    return v;
  };
  // functions: a map, a list of maps, or either one spread over included files
  const functionsOf = (v, out = []) => {
    if (Array.isArray(v)) for (const x of v) functionsOf(x, out);
    else if (v && typeof v === 'object') for (const [name, fn] of Object.entries(v)) if (fn && typeof fn === 'object' && !Array.isArray(fn)) out.push([name, fn]);
    return out;
  };

  const routes = [], triggers = [], unresolved = [], used = [];
  // configs another config includes are read through it (their handlers are relative to that service)
  const docs = configs.map((f) => [f.path, load(f.path)]);
  for (const [p, doc] of docs) if (doc && typeof doc === 'object') expand(doc.functions, p, 0, new Set([p]));
  for (const [p, doc] of docs) {
    if (!doc || typeof doc !== 'object' || included.has(p) || !('functions' in doc)) continue;
    const serviceDir = path.posix.dirname(p);
    const fns = functionsOf(expand(doc.functions, p, 0, new Set([p])));
    if (!fns.length) continue;
    used.push(p);
    for (const [name, fn] of fns) {
      const events = Array.isArray(fn.events) ? fn.events : [];
      const target = handlerTarget(String(fn.handler || ''), serviceDir, byPath, read);
      if (!target) { if (fn.handler && events.length) unresolved.push({ name, handler: String(fn.handler), config: p }); continue; }
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const [kind, spec] = Object.entries(ev)[0] || [];
        if (kind === 'http' || kind === 'httpApi') {
          const e = httpEvent(kind, spec);
          if (!e) continue;
          routes.push({ file: target.file, method: e.method, path: e.path, line: target.line, handler: target.handler, framework: 'serverless', ...(e.auth ? { auth: e.auth } : {}), ...(target.wrap ? { wrapFile: target.wrap.file, wrapLine: target.wrap.line, wrapName: target.wrap.name } : {}), config: p });
        } else if (BACKGROUND.includes(kind)) {
          triggers.push({ name, on: kind, ...(describeTrigger(spec) ? { what: describeTrigger(spec) } : {}), file: target.file, line: target.line });
        }
      }
    }
  }
  const seen = new Set();
  return {
    routes: routes.filter((r) => { const k = `${r.file}|${r.method}|${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; }),
    triggers, configs: used, unresolved,
  };
}

/** An `http:` or `httpApi:` event as { method, path, auth }; null when its address isn't written out. */
function httpEvent(kind, spec) {
  let method, p, auth = null;
  if (typeof spec === 'string') {
    // `http: GET /users`, `httpApi: 'POST /orders'`, `httpApi: '*'`
    const m = /^\s*(\S+)(?:\s+(\S+))?\s*$/.exec(spec);
    if (!m) return null;
    if (m[2]) { method = m[1]; p = m[2]; } else if (m[1] === '*') { method = '*'; p = '/{proxy+}'; } else return null;
  } else if (spec && typeof spec === 'object') {
    method = spec.method; p = spec.path;
    const a = spec.authorizer;
    if (a && !(typeof a === 'string' && /^(none|false)$/i.test(a))) auth = authName(a);
    else if (spec.private === true) auth = 'API key';
  } else return null;
  if (typeof p !== 'string') { // '' is the root
    if (kind === 'httpApi' && method === '*') p = '/{proxy+}'; else return null;
  }
  method = String(method || (kind === 'httpApi' ? '*' : '')).toUpperCase();
  if (!method) return null;
  if (method === '*') method = 'ANY';
  if (!/^[A-Z]+$/.test(method)) return null;
  // a variable in the address stands for one part of it, like a parameter
  p = '/' + p.trim().replace(/^\/+/, '').replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '{var}');
  return { method, path: p.replace(/\/+$/, '') || '/', auth };
}

/** What to call an authorizer: its name, else "authorizer". */
function authName(a) {
  const plain = (s) => (typeof s === 'string' && /^[\w-]{1,60}$/.test(s) ? s : null);
  if (typeof a === 'string') return plain(a) || plain(a.split(':').pop()) || 'authorizer';
  if (a && typeof a === 'object') return plain(a.name) || (a.type && plain(String(a.type)) ? String(a.type) : null) || 'authorizer';
  return 'authorizer';
}

/** A short note on what a background trigger runs on: a schedule, a queue, a bucket. */
function describeTrigger(spec) {
  if (typeof spec === 'string') return /^[\w ().,*?/:-]{1,80}$/.test(spec) ? spec : null;
  if (!spec || typeof spec !== 'object') return null;
  const v = spec.rate || spec.bucket || spec.queue || spec.arn || spec.topicName || spec.pattern?.source || spec.eventBus;
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length <= 80 && !/^\$\{|^!/.test(s) ? s : null;
}

/**
 * The file and line that answer `handler: src/users.signUp`. When that export only hands the event on to a
 * function in another of the project's files (`export const signUp = (e) => wrap(e, opts, users.signUp)`),
 * the endpoint goes to that file, since it holds the code that does the work.
 */
function handlerTarget(handler, serviceDir, byPath, read) {
  const m = /^(.+)\.([A-Za-z_$][\w$]*)$/.exec(handler.trim());
  if (!m) return null;
  const base = path.posix.normalize(path.posix.join(serviceDir, m[1].replace(/^\.\//, '')));
  let file = HANDLER_EXT.map((e) => byPath.get(base + e)).find(Boolean);
  if (!file) return null;
  let name = m[2];
  // a handlers file that re-exports it: `export { signUp } from './users'` or `export * from './users'`
  if (!(file.symbols || []).some((s) => s.name === name)) {
    for (const imp of file.imports || []) {
      const to = imp.reexport && imp.files?.length === 1 && byPath.get(imp.files[0]);
      if (!to) continue;
      const orig = imp.exported ? imp.exported[name] : (to.symbols || []).some((s) => s.name === name) && name;
      if (orig) { file = to; name = orig; break; }
    }
  }
  const lineOf = (f, n) => (f.symbols || []).find((s) => s.name === n)?.line || 1;
  const own = { file: file.path, line: lineOf(file, name), handler: name };
  if (/\.py$/.test(file.path)) return own;
  const hop = wrappedHandler(read(file.path), name, file, byPath);
  // the wrapper is kept too: a sign-in check handed to it (withAuth, requireUser) protects the endpoint
  return hop ? { file: hop.file.path, line: lineOf(hop.file, hop.name), handler: hop.name, wrap: { file: own.file, line: own.line, name } } : own;
}

/** The function an export passes the request on to, when it's clearly one function from another project file. */
function wrappedHandler(src, name, file, byPath) {
  if (!src) return null;
  const def = new RegExp(`(?:\\bexport\\s+(?:const|let|var)\\s+|\\bexport\\s+(?:async\\s+)?function\\s+|\\b(?:module\\.)?exports\\.)${name.replace(/\$/g, '\\$')}\\b`).exec(src);
  if (!def) return null;
  // the definition: up to the next export (or 1,500 characters)
  const after = src.slice(def.index + def[0].length, def.index + def[0].length + 1500);
  const body = after.slice(0, (/\n\s*(?:export\b|module\.exports|exports\.)/.exec(after)?.index) ?? after.length);
  // imported names (and namespaces) that point at one of the project's own files
  const local = new Map();
  for (const imp of file.imports || []) {
    const to = imp.files?.length === 1 && byPath.get(imp.files[0]);
    if (to) for (const [l, orig] of Object.entries(imp.locals || {})) local.set(l, { to, orig });
  }
  if (!local.size) return null;
  const pick = (ref) => {
    const r = /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?$/.exec(ref.trim());
    const imp = r && local.get(r[1]);
    if (!imp) return null;
    // ns.fn or a default export's method; a named import is that function itself
    const fn = r[2] ? (imp.orig === '*' || imp.orig === 'default' ? r[2] : null) : (imp.orig !== '*' && imp.orig !== 'default' ? imp.orig : null);
    return fn ? { file: imp.to, name: fn } : null;
  };
  // 1. something.<same name> from an imported file: users.signUp for the export signUp
  for (const m of body.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\.${name.replace(/\$/g, '\\$')}\\b`, 'g'))) { const t = pick(m[0]); if (t) return t; }
  // 2. the last argument of the call the export makes: wrap(event, opts, check, users.handleSignUp)
  const call = /^[^=(]*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]{0,200})?=>\s*(?:await\s+)?[A-Za-z_$][\w$.]*\s*\(/.exec(body)
    || /^[^=(]*=\s*[A-Za-z_$][\w$.]*\s*\(/.exec(body);
  if (!call) return null;
  let depth = 1, j = call[0].length, last = j;
  for (; j < body.length && depth; j++) {
    const c = body[j];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 1) last = j + 1;
  }
  if (depth) return null;
  return pick(body.slice(last, j - 1));
}
