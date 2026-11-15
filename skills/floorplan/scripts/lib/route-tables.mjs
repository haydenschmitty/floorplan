// Endpoints declared as data rather than with app.get(…): route-table objects
// ({ method: "GET", path: "/x" or /^\/x$/, handle: … }) and the literal keys of Bun.serve({ routes }).
// Approximate, like the rest of extract.mjs: a small literal-aware scanner, no parser.

const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const HANDLER_KEYS = new Set(['handle', 'handler', 'fetch', 'action', 'resolve']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'async', 'function', 'typeof', 'new', 'void', 'yield', 'super']);
const MAX_EXPANSIONS = 8;

function quotedEnd(code, i) {
  const q = code[i];
  for (let j = i + 1; j < code.length; j++) {
    if (code[j] === '\\') j++;
    else if (code[j] === q || code[j] === '\n') return j + 1;
  }
  return code.length;
}

function templateEnd(code, i) {
  for (let j = i + 1; j < code.length; j++) {
    if (code[j] === '\\') j++;
    else if (code[j] === '`') return j + 1;
    else if (code[j] === '$' && code[j + 1] === '{') j = balancedEnd(code, j + 1) - 1;
  }
  return code.length;
}

function regexEnd(code, i) {
  let inClass = false;
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (c === '\\') j++;
    else if (c === '\n') return j;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '/') { j++; while (/[a-z]/i.test(code[j] ?? '')) j++; return j; }
  }
  return code.length;
}

/** A `/` starts a regex literal where a value is expected, not after an operand (division). */
function startsRegex(code, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(code[k])) k--;
  return k < 0 || /[(,=:[!&|?{};]/.test(code[k]) || (code[k] === '>' && code[k - 1] === '=');
}

/** The index just past the string, template or regex literal starting at `i`, or null when none does. */
function literalEnd(code, i) {
  const c = code[i];
  if (c === '"' || c === "'") return quotedEnd(code, i);
  if (c === '`') return templateEnd(code, i);
  if (c === '/' && startsRegex(code, i)) return regexEnd(code, i);
  return null;
}

/** The index just past the bracket that closes the one at `open`. */
function balancedEnd(code, open) {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    const end = literalEnd(code, j);
    if (end != null) { j = end - 1; continue; }
    const c = code[j];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if ((c === '}' || c === ')' || c === ']') && --depth === 0) return j + 1;
  }
  return code.length;
}

/** Where the value starting at `i` ends: at the next top-level comma, or at `close`. */
function valueEnd(code, i, close) {
  for (let j = i; j < close; j++) {
    const end = literalEnd(code, j);
    if (end != null) { j = end - 1; continue; }
    const c = code[j];
    if (c === '{' || c === '(' || c === '[') j = balancedEnd(code, j) - 1;
    else if (c === ',') return j;
  }
  return close;
}

const KEY = /\s*(?:([A-Za-z_$][\w$]*)|"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`)\s*:/y;

/**
 * The `key: value` entries of the object literal whose `{` is at `open`, in order:
 * [{ key, at (offset of the key), start (offset of the value), value (its trimmed text) }].
 * Spreads and method shorthand have no key and are skipped.
 */
function entries(code, open) {
  const out = [];
  const close = balancedEnd(code, open) - 1;
  for (let i = open + 1; i < close;) {
    KEY.lastIndex = i;
    const k = KEY.exec(code);
    const from = k ? KEY.lastIndex : i;
    const end = valueEnd(code, from, close);
    if (k) {
      const text = code.slice(from, end);
      out.push({ key: k[1] ?? k[2] ?? k[3] ?? k[4], at: i + k[0].search(/\S/), start: from + text.search(/\S|$/), value: text.trim() });
    }
    i = end + 1;
  }
  return out;
}

/** The `{` of the object around offset `i`, or -1; strings holding braces before `i` can mislead it. */
function enclosingBrace(code, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0 && i - j < 4000; j--) {
    if (code[j] === '}') depth++;
    else if (code[j] === '{' && depth-- === 0) return j;
  }
  return -1;
}

