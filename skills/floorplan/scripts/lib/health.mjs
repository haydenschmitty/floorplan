// Health check: plain-language warnings about the codebase (secrets, endpoints anyone can call,
// the usual Supabase / Firebase / Stripe / CORS mistakes, unused files, oversized files), written for
// people who built an app with AI and don't know its insides. It's a check, not an audit. Precision
// beats recall: a false alarm costs this audience more than a missed one.
//
// findIssues(src, file)  — called by scan.mjs for every code/config/docs file with its source.
//                           Returns raw findings for that file, stored in scan.json files[].issues.
//                           Findings never contain a secret's value, only its line, kind and a masked hint.
// buildHealth(ctx)       — called by build.mjs with { graph, scan, arch, root } after the graph is built.
//                           Returns { summary: { high, medium, low }, issues: [...] }, stored as graph.health.

import fs from 'node:fs';
import path from 'node:path';
import { git, compileGlob, blockComments, blankBlockComments, forwardIndexOf, callArgs } from './common.mjs';
import { csRoutes, csCors, csStripeEvents, csStripeVerified, csBuildContext, csFinding } from './health-csharp.mjs';
import { stripPhp, phpBare, phpBrackets, phpBudget, phpParts, phpSplit, phpStr, phpArrayBody, phpNamed, phpPairs } from './extract.mjs';

export const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

/** Shannon entropy in bits per character: random keys score ~4+, words and placeholders ~2-3. */
function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let e = 0;
  for (const n of counts.values()) { const p = n / s.length; e -= p * Math.log2(p); }
  return e;
}

// Files where keys are usually fake: tests, fixtures, examples, docs.
const TEST_FILE = /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|fixtures?|testdata|mocks?)\/|\.(test|spec|stories)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/i;
const EXAMPLE_FILE = /(^|\/)(examples?|samples?|docs?|demo)\/|\.(example|sample|template|dist|tmpl)(\.|$)|(^|\/)[^/]*example[^/]*$/i;
// The same "your key here" and "change this" words in Portuguese, Spanish, French and German, whole words only
// (between separators), so a random key that happens to hold the letters "sua" or "ici" is still a key.
const PLACEHOLDER_WORDS = 'generate'
  + '|sua|seu|aqui|aquí|troque|trocar|altere|alterar|mude|mudar|substitua|substituir|defina|definir|coloque|insira|gere|gerar|exemplo'
  + '|tu|cambia|cambiar|cambiame|cámbiame|reemplaza|reemplazar|genera|generar|ejemplo'
  + '|votre|ici|changez|changer|remplacez|remplacer|modifiez|générez|generez|exemple'
  + '|dein|deine|hier|ändern|aendern|ersetzen|beispiel';
const PLACEHOLDER = new RegExp(String.raw`your|xxxx|example|changeme|change[-_]?me|placeholder|replace|dummy|fake|sample|redacted|insert|<[^>]*>|\$\{|\{\{|%\(|\*\*\*|0{8,}|1234567|abcdef|_here\b|-here\b`
  + String.raw`|(?<![\p{L}\d])(?:${PLACEHOLDER_WORDS})(?![\p{L}\d])`, 'iu');

// ---------- 1. secrets ----------

// Well-known key formats. `sev` defaults to high; `live` formats are flagged even in test files.
const FORMATS = [
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'an Amazon Web Services (AWS) access key', svc: 'AWS', live: true },
  { re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/g, what: 'a Stripe live secret key', svc: 'Stripe', live: true },
  { re: /\b(?:sk|rk)_test_[0-9a-zA-Z]{20,}/g, what: 'a Stripe test key', svc: 'Stripe', sev: 'medium' },
  { re: /\bwhsec_[A-Za-z0-9]{24,}/g, what: 'a Stripe webhook signing secret', svc: 'Stripe' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, what: 'a GitHub access token', svc: 'GitHub', live: true },
  { re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g, what: 'a GitHub access token', svc: 'GitHub', live: true },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, what: 'a GitLab access token', svc: 'GitLab', live: true },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, what: 'a Slack token', svc: 'Slack', live: true },
  { re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g, what: 'a Slack webhook address (anyone with it can post to your Slack)', svc: 'Slack', sev: 'medium' },
  { re: /\bAIza[0-9A-Za-z_\-]{35}\b/g, what: 'a Google API key', svc: 'Google Cloud', sev: 'medium', skipIf: /firebase|authDomain|messagingSenderId/i },
  { re: /\bGOCSPX-[A-Za-z0-9_\-]{20,}/g, what: 'a Google sign-in client secret', svc: 'Google Cloud' },
  { re: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_\-]{40,}/g, what: 'an Anthropic (Claude) API key', svc: 'Anthropic', live: true },
  { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{16,}T3BlbkFJ[A-Za-z0-9_\-]{16,}/g, what: 'an OpenAI API key', svc: 'OpenAI', live: true },
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{40,}/g, what: 'an OpenAI API key', svc: 'OpenAI', live: true },
  // (a passphrase-protected key, ENCRYPTED PRIVATE KEY or Proc-Type: 4,ENCRYPTED, is left alone: see encryptedKeyAt)
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, what: 'a private key', svc: null, whole: true },
  { re: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g, what: 'a SendGrid email API key', svc: 'SendGrid', live: true },
  { re: /\bsq0csp-[0-9A-Za-z_\-]{40,}/g, what: 'a Square app secret', svc: 'Square', live: true },
  { re: /\bsq0atp-[0-9A-Za-z_\-]{20,}/g, what: 'a Square access token', svc: 'Square', live: true },
  { re: /\bEAAA[A-Za-z0-9_\-]{60,}/g, what: 'a Square access token', svc: 'Square', live: true },
  { re: /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, what: 'a Shopify access token', svc: 'Shopify', live: true },
  { re: /\bhf_[A-Za-z0-9]{30,}\b/g, what: 'a Hugging Face token', svc: 'Hugging Face', live: true },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, what: 'an npm publishing token', svc: 'npm', live: true },
  { re: /\bsbp_[a-f0-9]{40}\b/g, what: 'a Supabase account token', svc: 'Supabase', live: true },
  { re: /\bsb_secret_[A-Za-z0-9_\-]{20,}/g, what: 'a Supabase secret key', svc: 'Supabase', live: true },
  { re: /\b\d{8,10}:AA[0-9A-Za-z_\-]{33}\b/g, what: 'a Telegram bot token', svc: 'Telegram', live: true },
  { re: /\bdop_v1_[a-f0-9]{64}\b/g, what: 'a DigitalOcean token', svc: 'DigitalOcean', live: true },
  { re: /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/g, what: 'an Airtable token', svc: 'Airtable', live: true },
];
// A key starts where a run of key characters starts: "\b" alone would also try from inside "sk-sk-sk-…" or
// "xoxb-xoxb-…" at every repeat, and each try scans to the end of the run (quadratic on a hostile file).
for (const fm of FORMATS) if (fm.re.source.startsWith('\\b')) fm.re = new RegExp(`(?<![A-Za-z0-9_\\-.])${fm.re.source.slice(2)}`, fm.re.flags);
const JWT = /(?<![A-Za-z0-9_\-.])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g;
const DB_URL = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?)(?:\+\w+)?:\/\/([^:\s\/'"@]{1,200}):([^@\s'"]{1,200})@([^\/\s'":?,]+)/g;
// .NET-style connection strings: "Server=db.example.com;User Id=app;Password=…;". Each part is bounded and
// ends at ";", so a long line of look-alikes can't make every match scan to its end.
const ADO_CONN = /\b(?:Server|Host|Data Source|Address|Addr)\s*=[^"'\n;]{0,200};(?:[^"'\n;]{0,200};){0,10}?[ \t]*(?:Password|Pwd)\s*=\s*([^;"'\n]{1,200})/gi;
// SQL Server's names for this computer: (localdb)\MSSQLLocalDB, (local), "."
const ADO_LOCAL_HOST = /^(\(localdb\)|\(local\)|\.)$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|mysql|redis|mongo|database|host\.docker\.internal)$/i;

