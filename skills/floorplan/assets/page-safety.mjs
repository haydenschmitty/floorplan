// How text gets into a map page safely. Used by build.mjs, and by the map's server (serve.mjs, which finds a
// copy of this file next to it in floorplan/). Plain Node: no dependencies, nothing from the network.
//
// A map shows text Floorplan didn't write: file names, route paths and comments from the code, and
// descriptions written by an agent or a person. A page must never treat any of it as markup, so:
// - scriptJson() is the one way data goes into a <script> block. Every <, >, & and line or paragraph
//   separator is written as a \u escape: the same JSON value, but nothing the HTML parser reacts to
//   (a stray "<!--<script>" in a route path would otherwise make the browser swallow the rest of the page).
// - scriptCode() is the one way code (the layout engine, the page's own add-ons) goes into a <script> block.
// - withPolicy() gives a page its Content-Security-Policy: only the page's own scripts run (by hash), and an
//   exported copy can't contact anything at all, so even a bug that let text become script couldn't send the
//   map anywhere.
import crypto from 'node:crypto';

const JSON_ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };

/** JSON for inside a <script> block: parses to exactly the same value, with no character the HTML parser acts on. */
export function scriptJson(value) {
  return String(JSON.stringify(value) ?? 'null').replace(/[<>&\u2028\u2029]/g, (c) => JSON_ESCAPES[c]);
}

/**
 * JavaScript source for inside a <script> block. "</script" would end the block and "<!--" can stop the next
 * "</script>" from ending it, so both are rewritten the way JavaScript reads them the same (in strings,
 * template literals, regular expressions and comments).
 */
export function scriptCode(src) {
  return String(src).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '\\x3C!--');
}

const isEnd = (c) => c === undefined || /[\t\n\f\r />]/.test(c);
/**
 * The inline <script> blocks of a page, as the browser's HTML parser finds them (including the "escaped"
 * states a "<!--" inside a script starts), skipping HTML comments, <style>, <title> and <textarea>.
 * Returns [{ start, open, end, body, attrs }]: `body` is the text between the tags.
 */
export function scriptBlocks(html) {
  const lower = html.toLowerCase();
  const out = [];
  let i = 0;
  while (i < lower.length) {
    const lt = lower.indexOf('<', i);
    if (lt < 0) break;
    if (lower.startsWith('<!--', lt)) { const e = lower.indexOf('-->', lt + 4); i = e < 0 ? lower.length : e + 3; continue; }
    const raw = /^<(style|title|textarea)(?=[\t\n\f\r />])/.exec(lower.slice(lt, lt + 10));
    if (raw) { const e = lower.indexOf('</' + raw[1], lt); i = e < 0 ? lower.length : e + 2 + raw[1].length; continue; }
    if (!(lower.startsWith('<script', lt) && isEnd(lower[lt + 7]))) { i = lt + 1; continue; }
    const open = lower.indexOf('>', lt);
    if (open < 0) break;
    let j = open + 1, state = 'data', end = -1;
    while (j < lower.length) {
      const c = lower[j];
      if (c === '<' || c === '-') {
        if (state !== 'double' && lower.startsWith('</script', j) && isEnd(lower[j + 8])) { end = j; break; }
        if (state === 'data' && lower.startsWith('<!--', j)) { state = 'escaped'; j += 4; continue; }
        if (state !== 'data' && lower.startsWith('-->', j)) { state = 'data'; j += 3; continue; }
        if (state === 'escaped' && lower.startsWith('<script', j) && isEnd(lower[j + 7])) { state = 'double'; j += 7; continue; }
        if (state === 'double' && lower.startsWith('</script', j) && isEnd(lower[j + 8])) { state = 'escaped'; j += 8; continue; }
      }
      j++;
    }
    if (end < 0) end = lower.length;
    out.push({ start: lt, open: open + 1, end, body: html.slice(open + 1, end), attrs: html.slice(lt + 7, open) });
    const close = lower.indexOf('>', end);
    i = close < 0 ? lower.length : close + 1;
  }
  return out;
}

/** The CSP source for one inline script, as a browser computes it (over the text after line endings are normalised). */
export const scriptHash = (body) => `'sha256-${btoa(String.fromCharCode(...crypto.createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest()))}'`;

// What a page may do besides run its own scripts. Inline styles stay allowed: the map colours its cards with
// style attributes, and a style can't run code. Images and fonts come only from inside the page (data: URLs).
const POLICIES = {
  // an exported copy, to share: talks to nothing
  export: { 'connect-src': "'none'" },
  // the map in floorplan/index.html, and the page serve.mjs serves: may talk to its own local server
  // (Ask, live reload, flows, Export, Change and Undo) and nothing else
  local: { 'connect-src': "'self'" },
};
const MARK = 'data-floorplan-policy';
const POLICY_TAG = new RegExp(`<meta http-equiv="Content-Security-Policy" ${MARK}="[a-z]+" content="[^"]*">\\n?`, 'g');

/** The policy text for a page and kind ('export' or 'local'). */
export function policyFor(html, kind) {
  if (!POLICIES[kind]) throw new Error(`unknown policy "${kind}"`);
  const hashes = [...new Set(scriptBlocks(html.replace(POLICY_TAG, '')).filter((b) => !/\ssrc\s*=/i.test(b.attrs)).map((b) => scriptHash(b.body)))];
  return [
    "default-src 'none'",
    `script-src ${hashes.join(' ') || "'none'"}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    `connect-src ${POLICIES[kind]['connect-src']}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * The page with its Content-Security-Policy as early in <head> as it can go (right after the charset), replacing
 * any policy this function added before. Call it last, once every script in the page is final.
 */
export function withPolicy(html, kind) {
  const clean = html.replace(POLICY_TAG, '');
  const tag = `<meta http-equiv="Content-Security-Policy" ${MARK}="${kind}" content="${policyFor(clean, kind)}">\n`;
  const charset = /<meta charset="utf-8">\n?/i.exec(clean);
  if (charset) return clean.slice(0, charset.index + charset[0].length) + tag + clean.slice(charset.index + charset[0].length);
  const head = /<head>\n?/i.exec(clean);
  if (!head) throw new Error('the page has no <head> to put its policy in');
  return clean.slice(0, head.index + head[0].length) + tag + clean.slice(head.index + head[0].length);
}