/** `listItems` for a bare name, else the first function an arrow or function body calls. */
function handlerName(value) {
  const ident = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.exec(value)?.[0];
  if (ident) return ident.split('.').pop();
  const body = /=>|\bfunction\b[^{]*\{/.exec(value);
  if (!body) return undefined;
  for (const m of value.slice(body.index + body[0].length).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const name = m[1].split('.').pop().trim();
    if (!KEYWORDS.has(name)) return name;
  }
  return undefined;
}

const PARAM = '\u0001', STAR = '\u0002', SYNTAX = '\u0003';

function parseClass(src, pos) {
  const start = pos.i;
  while (pos.i < src.length && src[pos.i] !== ']') pos.i += src[pos.i] === '\\' ? 2 : 1;
  const body = src.slice(start, pos.i++);
  const slash = body.includes('/');
  return { t: 'class', spans: body.startsWith('^') ? !slash : slash };
}

function parseEscape(src, pos) {
  const e = src[pos.i++] ?? '';
  if (/[dws]/.test(e)) return { t: 'class', spans: false };
  if (/[DWS]/.test(e)) return { t: 'class', spans: true };
  if (/[/.\-_~]/.test(e)) return { t: 'lit', v: e };
  return { t: 'syntax' };
}

function parseGroup(src, pos) {
  const head = /^(?:\?(?:[=!]|<[=!]|:|<[A-Za-z_$][\w$]*>))?/.exec(src.slice(pos.i))[0];
  pos.i += head.length;
  const alts = parseAlternatives(src, pos);
  pos.i++;
  if (/^\?<?[=!]$/.test(head)) return { t: 'skip' };
  return { t: 'group', capture: head !== '?:', alts };
}

function parseAtom(src, pos) {
  const c = src[pos.i++];
  if (c === '\\') return parseEscape(src, pos);
  if (c === '[') return parseClass(src, pos);
  if (c === '(') return parseGroup(src, pos);
  if (c === '.') return { t: 'class', spans: true };
  if (c === '^' || c === '$') return { t: 'anchor' };
  if (/[\w\-~%@/]/.test(c)) return { t: 'lit', v: c };
  return { t: 'syntax' };
}

/** Alternatives up to the `)` that closes the current group (or the end): [[atom, …], …]. */
function parseAlternatives(src, pos) {
  const alts = [[]];
  while (pos.i < src.length && src[pos.i] !== ')') {
    if (src[pos.i] === '|') { alts.push([]); pos.i++; continue; }
    const atom = parseAtom(src, pos);
    atom.q = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/.exec(src.slice(pos.i))?.[0] || '';
    pos.i += atom.q.length;
    alts[alts.length - 1].push(atom);
  }
  return alts;
}

const spans = (alts) => alts.some((seq) => seq.some((a) => a.v === '/' || a.spans || (a.alts && spans(a.alts))));
const plainLiteral = (seq) => seq.every((a) => a.t === 'lit' && !a.q);
const optional = (q) => q === '?' || q === '??';

/**
 * A group of plain words as the strings it stands for: `(?:mails|inbox)` → two, `(?:\/edit)?` → with and
 * without. Past the expansion budget, a group within one path segment matches any segment; otherwise null.
 */
function groupOptions(a, count, room) {
  if (a.q && !optional(a.q)) return [SYNTAX];
  const options = a.alts.map((seq) => seq.map((x) => x.v).join(''));
  if (a.q) options.unshift('');
  if (count * options.length <= room) return options;
  return !a.q && !spans(a.alts) ? [STAR] : [SYNTAX];
}

/** One atom as the strings it can stand for, given how many variants exist so far and the room left. */
function renderAtom(a, count, room) {
  if (a.t === 'skip') return [''];
  if (a.t === 'lit') return [a.q ? SYNTAX : a.v];
  if (a.t === 'class') return [!a.q || optional(a.q) ? SYNTAX : a.spans ? STAR : PARAM];
  if (a.t !== 'group') return [SYNTAX];
  if (a.capture) return [a.q ? SYNTAX : spans(a.alts) ? STAR : PARAM];
  return a.alts.every(plainLiteral) ? groupOptions(a, count, room) : [SYNTAX];
}

/**
 * Marked-up variant → route path: parameters numbered in order, `.*` and spanning captures a wildcard
 * segment. Leftover regex syntax, a capture inside a word, or no real word: null, so an odd regex never
 * widens to match anything.
 */
function toRoutePath(variant) {
  let n = 0;
  const segs = variant.split('/');
  if (segs[0] !== '' || variant.includes(SYNTAX)) return null;
  const out = segs.slice(1).filter(Boolean).map((s) => (s === PARAM ? `:p${++n}` : s.includes(PARAM) ? null : s.includes(STAR) ? '*' : s));
  if (out.includes(null)) return null;
  return out.some((s) => /[A-Za-z]{2,}/.test(s) && !s.startsWith(':')) ? '/' + out.join('/') : null;
}

/** One top-level alternative, without its anchors and a trailing optional slash. */
function branchAtoms(seq) {
  const atoms = [...seq];
  while (atoms[0]?.t === 'anchor') atoms.shift();
  while (atoms.at(-1)?.t === 'anchor') atoms.pop();
  const last = atoms.at(-1);
  if (last?.t === 'lit' && last.v === '/' && optional(last.q)) atoms.pop();
  return atoms;
}

/**
 * The route paths a path-matching regex stands for (source without slashes or flags):
 * `^\/api\/items\/([^/]+)$` → ['/api/items/:p1']. Each top-level alternative converts on its own;
 * lookarounds are dropped, groups of plain words expand (up to 8 paths per regex), and only `.*` or a
 * capture that can span `/` becomes `*`. Returns [] for anything else; never throws.
 */
export function regexRoutePaths(source) {
  const pos = { i: 0 };
  const top = parseAlternatives(source, pos);
  if (pos.i < source.length) return [];
  let total = 0;
  const paths = top.flatMap((seq) => {
    let variants = [''];
    for (const atom of branchAtoms(seq)) {
      const parts = renderAtom(atom, variants.length, MAX_EXPANSIONS - total);
      variants = variants.flatMap((v) => parts.map((p) => v + p));
    }
    total += variants.length;
    return variants.map(toRoutePath).filter(Boolean);
  });
  return [...new Set(paths)];
}

function pathValues(value) {
  const str = /^(["'`])(\/[^"'`\n]*)\1$/.exec(value);
  if (str) return str[1] === '`' && str[2].includes('${') ? [] : [str[2]];
  const re = /^\/([\s\S]+)\/[a-z]*$/.exec(value);
  return re ? regexRoutePaths(re[1]) : [];
}

function tableRoutes(list, at) {
  const method = list.find((e) => e.key === 'method');
  const pathEntry = list.find((e) => e.key === 'path');
  const handle = list.find((e) => HANDLER_KEYS.has(e.key));
  if (!method || !pathEntry || !handle) return [];
  const verb = /^(["'`])([A-Za-z]+)\1$/.exec(method.value)?.[2].toUpperCase();
  if (!VERBS.has(verb)) return [];
  const handler = handlerName(handle.value);
  const line = at(pathEntry.at);
  return pathValues(pathEntry.value).map((path) => ({ method: verb, path, var: null, line, framework: 'route-table', ...(handler ? { handler } : {}) }));
}

/** `{ method: "GET", path: …, handle: … }` objects, found from each `method:` key. */
function routeTableRoutes(code, at) {
  if (!/\bmethod\s*:\s*["'`]/.test(code) || !/\bpath\s*:/.test(code)) return [];
  const routes = [];
  const seen = new Set();
  for (const m of code.matchAll(/\bmethod\s*:\s*["'`]/g)) {
    const open = enclosingBrace(code, m.index);
    if (open < 0 || seen.has(open)) continue;
    seen.add(open);
    routes.push(...tableRoutes(entries(code, open), at));
  }
  return routes;
}

/** `routes: { "/api/x": { GET: a, POST: b }, "/y": handler }` in a file that starts Bun.serve. */
function bunRoutes(code, at) {
  if (!/\bBun\.serve\s*(?:<[^>]*>)?\s*\(/.test(code)) return [];
  const routes = [];
  for (const m of code.matchAll(/\broutes\s*:\s*\{/g)) {
    for (const e of entries(code, m.index + m[0].length - 1)) {
      if (!e.key.startsWith('/')) continue;
      const line = at(e.at);
      const methods = e.value.startsWith('{') ? entries(code, e.start).filter((x) => VERBS.has(x.key)) : [];
      const targets = methods.length ? methods : [{ key: 'ANY', value: e.value }];
      for (const t of targets) {
        const handler = handlerName(t.value);
        routes.push({ method: t.key, path: e.key, var: null, line, framework: 'bun', ...(handler ? { handler } : {}) });
      }
    }
  }
  return routes;
}

/** Route records ({ method, path, var, line, framework, handler? }) declared as data in comment-stripped JS/TS. */
export function dataRoutes(code, at) {
  return [...routeTableRoutes(code, at), ...bunRoutes(code, at)];
}