// Names that hold secrets (after camelCase → snake_case). Public-by-design keys are excluded below.
const SECRET_NAME = /(?:^|[_.-])(api_?key|apikey|secret(?:_?key)?|client_?secret|app_?secret|token|access_?token|refresh_?token|auth_?token|authtoken|bearer_?token|passw(?:or)?d|passwd|pwd|private_?key|secret_?access_?key|signing_?(?:key|secret)|signature_?key|webhook_?secret|encryption_?key|auth(?:orization)?_?key|master_?key|credentials?)$/i;
const PUBLIC_NAME = /(^|_)(public|publishable|anon|site_?key|example|sample|test|dummy|fake|mock|placeholder|default|field|label|header|name|type|url|uri|endpoint|path|file|env|var|prefix|length|len|min|max|regex|pattern|format|expires?|ttl)(_|$)|^(next_public|vite|react_app|expo_public|nuxt_public|gatsby)_/i;
const ENV_LOOKUP = /Environment\.GetEnvironmentVariable|GetConnectionString\(|Configuration\[|os\.environ|os\.getenv|getenv\(|process\.env|import\.meta\.env|ENV\[|ENV\.fetch|System\.getenv|Deno\.env|secrets\.|config\(\s*['"]|env\(\s*['"]|\$\{\{/;
const PASSWORD_NAME = /pass|pwd/i;
const CONFIG_LANGS = new Set(['yaml', 'yml', 'ini', 'cfg', 'conf', 'properties', 'env', 'toml']);

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const kindFromName = (name) => {
  const n = snake(name);
  if (/pass|pwd/.test(n)) return 'a password';
  if (/private_?key/.test(n)) return 'a private key';
  if (/token/.test(n)) return 'an access token';
  if (/api_?key|apikey/.test(n)) return 'an API key';
  if (/credential/.test(n)) return 'login credentials';
  return 'a secret key';
};
const mask = (v, password) => password || v.length < 12 ? `${v.length} characters` : `starts “${v.slice(0, 4)}…”, ${v.length} characters`;

// A stored password hash isn't the password: bcrypt / argon2 / scrypt / crypt(3) ($2b$…, $argon2id$…,
// $6$…), Django's pbkdf2_sha256$…, LDAP's {SSHA}…, and anything kept under a name that says it's a hash.
const HASHED_VALUE = /^\$(2[abxy]?|argon2(id|i|d)|scrypt|pbkdf2[\w-]*|[156]|y|7|sha\d*|md5)\$|^(pbkdf2_sha\d+|bcrypt(_sha256)?|argon2|scrypt|sha1|md5)\$|^\{(S?SHA\d*|SMD5|CRYPT|PBKDF2[\w-]*)\}/i;
// (HASH_SECRET, PASSWORD_HASH_KEY and HASH_SALT are the secret that makes the hash, so they don't count.)
const HASHED_NAME = /(^|_)(hash|hashed|hashes|digest|bcrypt|argon2?|scrypt|pbkdf2)(_(?!.*(secret|key|salt|pepper|token))|$)/i;
// Encrypted values are safe to commit (that's the point): dotenvx's encrypted:…, sops' ENC[AES256_GCM,…],
// Ansible Vault, AWS KMS ciphertext, HashiCorp Vault transit (vault:v1:…), age and PGP armour, OpenSSL's
// "Salted__" (U2FsdGVkX1…) and Python's Fernet (gAAAAA…).
const ENCRYPTED_VALUE = /^encrypted:[A-Za-z0-9+/=_-]{20,}|^ENC\[[A-Z0-9_]+,data:|^\$ANSIBLE_VAULT;|^!vault\b|^AQICAH[A-Za-z0-9+/=]{40,}$|^vault:v\d+:|^-----BEGIN (AGE ENCRYPTED FILE|PGP MESSAGE)-----|^U2FsdGVkX1[A-Za-z0-9+/=]{10,}|^gAAAAA[A-Za-z0-9_=-]{40,}/;
/** A value that's a password hash or ciphertext rather than the secret itself. */
export const protectedValue = (v, name = '') => ENCRYPTED_VALUE.test(v) || HASHED_VALUE.test(v) || HASHED_NAME.test(snake(name));

// A variable handed along, not a value: "$DB_PASSWORD" in a shell script or a PHP string, %DB_PASSWORD% on
// Windows, $env:DB_PASSWORD in PowerShell, $(dbPassword) in a pipeline or Makefile, #{password} in Ruby, or a
// few of them joined ("$DB_USER:$DB_PASSWORD"). The secret itself lives wherever that variable is set.
const VARIABLE_REF = String.raw`(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_][\w.:-]*\}|\$\([A-Za-z_][\w.]*\)|#\{[A-Za-z_][\w.]*\}|%[A-Za-z_]\w*%|\$env:[A-Za-z_]\w*)`;
const VARIABLE_VALUE = new RegExp(`^${VARIABLE_REF}(?:[:@/._-]{1,3}${VARIABLE_REF})*$`, 'i');
// The words browsers' autofill reads (autoComplete="new-password"), not a password
const AUTOFILL_VALUE = /^(new-password|current-password|one-time-code)$/i;
// A path to one of the project's own files kept under a password-ish key, such as a map from page names to
// page files: 'confirm_password' => 'resources/js/pages/auth/confirm-password.tsx'
const FILE_PATH_VALUE = /^[\w@.-]+(?:\/[\w@.-]+)+\.(?:[cm]?[jt]sx?|vue|svelte|astro|php|py|rb|go|rs|java|kts?|swift|dart|html?|css|scss|less|md|txt|json|ya?ml|png|jpe?g|gif|svg|webp|ico)$/i;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * A ULID: a sortable record id (26 characters) whose first ten encode when it was made. A random key of the
 * same shape almost never decodes to a date between 2016 and a few years from now, so this tells them apart.
 */
export function isUlid(v) {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(v)) return false;
  let ms = 0;
  for (const c of v.slice(0, 10).toUpperCase()) ms = ms * 32 + CROCKFORD.indexOf(c);
  return ms >= Date.UTC(2016, 0, 1) && ms <= Date.now() + 5 * 365 * 864e5;
}

function valueLooksReal(v, name) {
  if (/\s/.test(v) || PLACEHOLDER.test(v)) return false;
  if (protectedValue(v, name)) return false;
  if (VARIABLE_VALUE.test(v) || FILE_PATH_VALUE.test(v) || AUTOFILL_VALUE.test(v)) return false;
  // a record id under a plain "…token" name (routeToken: '01J…'); access, auth, secret… tokens still count
  if (/token$/i.test(name) && !NOT_SITE_TOKEN.test(name) && isUlid(v)) return false;
  if (/^(none|null|nil|undefined|true|false|string|number|text|required|optional|bearer|basic|secret|token|password|test|dev|development|local|admin)$/i.test(v)) return false;
  if (/^[A-Z][A-Z0-9_]+$/.test(v)) return false;                 // the NAME of an env var
  if (/^env\([A-Za-z_][\w]*\)$/.test(v)) return false;           // Supabase config.toml reading one: "env(S3_SECRET_KEY)"
  if (/^[a-z_]+(\.[a-z_]+)+$/i.test(v)) return false;            // dotted identifier / key path
  if (/^(\.{0,2}\/|~\/|https?:\/\/|[a-z]:\\)/i.test(v)) return false; // paths and URLs
  if (/\.(json|pem|key|txt|ya?ml|env|crt|p12)$/i.test(v)) return false; // a file name, not the key
  if (/^x-[\w-]+$/i.test(v) || /^(application|text)\//.test(v)) return false;
  if (/^(.)\1+$/.test(v)) return false;
  if (/^(pass(word)?|secret|admin|test|user|changeit|letmein|qwerty|demo|guest|root|welcome)[\d!@#$._-]*$/i.test(v)) return false;
  if (PASSWORD_NAME.test(name)) return v.length >= 6 && !/^[a-z]+$/.test(v);
  return v.length >= 16 && entropy(v) >= 3.2 && /\d/.test(v) && /[a-zA-Z]/.test(v);
}

// Tokens that are public by design, because the browser has to send them: Cloudflare Web Analytics'
// beacon (data-cf-beacon='{"token":"…"}'), Mapbox public tokens (pk.…), and publishable keys, which services
// issue to be put in web pages: pk_… (Stripe, Clerk and others), Supabase's sb_publishable_…,
// PostHog's project key (phc_…) and Flutterwave's public key (FLWPUBK-…). Their secret partners (sk_…,
// sb_secret_…) are still found. A password is chosen by a person, so a "pk_" at its start excuses nothing.
const PUBLIC_TOKEN_LINE = /data-cf-beacon|cloudflareinsights\.com/i;
const PUBLIC_TOKEN_VALUE = /^pk\.[\w-]{20,}\.[\w-]{10,}$|^pk_(?:live_|test_)?[A-Za-z0-9_-]{10,}$|^sb_publishable_[A-Za-z0-9_-]{10,}$|^phc_[A-Za-z0-9]{20,}$|^FLWPUBK(?:_TEST)?-[A-Za-z0-9-]{20,}$/;
const publicByDesign = (value, name) => PUBLIC_TOKEN_VALUE.test(value) && !PASSWORD_NAME.test(name);

// A made-up value with a long run of the alphabet or the digits in it (…abcdefghij…, …0123456789…): a real key
// is random, and six in a row (up or down) turns up by chance in fewer than one in ten million keys.
const charClass = (c) => (c >= 48 && c <= 57 ? 1 : c >= 65 && c <= 90 ? 2 : c >= 97 && c <= 122 ? 3 : 0);
function hasSequence(v, min = 6) {
  let run = 1, dir = 0;
  for (let i = 1; i < v.length; i++) {
    const a = v.charCodeAt(i - 1), b = v.charCodeAt(i);
    const step = Math.abs(b - a) === 1 && charClass(a) && charClass(a) === charClass(b) ? b - a : 0;
    if (step && step === dir) run++;
    else { dir = step; run = step ? 2 : 1; }
    if (run >= min) return true;
  }
  return false;
}
// A site token handed to a browser tracker's script: the script reads it from the page, so every visitor has it.
// Names that say more than "token" (access, auth, secret…) and real key formats are never excused this way.
const SCRIPT_TAG = /<script\b|createElement\(\s*['"]script['"]\s*\)/i;
const TRACKER_FILE = /analytics|tracker|tracking|beacon|pixel|telemetry/i;
const NOT_SITE_TOKEN = /secret|passw|private|access|refresh|auth|bearer|api_?key|signing/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function trackerToken(name, value, src, file) {
  const n = snake(name);
  if (!/token$/.test(n) || NOT_SITE_TOKEN.test(n) || !SCRIPT_TAG.test(src)) return false;
  if (TRACKER_FILE.test(file.split('/').pop())) return true;
  const id = escapeRe(name), val = escapeRe(value);
  return new RegExp('<script\\b[^>]*\\bdata-[\\w-]+\\s*=\\s*(?:\\{\\s*' + id + '\\s*\\}|["\'`]' + val + ')', 'i').test(src)
    || new RegExp('dataset\\.\\w+\\s*=\\s*' + id + '\\b|setAttribute\\(\\s*[\'"]data-[\\w-]+[\'"]\\s*,\\s*' + id + '\\b').test(src);
}

/** 1-based line numbers inside docstrings or block comments (examples there aren't real config). */
function docLines(src, lang) {
  const set = new Set();
  if (!['python', 'typescript', 'javascript', 'java', 'kotlin', 'go', 'csharp', 'php', 'rust', 'swift'].includes(lang)) return set;
  const at = lineIndex(src);
  const spans = lang === 'python' ? [...src.matchAll(/("""|''')[\s\S]*?\1/g)].map((m) => [m.index, m.index + m[0].length]) : blockComments(src);
  for (const [s, e] of spans) { const a = at(s), b = at(e); for (let l = a; l <= b; l++) set.add(l); }
  return set;
}

/** A PEM private key block starting at `idx` that is passphrase-protected (legacy OpenSSL headers). */
const encryptedKeyAt = (src, idx) => /^[^\n]*\n(?:[^\n]*\n)?\s*Proc-Type:\s*4,\s*ENCRYPTED/.test(src.slice(idx, idx + 300));
/** A key file's head holds a private key that isn't passphrase-protected. */
const plainKeyIn = (head) => [...head.matchAll(/-----BEGIN ([A-Z ]*)PRIVATE KEY(?: BLOCK)?-----/g)].some((m) => !/ENCRYPTED/.test(m[1]) && !encryptedKeyAt(head, m.index));

/**
 * A name = "value" match that isn't one: the two answers of a choice (mode === 'signup' ? 'new-password' :
 * 'current-password'), where the first answer only looks like a name, or a psql variable the script fills in
 * from outside (PASSWORD :'app_password').
 */
function notAnAssignment(m, text, sqlish) {
  const [whole, q, name, , value] = m;
  const op = /^\s*(:=|=>|=|:)/.exec(whole.slice(q.length * 2 + name.length))?.[1];
  if (op !== ':') return false;
  if (q && /\?\s*$/.test(text.slice(0, m.index))) return true;
  // (psql reads :'name' as a variable with or without a space before it: PASSWORD:'app_password')
  return sqlish && !q && /^password$/i.test(name) && /^[A-Za-z_]\w*$/.test(value) && /^\s*:["']/.test(whole.slice(name.length));
}

function findSecrets(src, f, out) {
  const at = lineIndex(src);
  const isTest = TEST_FILE.test(f.path) || EXAMPLE_FILE.test(f.path);
  const seenLines = new Set();
  const add = (line, rec) => { if (seenLines.has(line)) return; seenLines.add(line); out.push({ k: 'secret', line, ...rec }); };

  for (const fm of FORMATS) {
    if (fm.skipIf?.test(src)) continue;
    for (const m of src.matchAll(fm.re)) {
      const v = m[0];
      if (isTest && (!fm.live || fm.whole)) continue;
      if (!fm.whole && (/EXAMPLE|xxxx|XXXX|0{10,}/.test(v) || entropy(v) < 3 || hasSequence(v))) continue;
      if (fm.whole && encryptedKeyAt(src, m.index)) continue;
      add(at(m.index), { what: fm.what, svc: fm.svc, sev: fm.sev || 'high', hint: fm.whole ? 'private key block' : mask(v) });
    }
  }
  if (!isTest) {
    for (const m of src.matchAll(JWT)) {
      let payload = null;
      try { payload = JSON.parse(Buffer.from(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { continue; }
      if (payload?.role !== 'service_role') continue; // "anon" keys are public by design
      add(at(m.index), { what: 'a Supabase service-role key (full access to your database, skipping all security rules)', svc: 'Supabase', sev: 'high', hint: mask(m[0]) });
    }
    for (const m of src.matchAll(ADO_CONN)) {
      const host = (/(?:Server|Host|Data Source|Address|Addr)\s*=\s*(?:tcp:)?([^;,"'\s]+)/i.exec(m[0])?.[1] || '').split(/[:\\]/)[0];
      const pw = m[1].trim();
      // the same rules as any other password: variables ($(DbPassword), %DB_PASSWORD%), C# interpolation
      // ({password}), placeholders and made-up words aren't secrets
      if (LOCAL_HOST.test(host) || ADO_LOCAL_HOST.test(host) || PLACEHOLDER.test(pw) || /^[:$%{<]/.test(pw) || !valueLooksReal(pw, 'password')) continue;
      add(at(m.index), { what: 'a database password inside a connection string', svc: 'your database', sev: 'high', hint: mask(pw, true) });
    }
    for (const m of src.matchAll(DB_URL)) {
      const [, user, pw, host] = m;
      if (LOCAL_HOST.test(host) || PLACEHOLDER.test(pw) || /^[:$%{<]/.test(pw) || pw.length < 4 || /^(password|pass|postgres|root|secret|admin|user)$/i.test(pw)) continue;
      add(at(m.index), { what: 'a database password inside a connection address', svc: 'your database', sev: 'high', hint: mask(pw, true) });
    }
  }
  if (isTest || f.category === 'docs') return;

  // Assignments: api_key = "…", "password": "…", PASSWORD=… (config files may leave values unquoted).
  const lines = src.split('\n');
  const inDoc = docLines(src, f.lang);
  // CI / docker-compose database containers get throwaway passwords
  const throwawayDb = /(^|\/)\.github\/|(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/i.test(f.path);
  const quoted = /(["']?)([A-Za-z_][\w.-]*)\1\s*(?::=|=>|=|:)\s*(?:[rbuRBU]{1,2})?(["'`])([^"'`\n]{6,200})\3/g;
  const unquoted = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[:=]\s*([^\s#'"]{6,200})\s*(?:#.*)?$/;
  const sqlish = ['shell', 'sql'].includes(f.lang) || /\.(sh|bash|sql|psql)$/i.test(f.path);
  lines.forEach((text, i) => {
    // (in SQL, and in the SQL a shell script hands to psql, a line starting with -- is a comment)
    if (text.length > 400 || ENV_LOOKUP.test(text) || PUBLIC_TOKEN_LINE.test(text) || inDoc.has(i + 1) || /^\s*(#|\/\/|\*|\/\*|<!--)/.test(text) || (sqlish && /^\s*--\s/.test(text))) return;
    const pairs = [...text.matchAll(quoted)].filter((m) => !notAnAssignment(m, text, sqlish)).map((m) => [m[2], m[4]]);
    if (!pairs.length && (f.category === 'config' && CONFIG_LANGS.has(f.lang))) { const u = unquoted.exec(text); if (u) pairs.push([u[1], u[2]]); }
    for (const [name, value] of pairs) {
      const n = snake(name.split('.').pop());
      if (!SECRET_NAME.test(n) || PUBLIC_NAME.test(n) || publicByDesign(value, n) || !valueLooksReal(value, n)) continue;
      if (trackerToken(name.split('.').pop(), value, src, f.path)) continue;
      if (throwawayDb && /^(postgres|mysql|mariadb|mongo(_initdb_root)?|redis|pg|rabbitmq_default|db|database)_(root_)?(password|pass|pwd)$/.test(n)) continue;
      add(i + 1, { what: kindFromName(name), name: name.split('.').pop(), sev: 'high', hint: mask(value, PASSWORD_NAME.test(n)), generic: true });
    }
  });
}

/**
 * maskSecrets(text, file?): text that is safe to show or store, with every value that is or might be a secret
 * replaced with «hidden». A stable export: describe.mjs uses it on the code it quotes in worksheets, build.mjs on
 * every description, label and note before it goes into the map, and a driver can call it on text before
 * writing it (docs/unattended.md). Text without secrets comes back unchanged, so `maskSecrets(t) !== t` says
 * something was hidden.
 *
 * Here recall beats precision: hiding a harmless value costs a reader nothing. It hides every well-known key
 * format and private key block (in test files too), database passwords in connection addresses, any quoted
 * value given to a name that sounds secret, long random-looking quoted strings, and the lines Health itself
 * would flag. `file` ({ path, lang, category }) says the text is a file's source. Without it the text is
 * treated as prose written by a person or an agent: NAME=value lines count as settings, and long random-looking
 * strings are hidden even unquoted when they mix upper and lower case letters and digits the way generated keys
 * do (so commit hashes, UUIDs, file paths and ordinary words stay as they are).
 */
const HIDDEN = '«hidden»';
const QUOTED_ASSIGN = /(["']?)(?<![\w.-])([A-Za-z_][\w.-]{0,100})\1(\s*(?::=|=>|=|:)\s*(?:[rbuRBU]{1,2})?)(["'`])([^"'`\n]{0,2000})\4/g;
const RANDOM_LOOKING = /(["'`])([A-Za-z0-9+/=_\-]{32,1000})\1/g;
const BARE_RANDOM = /(?<![A-Za-z0-9+/=_\-])[A-Za-z0-9+/_\-]{32,1000}={0,2}(?![A-Za-z0-9+/=_\-])/g;
const count = (s, re) => (s.match(re) || []).length;
// generated: upper and lower case letters and digits all through it, not words (CamelCase names, paths) or a year
const looksGenerated = (v) => count(v, /\d+/g) >= 3 && count(v, /\d/g) >= 4 && count(v, /[A-Z]/g) >= 4 && count(v, /[a-z]/g) >= 4
  && count(v, /[A-Z][a-z]{3,}/g) < 3 && entropy(v) >= 4;
export function maskSecrets(src, file) {
  const prose = !file || typeof file !== 'object';
  const where = prose ? { path: '', lang: 'env', category: 'config' } : file;
  let out = String(src)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, `${HIDDEN} (a private key)`);
  for (const fm of FORMATS) out = out.replace(fm.re, HIDDEN);
  out = out.replace(JWT, HIDDEN).replace(DB_URL, (m, user, pw) => m.replace(`:${pw}@`, `:${HIDDEN}@`));
  out = out.replace(QUOTED_ASSIGN, (m, q, name, op, q2, value) => value && SECRET_NAME.test(snake(name.split('.').pop())) ? `${q}${name}${q}${op}${q2}${HIDDEN}${q2}` : m);
  out = out.replace(RANDOM_LOOKING, (m, q, v) => /\d/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 4 ? `${q}${HIDDEN}${q}` : m);
  if (prose) out = out.replace(BARE_RANDOM, (v) => looksGenerated(v) ? HIDDEN : v);
  // and the lines Health itself flags (config files may leave values unquoted)
  const flagged = [];
  try { findSecrets(out, { path: where.path || '', lang: where.lang, category: where.category }, flagged); } catch {}
  if (!flagged.length) return out;
  const lines = out.split('\n');
  for (const { line } of flagged) {
    const i = line - 1;
    if (lines[i] == null || lines[i].includes(HIDDEN)) continue;
    lines[i] = lines[i].replace(/(["'`])[^"'`\n]*\1/g, `$1${HIDDEN}$1`).replace(/^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[:=]\s*)([^\s#'"`].*)$/, `$1${HIDDEN}`);
  }
  return lines.join('\n');
}

// ---------- 2. who may call each endpoint ----------

/**
 * The same pattern with every open-ended \w* and [\w-]* capped at 60 characters. Patterns tested against whole
 * handler bodies (or whole files) otherwise retry an unbounded run from every position in a long identifier.
 */
function bounded(re) {
  return new RegExp(re.source.replaceAll('\\w*', '\\w{0,60}').replaceAll('[\\w-]*', '[\\w-]{0,60}'), re.flags);
}

// Decorators / middleware / dependencies whose names say "check who is calling".
const GUARD_NAME = /(^|_)(login|auth|authenticated|authorized?|jwt|token|permission|permissions|perm|role|roles|staff|admin|superuser|owner|scope|scopes|session|api_?key|signature|signed|hmac|device|member|user)(_|$)|_required$|^requires?_|^ensure_|^verify_|^guard(?:_|$)|_guard$|^check_(auth|token|user|session|permission|role|api)|protect|^is_?authenticated|^is_?admin/i;
// …and names that only look like it, matched on the snake_case name. Logging (`log_call`, `logged_request`)
// but not `login_required` or `logged_in_required`; validating a payload's shape (`validate`, `validate_body`,
// `validate_user_input`) but not a credential (`validate_jwt`, `validate_api_key`, `validateToken`).
const NOT_GUARD = /^(route|get|post|put|patch|delete|cached?|limit|limiter|rate_?limit\w*|cross_origin|wraps|staticmethod|classmethod|property|retry|timed|log(?!in(?:_|$)|ged_?in(?:_|$))\w*|swag_from|validate(?!_(?:\w+_)?(?:login|auth|authenticated|authorized?|jwt|tokens?|permissions?|perms?|roles?|staff|admin|superuser|owner|scopes?|session|api_?key|signature|signed|hmac|device|member|user|credentials?|bearer)$)\w*|expects|marshal\w*|doc|json_required|fields?_required|params?_required|body_required|transaction\w*|csrf\w*|exempt)$/i;
const isGuardName = (name) => !!name && !NOT_GUARD.test(snake(name)) && (GUARD_NAME.test(snake(name)) || /^(authenticate|authorize)$/.test(snake(name)));
// JavaScript checks GUARD_NAME doesn't spell out: passport.authenticate('jwt'), expressjwt({ … }), isLoggedIn
const JS_GUARD_NAME = /(^|_)authenticate(_|$)|^express_?jwt$|(^|_)logged_in(_|$)/;
const isJsGuardName = (name) => isGuardName(name) || (!!name && !NOT_GUARD.test(snake(name)) && JS_GUARD_NAME.test(snake(name)));
// Middleware that never turns anyone away, matched on the snake_case name of what app.use() is handed
const NOT_GUARD_MIDDLEWARE = /^(cors|helmet|compression|morgan|cookie_parser|body_parser|json|urlencoded|raw|text|static|serve_static|favicon|method_override|response_time|timeout|express_session|session|cookie_session|rate_limit|slow_down|hpp|csurf|nocache|pino_http|request_id|logger|secure_headers|etag|pretty_json|initialize)$/;
// words that say the middleware only loads or prepares something (loadUser, optionalAuth, attachSession,
// withAuth), or protects against something other than strangers (xssProtection)
const NOT_A_CHECK = /(^|_)(optional|maybe|soft|load|loads|attach|attaches|populate|parse|parser|extract|deserialize|current|context|with|init|setup|xss|ddos|csrf|xsrf|brute|spam|clickjacking)(_|$)/;
// words that add nothing to what a name checks (authMiddleware is auth, createShutdownGuard is shutdown)
const FILLER = /(^|_)(guard|guards|middleware|middlewares|mw|handler|create|make|build|get|use|express|hono|koa|fastify|plugin|global|app)(?=_|$)/g;
// on their own, these name a session, a cookie or a user being made available, not checked
const NOT_ENOUGH = /^(session|sessions|cookie|cookies|user|users|store|device|member|members)(_(session|sessions|cookie|cookies|user|users|store))*$/;
/**
 * Whether middleware handed to app.use() / router.use() checks the caller. It protects every route after it, so
 * this is stricter than a check on one route (#72): the name must say what it checks (authGuard, requireUser,
 * verifyToken, passport.authenticate), not just "guard" (createShutdownGuard) or "session" (sessionMiddleware),
 * and a router (authRoutes, adminRouter) or middleware that turns no one away (cors, helmet) doesn't count.
 */
const isUseGuard = (name) => {
  if (!name || NOT_GUARD.test(snake(name))) return false;
  const s = snake(name);
  if (NOT_GUARD_MIDDLEWARE.test(s) || NOT_A_CHECK.test(s) || /(^|_)(router|routes|route|routing|controller|controllers|endpoints|api|server)$/.test(s)) return false;
  const core = s.replace(FILLER, '').replace(/__+/g, '_').replace(/^_|_$/g, '');
  return !!core && !NOT_ENOUGH.test(core) && (GUARD_NAME.test(core) || JS_GUARD_NAME.test(core));
};
const JS_STRING = /(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g;
/**
 * The name to judge for one argument of app.use(…), with strings and comments removed: the call or name
 * itself (cors({ exposedHeaders: ['X-Refreshed-Token'] }) is cors, passport.authenticate('jwt') is
 * authenticate), never a word inside its options. null for anything else (an inline function, an object).
 */
function useArgName(arg) {
  const code = arg.replace(JS_STRING, '""').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').trim();
  const m = /^(?:await\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(\(|<|$)/.exec(code);
  if (!m || /^(async|function|new|class)$/.test(m[1])) return null;
  const segs = m[1].replace(/\s+/g, '').split('.');
  const last = segs[segs.length - 1];
  // the last part is what runs: passport.session() loads a session whatever passport is
  if (NOT_GUARD_MIDDLEWARE.test(snake(last)) || NOT_A_CHECK.test(snake(last))) return null;
  return [...segs].reverse().find(isUseGuard) || null;
}
// NestJS guards that check the caller (AuthGuard, JwtAuthGuard, RolesGuard), not rate limits or quotas
const isNestAuthGuard = (name) => isGuardName(name) && !/rate_?limit|throttl|quota|limiter/i.test(snake(name));
// an app-wide one also needs a name that says what it checks, past the word "guard" (see isUseGuard)
const isNestGlobalGuard = (name) => isNestAuthGuard(name) && isUseGuard(name);
// decorators that open a route past a global NestJS guard
const NEST_PUBLIC = /@(?:Public|IsPublic|SkipAuth|NoAuth|AllowAnonymous|Anonymous)\s*\(/;
// FastAPI dependencies that hand over a database session rather than check the caller
// (SessionDep, get_db, get_sql_session, SessionLocal, a unit of work), matched on the snake_case name
const DB_DEPENDENCY = /^(get_|new_|create_)?(async_)?(db|database|session|db_session|sessionmaker)$|(^|_)(db|database|sql\w*|engine|conn|connection|cursor|uow|unit_of_work)(_|$)|session_?(local|maker|factory)/i;
const isDbDep = (name) => DB_DEPENDENCY.test(snake(name));
const isGuardDep = (name) => isGuardName(name) && !isDbDep(name);
// A handler body that inspects the caller itself.
const INLINE_CHECK = bounded(/request\.headers(?:\.get)?\(?\s*\[?\s*['"](authorization|x-api-key|x-[\w-]*(token|key|secret|signature)[\w-]*)['"]|req\.headers(?:\.|\[\s*['"])(authorization|x-api-key)|\b(verify|check|require|validate|authenticate|authorize)_?\w*(auth|token|session|user|key|signature|webhook|hmac|jwt|device|staff|admin|permission|role|request|caller)\w*\s*\(|\bcurrent_user\b|get_jwt_identity|verify_jwt_in_request|compare_digest|abort\(\s*40[13]\b|,\s*40[13]\s*\)?\s*$|status(?:Code)?\s*[:=(]\s*40[13]\b|\.status\(\s*40[13]\s*\)|req\.user\b|req\.session\.user|req\.auth\b|jwt\.verify|jwtVerify|getServerSession|auth\(\)|currentUser\(|getAuth\(|auth\.getUser|getSession\(|verifyIdToken|getToken\(|\b(?:verify|check|require|validate|authenticate|authorize)\w*(?:Auth|Token|Session|Signature|Webhook|Hmac|Jwt|Secret|Permission|Role)\w*\s*\(|\bis_?(?:[Vv]alid_?)?(?:[Aa]uthorized|[Aa]uthenticated|[Ss]ignature|[Tt]oken|[Ss]ecret|[Aa]pi_?[Kk]ey)\w*\s*\(|timingSafeEqual|safeCompare|[!=]==?\s*(?:[`'"]Bearer\s+\$\{\s*)?process\.env\.\w*(?:SECRET|TOKEN|KEY|PASSWORD)|process\.env\.\w*(?:SECRET|TOKEN|KEY|PASSWORD)\w*\s*[!=]==?/m);
// A Header parameter alone is NOT authentication. Count it only when the
// handler checks that token and rejects a bad value with HTTP 401/403.
function pyValidatedHeader(sig, body) {
  const names = [...sig.matchAll(/\b([A-Za-z_]\w*(?:token|key|signature)\w*)\s*:\s*[^,\n]*=\s*Header\s*\(/g)]
    .map((m) => m[1]);
  if (!names.length || !/raise\s+HTTPException\s*\(\s*status_code\s*=\s*40[13]\b/.test(body)) return false;
  return names.some((name) => new RegExp('\\bif\\s+(?:not\\s+)?' + name + '\\b').test(body));
}

const FIREBASE_CHECK = /\b\w+\.auth\b(?!\s*\()|HttpsError\(\s*["'](unauthenticated|permission-denied)["']|enforceAppCheck\s*:\s*true|\b\w+\.app\b\s*(==|!=|===|!==)\s*(undefined|null)|!\s*\w+\.app\b/;
const SIGNATURE_CHECK = bounded(/hmac|signature|verify_?webhook|construct_?event|x-hub-signature|compare_digest|svix|webhooks?\.verify|jwt\.decode|oidc|id_token|authenticated|verify_\w*(token|request|push)/i);
const NEXT_GUARD = /getServerSession|\bauth\(\)|currentUser\(|getAuth\(|auth\.getUser|supabase\.auth\.get(User|Session)|getSession\(|verifyIdToken|jwt\.verify|jwtVerify|getToken\(|clerkClient|requireAuth|requireUser|withAuth|validateRequest|headers\(\)\.get\(\s*['"]authorization|status:\s*40[13]\b/;
// A response marked to be stored and served to everyone can't hold one caller's data.
const PUBLIC_RESPONSE = /cache-control['"]?\]?\s*[:,=]\s*[`'"f]*[^`'"\n]{0,200}\b(?:public|s-maxage)\b/i;
const PRIVATE_RESPONSE = /cache-control['"]?\]?\s*[:,=]\s*[`'"f]*[^`'"\n]{0,200}\b(?:private|no-store)\b/i;
const NEXT_STATIC = /\bdynamic\s*=\s*['"]force-static['"]|export\s+const\s+revalidate\s*=\s*[1-9]/;
// API routes from a library that checks access itself: Payload CMS generates these and applies its collections' access rules
const SELF_CHECKING_ROUTES = /from\s+['"]@payloadcms\/next\/routes['"]/;
// Where a Next.js GET could get something worth protecting from: a data store, the caller's session, or a server-side secret
const READS_PRIVATE = /\b(?:prisma\w*|drizzle\w*|mongoose|mongodb|sequelize|typeorm|knex|kysely|supabase|firestore|firebase-admin|firebase\/\w+|dynamodb|redis|upstash|postgres|pg|mysql2?|sqlite3?|payload\w*|neon|turso|libsql)\b|\bdb\s*[.(]|\bdatabase\s*\.|\.(?:findMany|findUnique|findFirst|findOne|findAll|query|execute)\s*\(|\bcookies\s*\(|\bgetServerSession\b|\.session\b|\breq(?:uest)?\.(?:user|auth)\b|process\.env\.(?!NEXT_PUBLIC_|NODE_ENV\b|VERCEL|PUBLIC_|SITE_URL\b|BASE_URL\b|APP_URL\b)\w+/i;
const READS_FILES = /\b(?:readFile(?:Sync)?|createReadStream|readdir(?:Sync)?)\b/;
// Helpers around a route that don't feed what it returns
const NOT_ITS_DATA = /(^|\/)[^/]*(rate-?limit|limiter|logger|logging|metrics|telemetry|sentry|analytics)[^/]*$/i;
const METHOD_NOT_ALLOWED = /status(?:Code)?\s*[:=(]\s*405\b|\.status\(\s*405\b|\bmethodNotAllowed\b/i;
/** The code of one exported handler in a Next.js route file. */
function nextHandler(src, method) {
  const m = new RegExp('^[ \\t]*export\\s+(?:async\\s+)?(?:function|const)\\s+' + method + '\\b', 'm').exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/^[ \t]*export\s/m);
  return end < 0 ? rest : rest.slice(0, end);
}
const NEXT_MIDDLEWARE_GUARD = /getToken|withAuth|clerkMiddleware|authMiddleware|auth\(|supabase|getSession|jwtVerify|jwt\.verify|cookies\.get\([^)]*(session|token|auth)|redirect\([^)]*login/i;

function blockAfter(lines, defIdx) {
  // A Python def's body: every line after it that's more indented, up to 120 lines.
  const ind = /^\s*/.exec(lines[defIdx])[0].length;
  let end = defIdx + 1;
  while (end < lines.length && end < defIdx + 120 && (!lines[end].trim() || /^\s*/.exec(lines[end])[0].length > ind || /^\s*[)\]]/.test(lines[end]))) end++;
  return lines.slice(defIdx, end).join('\n');
}

// Does a Python body send the caller away: a `return` or `raise` whose statement carries a 401 or 403
// (JSONResponse(..., status_code=401), HTTPException(403), status.HTTP_401_UNAUTHORIZED…)? A dependency
// can only turn the caller away by raising, so pass 'raise' alone for one.
const PY_DENIED = /\b40[13]\b|HTTP_40[13]_\w+|Unauthorized|Forbidden/;
function pyRejectsCaller(body, stmt = 'return|raise') {
  for (const m of body.matchAll(new RegExp('^[ \\t]*(?:' + stmt + ')\\b', 'gm'))) {
    let depth = 0, i = m.index + m[0].length;
    for (; i < body.length && !(body[i] === '\n' && depth <= 0); i++) {
      if ('([{'.includes(body[i])) depth++;
      else if (')]}'.includes(body[i])) depth--;
    }
    if (PY_DENIED.test(body.slice(m.index, i))) return true;
  }
  return false;
}

/** The top-level items of the Python list that opens at text[open]. */
function pyListItems(text, open) {
  const items = [];
  let depth = 0, start = open + 1;
  for (let i = open; i < text.length && i - open < 3000; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (!--depth) { items.push(text.slice(start, i)); break; } }
    else if (c === ',' && depth === 1) { items.push(text.slice(start, i)); start = i + 1; }
  }
  return items.map((x) => x.trim()).filter(Boolean);
}

/** The function in a `Depends(fn)` / `Security(fn)` at the start of text, if any. */
const PY_DEPENDS = /^(?:[\w.]+\.)?(?:Depends|Security)\(\s*([\w.]+)/;

/**
 * What a FastAPI route or router names as its dependencies, for build to judge repo-wide (pyDependencyGuards):
 * `fn:name` for `Depends(name)` / `Security(name)`, `dep:name` for a `Depends(...)` kept in a variable
 * (`dependencies=[api]`, or a parameter default `_: None = api`), and `list:NAME` for `dependencies=NAME`.
 */
function pyDepRefs(text, sig = '') {
  const refs = new Set();
  const short = (n) => n.split('.').pop();
  for (const m of text.matchAll(/\b(?:Depends|Security)\(\s*([\w.]+)/g)) refs.add('fn:' + short(m[1]));
  for (const m of text.matchAll(/\bdependencies\s*=\s*/g)) {
    const at = m.index + m[0].length;
    if (text[at] === '[') { for (const item of pyListItems(text, at)) if (/^[A-Za-z_][\w.]*$/.test(item)) refs.add('dep:' + short(item)); }
    else { const name = /^[A-Za-z_][\w.]*(?![\w.(])/.exec(text.slice(at, at + 200))?.[0]; if (name) refs.add('list:' + short(name)); }
  }
  for (const m of sig.matchAll(/=\s*([A-Za-z_][\w.]*)(?=\s*(?:[,)]|$))/gm)) if (!/^(None|True|False)$/.test(m[1])) refs.add('dep:' + short(m[1]));
  return [...refs];
}

/**
 * The inside of the Python bracket that opens at src[start] (`APIRouter(…)`, `[…]`), however deeply calls nest in
 * it (`Depends(require_workspace("tours"))`), with comments and the insides of strings blanked, so a bracket or a
 * `Depends(require_login)` written in either is neither a delimiter nor a dependency. An expression that doesn't
 * close is '': it's no evidence of a check, and must not swallow the routers and handlers after it.
 */
function pyEnclosed(src, start) {
  const pairs = { '(': ')', '[': ']', '{': '}' }, stack = [pairs[src[start]]];
  if (!stack[0]) return '';
  let quote = '', comment = false, out = '';
  for (let i = start + 1; i < src.length && i - start < 20000; i++) {
    const c = src[i];
    if (comment) { if (c === '\n') { comment = false; out += c; } else out += ' '; continue; }
    if (quote) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (src.startsWith(quote, i)) { out += quote; i += quote.length - 1; quote = ''; continue; }
      out += c === '\n' ? c : ' ';
      continue;
    }
    if (c === '#') { comment = true; out += ' '; continue; }
    if (c === '"' || c === "'") {
      quote = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      out += quote;
      i += quote.length - 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (c !== stack.pop()) return '';
      if (!stack.length) return out;
    }
    out += c;
  }
  return '';
}

function pyRoutes(src, f, out) {
  const lines = src.split('\n');
  const lineAt = (() => { const at = lineIndex(src); return (i) => at(i) - 1; })(); // 0-based line of an offset
  // Blueprint / app-wide before_request hooks and router-level dependencies that check the caller.
  const guardedVars = new Map();
  for (const m of src.matchAll(/^@(\w+)\.before_(?:app_)?request\s*\n(?:@.*\n)*\s*def\s+(\w+)/gm)) {
    const defIdx = lineAt(m.index + m[0].length);
    const body = blockAfter(lines, defIdx);
    if (!/\b40[13]\b|Unauthorized|Forbidden|verify_jwt_in_request|login_required|is_authenticated|current_user/.test(body)) continue;
    guardedVars.set(m[1], m[2]);
    if (m[1] === 'app') out.push({ k: 'global-guard', framework: 'flask', name: m[2], line: defIdx + 1 });
  }
  // FastAPI / Starlette: an @app.middleware("http") function runs before every route, so it guards
  // them all when it turns callers away itself. One that only adds headers, logs or reads a 401 from
  // the response doesn't count.
  for (const m of src.matchAll(/^@\w+\.middleware\(\s*["']http["']\s*\)\s*\n(?:@.*\n)*\s*(?:async\s+)?def\s+(\w+)/gm)) {
    const defIdx = lineAt(m.index + m[0].length);
    if (pyRejectsCaller(blockAfter(lines, defIdx))) out.push({ k: 'global-guard', framework: 'fastapi', name: m[1], line: defIdx + 1 });
  }
  // APIRouter(dependencies=[...]): a check named as one counts here; anything else (a factory's result,
  // a Depends() kept in a variable, a list kept in a constant) is left for build to judge (routerRefs)
  const routerRefs = new Map();
  for (const m of src.matchAll(/^[ \t]*(\w+)\s*=\s*(?:\w+\.)?APIRouter\s*\(/gm)) {
    const args = pyEnclosed(src, m.index + m[0].length - 1);
    if (!/\bdependencies\s*=/.test(args)) continue;
    const refs = pyDepRefs(args);
    const named = refs.find((r) => r.startsWith('fn:') && isGuardDep(r.slice(3)));
    if (named) guardedVars.set(m[1], named.slice(3));
    else if (refs.length) routerRefs.set(m[1], refs);
  }
  // FastAPI dependency aliases, `AdminUser = Annotated[Session, Depends(admin_user)]`, and the dependency
  // functions behind them. They're usually imported from a shared deps.py, so build decides repo-wide
  // which ones check the caller (see pyDependencyGuards).
  const sigAt = (idx) => lines.slice(idx, idx + 15).join('\n').split(/\)\s*(->[^:]*)?:\s*$/m)[0];
  const depsIn = (text) => [...text.matchAll(/\b(?:Depends|Security)\(\s*([\w.]+)/g)].map((m) => m[1].split('.').pop());
  const typesIn = (sig) => [...new Set([...sig.matchAll(/\b\w+\s*:\s*(?:[\w.]*Annotated\[\s*)?([A-Za-z_][\w.]*)/g)].map((m) => m[1].split('.').pop()))];
  if (/\b(?:Depends|Security)\(|\bHTTPException\b/.test(src)) {
    for (const m of src.matchAll(/^(?:type\s+)?(\w+)\s*(?::[^=\n]*)?=\s*(?:[\w.]+\.)?Annotated\[/gm)) {
      let depth = 1, j = m.index + m[0].length;
      while (j < src.length && depth && j - m.index < 800) { if (src[j] === '[') depth++; else if (src[j] === ']') depth--; j++; }
      const fn = depsIn(src.slice(m.index, j))[0];
      if (fn) out.push({ k: 'py-alias', name: m[1], fn, line: lineAt(m.index) + 1 });
    }
    // top-level functions that aren't routes, with the dependencies and types they take, and whether they
    // turn the caller away themselves (raise a 401 or 403) or return a function that does (a factory
    // like require_role("admin")); a class counts by its __call__
    for (const m of src.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(|^class\s+(\w+)\b/gm)) {
      const idx = lineAt(m.index);
      if (idx > 0 && /^\s*@/.test(lines[idx - 1])) continue;
      const body = blockAfter(lines, idx);
      if (m[2] && !/^\s+(?:async\s+)?def\s+__call__\s*\(/m.test(body)) continue;
      const sig = m[2] ? '' : sigAt(idx), deps = [...new Set(depsIn(body))], types = typesIn(sig);
      const rejects = pyRejectsCaller(body, 'raise');
      if (deps.length || types.length || rejects) out.push({ k: 'py-dep-fn', name: m[1] || m[2], ...(deps.length ? { deps } : {}), ...(types.length ? { types } : {}), ...(rejects ? { rejects } : {}) });
    }
    // module-level names a route can depend on: `api = Depends(require_key)`, a factory's result
    // (`editor = require_role("editor")`) and lists of dependencies (`WRITE = [Depends(require_login)]`)
    for (const m of src.matchAll(/^(\w+)\s*(?::[^=\n]*)?=(?!=)\s*(?:([\w.]+)\s*\(|(\[))/gm)) {
      const callee = m[2]?.split('.').pop();
      if (callee === 'Depends' || callee === 'Security') {
        const fn = depsIn(src.slice(m.index, m.index + m[0].length + 200))[0];
        if (fn) out.push({ k: 'py-dep-var', name: m[1], depends: fn });
      } else if (callee && !/^(Annotated|APIRouter|FastAPI|Blueprint|Flask)$/.test(callee)) {
        out.push({ k: 'py-dep-var', name: m[1], call: callee });
      } else if (m[3]) {
        const list = pyListItems(src, m.index + m[0].length - 1).map((item) => {
          const fn = PY_DEPENDS.exec(item)?.[1];
          return fn ? 'fn:' + fn.split('.').pop() : /^[A-Za-z_][\w.]*$/.test(item) ? 'dep:' + item.split('.').pop() : null;
        }).filter(Boolean);
        if (list.length) out.push({ k: 'py-dep-var', name: m[1], list });
      }
    }
  }
  // Only treat a helper as a verifier if its body visibly checks the
  // provider signature and rejects an invalid request. A helper name alone
  // (validated_sender, for example) is not proof of authentication.
  for (const m of src.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
    const idx = lineAt(m.index);
    const body = blockAfter(lines, idx);
    if (/\bRequestValidator\s*\(/.test(body) && /\.validate\s*\(/.test(body) &&
        /raise\s+HTTPException\s*\(\s*status_code\s*=\s*40[13]\b/.test(body)) {
      out.push({ k: 'py-verified-helper', name: m[1], line: idx + 1 });
    }
  }
  // Decorators defined here: auth-named ones, and project wrappers like `@endpoint(write=True)` whose
  // body applies an auth decorator itself. Repeat once so a wrapper of a wrapper counts too.
  const localGuards = new Set();
  const defs = [...src.matchAll(/^def\s+(\w+)\s*\(/gm)].map((m) => { const idx = lineAt(m.index); return { name: m[1], line: idx + 1, body: blockAfter(lines, idx) }; });
  const decoratorish = (body) => /wraps|decorat|def\s+\w+\(\s*\*args|return\s+\w+\s*$/m.test(body);
  for (let pass = 0; pass < 2; pass++) for (const d of defs) {
    if (localGuards.has(d.name) || !decoratorish(d.body)) continue;
    const applied = [...d.body.matchAll(/^\s*@([\w.]+)/gm)].map((m) => m[1].split('.').pop());
    const wraps = applied.some((a) => isGuardName(a) || localGuards.has(a));
    if (isGuardName(d.name) || wraps) { localGuards.add(d.name); out.push({ k: 'guard-def', name: d.name, line: d.line, ...(wraps && !isGuardName(d.name) ? { wrapper: true } : {}) }); }
  }

  for (const r of f.routes || []) {
    // django: no per-route checks to read; table: sign-in is checked by the dispatcher or inside the handler
    if (r.framework === 'django' || r.framework === 'table') continue;
    const i0 = r.line - 1;
    // decorators above the route decorator (wrong place in Flask/FastAPI: the route registers the unwrapped function)
    const above = [];
    for (let i = i0 - 1; i >= 0 && /^\s*@/.test(lines[i]); i--) above.push(/^\s*@([\w.]+)/.exec(lines[i])[1].split('.').pop());
    // decorators below it, up to the def
    const below = [];
    let defIdx = -1;
    for (let i = i0 + 1; i < lines.length && i < i0 + 30; i++) {
      if (/^\s*(async\s+)?def\s/.test(lines[i])) { defIdx = i; break; }
      const d = /^\s*@([\w.]+)/.exec(lines[i]);
      if (d) below.push(d[1].split('.').pop());
    }
    const decoText = lines.slice(i0, defIdx > 0 ? defIdx : i0 + 1).join('\n');
    const sig = defIdx > 0 ? lines.slice(defIdx, defIdx + 15).join('\n').split(/\)\s*(->[^:]*)?:\s*$/m)[0] : '';
    const body = defIdx > 0 ? blockAfter(lines, defIdx) : '';
    const rec = { k: 'route', line: r.line, method: r.method };
    const deco = below.find((d) => (isGuardName(d) || localGuards.has(d)) && !/^(route|get|post|put|patch|delete)$/.test(d));
    const dep = /Depends\(\s*([\w.]+)|Security\(\s*([\w.]+)/g;
    const deps = [...(decoText + '\n' + sig).matchAll(dep)].map((m) => (m[1] || m[2]).split('.').pop());
    if (deco) Object.assign(rec, { guard: deco, via: 'decorator' });
    else if (guardedVars.has(r.var)) Object.assign(rec, { guard: guardedVars.get(r.var), via: 'blueprint' });
    else if (deps.some(isGuardDep)) Object.assign(rec, { guard: deps.find(isGuardDep), via: 'dependency' });
    else if (INLINE_CHECK.test(body)) Object.assign(rec, { via: 'inline' });
    else if (pyValidatedHeader(sig, body)) Object.assign(rec, { via: 'inline' });
    else {
      const misplaced = above.find((d) => isGuardName(d) && !/^(route|get|post|put|patch|delete)$/.test(d));
      if (misplaced) rec.misplaced = misplaced;
      // other decorators may be auth wrappers defined in another file; build resolves them
      const other = below.filter((d) => !/^(route|get|post|put|patch|delete|api_route|websocket)$/.test(d));
      if (other.length) rec.decos = other;
      // so may parameter types: `user: AdminUser`, a dependency alias (pyDependencyGuards)
      const types = typesIn(sig);
      if (types.length) rec.types = types;
      // and dependencies whose names don't say what they do: a factory's result, a Depends() kept in a
      // variable, a list kept in a constant, a function that raises a 401 (pyDependencyGuards)
      const refs = [...new Set([...pyDepRefs(decoText + '\n' + sig, sig), ...(routerRefs.get(r.var) || [])])];
      if (refs.length) rec.depRefs = refs;
    }
    if (body) rec.calls = [...new Set([...body.matchAll(/\b(?:await\s+)?([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]))];
    if (SIGNATURE_CHECK.test(body)) rec.signed = true;
    if (PUBLIC_RESPONSE.test(body)) rec.publicResponse = true;
    if (defIdx > 0) rec.fn = /def\s+(\w+)/.exec(lines[defIdx])[1];
    out.push(rec);
  }
}

function jsRoutes(src, f, out) {
  // route tables (keyed, listed, Bun.serve's) are checked by the dispatcher or inside the handler, where this can't
  // see; leaving them out also keeps them from cutting short the code read for the routes around them
  const routes = (f.routes || []).filter((r) => r.framework !== 'table');
  if (!routes.length && !/\.use\(/.test(src) && !/(^|\/)middleware\.(t|j)s$/.test(f.path) && !/\bAPP_GUARD\b|\.useGlobalGuards\s*\(/.test(src)) return;
  const lines = src.split('\n');
  // NestJS: `{ provide: APP_GUARD, useClass: AuthGuard }` in a module, or `app.useGlobalGuards(new JwtAuthGuard())`
  // in main.ts, guards every Nest route of the app, except the ones a @Public()-style decorator opens. It turns
  // off the open-endpoint check for all of them, so its name must say what it checks, as for app.use() (#72):
  // a rate-limit or quota guard, or one named only "guard" (MaintenanceGuard), isn't a sign-in check.
  const commented = (i) => { const before = src.slice(Math.max(0, i - 300), i); return /(^|[^:])\/\//.test(before.slice(before.lastIndexOf('\n') + 1)); };
  for (const m of src.matchAll(/\bprovide\s*:\s*APP_GUARD\s*,\s*useClass\s*:\s*([A-Za-z_$][\w$]*)/g)) {
    if (!commented(m.index) && isNestGlobalGuard(m[1])) out.push({ k: 'global-guard', framework: 'nest', name: m[1], line: lineIndex(src)(m.index) });
  }
  for (const m of src.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*\.useGlobalGuards\s*\(/g)) {
    if (commented(m.index)) continue;
    const names = (callArgs(src, m.index + m[0].length) || []).map((a) => /^(?:new\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(a.replace(JS_STRING, '""').trim())?.[1]?.split('.').pop());
    const name = names.find(isNestGlobalGuard);
    if (name) out.push({ k: 'global-guard', framework: 'nest', name, line: lineIndex(src)(m.index) });
  }
  // Next.js middleware.ts protecting the app
  if (/(^|\/)(src\/)?middleware\.(t|j)s$/.test(f.path) && NEXT_MIDDLEWARE_GUARD.test(src)) {
    const matcher = /matcher\s*:\s*([^\n]+)/.exec(src)?.[1] || '';
    if (!matcher || /api|\(\?!/.test(matcher)) out.push({ k: 'global-guard', framework: 'next', line: 1 });
  }
  // app.use(auth) / router.use(requireAuth) without a path guards everything registered after it.
  // That turns off the open-endpoint check for every route behind it, so the evidence must be the
  // middleware itself (#72): words inside strings (a header named 'X-Refreshed-Token') and options
  // don't count, nor does middleware that never checks the caller (cors, helmet, express-session…)
  const uses = [];
  const lineOf = lineIndex(src);
  for (const m of src.matchAll(/(?<![\w$])(\w+)\.use\(/g)) {
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    if (/(^|[^:])\/\//.test(before.slice(before.lastIndexOf('\n') + 1))) continue; // commented out
    const args = callArgs(src, m.index + m[0].length);
    if (!args?.length || /^\s*['"`]/.test(args[0])) continue; // a path first: mounted, not app-wide
    const name = args.map(useArgName).find(Boolean);
    if (name) uses.push({ v: m[1], line: lineOf(m.index), name });
  }
  for (const u of uses) if (u.v === 'app' || u.v === 'server') out.push({ k: 'global-guard', framework: 'express', name: u.name, line: u.line });

  routes.forEach((r, idx) => {
    const rec = { k: 'route', line: r.line, method: r.method };
    if (r.framework === 'nest') {
      // the decorators stacked on this method (above and below the route one, up to the handler), and the
      // ones on its class (around the nearest @Controller above)
      const i0 = r.line - 1;
      let top = i0; while (top > 0 && /^\s*@/.test(lines[top - 1])) top--;
      let hIdx = i0 + 1;
      const hRe = r.handler ? new RegExp(`^\\s*(?:(?:public|private|protected|static|async|readonly)\\s+)*${r.handler.replace(/\$/g, '\\$')}\\s*\\(`) : null;
      while (hIdx < lines.length && hIdx < i0 + 30 && !(hRe && hRe.test(lines[hIdx]))) hIdx++;
      const methodDecos = lines.slice(top, hIdx).join('\n');
      let c = i0; while (c >= 0 && !/@Controller\s*\(/.test(lines[c])) c--;
      let cTop = c, cEnd = c;
      if (c >= 0) { while (cTop > 0 && /^\s*@/.test(lines[cTop - 1])) cTop--; while (cEnd < lines.length - 1 && !/\bclass\s/.test(lines[cEnd])) cEnd++; }
      const classDecos = c >= 0 ? lines.slice(cTop, cEnd + 1).join('\n') : '';
      const decos = methodDecos + '\n' + classDecos;
      const guards = [...decos.matchAll(/@UseGuards\s*\(([^)]{0,500})\)/g)].flatMap((m) => m[1].match(/[A-Za-z_$][\w$]*/g) || []);
      const guard = guards.find(isNestAuthGuard);
      rec.nest = true; // only Nest routes are behind a Nest app-wide guard
      if (NEST_PUBLIC.test(decos)) rec.nestPublic = true;
      const next = routes.slice(idx + 1).find((x) => x.line > r.line)?.line || r.line + 80;
      const body = lines.slice(hIdx, Math.min(next - 1, hIdx + 80)).join('\n');
      if (guard) Object.assign(rec, { guard, via: 'decorator' });
      else if (rec.nestPublic && INLINE_CHECK.test(body)) rec.via = 'inline';
      if (SIGNATURE_CHECK.test(body)) rec.signed = true;
      if (PUBLIC_RESPONSE.test(body)) rec.publicResponse = true;
      if (r.handler) rec.fn = r.handler;
      out.push(rec);
      return;
    }
    if (r.framework === 'firebase') {
      // a callable checks request.auth (v1: context.auth) or turns on App Check; an onRequest function
      // checks a token or signature itself, like any other handler
      const next = routes.slice(idx + 1).find((x) => x.line > r.line)?.line || r.line + 80;
      const body = lines.slice(r.line - 1, Math.min(next - 1, r.line + 80)).join('\n');
      if (FIREBASE_CHECK.test(body) || INLINE_CHECK.test(body)) rec.via = 'inline';
      if (SIGNATURE_CHECK.test(body)) rec.signed = true;
      rec.fn = r.handler;
      out.push(rec);
      return;
    }
    if (r.framework === 'next') {
      if (SELF_CHECKING_ROUTES.test(src)) rec.via = 'library';
      else if (NEXT_GUARD.test(src) || INLINE_CHECK.test(src)) rec.via = 'inline';
      if (SIGNATURE_CHECK.test(src)) rec.signed = true;
      const handler = nextHandler(src, r.method);
      if (METHOD_NOT_ALLOWED.test(handler) && !READS_PRIVATE.test(handler)) rec.notAllowed = true;
      if (r.method === 'GET') rec.nextGet = true;
      rec.fn = r.method;
      out.push(rec);
      return;
    }
    // the route call's own arguments before its handler: router.post('/x', requireAuth, async (req, res) => …),
    // or router.post('/x', requireAuth, createOrder) where the last one is the handler
    const head = lines.slice(r.line - 1, r.line + 4).join('\n');
    const call = /\.\w+\(\s*["'`][^"'`]*["'`]\s*,/.exec(head);
    let args = '';
    if (call) {
      let depth = 1, j = call.index + call[0].length;
      for (; j < head.length && depth; j++) { if (head[j] === '(') depth++; else if (head[j] === ')') depth--; }
      const own = head.slice(call.index + call[0].length, depth ? j : j - 1);
      const fn = /(?:async\s*)?(?:\(\s*req\b|function\b|\breq\s*=>|\(\s*\{|\(\s*c\s*\)|\(\s*ctx\b)/.exec(own);
      args = fn ? own.slice(0, fn.index) : own.slice(0, Math.max(0, own.lastIndexOf(',')));
    }
    // Fastify per-route hooks take precedence over adjacent route middleware.
    const objectMw = (r.guardOptions || [])
      .flatMap((option) => option.replace(JS_STRING, '""').match(/[A-Za-z_$][\w$.]*/g) || [])
      .map((name) => name.split('.').pop())
      .find(isJsGuardName);
    const mw = objectMw || (args.replace(JS_STRING, '""').match(/[A-Za-z_$][\w$.]*/g) || [])
      .map((name) => name.split('.').pop()).find(isJsGuardName);
    // the next route below this one (routes are listed by kind, not in file order)
    const next = Math.min(...routes.map((x) => x.line).filter((l) => l > r.line), r.line + 60);
    const body = lines.slice(r.line - 1, Math.min(next - 1, r.line + 60)).join('\n');
    const prior = uses.find((u) => u.v === r.var && u.line < r.line);
    if (mw) Object.assign(rec, { guard: mw, via: 'middleware' });
    else if (prior) Object.assign(rec, { guard: prior.name, via: 'router' });
    else if (INLINE_CHECK.test(body)) rec.via = 'inline';
    if (SIGNATURE_CHECK.test(body)) rec.signed = true;
    if (PUBLIC_RESPONSE.test(body)) rec.publicResponse = true;
    out.push(rec);
  });
}

// ---------- Laravel: who may call each endpoint ----------
// Laravel's routes come from routes.mjs with the middleware of the route, its groups and the route files around
// it. Here, per PHP file: the app's middleware aliases and groups (bootstrap/app.php, or app/Http/Kernel.php
// before Laravel 11), a controller's own middleware, the checks inside each controller method and the form
// requests it takes. buildHealth puts them together for each endpoint (laravelFinding).

const LARAVEL_MW_CONFIG = /->\s*withMiddleware\s*\(|\$(?:middlewareGroups|middlewareAliases|routeMiddleware)\s*=/;
// a method that checks the caller itself: a policy or gate, a permission test, an abort with 401/403
// (an abort_if's condition is read up to 300 characters, so a file of `abort_if(` with no `;` isn't read once per call)
const PHP_INLINE_CHECK = /\$this\s*->\s*authorize\w*\s*\(|\bGate\s*::\s*(?:authorize|allows|denies|check|any|none|inspect|forUser)\s*\(|\babort_(?:if|unless)\s*\([^;]{0,300}?(?:->\s*(?:can|cannot|cant|user)\s*\(|auth\(\)|Auth\s*::|\b40[13]\b)|\babort\s*\(\s*40[13]\b|->\s*(?:can|cannot|cant)\s*\(|\bAuth\s*::\s*(?:check|guest|authenticate)\s*\(|\bauth\(\)\s*->\s*(?:check|guest|authenticate)\s*\(|\bpolicy\s*\(|\bthrow\s+new\s+\\?(?:[\w\\]*\\)?(?:AuthorizationException|AuthenticationException|AccessDeniedHttpException|UnauthorizedHttpException)\b/;
// a form request's authorize() that looks at the user, rather than `return true;`
const PHP_REQUEST_CHECK = /->\s*user\s*\(|->\s*(?:can|cannot|cant)\s*\(|\bGate\s*::|\bauth\(\)|\bAuth\s*::|->\s*authorize\w*\s*\(/;

/** A middleware entry as a name: 'auth:sanctum' stays, EnsureStaff::class and Authenticate::using('x') become the class name. */
const phpMwName = (t) => {
  const s = phpStr(t);
  if (s != null) return s;
  const m = /^\\?((?:[\w]+\\)*)(\w+)\s*::\s*(?:class\b|using\s*\()/.exec((t || '').trim());
  return m ? m[2] : null;
};
const phpMwItems = (t) => { const b = phpArrayBody(t); return (b != null ? phpSplit(b) : t ? [t] : []).map(phpMwName).filter(Boolean); };
const phpStrList = (t) => { const s = phpStr(t); if (s != null) return [s]; const b = phpArrayBody(t); return b == null ? [] : phpSplit(b).map(phpStr).filter((x) => x != null); };

/**
 * One PHP file, ready to read: code (stripPhp), bare (strings blanked), close (where brackets close) and spend
 * (phpBudget). args(open) is the argument list of the call whose ( is at open, and text(from, to) a piece of code,
 * each empty once the file's allowance for reading nested text again is used up.
 */
function phpSource(src) {
  const code = stripPhp(src), bare = phpBare(code), close = phpBrackets(bare), spend = phpBudget(code.length);
  const args = (open) => { const a = phpParts(code, bare, close, open + 1, close(open) - 1); return spend(a.reduce((n, x) => n + x.length, 0)) ? a : []; };
  return { code, bare, close, args, text: (from, to) => (spend(to - from) ? code.slice(from, to) : '') };
}

/** The middleware aliases and groups an app defines: { aliases: { name: ClassName }, groups: { name: [entries] } }. */
function laravelMiddlewareConfig({ bare, close, args, text }) {
  const aliases = {}, groups = {};
  const add = (g, list, front) => { groups[g] = front ? [...list, ...(groups[g] || [])] : [...(groups[g] || []), ...list]; };
  // Laravel 11+: $middleware->alias([...]), ->group('x', [...]), ->appendToGroup('x', [...]), ->web(append: [...])
  for (const m of bare.matchAll(/->\s*(alias|group|appendToGroup|prependToGroup|web|api)\s*\(/g)) {
    const a = args(m.index + m[0].length - 1);
    if (m[1] === 'alias') { for (const [k, v] of phpPairs(a[0])) if (k) aliases[k] = phpMwName(v); }
    else if (m[1] === 'web' || m[1] === 'api') { for (const x of a) { const [name, val] = phpNamed(x); if (name === 'append' || name === 'prepend') add(m[1], phpMwItems(val), name === 'prepend'); } }
    else { const g = phpStr(a[0]); if (g) add(g, phpMwItems(a[1]), m[1] === 'prependToGroup'); }
  }
  // Laravel 10 and older: properties of app/Http/Kernel.php
  for (const m of bare.matchAll(/\$(middlewareGroups|middlewareAliases|routeMiddleware)\s*=\s*(?=\[|array\s*\()/g)) {
    const start = m.index + m[0].length;
    const open = bare[start] === '[' ? start : bare.indexOf('(', start);
    const pairs = phpPairs(text(start, close(open)));
    for (const [k, v] of pairs) if (k) { if (m[1] === 'middlewareGroups') add(k, phpMwItems(v)); else aliases[k] = phpMwName(v); }
  }
  return { aliases, groups };
}

/** A controller's own middleware: HasMiddleware's static middleware() (Laravel 11+), or $this->middleware(…) in its constructor. */
function controllerMiddleware({ bare, close, args, text }) {
  const out = [];
  const m = /\bfunction\s+middleware\s*\(\s*\)\s*(?::\s*\??[\w\\]+\s*)?\{/.exec(bare);
  if (m) {
    const open = m.index + m[0].length - 1;
    // the list it returns: from its first return to the ; that ends the method
    const body = text(open + 1, close(open) - 1).trim();
    const ret = body.endsWith(';') ? /\breturn\s+/.exec(body) : null;
    for (const item of phpSplit(phpArrayBody(ret ? body.slice(ret.index + ret[0].length, -1).trim() : '') ?? '')) {
      const nm = /^new\s+\\?(?:[\w\\]*\\)?Middleware\s*\(([\s\S]*)\)$/.exec(item.trim());
      if (!nm) { const name = phpMwName(item); if (name) out.push({ name }); continue; }
      const parts = phpSplit(nm[1]).map(phpNamed);
      const named = Object.fromEntries(parts.filter(([k]) => k));
      const first = parts.find(([k]) => !k)?.[1] ?? named.middleware;
      for (const name of phpMwItems(first)) out.push({ name, ...(named.only ? { only: phpStrList(named.only) } : {}), ...(named.except ? { except: phpStrList(named.except) } : {}) });
    }
  }
  const tail = /\s*->\s*(only|except)\s*\(/y;
  for (const mm of bare.matchAll(/\$this\s*->\s*middleware\s*\(/g)) {
    const open = mm.index + mm[0].length - 1;
    tail.lastIndex = close(open);
    const t = tail.exec(bare);
    const limit = t ? phpStrList(args(tail.lastIndex - 1)[0]) : null;
    for (const name of args(open).flatMap(phpMwItems)) out.push({ name, ...(t ? { [t[1]]: limit } : {}) });
  }
  return out;
}

// PHP that answers web requests itself: it reads the request, or declares routes in a way the scan doesn't read
// yet (Symfony's #[Route], Slim's or Lumen's $app->get('/…')). Read outside comments and strings.
const PHP_SERVER_CODE = /\$_(?:GET|POST|REQUEST|FILES)\b|\$_SERVER\s*\[|#\[\s*Route\s*\(|\$(?:app|router)\s*->\s*(?:get|post|put|patch|delete|any|map)\s*\(/g;
function phpServerCode({ code, bare }) {
  for (const m of bare.matchAll(PHP_SERVER_CODE)) {
    const next = code.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (m[0].startsWith('$_SERVER')) {
      const key = /^\s*(['"])(REQUEST_(?:METHOD|URI))\1/.exec(next);
      if (key) return { at: m.index, how: 'reads', what: `$_SERVER['${key[2]}']` };
    } else if (m[0].startsWith('$')) {
      if (!m[0].startsWith('$_')) { if (/^\s*['"]\//.test(next)) return { at: m.index, how: 'calls', what: m[0].replace(/\s*\($/, '').replace(/\s+/g, '') }; }
      else return { at: m.index, how: 'reads', what: m[0] };
    } else return { at: m.index, how: 'declares routes with', what: '#[Route]' };
  }
  return null;
}

function phpChecks(src, f, out) {
  if (TEST_FILE.test(f.path)) return;
  const php = phpSource(src);
  const { code, bare, close, text } = php;
  // code that answers web requests, for "What was checked" when no endpoints were found (templates only show what they're given)
  if (!EXAMPLE_FILE.test(f.path) && !/\.blade\.php$/i.test(f.path)) {
    const sv = phpServerCode(php);
    if (sv) out.push({ k: 'server-code', line: lineIndex(code)(sv.at), how: sv.how, what: sv.what });
  }
  if (LARAVEL_MW_CONFIG.test(bare)) out.push({ k: 'laravel-mw', ...laravelMiddlewareConfig(php) });
  const mw = controllerMiddleware(php);
  if (mw.length) out.push({ k: 'php-ctrl-mw', items: mw });
  // each public method: does it check the caller itself, and which classes does it take (a form request may check)
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  const brace = /\s*(?::[^{;]{1,300})?\{/y;
  for (const m of f.methods || []) {
    if (m.hidden) continue;
    const from = bare.indexOf('(', starts[m.line - 1] ?? 0);
    if (from < 0) continue;
    brace.lastIndex = close(from);
    const body = brace.exec(bare) ? text(brace.lastIndex, close(brace.lastIndex - 1) - 1) : '';
    const checked = PHP_INLINE_CHECK.test(body);
    if (checked || m.types?.length) out.push({ k: 'php-fn', fn: m.name, ...(checked ? { checked: true } : {}), ...(m.types?.length ? { takes: m.types } : {}) });
  }
  // a form request whose authorize() looks at the user
  if (/\bextends\s+\\?(?:[\w\\]*\\)?FormRequest\b/.test(bare) && f.classes?.length) {
    const a = /\bfunction\s+authorize\s*\(\s*\)\s*(?::\s*\??\w+\s*)?\{/.exec(bare);
    const body = a ? text(a.index + a[0].length, close(a.index + a[0].length - 1) - 1) : '';
    if (PHP_REQUEST_CHECK.test(body)) out.push({ k: 'php-form-request', cls: f.classes[0] });
  }
}

// Laravel's own middleware that let only signed-in (or permitted) callers through
const LARAVEL_GUARD = /^(auth|auth\.basic|auth\.session|can|verified|signed|password\.confirm|abilities|ability|role|permission|role_or_permission|subscribed)$/;
// middleware classes that check the caller, by name (EnsurePortalAccess, RequireTwoFactor, BindDevice…)…
const LARAVEL_GUARD_CLASS = /(^|_)(authenticate|authenticated|authenticates|auth|authorize|authorized|login|permissions?|roles?|admins?|staff|access|two_?factor|2fa|tokens?|signature|signed|abilities|ability|owner|members?|verified|device|account)(_|$)/;
// …unless the name says it does something else
const NOT_LARAVEL_GUARD = /header|version|locale|json|log|throttle|cors|cache|store|request_?id|idempot|deprecat|https|body|trim|encrypt|cookie|csrf|binding|precognit|maintenance|trust|appearance|inertia|preload|observe|security_?header/;
const laravelGuard = (entry, aliases) => {
  const base = entry.split(':')[0];
  if (LARAVEL_GUARD.test(base)) return true;
  const cls = aliases[base] || (/^[A-Z]/.test(base) ? base : null);
  const n = cls && snake(cls);
  return !!n && LARAVEL_GUARD_CLASS.test(n) && !NOT_LARAVEL_GUARD.test(n);
};

/**
 * FastAPI dependencies that check the caller, per repo: Map(repo -> { aliases: Map(alias -> file), checks(ref) }).
 * A dependency function checks the caller by its name (admin_user, validate_jwt), by raising a 401 or 403
 * itself or in the function it returns (a factory like require_role), or by taking a checking dependency
 * (Depends(require_login)) or a checking alias (`admin: AdminUser`). A module-level name checks when what it
 * holds does: `api = Depends(require_key)`, `editor = require_role("editor")`, `WRITE = [Depends(require_login)]`.
 * An alias checks the caller when its dependency function does, e.g.
 * `AdminOffice = Annotated[Office, Depends(admin_owned_office)]` where admin_owned_office takes `admin: AdminUser`,
 * or when its own name reads as a check (`AdminAccess = Annotated[dict, Depends(check)]`),
 * unless either name says it's a database session (`SqlSessionDep` over `get_sql_session`).
 * `checks` takes a route's depRefs (see pyDepRefs).
 */
function pyDependencyGuards(files, findings) {
  const byRepo = new Map(); // repo -> { aliases: Map(name -> {fn, file}), fns: Map(name -> {deps, types, rejects}), vars: Map(name -> finding) }
  for (const f of files) for (const x of findings(f.path)) {
    if (x.k !== 'py-alias' && x.k !== 'py-dep-fn' && x.k !== 'py-dep-var') continue;
    const k = f.repo ?? '';
    if (!byRepo.has(k)) byRepo.set(k, { aliases: new Map(), fns: new Map(), vars: new Map() });
    const r = byRepo.get(k);
    if (x.k === 'py-alias') r.aliases.set(x.name, { fn: x.fn, file: f.path });
    else if (x.k === 'py-dep-var') r.vars.set(x.name, x);
    else r.fns.set(x.name, { deps: x.deps || [], types: x.types || [], rejects: !!x.rejects });
  }
  const out = new Map();
  for (const [repo, { aliases, fns, vars }] of byRepo) {
    const ok = new Map();
    const looking = new Set(); // names being looked at, so a loop of names ends
    const via = (name, look) => {
      if (looking.has(name) || looking.size > 12) return false;
      looking.add(name);
      try { return look(); } finally { looking.delete(name); }
    };
    // a function (or the result of calling one) passed to Depends()
    const checks = (fn) => !!fn && !isDbDep(fn) && (isGuardDep(fn) || via(fn, () => {
      const d = fns.get(fn);
      if (d && (d.rejects || d.deps.some(checks) || d.types.some((t) => ok.has(t)))) return true;
      const v = vars.get(fn);
      return !!v?.call && checks(v.call);
    }));
    const ref = (r) => {
      const at = r.indexOf(':'), kind = r.slice(0, at), name = r.slice(at + 1);
      if (kind === 'fn') return checks(name);
      const v = vars.get(name);
      if (kind === 'dep') return !!v?.depends && checks(v.depends);
      return kind === 'list' && !!v?.list && via(name, () => v.list.some(ref));
    };
    const aliasChecks = (name, fn) => checks(fn) || (isGuardDep(name) && !isDbDep(fn));
    // a few passes, so aliases built on other aliases resolve in any file order
    for (let pass = 0; pass < 3; pass++) for (const [name, a] of aliases) if (!ok.has(name) && aliasChecks(name, a.fn)) ok.set(name, a.file);
    out.set(repo, { aliases: ok, checks: ref });
  }
  return out;
}

// ---------- 3. the usual mistakes in apps built on Supabase, Firebase, Stripe, Next.js and Vite ----------

// Frontend build tools copy variables with these prefixes into the code every visitor downloads.
// (A bare PUBLIC_ prefix only means that to SvelteKit and Astro, so it counts only where they read it.)
const PUBLIC_PREFIX = /^(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|PUBLIC)_/;
const CLIENT_ONLY_PREFIX = /^(VITE|REACT_APP|EXPO_PUBLIC|GATSBY|PUBLIC)_/; // these exist only in browser code
// After the prefix: names that hold something private…
const PRIVATE_NAME = /(^|_)(SECRETS?|SERVICE_ROLE|SERVICE_KEY|PRIVATE|PASSWORD|PASSWD|PWD|DATABASE_URL|DB_URL|CONNECTION_STRING|ADMIN_KEY|ADMIN_TOKEN|AUTH_TOKEN|JWT_SECRET)(_|$)/;
// …or a key or token for a service that charges you or acts as you (AI, email, messaging, code hosting)
const PRIVATE_SERVICE = /(^|_)(OPENAI|ANTHROPIC|CLAUDE|GEMINI|GROQ|GROK|XAI|MISTRAL|REPLICATE|ELEVEN_?LABS|SENDGRID|RESEND|POSTMARK|MAILGUN|BREVO|TWILIO|OPENROUTER|DEEPSEEK|PERPLEXITY|COHERE|TOGETHER|FIREWORKS|HUGGING_?FACE|HF|STABILITY|FAL|ASSEMBLY_?AI|DEEPGRAM|PINECONE|SERPAPI|TAVILY|FIRECRAWL|AIRTABLE|NOTION|GITHUB|SLACK|DISCORD|TELEGRAM|STRIPE)(_|$)/;
const KEYISH = /(^|_)(KEY|API_?KEY|TOKEN|SECRET)$/;
// Keys that are public by design: Supabase's anon key, Stripe's publishable key, reCAPTCHA site keys, IDs
const PUBLIC_BY_DESIGN = /(^|_)(PUBLISHABLE|ANON|PK|PUBLIC|SITE|CLIENT_ID|APP_ID|PROJECT_ID|MEASUREMENT_ID)(_|$)/;
const SERVICE_LABEL = { OPENAI: 'OpenAI', ANTHROPIC: 'Anthropic', CLAUDE: 'Anthropic', GEMINI: 'Google Gemini', GROQ: 'Groq', GROK: 'xAI', XAI: 'xAI', ELEVENLABS: 'ElevenLabs', ELEVEN_LABS: 'ElevenLabs', SENDGRID: 'SendGrid', OPENROUTER: 'OpenRouter', DEEPSEEK: 'DeepSeek', HF: 'Hugging Face', HUGGINGFACE: 'Hugging Face', HUGGING_FACE: 'Hugging Face', ASSEMBLYAI: 'AssemblyAI', ASSEMBLY_AI: 'AssemblyAI', SERPAPI: 'SerpApi', GITHUB: 'GitHub' };

/** For a variable like VITE_OPENAI_API_KEY: the service it unlocks ('OpenAI', or '' for a generic secret), or null when it's fine to be public. */
export function leakyPublicVar(name) {
  const m = PUBLIC_PREFIX.exec(name);
  if (!m) return null;
  const rest = name.slice(m[0].length);
  if (PUBLIC_BY_DESIGN.test(rest) || HASHED_NAME.test(rest)) return null;
  const svc = PRIVATE_SERVICE.exec(rest)?.[2];
  if (svc && KEYISH.test(rest)) return SERVICE_LABEL[svc] || svc.charAt(0) + svc.slice(1).toLowerCase();
  if (PRIVATE_NAME.test(rest)) return /SERVICE_ROLE|SERVICE_KEY/.test(rest) ? 'Supabase' : '';
  return null;
}

function findPublicEnv(src, f, out) {
  const at = lineIndex(src);
  const seen = new Set();
  const add = (name, idx) => { if (leakyPublicVar(name) === null || seen.has(name)) return; seen.add(name); out.push({ k: 'public-env', name, line: at(idx) }); };
  for (const m of src.matchAll(/\b(process\.env\.|process\.env\[\s*['"]|import\.meta\.env\.)([A-Z][A-Z0-9_]*)/g)) {
    if (/^PUBLIC_/.test(m[2]) && m[1].startsWith('process')) continue; // PUBLIC_ means nothing to Node
    add(m[2], m.index);
  }
  // import { … } from '$env/static/public', however many names: each "}" is found by reading forward once
  const nextClose = forwardIndexOf(src, '}');
  const from = /\s*from\s*['"]\$env\/(?:static|dynamic)\/public['"]/y;
  let end = 0, memoAt = -1, memo = false;
  for (const m of src.matchAll(/import\s*\{/g)) {
    if (m.index < end) continue;
    const close = nextClose(m.index + m[0].length);
    if (close < 0) break;
    if (close !== memoAt) { memoAt = close; from.lastIndex = close + 1; memo = from.test(src) && from.lastIndex; }
    if (!memo) continue;
    end = memo;
    for (const n of src.slice(m.index + m[0].length, close).match(/[A-Z][A-Z0-9_]*/g) || []) add(n, m.index);
  }
}

// Stripe: code that acts on payment events. Without checking Stripe's signature first, anyone can send
// a fake "payment succeeded" event to the webhook address.
const STRIPE_EVENT = /(?:\bcase\s*|[!=]==?\s*)["'](checkout\.session\.(?:completed|async_payment_succeeded)|payment_intent\.succeeded|invoice\.(?:paid|payment_succeeded|payment_failed)|customer\.subscription\.(?:created|updated|deleted)|charge\.(?:succeeded|refunded))["']/g;
const STRIPE_VERIFIED = /constructEvent(?:Async)?\s*\(|construct_event\s*\(|verifyHeader|verify_header|events\.retrieve\s*\(|Event\.retrieve\s*\(/;

function findStripeWebhook(src, f, out) {
  if (!/stripe/i.test(src)) return;
  // checked and fine: counted in "What was checked"
  if (STRIPE_VERIFIED.test(src) || (f.lang === 'csharp' && csStripeVerified(src))) { out.push({ k: 'stripe-signed' }); return; }
  const hits = [...src.matchAll(STRIPE_EVENT)].map((m) => ({ index: m.index, event: m[1] }));
  if (f.lang === 'csharp') hits.push(...csStripeEvents(src));
  if (!hits.length) return;
  hits.sort((a, b) => a.index - b.index);
  out.push({ k: 'stripe-unsigned', line: lineIndex(src)(hits[0].index), events: [...new Set(hits.map((h) => h.event))].slice(0, 4) });
}

const ENV_SECRET_STEP = `4. Add STRIPE_WEBHOOK_SECRET (empty) to .env.example and tell me where to get it: the Stripe dashboard (Developers → Webhooks → the endpoint → Signing secret), or \`stripe listen\` when testing locally.`;
const STRIPE_FIX = {
  python: {
    verify: 'stripe.Webhook.construct_event',
    steps: [
      `1. Read the raw request body as bytes (FastAPI: \`await request.body()\`; Flask: \`request.get_data()\`), not the parsed JSON.`,
      `2. Call \`stripe.Webhook.construct_event(payload, request.headers["stripe-signature"], os.environ["STRIPE_WEBHOOK_SECRET"])\` and return 400 if it raises.`,
    ],
    secret: ENV_SECRET_STEP,
  },
  next: {
    verify: 'stripe.webhooks.constructEvent',
    steps: [
      `1. Read the raw request body with \`await req.text()\` (App Router) or turn off the body parser for this route (Pages Router), not the parsed JSON.`,
      `2. Call \`stripe.webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET)\` (the \`stripe-signature\` header) and return 400 if it throws.`,
    ],
    secret: ENV_SECRET_STEP,
  },
  express: {
    verify: 'stripe.webhooks.constructEvent',
    steps: [
      `1. Give this route the raw body: \`express.raw({ type: 'application/json' })\` on it, registered before \`express.json()\` runs for it.`,
      `2. Call \`stripe.webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET)\` (the \`stripe-signature\` header) and return 400 if it throws.`,
    ],
    secret: ENV_SECRET_STEP,
  },
  csharp: {
    verify: 'EventUtility.ConstructEvent',
    steps: [
      `1. Read the raw request body with \`await new StreamReader(Request.Body).ReadToEndAsync()\`, not a model-bound parameter.`,
      `2. Call \`EventUtility.ConstructEvent(json, Request.Headers["Stripe-Signature"], webhookSecret)\` with the secret read from configuration, and return 400 if it throws a \`StripeException\`.`,
    ],
    secret: `4. Add an empty Stripe:WebhookSecret setting (user secrets locally, an environment variable such as Stripe__WebhookSecret when deployed) and tell me where to get it: the Stripe dashboard (Developers → Webhooks → the endpoint → Signing secret), or \`stripe listen\` when testing locally.`,
  },
};

/** Which Stripe fix instructions fit a file: Python, a Next.js route, Express, or ASP.NET Core. */
function stripeStack(file) {
  if (/\.py$/.test(file)) return 'python';
  if (/\.cs$/.test(file)) return 'csharp';
  if (/(^|\/)app\/.*route\.[jt]s$|(^|\/)pages\/api\//.test(file)) return 'next';
  return 'express';
}

// CORS: a server that tells browsers any website may call it. Harmless for a public API without login
// cookies; with them, any site a signed-in visitor opens could act as them.
function findCors(src, f, out) {
  const at = lineIndex(src);
  const add = (idx, how, credentials) => out.push({ k: 'cors-any', line: at(idx), how, credentials });
  if (['typescript', 'javascript'].includes(f.lang)) {
    if (/require\(\s*['"]cors['"]\s*\)|from\s+['"]cors['"]/.test(src)) {
      for (const m of src.matchAll(/\bcors\(\s*\)/g)) add(m.index, 'cors()', false);
      for (const m of src.matchAll(/\bcors\(\s*\{([^}]*)\}/g)) {
        const origin = /\borigin\s*:\s*(?:(['"`])\*\1|(true)\b)/.exec(m[1]);
        // '*' with credentials is refused by browsers; origin: true echoes whichever site asks
        if (origin) add(m.index, origin[2] ? 'cors({ origin: true })' : "cors({ origin: '*' })", !!origin[2] && /\bcredentials\s*:\s*true/.test(m[1]));
      }
    }
    const credHeader = /['"]Access-Control-Allow-Credentials['"]\s*[,:]\s*['"`]?true/i.test(src);
    for (const m of src.matchAll(/['"]Access-Control-Allow-Origin['"]\s*[,:]\s*(?:(['"`])\*\1|(req(?:uest)?\.headers(?:\.origin\b|\[\s*['"]origin['"]\s*\]|\.get\(\s*['"]origin['"]\s*\))))/gi)) {
      add(m.index, m[2] ? 'Access-Control-Allow-Origin set to the caller’s origin' : 'Access-Control-Allow-Origin: *', !!m[2] && credHeader);
    }
  } else if (f.lang === 'python') {
    for (const m of src.matchAll(/CORSMiddleware\s*,([\s\S]{0,800}?)\)\s*$/gm)) {
      if (/allow_origins\s*=\s*\[\s*(['"])\*\1\s*\]|allow_origin_regex\s*=\s*r?(['"])\.\*\2/.test(m[1])) add(m.index, 'CORSMiddleware with allow_origins=["*"]', /allow_credentials\s*=\s*True/.test(m[1]));
    }
    for (const m of src.matchAll(/\bCORS\(\s*\w+\s*(?:\)|,([^)]*)\))/g)) {
      const opts = m[1] || '';
      if (/\borigins["']?\s*[:=]\s*(?!(['"])\*\1)/.test(opts)) continue; // a list of allowed sites (origins=… or "origins": …)
      add(m.index, 'CORS(app) with every origin allowed', /supports_credentials\s*=\s*True/.test(opts));
    }
    const all = /^[ \t]*CORS_(?:ALLOW_ALL_ORIGINS|ORIGIN_ALLOW_ALL)\s*=\s*True\b/m.exec(src);
    if (all) add(all.index, 'CORS_ALLOW_ALL_ORIGINS = True', /^[ \t]*CORS_ALLOW_CREDENTIALS\s*=\s*True\b/m.test(src));
  } else if (f.lang === 'csharp') {
    csCors(src, add);
  }
}

// Supabase / Postgres migrations: tables, row-level security switched on or off, tables dropped or
// renamed, and security rules that let anyone change a table. build.mjs replays them in file order.
const SQL_ID = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const SQL_NAME = String.raw`(?:${SQL_ID}\s*\.\s*)?${SQL_ID}`;
const sqlName = (raw) => {
  const parts = raw.split(/\s*\.\s*(?=(?:"[^"]*"|[^"])*$)/).map((p) => p.trim().replace(/^"|"$/g, '').toLowerCase());
  return parts.length > 1 ? `${parts[0]}.${parts[1]}` : `public.${parts[0]}`;
};

function findSql(src, f, out) {
  // blank out comments, keeping line breaks so line numbers stay right
  const s = blankBlockComments(src.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length)));
  const at = lineIndex(s);
  const found = [];
  for (const m of s.matchAll(new RegExp(String.raw`\bcreate\s+(?:(temp|temporary)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(${SQL_NAME})`, 'gi'))) {
    if (!m[1]) found.push({ i: m.index, k: 'sql-table', table: sqlName(m[2]) });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${SQL_NAME})\s+(enable|disable|force|no\s+force)\s+row\s+level\s+security`, 'gi'))) {
    found.push({ i: m.index, k: 'sql-rls', table: sqlName(m[1]), on: !/^(disable|no)/i.test(m[2]) });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${SQL_NAME})\s+rename\s+to\s+(${SQL_ID})`, 'gi'))) {
    const from = sqlName(m[1]);
    found.push({ i: m.index, k: 'sql-rename', table: from, to: `${from.split('.')[0]}.${m[2].replace(/^"|"$/g, '').toLowerCase()}` });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(${SQL_NAME}(?:\s*,\s*${SQL_NAME})*)`, 'gi'))) {
    for (const t of m[1].split(/\s*,\s*/)) found.push({ i: m.index, k: 'sql-drop', table: sqlName(t) });
  }
  // a permissive rule that lets signed-out visitors add, change or delete rows: `using (true)` / `with check (true)`
  for (const m of s.matchAll(new RegExp(String.raw`\bcreate\s+policy\s+(${SQL_ID})\s+on\s+(${SQL_NAME})([^;]{0,4000})`, 'gi'))) {
    const body = m[3];
    if (/\bas\s+restrictive\b/i.test(body)) continue;
    const cmd = (/\bfor\s+(all|select|insert|update|delete)\b/i.exec(body)?.[1] || 'all').toLowerCase();
    if (cmd === 'select') continue;
    const to = /\bto\s+([\w\s,"]{1,300}?)(?=\s+(?:using|with)\b|\s*$)/i.exec(body)?.[1];
    const roles = to ? to.split(/\s*,\s*/).map((r) => r.replace(/"/g, '').trim().toLowerCase()) : ['public'];
    if (!roles.some((r) => r === 'anon' || r === 'public')) continue;
    const yes = (clause) => new RegExp(String.raw`\b${clause}\s*\(\s*\(?\s*true\s*\)?\s*\)`, 'i').test(body);
    const open = cmd === 'insert' ? yes('with\\s+check') : cmd === 'all' ? yes('using') || yes('with\\s+check') : yes('using');
    if (open) found.push({ i: m.index, k: 'sql-open-policy', table: sqlName(m[2]), policy: m[1].replace(/^"|"$/g, ''), cmd, signedOut: roles.includes('anon') || !to });
  }
  dynamicRls(s, found);
  for (const x of found.sort((a, b) => a.i - b.i)) { const { i, ...rest } = x; out.push({ ...rest, line: at(i) }); }
}

// Row-level security switched on with SQL built as it runs, the way one migration covers many tables:
//   foreach t in array array['wallets', 'ledger'] loop
//     execute format('alter table public.%I enable row level security', t);
//   end loop;
// The names in the loop's array literal count as switched on (or off). When the tables can't be read from the
// migration (a loop over a query, a variable from elsewhere), it's recorded as `sql-rls-dynamic`, so the tables
// it may cover are reported as "can't tell" instead of "never switched on".
const RLS_WORDS = /(enable|disable|force|no\s+force)\s+row\s+level\s+security/gi;
const SQL_ARRAY = String.raw`array\s*\[[^\]]{0,4000}\]|'\{[^}']{0,4000}\}'`;
const ARRAY_CAST = String.raw`(?:\s*::\s*\w+(?:\s*\[\s*\])?)?`;
/** The text of the statement starting at `from`, up to the `;` that ends it outside quotes (at most 2000 characters). */
function statementFrom(s, from) {
  let q = false;
  for (let i = from; i < s.length && i < from + 2000; i++) {
    if (s[i] === "'") q = !q;
    else if (s[i] === ';' && !q) return s.slice(from, i);
  }
  return null;
}
/** The items of an array literal: array['a', 'b'] or '{a,b}'. */
function arrayItems(lit) {
  if (/^array/i.test(lit)) return [...lit.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  return lit.slice(2, -2).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
}
/**
 * What an `execute` runs, as a template with %I where a value goes in, and those values:
 * format('alter table %I …', t) → { tpl: 'alter table %I …', args: ['t'] }, and the same for
 * 'alter table ' || quote_ident(t) || ' …'. Null when it's something else.
 */
function executeTemplate(stmt) {
  const f = /^\s*format\s*\(\s*'((?:[^']|''){0,1000})'\s*((?:,[^;]{0,500})?)\)\s*$/i.exec(stmt);
  if (f) return { tpl: f[1].replace(/''/g, "'"), args: f[2].split(',').slice(1).map((a) => a.trim()) };
  const parts = stmt.split('||').map((p) => p.trim());
  if (parts.length < 2 || !parts.some((p) => p.startsWith("'"))) return null;
  let tpl = '';
  const args = [];
  for (const p of parts) {
    const lit = /^'((?:[^']|''){0,1000})'$/.exec(p);
    if (lit) { tpl += lit[1].replace(/''/g, "'"); continue; }
    tpl += '%I';
    args.push(p);
  }
  return { tpl, args };
}
function dynamicRls(s, found) {
  if (!/\bexecute\b/i.test(s) || !RLS_WORDS.test(s)) return;
  RLS_WORDS.lastIndex = 0;
  // loops over a list of names: foreach t in array <list> loop, for t in [select] unnest(<list>) loop
  const loops = [];
  const list = String.raw`(${SQL_ARRAY}|[A-Za-z_]\w*)${ARRAY_CAST}`;
  for (const m of s.matchAll(new RegExp(String.raw`\bforeach\s+([A-Za-z_]\w*)\s+in\s+array\s+${list}\s+loop\b|\bfor\s+([A-Za-z_]\w*)\s+in\s+(?:select\s+(?:\*\s+from\s+)?)?unnest\s*\(\s*${list}\s*\)(?:\s+(?:as\s+)?[A-Za-z_]\w*)?\s+loop\b`, 'gi'))) {
    const v = (m[1] || m[3]).toLowerCase();
    let lit = m[2] || m[4];
    if (!/^(array|')/i.test(lit)) {
      // a variable declared with the list: tables text[] := array['a', 'b'];
      const decl = [...s.slice(0, m.index).matchAll(new RegExp(String.raw`\b${lit}\s+(?:text|varchar|name|regclass|character\s+varying)\s*\[\s*\]\s*(?::=|=|default)\s*(${SQL_ARRAY})`, 'gi'))].pop();
      lit = decl ? decl[1] : null;
    }
    loops.push({ v, items: lit ? arrayItems(lit) : null, start: m.index, end: m.index + m[0].length });
  }
  /** The innermost loop above `at` that is still open there. */
  const loopAround = (at) => {
    for (let k = loops.length - 1; k >= 0; k--) {
      const lp = loops[k];
      if (lp.end > at) continue;
      let depth = 1;
      for (const t of s.slice(lp.end, at).matchAll(/\bend\s+loop\b|\bloop\b/gi)) { depth += /^end/i.test(t[0]) ? -1 : 1; if (!depth) break; }
      if (depth > 0) return lp;
    }
    return null;
  };
  for (const m of s.matchAll(/\bexecute\b(?!\s+(?:function|procedure|on)\b)/gi)) {
    const stmt = statementFrom(s, m.index + m[0].length);
    if (!stmt || !new RegExp(RLS_WORDS.source, 'i').test(stmt)) continue;
    const ex = executeTemplate(stmt);
    const unread = (on) => found.push({ i: m.index, k: 'sql-rls-dynamic', on });
    if (!ex) { unread(!/\b(disable|no\s+force)\s+row/i.test(stmt)); continue; }
    for (const w of ex.tpl.matchAll(RLS_WORDS)) {
      const on = !/^(disable|no)/i.test(w[1]);
      const target = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(\S+)\s+$/i.exec(ex.tpl.slice(0, w.index));
      if (target && !target[1].includes('%')) continue; // a table named outright: read like any other alter table
      const ph = target && new RegExp(String.raw`^(?:(${SQL_ID})\s*\.\s*)?%[IsL]$`).exec(target[1]);
      if (!ph) { unread(on); continue; }
      const nth = (ex.tpl.slice(0, w.index).replace(/%%/g, '').match(/%[IsL]/g) || []).length - 1;
      const arg = (ex.args[nth] || '').replace(/^quote_ident\s*\(\s*([^)]*?)\s*\)$/i, '$1').replace(/::\s*\w+$/, '').trim();
      const schema = ph[1] ? ph[1].replace(/^"|"$/g, '') + '.' : '';
      const named = /^'((?:[^']|''){1,200})'$/.exec(arg);
      if (named) { found.push({ i: m.index, k: 'sql-rls', table: sqlName(schema + named[1].replace(/''/g, "'")), on }); continue; }
      const lp = /^[A-Za-z_]\w*$/.test(arg) ? loopAround(m.index) : null;
      if (!lp || lp.v !== arg.toLowerCase() || !lp.items) { unread(on); continue; }
      for (const name of lp.items) found.push({ i: m.index, k: 'sql-rls', table: sqlName(schema + name), on });
    }
  }
}

// a call that starts a web server: if the scan found no endpoints next to one, it may use a setup it doesn't know
const SERVER_CODE = /\b(?:https?\.|http2\.)?createServer\s*\(|\bDeno\.serve\s*\(|\bBun\.serve\s*\(|\bserve\s*\(\s*\{\s*fetch\b|\.listen\s*\(\s*(?:\d|process\.env|PORT\b|port\b)|\buvicorn\.run\s*\(|\bhttp\.ListenAndServe\s*\(/;
const USES_SUPABASE = /@supabase\/(?:supabase-js|ssr|auth-helpers[\w-]*)|from\s+supabase\s+import|^[ \t]*import\s+supabase\b/m;

// ---------- per-file entry point ----------

export function findIssues(src, f) {
  const out = [];
  findSecrets(src, f, out);
  if (f.category !== 'code') return out;
  if (f.lang === 'sql') findSql(src, f, out);
  if (!TEST_FILE.test(f.path) && !EXAMPLE_FILE.test(f.path)) {
    if (['typescript', 'javascript', 'vue', 'svelte', 'astro'].includes(f.lang)) findPublicEnv(src, f, out);
    if (['typescript', 'javascript', 'python', 'csharp'].includes(f.lang)) { findStripeWebhook(src, f, out); findCors(src, f, out); }
  }
  if (['typescript', 'javascript', 'python'].includes(f.lang) && USES_SUPABASE.test(src)) out.push({ k: 'uses-supabase' });
  // code that starts a server, for "What was checked" when no endpoints were found
  if (['typescript', 'javascript', 'python', 'go'].includes(f.lang) && !TEST_FILE.test(f.path) && !EXAMPLE_FILE.test(f.path)) {
    const sv = SERVER_CODE.exec(src);
    if (sv && !(/^createServer/.test(sv[0]) && /from\s+['"]vite['"]|require\(\s*['"]vite['"]/.test(src))) out.push({ k: 'server-code', line: lineIndex(src)(sv.index), what: sv[0].replace(/\s*\($/, '') });
  }
  if (f.lang === 'python') pyRoutes(src, f, out);
  else if (['typescript', 'javascript'].includes(f.lang)) jsRoutes(src, f, out);
  else if (f.lang === 'csharp' && !TEST_FILE.test(f.path)) csRoutes(src, f, out, SIGNATURE_CHECK);
  else if (f.lang === 'php') phpChecks(src, f, out);
  // run directly or registered by name (so "nothing imports it" doesn't mean unused)
  if (/^#!|if\s+__name__\s*==\s*['"]__main__['"]|@(?:\w+\.)*(?:task|shared_task|command|group|receiver|scheduled_job|on_event|listener|hookimpl|periodic_task|cli\.command)\b|require\.main\s*===\s*module|import\.meta\.main/m.test(src)) out.push({ k: 'runnable' });
  // a frontend calling a fixed localhost address (breaks once deployed)
  // (only in files with no environment / hostname switching, where it can't be a dev-only fallback)
  if (['typescript', 'javascript', 'vue', 'svelte'].includes(f.lang) && !TEST_FILE.test(f.path) && !/process\.env|import\.meta\.env|NODE_ENV|location\.(hostname|host|origin)|isDev|__DEV__/.test(src)) {
    src.split('\n').forEach((t, i) => {
      if (/["'`]https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(t) && !/\?\?|\|\||local|dev|fallback|default|^\s*(\/\/|\*)/i.test(t.replace(/https?:\/\/(localhost|127\.0\.0\.1)/g, ''))) out.push({ k: 'localhost', line: i + 1 });
    });
  }
  return out;
}

// ======================= build: turn findings into issues =======================

const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const PUBLIC_PATH = /(^|\/)(health|healthz|healthcheck|ping|status|ready|readyz|readiness|live|livez|liveness|version|metrics|robots\.txt|sitemap[\w.]*|favicon[\w.]*|\.well-known|login|logout|signin|pair|sign-in|signout|signup|sign-up|register|forgot[\w-]*|reset[\w-]*|verify[\w-]*|oauth\w*|callback|auth|token|refresh|static|assets|public|newsletter|contact|waitlist|unsubscribe|openapi\.json|docs|swagger[\w.]*|i|images?)(\/|$)/i;
// A site's privacy, terms and legal pages, which every visitor may read: only reading them, and only when the whole
// address is the page (/privacy, /legal/imprint), so /account/privacy (someone's settings) or /api/legal/cases is still checked
const LEGAL_PAGE = /^\/(?:legal\/)?(?:privacy(?:-policy|-notice|-statement)?|terms(?:-of-(?:service|use)|-and-conditions|-conditions)?|tos|legal|imprint|impressum)\/?$/i;
// Files and feeds that exist to be read by crawlers, feed readers and AI tools. Only for reading: see publicByDesign.
const PUBLIC_FILE_PATH = /(^|\/)(llms(-full)?\.txt|ai\.txt|humans\.txt|(app-)?ads\.txt|security\.txt|rss(\.xml)?|atom(\.xml)?|feed\.(xml|rss|atom|json)|index\.xml|opensearch\.xml|site\.webmanifest|manifest\.(json|webmanifest)|openapi\.ya?ml)$/i;
const LISTING_FILE = /(^|\/)(llms(-full)?\.txt|robots\.txt)$/i;
/** The addresses a project publishes in its llms.txt, or explicitly allows in its robots.txt. */
function listedPaths(file, src) {
  const found = /robots\.txt$/i.test(file) ? [...src.matchAll(/^\s*Allow:\s*(\/\S*)/gim)] : [...src.matchAll(/(?:https?:\/\/[^\s/)\]"'<>]+|(?<![\w./-]))(\/[^\s)\]"'<>#?*]+)/g)];
  return found.map((m) => m[1].replace(/[.,;:]+$/, '').replace(/\/$/, '')).filter((p) => p.length > 1 && !p.includes('*'));
}
const WEBHOOK_PATH = /webhook|\/hooks?\//i;
// endpoints under a webhook URL that manage the webhooks (create, list, test…) rather than receive them
const WEBHOOK_ADMIN = /\/(manage|admin|setup|settings|config|list|create|register|delete|test[\w-]*)(\/|$)/i;
const NOT_USED_KINDS = new Set(['test', 'script', 'infra', 'config', 'worker', 'external']);
const SPECIAL_FILE = /(^|\/)(index|main|app|server|cli|manage|wsgi|asgi|__init__|__main__|conftest|setup|config|settings|env|middleware|instrumentation|layout|page|route|loading|error|not-found|template|default|global-error|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon|_app|_document|_error|404|500|models|admin|apps|views|urls|signals|tasks|forms|serializers|celery|gunicorn\.conf|vite-env\.d|worker|sw|service-worker)\.[a-z]+$|\.d\.ts$|\.config\.[a-z]+$|\.stories\.|(^|\/)(pages|migrations|alembic|versions|scripts|bin|tools|seeds?|fixtures?|examples?|docs?|public|static|templates|\.github|e2e|cypress|playwright)\//i;
// A comment saying a tool opens this file by name, or that it's generated: not leftover code, whatever imports it
const LOADED_BY_NAME = /^\s*(?:\/\/|\/?\*|#|<!--|"""|''')[^\n]*(?:\b(?:cli|tool|tooling|framework|runner|bundler|build|compiler|plugin|sdk|script)\b[^\n]*\b(?:reads?|loads?|imports?|runs?|executes?|opens?|requires?|picks? up)\b[^\n]*\b(?:this file|directly|by name|by path|at runtime)\b|\bthis file is (?:read|loaded|imported|run|executed|required|used|picked up)\b[^\n]*\b(?:by|directly|at runtime)\b|\bthis (?:file|code) (?:is|was) (?:auto-?)?generated\b|@generated\b|\b(?:auto-?)?generated (?:file|code)\b|\bcode generated by\b|\bdo not (?:edit|modify|delete|remove) (?:this|it)\b)/im;
const USED_LANGS = new Set(['typescript', 'javascript', 'python', 'vue', 'svelte', 'astro', 'liquid']);
const plural = (n, w, ws) => `${n} ${n === 1 ? w : ws || w + 's'}`;

/** How a fix prompt names a check: a FastAPI alias parameter, a Python decorator, a C# attribute, or as written. */
function guardLabel(name, defs, lang) {
  if (defs.some((g) => g.alias)) return `a parameter typed ${name}`;
  if (lang === 'python') return '@' + name;
  if (lang === 'php' && /^[a-z]/.test(name)) return `the '${name}' middleware`;
  // [Authorize(...)] and .RequireAuthorization(...) arrive written out; a custom attribute arrives as its name
  if (lang === 'csharp' && !/^[[.]/.test(name)) return `[${name}]`;
  return name;
}

export function buildHealth({ graph, scan, arch, root }) {
  const issues = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const fileByPath = new Map(graph.files.map((f) => [f.p, f]));
  const scanByPath = new Map(scan.files.map((f) => [f.path, f]));
  const lineage = (id) => { const out = []; let n = nodeById.get(id); while (n) { out.push(n); n = n.parent ? nodeById.get(n.parent) : null; } return out; };
  const kinds = (id) => lineage(id).map((n) => n.kind);
  const isFrontend = (p) => { const f = fileByPath.get(p); return !!f && kinds(f.n).includes('ui'); };
  const nameOf = (p) => fileByPath.get(p)?.name || p.split('/').pop();
  const label = (id) => nodeById.get(id)?.label || id;
  // Files outside the map (config, .env, Firebase rules) point at the module that owns their folder, or
  // failing that the most specific part of the map whose paths name them.
  const archGlobs = (arch?.nodes || []).filter((n) => n?.id && nodeById.has(n.id) && Array.isArray(n.paths)).flatMap((n) => n.paths.map((p) => ({ id: n.id, g: compileGlob(p) })));
  const globOwner = (p) => archGlobs.filter((x) => x.g.test(p)).sort((a, b) => b.g.specificity - a.g.specificity)[0]?.id;
  const dirOwner = new Map();
  for (const f of graph.files) { let d = f.p; while (d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')); if (!dirOwner.has(d)) dirOwner.set(d, new Map()); const m = dirOwner.get(d); m.set(f.n, (m.get(f.n) || 0) + 1); } }
  const itemFor = (p) => {
    if (fileByPath.has(p)) return 'f:' + p;
    let d = p;
    while (d.includes('/')) {
      d = d.slice(0, d.lastIndexOf('/'));
      const m = dirOwner.get(d);
      const top = m && [...m.entries()].filter(([n]) => n !== 'unassigned').sort((a, b) => b[1] - a[1])[0];
      if (top) return 'n:' + top[0];
    }
    const owner = globOwner(p);
    return owner ? 'n:' + owner : null;
  };
  const findings = (p) => scanByPath.get(p)?.issues || [];

  // ---------- secrets in code and config ----------
  const secretFiles = [];
  for (const f of scan.files) {
    const s = findings(f.path).filter((x) => x.k === 'secret');
    if (s.length) secretFiles.push({ path: f.path, list: s });
  }
  // credential files (service-account JSON, .pem keys) that the scanner doesn't read as config
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (TEST_FILE.test(f.path) || EXAMPLE_FILE.test(f.path) || /\.pub$/.test(base)) continue;
    if (!/\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)$|service[-_]?account.*\.json$|^credentials?\.json$|firebase-adminsdk.*\.json$|^client_secret.*\.json$|-key\.json$/i.test(base)) continue;
    let head = '';
    try { head = readHead(path.join(root, f.path), 65536); } catch { continue; }
    if (plainKeyIn(head) || /"private_key"\s*:\s*"-----|"client_secret"\s*:\s*"[^"]{8,}/.test(head) || /\.(p12|pfx|jks|keystore)$/i.test(base)) secretFiles.push({ path: f.path, list: [{ k: 'secret', line: 1, what: 'a credentials file (a private key that logs in as your app)', sev: 'high', hint: 'whole file' }], file: true });
  }
  const secretIssue = (group) => {
    const locations = [], notes = {}, items = [];
    const kinds = new Set(), svcs = new Set();
    let frontend = false;
    for (const { path: p, list, file } of group) {
      list.sort((a, b) => a.line - b.line);
      const it = itemFor(p);
      if (it && !items.includes(it)) items.push(it);
      for (const s of list) {
        locations.push({ file: p, line: s.line });
        kinds.add(s.what);
        if (s.svc) svcs.add(s.svc);
      }
      if (isFrontend(p)) frontend = true;
      if (it) notes[it] = (notes[it] ? notes[it] + ' · ' : '') + list.slice(0, 4).map((s) => `${file ? p.split('/').pop() : `line ${s.line}`}: ${s.name ? `${s.name}, ` : ''}${s.what.replace(/ \(.*\)$/, '')} (${s.hint})`).join(' · ') + (list.length > 4 ? ` · +${list.length - 4} more` : '');
    }
    const n = locations.length;
    const sev = group.some((g) => g.list.some((s) => s.sev === 'high')) ? 'high' : 'medium';
    const one = group.length === 1 ? group[0].path : null;
    const kindText = kinds.size === 1 ? [...kinds][0].replace(/ \(.*\)$/, '') : 'passwords or keys';
    return {
      id: 'secret:' + (one || group.map((g) => g.path).join('|')),
      kind: 'secret', severity: sev,
      title: n === 1 ? `A secret key is written into ${one ? one.split('/').pop() : `${group.length} more files`}` : `${n} passwords or keys are written into ${one ? one.split('/').pop() : `${group.length} more files`}`,
      detail: `${one ? `${nameOf(one)} (${one})` : plural(group.length, 'file')} contains ${n === 1 ? kindText : `${n} secrets (${kindText})`}. Anyone who can see the code can use ${n === 1 ? 'it' : 'them'} to get into ${svcs.size ? [...svcs].slice(0, 4).join(', ') : 'the services they unlock'} as you${frontend ? ', and this code is sent to every visitor’s browser' : ''}. Treat ${n === 1 ? 'it' : 'them'} as leaked: move ${n === 1 ? 'it' : 'them'} out of the code and replace ${n === 1 ? 'it with a new one' : 'them with new ones'}.`,
      items, notes, locations,
      fix: [
        `Security fix: hard-coded secrets. Do not print, echo or repeat any secret value in your replies, commits or logs.`,
        ``,
        `These lines contain ${n === 1 ? 'a secret' : 'secrets'} written directly in the code:`,
        ...group.flatMap(({ path: p, list, file }) => list.map((s) => `- ${p}${file ? ' (the whole file)' : `:${s.line}`}: ${s.name ? `${s.name} — ` : ''}${s.what.replace(/ \(.*\)$/, '')}`)),
        ``,
        `For each one:`,
        `1. Replace the literal with an environment variable lookup (${group.some((g) => /\.py$/.test(g.path)) ? `os.environ["NAME"] in Python` : ''}${group.some((g) => /\.py$/.test(g.path)) && group.some((g) => /\.[jt]sx?$/.test(g.path)) ? ', ' : ''}${group.some((g) => /\.[jt]sx?$/.test(g.path)) ? 'process.env.NAME in JavaScript/TypeScript' : ''}${!group.some((g) => /\.(py|[jt]sx?)$/.test(g.path)) ? 'or a secret manager reference' : ''}), using a clear variable name. If the app can't run without it, fail with a clear error when it is missing instead of falling back to a hard-coded value.`,
        `2. Add each variable name (with an empty value, never the real one) to .env.example, and make sure .env is listed in .gitignore.`,
        frontend ? `3. This is frontend code that ships to the browser. Move the call that needs the secret to a server-side route or function so the key never reaches visitors.` : `3. Update any deployment config (Docker, Cloud Run, Vercel, etc.) so the variable is set in production.`,
        group.some((g) => g.file) ? `4. Remove the credentials file from the repository (git rm --cached), add its name to .gitignore, and load it from a path given by an environment variable.` : `4. Run the app or its tests to confirm it still starts with the variables set.`,
        ``,
        `Then give me a short checklist (without the values) of which services these keys belong to, so I can rotate each one: create a new key in that service's dashboard, put it in my environment, and revoke the old one. Because the old values are in git history, assume they are compromised.`,
      ].join('\n'),
    };
  };
  secretFiles.sort((a, b) => b.list.length - a.list.length);
  const MAX_SECRET_ISSUES = 8;
  secretFiles.slice(0, MAX_SECRET_ISSUES).forEach((g) => issues.push(secretIssue([g])));
  if (secretFiles.length > MAX_SECRET_ISSUES) issues.push(secretIssue(secretFiles.slice(MAX_SECRET_ISSUES)));

  // ---------- .env files that are (or will be) committed ----------
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!/^\.env(\.[\w.-]+)?$/i.test(base) || /example|sample|template|dist|defaults?|schema|test/i.test(base)) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    const secretVars = [];
    src.split('\n').forEach((t, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*["']?([^"'#\s]*)/.exec(t);
      if (!m || !m[2]) return;
      const n = snake(m[1]);
      const known = FORMATS.some((fm) => { fm.re.lastIndex = 0; const hit = fm.re.test(m[2]); fm.re.lastIndex = 0; return hit; });
      if (known || (SECRET_NAME.test(n) && !PUBLIC_NAME.test(n) && valueLooksReal(m[2], n)) || (/url|uri|dsn/i.test(n) && /:\/\/[^:\s\/]{1,200}:[^@\s]{1,200}@/.test(m[2]))) secretVars.push({ name: m[1], line: i + 1 });
    });
    if (!secretVars.length) continue;
    const repoAbs = f.repo ? path.join(root, f.repo) : root;
    const relInRepo = f.repo ? f.path.slice(f.repo.length + 1) : f.path;
    const tracked = !!git(repoAbs, ['ls-files', '--', relInRepo]);
    const it = itemFor(f.path);
    issues.push({
      id: 'env-file:' + f.path, kind: 'env-file', severity: tracked ? 'high' : 'medium',
      title: tracked ? 'Your private settings file is saved in git' : 'Your private settings file isn’t hidden from git',
      detail: tracked
        ? `${f.path} holds ${plural(secretVars.length, 'password or key', 'passwords and keys')} and is committed, so everyone with access to the code (and its history) can read them. This file is meant to stay on your computer only.`
        : `${f.path} holds ${plural(secretVars.length, 'password or key', 'passwords and keys')} and isn’t listed in .gitignore, so the next commit will upload it with your code.`,
      items: it ? [it] : [], notes: it ? { [it]: `${f.path}: ${secretVars.slice(0, 6).map((v) => v.name).join(', ')}${secretVars.length > 6 ? '…' : ''}` } : {},
      locations: secretVars.map((v) => ({ file: f.path, line: v.line })),
      fix: [
        `Security fix: ${f.path} contains secrets and ${tracked ? 'is committed to git' : 'is not ignored by git'}. Do not print or repeat any value from it.`,
        ``,
        `1. Add ${base} (and .env*.local) to ${f.repo ? f.repo + '/' : ''}.gitignore, keeping .env.example tracked.`,
        tracked ? `2. Stop tracking it without deleting my local copy: git rm --cached "${relInRepo}" (run inside ${f.repo || 'the repo'}), then commit.` : `2. Confirm with git status that the file no longer shows up as a new file.`,
        `3. Create or update .env.example next to it with the same variable names and empty values: ${secretVars.map((v) => v.name).join(', ')}.`,
        tracked ? `4. Give me a checklist (names only, no values) of which keys I need to rotate in each service's dashboard, since they are in git history. Mention that removing them from history needs a tool like git filter-repo, and ask before doing that.` : `4. Tell me which deployment settings need these variables.`,
      ].join('\n'),
    });
  }

  // ---------- secret keys in variables the browser gets (NEXT_PUBLIC_, VITE_ …) ----------
  const live = (p) => !TEST_FILE.test(p) && !EXAMPLE_FILE.test(p);
  const publicVars = new Map(); // name -> { svc, refs: [{file, line}], defs: [{file, line}] }
  const publicVar = (name) => { if (!publicVars.has(name)) publicVars.set(name, { name, svc: leakyPublicVar(name), refs: [], defs: [] }); return publicVars.get(name); };
  for (const f of scan.files) if (live(f.path)) for (const x of findings(f.path)) if (x.k === 'public-env') publicVar(x.name).refs.push({ file: f.path, line: x.line });
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!/^\.env(\.[\w.-]+)?$/i.test(base) || /example|sample|template|dist|schema/i.test(base) || !live(f.path)) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    src.split('\n').forEach((t, i) => {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*["']?([^"'#\s]*)/.exec(t);
      if (!m || !m[2] || leakyPublicVar(m[1]) === null) return;
      // VITE_ADMIN_PASSWORD=$2b$12$… is a hash (or ciphertext), not the password
      if (protectedValue(m[2], m[1])) publicVar(m[1]).protected = true;
      else if (!PLACEHOLDER.test(m[2]) && !/^\$/.test(m[2])) publicVar(m[1]).defs.push({ file: f.path, line: i + 1 });
    });
  }
  for (const [name, v] of publicVars) if (v.protected && !v.defs.length) publicVars.delete(name);
  if (publicVars.size) {
    const vars = [...publicVars.values()];
    const browserSide = (p) => isFrontend(p) || /\.(jsx|tsx|vue|svelte|astro)$/.test(p);
    const sev = vars.some((v) => CLIENT_ONLY_PREFIX.test(v.name) || v.refs.some((r) => browserSide(r.file))) ? 'high' : 'medium';
    const svcs = [...new Set(vars.map((v) => v.svc).filter(Boolean))];
    const locations = vars.flatMap((v) => [...v.defs, ...v.refs]);
    const items = [], notes = {};
    for (const v of vars) for (const loc of [...v.refs, ...v.defs]) {
      const it = itemFor(loc.file);
      if (!it) continue;
      if (!items.includes(it)) items.push(it);
      const note = `line ${loc.line}: ${v.name}`;
      if (!(notes[it] || '').includes(note)) notes[it] = (notes[it] ? notes[it] + ' · ' : '') + note;
    }
    const names = vars.map((v) => v.name);
    issues.push({
      id: 'public-env', kind: 'public-env-secret', severity: sev,
      title: vars.length === 1 ? `${names[0]} is sent to every visitor’s browser` : `${vars.length} secret keys are sent to every visitor’s browser`,
      detail: `Settings whose names start with NEXT_PUBLIC_, VITE_ and the like are copied into the code your site sends to every visitor, where anyone can read them in their browser’s developer tools. ${vars.length === 1 ? `${names[0]} looks like a secret key` : `${names.slice(0, 4).join(', ')}${vars.length > 4 ? '…' : ''} look like secret keys`}${svcs.length ? ` (for ${svcs.slice(0, 4).join(', ')})` : ''}, so anyone could use ${vars.length === 1 ? 'it' : 'them'} as you: run up your bill, send messages as you, or reach your data.${sev === 'medium' ? ' Right now only server code seems to read it, so it may not have reached a browser yet, but the name invites that.' : ''}`,
      items, notes, locations,
      fix: [
        `Security fix: secret keys in public environment variables (the browser gets every variable with these prefixes). Do not print, echo or repeat any key value.`,
        ``,
        ...vars.map((v) => `- ${v.name}${v.svc ? ` (${v.svc})` : ''}: ${[...v.defs.map((d) => `set in ${d.file}:${d.line}`), ...v.refs.map((r) => `used in ${r.file}:${r.line}`)].slice(0, 6).join(', ')}`),
        ``,
        `For each one:`,
        `1. Rename it without the public prefix (for example OPENAI_API_KEY instead of VITE_OPENAI_API_KEY) in the .env files, .env.example and the hosting settings.`,
        `2. Move every place that uses it into server-side code (a Next.js route handler or server action, a Supabase Edge Function, a serverless function or the existing backend) and have the frontend call that instead, so the key never reaches the browser.`,
        vars.some((v) => v.svc === 'Supabase') ? `3. For the Supabase service-role key: browser code should use the anon key and rely on row-level security; only server code may use the service-role key.` : `3. Keep the frontend working the same way, and run the app to check.`,
        ``,
        `Then give me a checklist (names only, no values) of the keys to rotate in each service's dashboard: anyone who loaded the site may have copied them.`,
      ].join('\n'),
    });
  }

  // ---------- Supabase tables anyone can read and change ----------
  const usesSupabase = scan.files.some((f) => /(^|\/)supabase\/(migrations\/|config\.toml$|functions\/)/.test(f.path) || findings(f.path).some((x) => x.k === 'uses-supabase'));
  let supabaseTables = 0; // for "What was checked"
  if (usesSupabase) {
    const byRepo = new Map(); // repo -> [file, …] in path order (migrations are named by timestamp)
    for (const f of scan.files) if (f.lang === 'sql' && live(f.path) && findings(f.path).some((x) => x.k.startsWith('sql-'))) { const k = f.repo ?? ''; if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(f.path); }
    for (const [repo, sqlFiles] of byRepo) {
      const tables = new Map(); // table -> { file, line, rls, off }
      const policies = [];
      for (const p of sqlFiles.sort()) for (const x of findings(p)) {
        const t = tables.get(x.table);
        if (x.k === 'sql-table' && !t) tables.set(x.table, { file: p, line: x.line, rls: null });
        else if (x.k === 'sql-rls' && t) { t.rls = x.on; t.off = x.on ? null : { file: p, line: x.line }; t.dyn = null; }
        // switched on (or off) for tables the migration doesn't name: each table it may cover becomes "can't tell"
        else if (x.k === 'sql-rls-dynamic') { for (const u of tables.values()) if (x.on ? u.rls !== true : u.rls === true) { u.rls = 'unsure'; u.dyn = { file: p, line: x.line, on: x.on }; } }
        else if (x.k === 'sql-rename' && t) { tables.delete(x.table); tables.set(x.to, t); for (const pol of policies) if (pol.table === x.table) pol.table = x.to; }
        else if (x.k === 'sql-drop') tables.delete(x.table);
        else if (x.k === 'sql-open-policy') policies.push({ ...x, file: p });
      }
      const short = (t) => t.replace(/^public\./, '');
      const open = [...tables.entries()].filter(([name, t]) => name.startsWith('public.') && t.rls !== true && t.rls !== 'unsure');
      const unsure = [...tables.entries()].filter(([name, t]) => name.startsWith('public.') && t.rls === 'unsure');
      supabaseTables += [...tables.keys()].filter((name) => name.startsWith('public.')).length;
      if (open.length) {
        const items = [], notes = {};
        for (const [name, t] of open) {
          const it = itemFor(t.file);
          if (!it) continue;
          if (!items.includes(it)) items.push(it);
          notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `line ${t.line}: ${short(name)} (row-level security ${t.off ? 'switched off' : 'never switched on'})`;
        }
        const list = open.map(([name]) => short(name));
        issues.push({
          id: 'rls:' + repo, kind: 'database-rules', severity: 'high',
          title: open.length === 1 ? `Anyone can read and change your ${list[0]} table` : `Anyone can read and change ${open.length} of your database tables`,
          detail: `Your app talks to Supabase with a public key that every visitor’s browser has. Row-level security is what stops one person from reading or changing someone else’s rows, and it’s off for ${open.length === 1 ? `the ${list[0]} table` : `${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''}`}. Without it, anyone can use that key to read, change or delete every row${open.length === 1 ? '' : ' in them'}. If your app only reaches the database from its own server, the risk is lower, but switching it on is still the safe default.`,
          items, notes,
          locations: open.map(([, t]) => t.off || { file: t.file, line: t.line }),
          fix: [
            `Security fix: Supabase tables without row-level security (RLS). Do not print any keys.`,
            ``,
            `Anyone with the app's public (anon) key can read and change these tables:`,
            ...open.map(([name, t]) => `- ${name}: created in ${t.file}:${t.line}${t.off ? `, row-level security switched off in ${t.off.file}:${t.off.line}` : ''}`),
            ``,
            `1. Read how the app uses each table: which pages read or write it, and whether rows belong to a user (for example a user_id column that should match auth.uid()).`,
            `2. Write one new migration (don't edit the old ones) that runs \`alter table <table> enable row level security;\` for each table, plus policies so the app keeps working: usually signed-in users can read and change only their own rows (\`using (auth.uid() = user_id)\`), and tables meant to be public get a read-only policy. Server code that uses the service-role key isn't affected by these rules.`,
            `3. Explain the policies to me in plain words before applying anything, and don't loosen any existing policy.`,
            `4. Tell me how to apply the migration (for example \`supabase db push\`) and how to check, while signed out, that I can't read other people's rows.`,
          ].join('\n'),
        });
      }
      if (unsure.length) {
        const items = [], notes = {};
        for (const [name, t] of unsure) {
          const it = itemFor(t.dyn.file);
          if (!it) continue;
          if (!items.includes(it)) items.push(it);
          const note = `line ${t.dyn.line}: row-level security switched ${t.dyn.on ? 'on' : 'off'} for tables this migration doesn’t name`;
          if (!(notes[it] || '').includes(note)) notes[it] = (notes[it] ? notes[it] + ' · ' : '') + note;
        }
        const list = unsure.map(([name]) => short(name));
        const where = [...new Map(unsure.map(([, t]) => [`${t.dyn.file}:${t.dyn.line}`, t.dyn])).values()];
        issues.push({
          id: 'rls-unsure:' + repo, kind: 'database-rules', severity: 'medium',
          title: unsure.length === 1 ? `Floorplan can’t tell whether your ${list[0]} table is protected` : `Floorplan can’t tell whether ${unsure.length} of your database tables are protected`,
          detail: `A migration (${where[0].file.split('/').pop()}, line ${where[0].line}) switches row-level security ${unsure[0][1].dyn.on ? 'on' : 'off'} with SQL it puts together as it runs, so Floorplan can’t see which tables it covers. If ${unsure.length === 1 ? `the ${list[0]} table` : `any of ${list.slice(0, 6).join(', ')}${list.length > 6 ? ` or ${list.length - 6} more` : ''}`} ends up without it, anyone with your app’s public key could read or change every row there. Worth checking once in the Supabase dashboard, where a table without it is marked “RLS disabled”.`,
          items, notes,
          locations: where.map((w) => ({ file: w.file, line: w.line })),
          fix: [
            `Security check: Supabase tables whose row-level security (RLS) is set by dynamic SQL. Do not print any keys.`,
            ``,
            `Row-level security is switched on or off with SQL built at run time here:`,
            ...where.map((w) => `- ${w.file}:${w.line}`),
            ``,
            `Check whether that covers each of these tables:`,
            ...unsure.map(([name, t]) => `- ${name}: created in ${t.file}:${t.line}`),
            ``,
            `1. Read the migration and tell me in plain words which tables it switches row-level security on for.`,
            `2. For any table it misses, write one new migration (don't edit the old ones) that runs \`alter table <table> enable row level security;\` plus policies so the app keeps working (usually \`using (auth.uid() = user_id)\` for rows that belong to a user). Show me before applying anything.`,
            `3. Tell me how to check, while signed out, that I can't read other people's rows.`,
          ].join('\n'),
        });
      }
      const loose = policies.filter((pol) => tables.get(pol.table)?.rls === true);
      if (loose.length) {
        const verb = (cmd) => ({ insert: 'add', update: 'change', delete: 'delete' }[cmd] || 'add, change and delete');
        const rowsOf = (cmd, t) => `${verb(cmd)} rows ${{ insert: 'to', delete: 'from' }[cmd] || 'in'} ${t}`;
        const items = [], notes = {};
        for (const pol of loose) {
          const it = itemFor(pol.file);
          if (!it) continue;
          if (!items.includes(it)) items.push(it);
          notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `line ${pol.line}: “${pol.policy}” lets anyone ${rowsOf(pol.cmd, short(pol.table))}`;
        }
        issues.push({
          id: 'open-policy:' + repo, kind: 'database-rules', severity: 'medium',
          title: loose.length === 1 ? `A database rule lets anyone change your ${short(loose[0].table)} table` : `${loose.length} database rules let anyone change your data`,
          detail: `${loose.length === 1 ? `The rule “${loose[0].policy}” lets anyone` : `These rules let anyone`}${loose.some((pol) => pol.signedOut) ? ', even people who aren’t signed in,' : ''} ${loose.length === 1 ? rowsOf(loose[0].cmd, short(loose[0].table)) : `add, change or delete rows in ${[...new Set(loose.map((pol) => short(pol.table)))].slice(0, 5).join(', ')}`}. If a table is a public form (like a waitlist or contact form), letting anyone add rows is fine; otherwise limit it to signed-in users and their own rows.`,
          items, notes,
          locations: loose.map((pol) => ({ file: pol.file, line: pol.line })),
          fix: [
            `Security review: Supabase row-level security policies that allow anyone to change data (\`using (true)\` / \`with check (true)\` for anon or public):`,
            ...loose.map((pol) => `- “${pol.policy}” on ${pol.table} (for ${pol.cmd}) — ${pol.file}:${pol.line}`),
            ``,
            `For each one, tell me in plain words what it allows and whether the app needs that. If the table isn't meant to be public, replace \`true\` with a check such as \`auth.uid() = user_id\`, limited to authenticated users, in a new migration. If it's a public form, keep adding rows open but make sure nobody can read, change or delete other people's rows. Show me the change before applying it.`,
          ].join('\n'),
        });
      }
    }
  }

  // ---------- Firebase security rules that let anyone in ----------
  const today = new Date();
  const longDate = (d) => d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  const firebaseFiles = []; // rules files read, for "What was checked"
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!live(f.path) || !(/\.rules$/i.test(base) || /^database(\.[\w-]+)?\.rules\.json$/i.test(base))) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    const rtdb = /\.json$/i.test(base);
    const service = rtdb ? 'Realtime Database' : /service\s+firebase\.storage/.test(src) ? 'Storage' : /service\s+cloud\.firestore/.test(src) ? 'Firestore' : null;
    if (!service) continue;
    firebaseFiles.push(f.path);
    const rules = rtdb ? firebaseRtdbRules(src, today) : firebaseRules(src, today);
    // the whole database, or (Firestore and Storage) any change beyond adding new records to one place
    const severe = (r) => r.wide || (!rtdb && !r.createOnly);
    const writes = rules.filter((r) => r.write && r.open !== 'expired' && severe(r));
    const deepWrites = rules.filter((r) => r.write && r.open === 'always' && !severe(r));
    const reads = rules.filter((r) => r.read && !r.write && r.open !== 'expired' && r.wide);
    const until = rules.find((r) => r.open === 'until');
    const expired = rules.find((r) => r.open === 'expired');
    if (!writes.length && !deepWrites.length && !reads.length && !expired) continue;
    const files = service === 'Storage';
    const what = files ? 'files' : 'data';
    const deploy = { Firestore: 'firestore:rules', Storage: 'storage', 'Realtime Database': 'database' }[service];
    const shown = [...writes, ...deepWrites, ...reads, ...(expired ? [expired] : [])];
    let title, detail, severity;
    if (until && writes.length) {
      severity = 'high';
      title = `Your Firebase ${service} is open to anyone until ${longDate(until.until)}`;
      detail = `${base} still has Firebase’s “test mode” rules: anyone can read and change ${files ? 'every file' : 'everything'} until ${longDate(until.until)}, without signing in or using your app. After that date every request is refused and the app stops working, so replace them with real rules rather than moving the date.`;
    } else if (writes.length) {
      severity = 'high';
      title = files ? 'Anyone can upload, replace or delete your Firebase files' : `Anyone can change or delete your Firebase ${service} data`;
      detail = `A rule in ${base} (line ${writes[0].line}, at ${writes[0].where}) lets anyone, signed in or not, ${files ? 'upload, replace or delete files' : 'add, change or delete data'}. Your app’s Firebase settings are in every visitor’s browser, so anyone can use them to reach your ${service} directly, without going through your app.`;
    } else if (deepWrites.length || reads.length) {
      severity = 'medium';
      title = reads.length && !deepWrites.length ? `Anyone can read everything in your Firebase ${service}` : `Anyone can change part of your Firebase ${service}`;
      detail = [
        reads.length ? `A rule in ${base} (line ${reads[0].line}) lets anyone read every ${files ? 'file' : 'record'}, including data that may belong to your users. If everything there is meant to be public, that’s fine; otherwise it needs a sign-in check.` : '',
        deepWrites.length ? `A rule in ${base} (line ${deepWrites[0].line}) lets anyone ${deepWrites[0].createOnly ? 'add to' : 'change'} ${deepWrites[0].where} without signing in. If that’s a public form (like a waitlist or contact form), that can be fine; otherwise it needs a sign-in check.` : '',
      ].filter(Boolean).join(' ');
    } else {
      severity = 'medium';
      title = `Your Firebase ${service} test-mode rules ran out on ${longDate(expired.until)}`;
      detail = `${base} has Firebase’s “test mode” rules, which stopped allowing access on ${longDate(expired.until)}. Every read and write is now refused, so the parts of the app that use ${service} won’t work. Replace them with real rules instead of moving the date, which would open everything to anyone again.`;
    }
    const it = itemFor(f.path);
    issues.push({
      id: 'firebase-rules:' + f.path, kind: 'database-rules', severity, title, detail,
      items: it ? [it] : [], notes: it ? { [it]: shown.slice(0, 4).map((r) => `line ${r.line}: ${r.text}`).join(' · ') } : {},
      locations: shown.map((r) => ({ file: f.path, line: r.line })),
      fix: [
        `Security fix: Firebase ${service} security rules in ${f.path}.`,
        ``,
        `These rules let anyone in (or have expired):`,
        ...shown.map((r) => `- line ${r.line}: ${r.text}`),
        ``,
        `1. Read how the app uses each ${rtdb ? 'path' : files ? 'storage folder' : 'collection'}: what each screen reads and writes, and which data belongs to a user (for example ${files ? 'files under a folder named after the user’s uid' : 'documents keyed by the user’s uid, or with an ownerId field'}).`,
        `2. Rewrite the rules so signed-in users can only read and write their own ${what} (${rtdb ? 'auth != null && auth.uid === $uid' : files ? 'request.auth != null && request.auth.uid == userId' : 'request.auth != null && request.auth.uid == resource.data.ownerId'}), public content is read-only, and everything else is denied. Don't use test-mode dates.`,
        `3. Explain the new rules to me in plain words and wait for my OK.`,
        `4. Then deploy them with \`firebase deploy --only ${deploy}\` and check them in the Firebase console's Rules Playground (or the emulator): a signed-out user shouldn't be able to read or change anything private.`,
      ].join('\n'),
    });
  }

  // ---------- Stripe webhooks that don't check Stripe's signature ----------
  const stripeFiles = new Map(); // file -> finding
  for (const f of scan.files) if (live(f.path)) { const x = findings(f.path).find((y) => y.k === 'stripe-unsigned'); if (x) stripeFiles.set(f.path, x); }
  for (const [file, x] of stripeFiles) {
    const routesHere = graph.routes.map((r, i) => ({ r, i })).filter(({ r }) => r.f === file && r.m !== 'GET');
    const it = itemFor(file);
    const items = [...(it ? [it] : []), ...routesHere.map(({ i }) => 'r:' + i)];
    const fixSteps = STRIPE_FIX[stripeStack(file)];
    issues.push({
      id: 'stripe-webhook:' + file, kind: 'stripe-webhook', severity: 'high',
      title: `Anyone could fake a Stripe payment in ${nameOf(file)}`,
      detail: `${file.split('/').pop()} acts on Stripe events (like “${x.events[0]}”) without checking Stripe’s signature, so anyone who finds the address can send a fake “payment succeeded” message and get orders, credits or a subscription for free. Stripe signs every real event; checking that signature takes a few lines.`,
      items, notes: Object.fromEntries(items.map((id) => [id, id.startsWith('r:') ? 'Receives Stripe events without checking they’re real' : `line ${x.line}: handles ${x.events.join(', ')} without checking Stripe’s signature`])),
      locations: [{ file, line: x.line }],
      fix: [
        `Security fix in ${file}: verify Stripe webhook signatures before acting on any event. Do not print any secret values.`,
        ``,
        `It handles ${x.events.join(', ')} (line ${x.line}) without calling ${fixSteps.verify}.`,
        ``,
        ...fixSteps.steps,
        `3. Use only the verified event from then on, and handle each event once even if Stripe sends it again.`,
        fixSteps.secret,
      ].join('\n'),
    });
  }

  // ---------- servers that let any website call them (CORS) ----------
  const cors = [];
  for (const f of scan.files) if (live(f.path)) for (const x of findings(f.path)) if (x.k === 'cors-any') cors.push({ file: f.path, ...x });
  if (cors.length) {
    const cred = cors.filter((c) => c.credentials);
    const filesC = [...new Set(cors.map((c) => c.file))];
    const items = [], notes = {};
    for (const c of cors) {
      const it = itemFor(c.file);
      if (!it) continue;
      if (!items.includes(it)) items.push(it);
      notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `line ${c.line}: ${c.how}${c.credentials ? ', with login cookies' : ''}`;
    }
    issues.push({
      id: 'cors', kind: 'cors', severity: cred.length ? 'medium' : 'low',
      title: cred.length ? 'Any website could act as your signed-in users' : 'Any website can call your server from a visitor’s browser',
      detail: cred.length
        ? `${cred[0].file.split('/').pop()} lets any website call this server from a visitor’s browser and send along their login cookies. So a site a signed-in user happens to visit could quietly read their data or act as them. Allow only your own app’s address instead.`
        : `${filesC.length === 1 ? filesC[0].split('/').pop() : `${filesC.length} files`} tell browsers that any website may call this server. That’s fine for a public API that doesn’t use login cookies (for example one that checks a token in the Authorization header); otherwise, allow only your own app’s address.`,
      items, notes,
      locations: cors.map((c) => ({ file: c.file, line: c.line })),
      fix: [
        `Security review: CORS settings that allow every website:`,
        ...cors.map((c) => `- ${c.file}:${c.line}: ${c.how}${c.credentials ? ' (with credentials)' : ''}`),
        ``,
        `First tell me in plain words whether this server uses login cookies or sessions, and which websites legitimately call it. Then replace the allow-everything setting with an explicit list of allowed origins read from an environment variable (for example ALLOWED_ORIGINS=https://myapp.com,http://localhost:3000). Keep credentials only if the app logs in with cookies, and never combine them with "*" or with echoing back whatever origin asks. Show me the change before making it, and change nothing else.`,
      ].join('\n'),
    });
  }

  // ---------- endpoints anyone can call ----------
  const routeFinding = new Map(); // `${file}|${line}|${method}` -> finding
  // ASP.NET Core facts that span files: projects, mounted and inherited access, handler checks, base classes
  const cs = csBuildContext(scan, findings);
  const globalGuards = new Map(); // repo -> [{framework, name, file}]
  const guardDefs = new Map();    // name -> [{ file, wrapper }]
  for (const f of scan.files) for (const x of findings(f.path)) {
    if (x.k === 'route') routeFinding.set(`${f.path}|${x.line}|${x.method}`, x);
    // app-wide checks count only from the app itself, not from scripts or tests that spin up their own
    if (x.k === 'global-guard' && !TEST_FILE.test(f.path) && !/(^|\/)(scripts?|tools|bin|examples?)\//.test(f.path) && !(fileByPath.has(f.path) && kinds(fileByPath.get(f.path).n).some((k) => NOT_USED_KINDS.has(k)))) { const k = f.repo ?? ''; if (!globalGuards.has(k)) globalGuards.set(k, []); globalGuards.get(k).push({ ...x, file: f.path }); }
    if (x.k === 'guard-def' && !TEST_FILE.test(f.path)) { if (!guardDefs.has(x.name)) guardDefs.set(x.name, []); guardDefs.get(x.name).push({ file: f.path, wrapper: !!x.wrapper, ...(x.base ? { base: true } : {}) }); }
  }
  const verifiedHelpers = new Map();
  for (const f of scan.files) {
    if (TEST_FILE.test(f.path)) continue;
    for (const x of findings(f.path)) {
      if (x.k !== 'py-verified-helper') continue;
      const repo = f.repo ?? '';
      if (!verifiedHelpers.has(repo)) verifiedHelpers.set(repo, new Map());
      const byName = verifiedHelpers.get(repo);
      if (!byName.has(x.name)) byName.set(x.name, []);
      byName.get(x.name).push(f.path);
    }
  }
  const routeImports = new Map();
  const helperImported = (file, helper, name) => {
    if (file === helper) return true;
    let src = routeImports.get(file);
    if (src === undefined) {
      try { src = fs.readFileSync(path.join(root, file), 'utf8'); }
      catch { src = ''; }
      routeImports.set(file, src);
    }
    const moduleName = helper.replace(/\.py$/, '').replace(/\//g, '.');
    const mod = moduleName.replaceAll('.', '\\.');
    return new RegExp('^\\s*from\\s+' + mod + '\\s+import\\s+[^\\n]*\\b' + name + '\\b', 'm').test(src);
  };
  const depGuards = pyDependencyGuards(scan.files.filter((f) => !TEST_FILE.test(f.path)), findings);
  for (const [repo, { aliases }] of depGuards) for (const [name, file] of aliases) {
    if (!guardDefs.has(name)) guardDefs.set(name, []);
    guardDefs.get(name).push({ file, alias: true, repo });
  }
  // a sign-in check applied where the route's router is mounted: app.use('/admin', requireStaff, adminRouter),
  // or app.include_router(admin.router, dependencies=[Depends(require_admin)]) (a database session isn't one)
  // In JavaScript that includes app.use('/api/*', auth) and router.use(requireAuth) above a mounted router, judged
  // like app-wide middleware since they cover every route behind them (app.use('/api', cors()) isn't one), and a
  // route served at two paths (mounted twice, or under /api and outside it) is open if either is.
  const isPy = (r) => scanByPath.get(r.file)?.lang === 'python';
  const mountCheck = (r) => r.framework !== 'laravel' && r.mountMw?.find(isPy(r) ? isGuardDep : isUseGuard);
  const mountGuard = new Map((scan.routes || []).filter(mountCheck).map((r) => [`${r.file}|${r.line}|${r.method}`, mountCheck(r)]));
  for (const r of scan.routes || []) if (!isPy(r) && !mountCheck(r)) mountGuard.delete(`${r.file}|${r.line}|${r.method}`);
  // Laravel: the route's own middleware and its groups' (through the app's aliases and groups), then the
  // controller's middleware, a form request that checks the user, or a check inside the method
  const lvConfig = new Map(); // repo -> { aliases, groups }
  const formRequests = new Set();
  for (const f of scan.files) for (const x of findings(f.path)) {
    if (x.k === 'php-form-request') formRequests.add(String(x.cls).toLowerCase());
    if (x.k !== 'laravel-mw') continue;
    const k = f.repo ?? '';
    const c = lvConfig.get(k) || { aliases: {}, groups: {} };
    Object.assign(c.aliases, x.aliases);
    for (const [g, list] of Object.entries(x.groups || {})) c.groups[g] = [...(c.groups[g] || []), ...list];
    lvConfig.set(k, c);
  }
  // a controller file's own middleware and its methods' facts, gathered once per file rather than once per route
  const factsOf = new Map();
  const phpFacts = (file) => {
    if (!factsOf.has(file)) {
      const fns = new Map();
      let ctrlMw = null;
      for (const x of findings(file)) {
        if (x.k === 'php-ctrl-mw' && !ctrlMw) ctrlMw = x;
        else if (x.k === 'php-fn' && !fns.has(x.fn.toLowerCase())) fns.set(x.fn.toLowerCase(), x);
      }
      factsOf.set(file, { ctrlMw, fns });
    }
    return factsOf.get(file);
  };
  const laravelFinding = (r) => {
    const { aliases, groups } = lvConfig.get(scanByPath.get(r.file)?.repo ?? '') || { aliases: {}, groups: {} };
    const expand = (n, depth = 0) => { const g = groups[n.split(':')[0]]; return g && depth < 6 ? g.flatMap((x) => expand(x, depth + 1)) : [n]; };
    const rec = { k: 'route', line: r.line, method: r.method, fn: r.action?.fn || null, ...(r.defFile ? { defFile: r.defFile, defLine: r.defLine } : {}) };
    const names = [...(r.mw || []), ...(r.mountMw || [])].flatMap((n) => expand(n));
    if (names.some((n) => n.split(':')[0] === 'guest')) return { ...rec, guest: true }; // for people who aren't signed in: sign-in pages
    const mw = names.find((n) => laravelGuard(n, aliases));
    if (mw) return { ...rec, guard: mw.split(':')[0], via: 'middleware' };
    const fn = r.action?.fn;
    const own = phpFacts(r.file);
    const ctrl = own.ctrlMw?.items.filter((i) => (!i.only || i.only.includes(fn)) && !(i.except || []).includes(fn)).flatMap((i) => expand(i.name)).find((n) => laravelGuard(n, aliases));
    if (ctrl) return { ...rec, guard: ctrl.split(':')[0], via: 'controller' };
    const method = fn && own.fns.get(fn.toLowerCase());
    const request = method?.takes?.find((t) => formRequests.has(t.toLowerCase()));
    if (request) return { ...rec, guard: request.split('\\').pop(), via: 'form request' };
    if (method?.checked) return { ...rec, via: 'inline' };
    // a closure that only redirects or answers something fixed, or a plain page: nothing to protect
    return r.quiet ? { ...rec, quiet: true } : rec;
  };
  for (const r of scan.routes || []) if (r.framework === 'laravel') routeFinding.set(`${r.file}|${r.line}|${r.method}`, laravelFinding(r));
  const sourceOf = new Map();
  const readSource = (p) => {
    if (!sourceOf.has(p)) { let src = ''; try { src = readHead(path.join(root, p), 262144); } catch { /* unreadable: nothing to go on */ } sourceOf.set(p, src); }
    return sourceOf.get(p);
  };
  // Serverless Framework: an authorizer (or API key) on the event in serverless.yml checks the caller before the
  // handler runs; without one, the handler may still check a token itself
  for (const r of scan.routes || []) {
    if (r.framework !== 'serverless') continue;
    const rec = { k: 'route', line: r.line, method: r.method, fn: r.handler };
    // a wrapper that hands the event on (`(e) => withAuth(e, users.update)`) may name the check among its arguments
    const wrapper = r.wrapFile ? readSource(r.wrapFile).split('\n').slice(r.wrapLine - 1, r.wrapLine + 15).join('\n').split(/\n\s*export\b/)[0] : '';
    // only what it's handed counts, not its own name (deleteUser, getSession) or the function it passes the request to
    const wrapGuard = (wrapper.replace(/^[^=]*=/, '').replace(JS_STRING, '""').match(/[A-Za-z_$][\w$]*/g) || [])
      .filter((n) => n !== r.wrapName && n !== r.handler).find(isJsGuardName);
    if (r.auth) Object.assign(rec, { guard: r.auth, via: 'gateway' });
    else if (wrapGuard) Object.assign(rec, { guard: wrapGuard, via: 'wrapper' });
    else {
      const body = readSource(r.file).split('\n').slice(r.line - 1, r.line + 80).join('\n');
      if (INLINE_CHECK.test(body) || INLINE_CHECK.test(wrapper)) rec.via = 'inline';
      if (SIGNATURE_CHECK.test(body)) rec.signed = true;
    }
    // one verdict per endpoint: several events (with and without an authorizer) can share a handler
    routeFinding.set(`${r.file}|${r.line}|${r.method}|${r.path}`, rec);
  }
  // Supabase Edge Functions answering every request themselves: the function's own code decides who may call it.
  // Supabase's verify_jwt (on unless config.toml turns it off) isn't counted: the public anon key the website
  // ships passes it, so it doesn't say the caller signed in.
  for (const r of scan.routes || []) {
    if (r.framework !== 'supabase-edge') continue;
    const body = readSource(r.file);
    const rec = { k: 'route', line: r.line, method: r.method, fn: null };
    if (INLINE_CHECK.test(body)) rec.via = 'inline';
    if (SIGNATURE_CHECK.test(body)) rec.signed = true;
    routeFinding.set(`${r.file}|${r.line}|${r.method}|${r.path}`, rec);
  }
  const published = new Map(); // repo -> addresses it lists for crawlers and AI tools
  for (const f of scan.files) {
    if (!LISTING_FILE.test(f.path) || TEST_FILE.test(f.path) || EXAMPLE_FILE.test(f.path)) continue;
    const k = f.repo ?? '';
    if (!published.has(k)) published.set(k, new Set());
    for (const p of listedPaths(f.path, readSource(f.path))) published.get(k).add(p);
  }
  const isListed = (repo, p) => {
    const listed = published.get(repo);
    if (!listed) return false;
    if (listed.has(p)) return true;
    if (!/\[\.\.\./.test(p)) return false; // a catch-all route covers what's listed under it
    const prefix = p.split('[')[0];
    return prefix.length > 1 && [...listed].some((x) => x.startsWith(prefix));
  };
  const importsOf = new Map();
  for (const l of graph.links) if (l.a !== l.b && l.a.startsWith('f:') && l.b.startsWith('f:')) { const a = l.a.slice(2); if (!importsOf.has(a)) importsOf.set(a, new Set()); importsOf.get(a).add(l.b.slice(2)); }
  const PROJECT_IMPORT = /\bfrom\s+['"](?:\.{1,2}\/|@\/|~\/|#)|\bimport\s*\(\s*['"](?:\.{1,2}\/|@\/|~\/|#)|\brequire\(\s*['"](?:\.{1,2}\/|@\/|~\/|#)/g;
  /** A Next.js route file whose code, and everything it imports, shows no data store, session or server secret. */
  const readsNothingPrivate = (file, dynamic) => {
    const seen = new Set([file]), queue = [file];
    while (queue.length) {
      const p = queue.pop();
      const src = readSource(p);
      if (READS_PRIVATE.test(src) || (dynamic && READS_FILES.test(src))) return false;
      const next = [...(importsOf.get(p) || [])];
      // an import we couldn't follow could hold anything
      if ((src.match(PROJECT_IMPORT) || []).length > next.length) return false;
      for (const n of next) if (!seen.has(n) && !NOT_ITS_DATA.test(n)) { seen.add(n); queue.push(n); }
      if (seen.size > 200) return false;
    }
    return true;
  };
  const marksPublic = (file) => {
    const src = readSource(file);
    if (PUBLIC_RESPONSE.test(src) || NEXT_STATIC.test(src)) return true;
    return [...(importsOf.get(file) || [])].some((p) => { const h = readSource(p); return PUBLIC_RESPONSE.test(h) && !PRIVATE_RESPONSE.test(h); });
  };
  /** A reading endpoint that's open on purpose: its address, the project's own listing, its response, or having nothing private to give. */
  const publicByDesign = (r, fnd, repo) => {
    if (r.m !== 'GET') return false;
    if (PUBLIC_FILE_PATH.test(r.p) || isListed(repo, r.p) || fnd.publicResponse) return true;
    return !!fnd.nextGet && (marksPublic(r.f) || readsNothingPrivate(r.f, /\[/.test(r.p)));
  };
  const perRepo = new Map(); // repo -> { guarded, open: [], guardCounts }
  const appWide = new Map(); // `${file}|${line}` -> an app-wide check and how many endpoints only it protects
  graph.routes.forEach((r, i) => {
    const own = routeFinding.get(`${r.f}|${r.l}|${r.m}|${r.p}`) || routeFinding.get(`${r.f}|${r.l}|${r.m}`);
    const fnd = /\.cs$/.test(r.f) ? csFinding(own, r, cs) : own;
    if (!fnd) return; // framework we don't analyse: say nothing
    const gf = fileByPath.get(r.f);
    if (!gf || kinds(gf.n).some((k) => NOT_USED_KINDS.has(k)) || TEST_FILE.test(r.f)) return;
    const repo = gf.r ?? '';
    if (!perRepo.has(repo)) perRepo.set(repo, { guarded: 0, total: 0, open: [], misplaced: [], guardCounts: new Map(), fileGuards: new Map(), guardedIn: new Map() });
    const pr = perRepo.get(repo);
    pr.total++; // checked, so "What was checked" counts it
    if (fnd.public) return; // [AllowAnonymous] / .AllowAnonymous(): public on purpose
    // a Flask before_request or FastAPI middleware guards that Python app, not a JavaScript server beside it;
    // a Nest APP_GUARD or useGlobalGuards() guards Nest's controllers, not an Express or Next.js server beside it;
    // an ASP.NET Core fallback policy guards its own project (the .csproj folder), and nothing else guards C# endpoints
    const csRoute = /\.cs$/.test(r.f);
    const global = (globalGuards.get(repo) || []).find((g) => ((g.framework === 'flask' || g.framework === 'fastapi') && /\.py$/.test(r.f))
      || (g.framework === 'express' && !csRoute) || (g.framework === 'next' && !csRoute && fnd.fn === r.m)
      || (g.framework === 'aspnet' && csRoute && cs.projectOf(g.file) === cs.projectOf(r.f))
      || (g.framework === 'nest' && fnd.nest && !fnd.nestPublic));
    // an unrecognised decorator that turns out to be an auth wrapper defined elsewhere in the project
    const viaWrapper = !fnd.via && fnd.decos?.find((d) => guardDefs.get(d)?.some((g) => (g.file.split('/')[0] === r.f.split('/')[0])));
    const mounted = !fnd.via && mountGuard.get(`${r.f}|${r.l}|${r.m}`);
    // a parameter typed with a dependency alias that checks the caller: `user: AdminUser`
    const viaAlias = !fnd.via && fnd.types?.find((t) => depGuards.get(repo)?.aliases.has(t));
    // a FastAPI dependency whose name doesn't say it checks, but whose code does (pyDependencyGuards)
    const viaDep = !fnd.via && fnd.depRefs?.find((ref) => depGuards.get(repo)?.checks(ref))?.replace(/^\w+:/, '');
    const viaSignatureHelper = !fnd.via && fnd.calls?.find((name) =>
      (verifiedHelpers.get(repo)?.get(name) || []).some((helper) => helperImported(r.f, helper, name)));
    if (fnd.via || global || viaWrapper || mounted || viaAlias || viaDep || viaSignatureHelper) {
      pr.guarded++; pr.guardedIn.set(r.f, (pr.guardedIn.get(r.f) || 0) + 1);
      // what the result rests on when only an app-wide check clears an endpoint, so the panel can name it (#72)
      if (global && !fnd.via && !viaWrapper && !viaAlias && !viaDep && !viaSignatureHelper && (!mounted || mounted === global.name)) {
        const k = `${global.file}|${global.line}`;
        if (!appWide.has(k)) appWide.set(k, { ...(repo && repo !== '.' ? { repo } : {}), name: global.name || global.file.split('/').pop(), file: global.file, line: global.line, endpoints: 0 });
        appWide.get(k).endpoints++;
      }
      const name = fnd.guard || viaWrapper || mounted || viaAlias || viaDep;
      if (name) {
        pr.guardCounts.set(name, (pr.guardCounts.get(name) || 0) + 1);
        if (!pr.fileGuards.has(r.f)) pr.fileGuards.set(r.f, new Map());
        pr.fileGuards.get(r.f).set(name, (pr.fileGuards.get(r.f).get(name) || 0) + 1);
      }
      return;
    }
    if (r.m === 'OPTIONS' || r.m === 'HEAD' || fnd.notAllowed || fnd.guest || fnd.quiet) return;
    // webhook receivers: by URL, or a webhook-ish handler in a webhook file (not that file's admin endpoints)
    const webhook = (WEBHOOK_PATH.test(r.p) && !WEBHOOK_ADMIN.test(r.p)) || (/webhook|hooks?\//i.test(r.f) && /webhook|hook|notify|event|ingress|pubsub|callback|receive|inbound/i.test(r.h || '') && !/create|list|manage|register|delete|test|setup|sync/i.test((r.h || '') + r.p));
    if (webhook && fnd.signed) return;
    // a Stripe webhook that doesn't check Stripe's signature has its own, more specific issue
    if (stripeFiles.has(r.f) && (webhook || /stripe|payment|hook/i.test(r.p) || graph.routes.filter((x) => x.f === r.f && x.m !== 'GET').length === 1)) return;
    if (!webhook && PUBLIC_PATH.test(r.p.replace(/<[^>]*>|\{[^}]*\}|:\w+|\[[^\]]*\]/g, 'x'))) return;
    if ((r.p === '/' || LEGAL_PAGE.test(r.p)) && r.m === 'GET') return;
    if (!webhook && publicByDesign(r, fnd, repo)) return;
    const entry = { i, r, fnd, write: !['GET', 'ANY'].includes(r.m), webhook };
    if (fnd.misplaced) pr.misplaced.push(entry); else pr.open.push(entry);
  });
  for (const [repo, pr] of perRepo) {
    const repoName = repo === '.' ? '' : repo; // a single repo at the root has no name to show
    const top = (m) => m && [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    // prefer what this file already uses, then the project's most common real (non-wrapper) check
    const guardHint = (file, lang) => {
      // a base controller or hub that carries [Authorize] isn't a check to copy onto an endpoint
      const copyable = (m) => m && new Map([...m].filter(([n]) => !guardDefs.get(n)?.some((g) => g.base)));
      const local = top(copyable(pr.fileGuards.get(file)));
      const name = local || top(new Map([...copyable(pr.guardCounts)].filter(([n]) => !guardDefs.get(n)?.every((g) => g.wrapper))));
      if (!name) return `the project's existing login check (find how other protected endpoints verify the user; if there is none, ask me before adding one)`;
      const defs = guardDefs.get(name) || [];
      const where = defs.find((g) => g.file === file) ? 'defined in this file' : defs.length ? `defined in ${defs[0].file}` : '';
      const how = guardLabel(name, defs, lang);
      return `the same check ${local ? 'the other endpoints in this file' : 'the protected endpoints'} already use (${how}${where ? ', ' + where : ''})`;
    };
    const routeLine = (e) => `- ${e.r.m} ${e.r.p} — ${e.r.f}:${e.r.l}${e.fnd.fn && !/^[A-Z]+$/.test(e.fnd.fn) ? ` (${e.fnd.fn})` : ''}${e.fnd.defFile ? `, route registered in ${e.fnd.defFile}:${e.fnd.defLine}` : ''}`;
    if (pr.misplaced.length) {
      const list = pr.misplaced;
      issues.push({
        id: 'misplaced-guard:' + repo, kind: 'unprotected-endpoint', severity: 'high',
        title: 'A login check is in the wrong place, so it does nothing',
        detail: `On ${plural(list.length, 'endpoint')} the login check (@${list[0].fnd.misplaced}) is written above the route line instead of below it. Flask only sees what's below, so ${list.length === 1 ? 'it is' : 'they are'} open to anyone even though ${list.length === 1 ? 'it looks' : 'they look'} protected.`,
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, `@${e.fnd.misplaced} sits above the route line, so it is skipped`])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [`Security fix: these endpoints have their auth decorator above the route decorator, so the framework registers the unprotected function:`, ...list.map(routeLine), ``, `Move each auth decorator directly below the @…route(...) line (route decorator first, then the auth decorator, then def). Change nothing else, then run the tests that cover these endpoints.`].join('\n'),
      });
    }
    if (!pr.open.length) continue;
    // Nothing in this repo checks the caller: probably protected elsewhere (gateway, private network) or not at all.
    if (pr.guarded === 0) {
      const list = pr.open.sort((a, b) => b.write - a.write);
      issues.push({
        id: 'no-auth:' + repo, kind: 'unprotected-endpoint', severity: 'medium',
        title: `None of ${repoName ? `${repoName}’s` : 'your'} endpoints check who is calling`,
        detail: `${plural(list.length, 'endpoint')} answer anyone who knows the address, with no login check in the code. That's fine only if this server is private (for example behind a company network or a gateway that checks logins); otherwise anyone could read or change its data.`,
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, e.write ? 'Changes data, no login check' : 'No login check'])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [`Review access control${repoName ? ` in ${repoName}` : ''}. None of these endpoints verify the caller in code:`, ...list.slice(0, 40).map(routeLine), list.length > 40 ? `- …and ${list.length - 40} more` : null, ``, `First tell me in plain words whether this server is reachable from the internet and whether anything in front of it (gateway, network rules) checks logins. If it is public, propose the smallest safe way to require login for the data-changing endpoints (POST/PUT/PATCH/DELETE) first, show me the plan, and wait for my OK before changing code.`].filter((x) => x !== null).join('\n'),
      });
      continue;
    }
    // One issue per route file
    const byFile = new Map();
    for (const e of pr.open) { if (!byFile.has(e.r.f)) byFile.set(e.r.f, []); byFile.get(e.r.f).push(e); }
    for (const [file, list] of byFile) {
      list.sort((a, b) => b.write - a.write || a.r.l - b.r.l);
      const writes = list.filter((e) => e.write && !e.webhook), hooks = list.filter((e) => e.webhook), reads = list.filter((e) => !e.write && !e.webhook);
      // many providers can't sign webhooks at all, so an unsigned one alone stays low
      const sev = writes.length ? 'high' : reads.length > 2 ? 'medium' : 'low';
      const lang = scanByPath.get(file)?.lang;
      const fileGuarded = pr.guardedIn.get(file) || 0;
      const sv = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const parts = [];
      if (writes.length) parts.push(sv(writes.length, 'endpoint that changes data (create, update or delete)', 'endpoints that change data (create, update or delete)'));
      if (reads.length) parts.push(sv(reads.length, 'endpoint that returns data', 'endpoints that return data'));
      const nOpen = writes.length + reads.length;
      const hookText = hooks.length ? `${sv(hooks.length, 'webhook (an automatic message from another service) is', 'webhooks (automatic messages from another service) are')} accepted without checking that ${hooks.length === 1 ? 'it really comes' : 'they really come'} from that service, so anyone could send fake ones. Some providers can't sign their messages; if so, that's expected.` : '';
      issues.push({
        id: 'open-endpoints:' + file, kind: 'unprotected-endpoint', severity: sev,
        title: writes.length ? `Anyone could change data through ${nameOf(file)}` : hooks.length ? `Anyone could send fake events to ${nameOf(file)}` : `Anyone could read data from ${nameOf(file)}`,
        detail: [
          parts.length ? `${file.split('/').pop()} has ${parts.join(' and ')} with no login check, so anyone who finds the address can use ${nOpen === 1 ? 'it' : 'them'}${fileGuarded > 0 ? ` (${sv(fileGuarded, 'other endpoint', 'other endpoints')} in the same file ${fileGuarded === 1 ? 'is' : 'are'} protected)` : ''}. If ${nOpen === 1 ? 'it is' : 'some are'} meant to be public, that's fine; otherwise ${nOpen === 1 ? 'it needs' : 'they need'} a login check.` : '',
          parts.length && hooks.length ? `It also accepts ${sv(hooks.length, 'webhook', 'webhooks')} without checking who sent ${hooks.length === 1 ? 'it' : 'them'}.` : hookText,
        ].filter(Boolean).join(' '),
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, e.webhook ? 'Webhook with no visible signature check' : e.write ? 'Changes data, no login check' : 'Returns data, no login check'])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [
          `Security fix in ${file}: these endpoints don't check who is calling:`,
          ...list.map((e) => routeLine(e) + (e.webhook ? ' [webhook]' : '')),
          ``,
          `For each endpoint that isn't meant to be public, add ${guardHint(file, lang)}.`,
          hooks.length ? `For webhooks, verify the provider's signature (using its signing secret from an environment variable) before doing anything, and reject requests that fail.` : null,
          `If an endpoint is intentionally public (for example a public page or a health check), leave it and tell me why. Don't change anything else; afterwards list exactly which endpoints you protected and run the related tests.`,
        ].filter((x) => x !== null).join('\n'),
      });
    }
  }

  // ---------- unused files ----------
  const incoming = new Set();
  for (const l of graph.links) if (l.a !== l.b && l.b.startsWith('f:')) incoming.add(l.b.slice(2));
  const entry = new Set(graph.project?.entrypoints || []);
  const routeFiles = new Set(graph.routes.map((r) => r.f));
  for (const fl of graph.flows || []) for (const s of fl.steps || []) if (s.ref?.startsWith('f:')) entry.add(s.ref.slice(2));
  // Expo Router makes every file in an app's app/ (or src/app/) folder a screen, found by its path, so nothing
  // imports them. (Next.js's app/ folder only counts its page, layout, route… files: see below.)
  const expoRouterDirs = [];
  for (const f of scan.files) {
    if (!/(^|\/)package\.json$/.test(f.path)) continue;
    let pj = null;
    try { pj = JSON.parse(readSource(f.path).replace(/^\uFEFF/, '')); } catch { continue; }
    const deps = { ...pj?.dependencies, ...pj?.devDependencies, ...pj?.peerDependencies };
    if (!deps['expo-router'] && !/^expo-router\//.test(String(pj?.main || ''))) continue;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    expoRouterDirs.push(dir + 'app/', dir + 'src/app/');
  }
  const expoScreen = (p) => expoRouterDirs.some((d) => p.startsWith(d));
  const candidates = graph.files.filter((f) => {
    if (incoming.has(f.p) || entry.has(f.p) || routeFiles.has(f.p) || !USED_LANGS.has(f.l)) return false;
    if (expoScreen(f.p)) return false;
    // Shopify loads a theme's layouts, templates, sections and blocks by name
    if (f.l === 'liquid' && !/(^|\/)snippets\//.test(f.p)) return false;
    if (TEST_FILE.test(f.p) || SPECIAL_FILE.test(f.p) || /(^|\/)app\/.*\/(page|layout|route|loading|error|template|default)\.[jt]sx?$/.test(f.p)) return false;
    if (/(^|\/)src\/routes\//.test(f.p) && /\+|\$|\[/.test(f.p.split('/').pop())) return false;
    if (kinds(f.n).some((k) => NOT_USED_KINDS.has(k))) return false;
    if (findings(f.p).some((x) => x.k === 'runnable' || x.k === 'route')) return false;
    return true;
  });
  // Safety net for dynamic loading: skip a file whose name appears in any other source file.
  if (candidates.length) {
    const want = new Map(candidates.map((f) => [stemOf(f.p), f.p]));
    const dotted = [...want.keys()].some((k) => k.includes('.'));
    const mentioned = new Set();
    for (const f of scan.files) {
      if (!['code', 'config', 'docs'].includes(f.category) || f.tooLarge) continue;
      let src;
      try { src = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
      for (const tok of new Set(src.match(/[\w$-]+/g) || [])) { const p = want.get(tok); if (p && p !== f.path) mentioned.add(p); }
      // a dotted name (users.service, from './users/users.service.js'), which the words above split at the dot
      if (dotted) for (const tok of new Set(src.match(/[\w$-]+(?:\.[\w$-]+)+/g) || [])) {
        const parts = tok.split('.', 6); // a name has a few dots at most; a long chain of them is code
        for (let k = 2, name = parts[0]; k <= parts.length; k++) { name += '.' + parts[k - 1]; const p = want.get(name); if (p && p !== f.path) mentioned.add(p); }
      }
    }
    const unused = candidates.filter((f) => !mentioned.has(f.p) && !LOADED_BY_NAME.test(readSource(f.p).split('\n', 20).map((l) => l.slice(0, 300)).join('\n')));
    // A module where most files look unused is more likely loaded in a way we can't see; stay quiet.
    const byNode = new Map();
    for (const f of unused) { if (!byNode.has(f.n)) byNode.set(f.n, []); byNode.get(f.n).push(f); }
    const groups = [...byNode.entries()].filter(([n, list]) => { const total = graph.files.filter((f) => f.n === n).length; return n === 'unassigned' || list.length <= 3 || list.length / total <= 0.6; }).sort((a, b) => b[1].length - a[1].length);
    const MAX = 5;
    const merged = groups.length > MAX ? [...groups.slice(0, MAX - 1), ['', groups.slice(MAX - 1).flatMap(([, l]) => l)]] : groups;
    for (const [nid, list] of merged) {
      list.sort((a, b) => b.loc - a.loc);
      const where = nid ? label(nid) : 'other areas';
      const lines = list.reduce((s, f) => s + f.loc, 0);
      issues.push({
        id: 'unused:' + (nid || 'other'), kind: 'unused-file', severity: 'low',
        title: list.length === 1 ? `A file in ${where} looks unused` : `${list.length} files in ${where} look unused`,
        detail: `Nothing in the app imports or calls ${list.length === 1 ? 'this file' : 'these files'} (${lines.toLocaleString('en-US')} lines). Leftover code confuses AI assistants, which may edit or copy the wrong version. Double-check before deleting: some files are loaded in ways the map can't see.`,
        items: list.slice(0, 24).map((f) => 'f:' + f.p),
        notes: Object.fromEntries(list.slice(0, 24).map((f) => ['f:' + f.p, `Nothing uses this file (${f.loc.toLocaleString('en-US')} lines)`])),
        locations: list.map((f) => ({ file: f.p, line: 1 })),
        fix: [`Cleanup check: these files look unused (nothing imports or calls them):`, ...list.slice(0, 40).map((f) => `- ${f.p}`), list.length > 40 ? `- …and ${list.length - 40} more` : null, ``, `For each file, search the codebase (including configs, scripts, HTML templates and dynamic imports) to confirm nothing uses it. Then tell me which ones are safe to delete and which are actually used, with one line of evidence each. Don't delete anything until I confirm.`].filter((x) => x !== null).join('\n'),
      });
    }
  }

  // ---------- very large files ----------
  const big = graph.files.filter((f) => f.loc > 1000 && USED_LANGS.has(f.l) && !TEST_FILE.test(f.p) && !/(^|\/)(migrations|alembic|versions|fixtures?|seeds?|generated|__generated__)\//i.test(f.p) && !/\.d\.ts$/.test(f.p)).sort((a, b) => b.loc - a.loc);
  if (big.length) {
    const huge = big.filter((f) => f.loc >= 2000);
    issues.push({
      id: 'large-files', kind: 'large-file', severity: huge.length ? 'medium' : 'low',
      title: big.length === 1 ? 'One file is very large' : `${big.length} files are very large`,
      detail: `${big.length === 1 ? 'This file has' : 'These files each have'} over 1,000 lines${huge.length ? ` (the biggest has ${big[0].loc.toLocaleString('en-US')})` : ''}. AI assistants read and edit big files less reliably: they lose track of what's where and can break one part while fixing another. Splitting them into smaller files by job makes future changes safer.`,
      items: big.slice(0, 24).map((f) => 'f:' + f.p),
      notes: Object.fromEntries(big.slice(0, 24).map((f) => ['f:' + f.p, `${f.loc.toLocaleString('en-US')} lines${f.tooLarge ? ': too big for Floorplan to read, so what it connects to and any secrets in it weren’t checked' : ''}`])),
      locations: big.map((f) => ({ file: f.p, line: 1 })),
      fix: [`Refactor plan: these files are very large:`, ...big.slice(0, 15).map((f) => `- ${f.p} (${f.loc.toLocaleString('en-US')} lines)`), ``, `Start with ${big[0].p}. Read it and propose how to split it into smaller files, each with one clear job (for example by feature or by type of work), keeping every public function name and behaviour the same. Show me the plan first. After I approve, move code in small steps, update the imports, and run the tests after each step. Don't change behaviour.`].join('\n'),
    });
  }

  // ---------- frontend hard-coded to localhost ----------
  const local = [];
  for (const f of graph.files) if (isFrontend(f.p)) for (const x of findings(f.p)) if (x.k === 'localhost') local.push({ file: f.p, line: x.line });
  if (local.length) {
    const filesL = [...new Set(local.map((x) => x.file))];
    issues.push({
      id: 'localhost-url', kind: 'hardcoded-url', severity: 'low',
      title: 'The app points at your own computer’s address',
      detail: `${filesL.length === 1 ? 'A frontend file' : `${filesL.length} frontend files`} call${filesL.length === 1 ? 's' : ''} a fixed “localhost” address. That only works on your machine; once the app is online those calls will fail for everyone else.`,
      items: filesL.slice(0, 24).map((p) => 'f:' + p),
      notes: Object.fromEntries(filesL.slice(0, 24).map((p) => ['f:' + p, `localhost address on line ${local.filter((x) => x.file === p).map((x) => x.line).join(', ')}`])),
      locations: local,
      fix: [`These frontend lines use a hard-coded localhost URL:`, ...local.map((x) => `- ${x.file}:${x.line}`), ``, `Replace each with the project's existing API base URL setting (or add one read from a public environment variable such as NEXT_PUBLIC_API_URL / VITE_API_URL, with the localhost value only in .env.development). Don't change anything else.`].join('\n'),
    });
  }

  const KIND_ORDER = ['secret', 'public-env-secret', 'database-rules', 'stripe-webhook', 'env-file', 'unprotected-endpoint', 'cors', 'large-file', 'hardcoded-url', 'unused-file'];
  issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.locations?.length || 0) - (a.locations?.length || 0));
  const kept = issues.slice(0, 40);
  const summary = { high: 0, medium: 0, low: 0 };
  for (const i of kept) summary[i.severity]++;
  // appWide: [{ repo?, name, file, line, endpoints }], the app-wide checks some endpoints count as protected by alone
  return { summary, issues: kept, ...(appWide.size ? { appWide: [...appWide.values()] } : {}), checked: whatWasChecked({ graph, scan, perRepo, live, usesSupabase, supabaseTables, firebaseFiles, findings }) };
}

// ---------- what was checked ----------
// A clean Health panel means something only if each check had something to look at, so every check says what it
// read, or that it found nothing to read. `loud` marks the gaps that matter: the code looks like it runs a server
// (or uses Supabase) but the scan found nothing for the check to look at.
function whatWasChecked({ graph, scan, perRepo, live, usesSupabase, supabaseTables, firebaseFiles, findings }) {
  const out = [];
  const add = (check, label, checked, text, loud) => out.push({ check, label, checked, text, ...(loud ? { loud: true } : {}) });

  const found = graph.routes.filter((r) => !TEST_FILE.test(r.f)).length;
  const checkedRoutes = [...perRepo.values()].reduce((s, pr) => s + pr.total, 0);
  const servers = [];
  for (const f of scan.files) {
    if (!live(f.path) || f.category !== 'code') continue;
    const sv = findings(f.path).find((x) => x.k === 'server-code');
    if (sv) servers.push({ file: f.path, what: `it ${sv.how || 'calls'} ${sv.what}` });
    else if (/(^|\/)supabase\/functions\/[^/]+\/index\.[jt]s$/.test(f.path)) servers.push({ file: f.path, what: 'it’s a Supabase Edge Function' });
  }
  if (checkedRoutes) add('endpoints', 'Endpoint sign-in', true, found > checkedRoutes
    ? `checked ${checkedRoutes} of the ${found} endpoints found (the others are set up in a way Floorplan can’t check yet, or belong to scripts and tests)`
    : `checked ${plural(checkedRoutes, 'endpoint')}`);
  else if (found) add('endpoints', 'Endpoint sign-in', false, `not checked: ${plural(found, 'endpoint')} found, but set up in a way Floorplan can’t check for a login yet`);
  else if (servers.length) add('endpoints', 'Endpoint sign-in', false, `not checked: no endpoints found, but ${servers[0].file} looks like it runs a server (${servers[0].what})${servers.length > 1 ? `, and so ${servers.length === 2 ? 'does 1 other file' : `do ${servers.length - 1} other files`}` : ''}. Its endpoints may be set up in a way Floorplan doesn’t recognise yet, so nothing checked whether they need a login.`, true);
  else add('endpoints', 'Endpoint sign-in', false, 'not checked: no endpoints found. If your app has a server, it may use a setup Floorplan doesn’t recognise yet.');

  if (usesSupabase && supabaseTables) add('supabase', 'Supabase table rules', true, `checked ${plural(supabaseTables, 'table')} in the migrations`);
  else if (usesSupabase) add('supabase', 'Supabase table rules', false, 'not checked: the app uses Supabase, but no migrations that create tables were found. Tables made in the Supabase dashboard can’t be checked from the code.', true);
  else add('supabase', 'Supabase table rules', false, 'no Supabase found');

  const firebaseJson = scan.files.some((f) => /(^|\/)firebase\.json$/.test(f.path));
  if (firebaseFiles.length) add('firebase', 'Firebase rules', true, `checked ${plural(firebaseFiles.length, 'rules file')}`);
  else add('firebase', 'Firebase rules', false, firebaseJson ? 'not checked: the project uses Firebase, but no rules files were found. Rules set in the Firebase console can’t be checked from the code.' : 'no rules files found');

  const stripe = scan.files.filter((f) => live(f.path) && findings(f.path).some((x) => x.k === 'stripe-unsigned' || x.k === 'stripe-signed')).length;
  // Stripe.net is `using Stripe;`, listed as the NuGet package Stripe
  const usesStripe = (scan.externals || []).some((e) => e.name === 'stripe' || /^@stripe\//.test(e.name || '') || (e.eco === 'nuget' && e.name === 'Stripe'));
  if (stripe) add('stripe', 'Stripe webhooks', true, `checked ${plural(stripe, 'file')} that receive${stripe === 1 ? 's' : ''} Stripe events`);
  else add('stripe', 'Stripe webhooks', false, usesStripe ? 'the app uses Stripe, but no code that receives its events was found' : 'no Stripe code found');

  const readable = scan.files.filter((f) => ['code', 'config', 'docs'].includes(f.category));
  const big = readable.filter((f) => f.tooLarge).length;
  add('secrets', 'Secrets in code', readable.length > big, `read ${plural(readable.length - big, 'file')}${big ? `; ${plural(big, 'file')} too big to read ${big === 1 ? 'wasn’t' : 'weren’t'} checked` : ''}`);
  return out;
}

// ---------- "not a problem": issues people dismissed from the Health panel ----------
// serve.mjs saves them to floorplan/health-dismissed.json as { dismissed: [{ id, locations: ['file:line'], reason, at }] }.
// A dismissal covers the issue as it was: it shows again if it gets more or less serious, or finds something new
// in a file. It counts per file, not per line, so an edit higher up the file doesn't bring it back.
// (assets/ui/20-health.js has the same rule for the page.)
export function dismissalFor(issue, list) {
  const d = (list || []).find((x) => x && x.id === issue.id);
  if (!d || (d.severity && d.severity !== issue.severity)) return null;
  const left = new Map();
  for (const loc of d.locations || []) { const f = String(loc).replace(/:[^:]*$/, ''); left.set(f, (left.get(f) || 0) + 1); }
  for (const l of issue.locations || []) { const n = left.get(l.file) || 0; if (!n) return null; left.set(l.file, n - 1); }
  return d;
}
/** Folds a dismissal list into a built health result: keeps the list, recounts the summary without them. */
export function withDismissed(health, list) {
  const dismissed = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.id === 'string');
  const summary = { high: 0, medium: 0, low: 0 };
  for (const i of health.issues) if (!dismissalFor(i, dismissed)) summary[i.severity]++;
  return { ...health, summary, ...(dismissed.length ? { dismissed } : {}) };
}

/** Test mode, in Firestore/Storage rules (request.time < timestamp.date(Y, M, D)) or Realtime Database rules (now < ms). */
const testModeEnd = (cond) => {
  const d = /^request\.time\s*<\s*timestamp\.date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)$/.exec(cond);
  if (d) return new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
  const ms = /^now\s*<\s*(\d{12,14})$/.exec(cond);
  return ms ? new Date(+ms[1]) : null;
};

/** Firestore / Storage rules that let anyone in: `allow …: if true`, `allow …;` (no condition) and test mode. */
function firebaseRules(src, now) {
  const s = src.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  const at = lineIndex(s);
  const matches = [...s.matchAll(/\bmatch\s+(\/\S*)\s*\{/g)].map((m) => ({ i: m.index, path: m[1] }));
  const out = [];
  for (const m of s.matchAll(/\ballow\s+([a-z][a-z,\s]{0,200}?)\s*(?::\s*if\s+([^;]{1,4000}?))?\s*;/g)) {
    const ops = m[1].split(/[\s,]+/).filter(Boolean);
    const cond = (m[2] || 'true').trim().replace(/\s+/g, ' ');
    const end = cond === 'true' ? null : testModeEnd(cond);
    if (cond !== 'true' && !end) continue;
    const where = matches.filter((x) => x.i < m.index).pop()?.path || '/';
    const writeOps = ops.filter((o) => /^(write|create|update|delete)$/.test(o));
    out.push({
      line: at(m.index), text: `allow ${ops.join(', ')}${m[2] ? `: if ${cond}` : ' (no condition)'} at ${where}`,
      read: ops.some((o) => /^(read|get|list)$/.test(o)), write: writeOps.length > 0, createOnly: writeOps.length > 0 && writeOps.every((o) => o === 'create'),
      open: !end ? 'always' : end > now ? 'until' : 'expired', until: end, where,
      wide: /=\*\*\}/.test(where) || /\/documents$/.test(where) || where === '/',
    });
  }
  return out;
}

/** Realtime Database rules (database.rules.json) with ".read" / ".write" set to true or test mode. */
function firebaseRtdbRules(src, now) {
  const s = src.replace(/(^|[^:"])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
  const at = lineIndex(s);
  const out = [];
  for (const m of s.matchAll(/"\.(read|write)"\s*:\s*(true\b|"([^"]*)")/g)) {
    const cond = m[2] === 'true' ? 'true' : (m[3] || '').trim();
    const end = cond === 'true' ? null : testModeEnd(cond);
    if (cond !== 'true' && !end) continue;
    if (out.length >= 100) break; // each one rereads the file up to it; real rules files have a handful
    // how deep it sits: { "rules": { ".read": … } } is the whole database
    let depth = 0;
    for (let i = 0; i < m.index; i++) { if (s[i] === '{') depth++; else if (s[i] === '}') depth--; }
    const keys = [...s.slice(0, m.index).matchAll(/"([^".][^"]*)"\s*:\s*\{/g)].map((k) => k[1]);
    const where = depth <= 2 ? 'the whole database' : '/' + keys.slice(-(depth - 2)).join('/');
    out.push({
      line: at(m.index), text: `"${m[1] === 'read' ? '.read' : '.write'}": ${m[2]} for ${where}`,
      read: m[1] === 'read', write: m[1] === 'write', createOnly: false,
      open: !end ? 'always' : end > now ? 'until' : 'expired', until: end, where, wide: depth <= 2, root: depth <= 2,
    });
  }
  return out;
}

function readHead(file, max) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(max); const n = fs.readSync(fd, buf, 0, max, 0); return buf.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
function stemOf(p) {
  const base = p.split('/').pop().replace(/\.[^.]+$/, '');
  return base === 'index' ? p.split('/').slice(-2, -1)[0] : base;
}
