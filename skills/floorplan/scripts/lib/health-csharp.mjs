// Health's checks for C# / ASP.NET Core: who may call each endpoint, CORS and Stripe.net webhooks.
// Per-file findings have the same shapes as the Python and JS ones (route, guard-def, global-guard),
// so buildHealth treats them alike; csBuildContext and csFinding add what only the whole scan knows.
// As in extract.mjs, nothing scans from every match to the end of the file: code built to make pattern
// matching slow must not stall Health.
import { csProjects } from './resolve.mjs';
import { csLastName } from './extract.mjs';

// A handler that checks the caller itself, or rejects one with 401/403
// (also a call like TenantAccessGate.CheckAsync(…), VerifyApiKey(…), EnsureCallerAllowed(…))
const CS_INLINE_CHECK = /\b\w{0,40}(?:Auth|Access|Permission|Tenant|Session|Token|Login|ApiKey|Signature)\w{0,40}\.(?:Check|Verify|Require|Ensure|Validate|Authorize|Authenticate)\w{0,40}\s*\(|\b(?:Check|Verify|Require|Ensure|Validate|Authorize|Authenticate)\w{0,40}(?:Auth|Access|Permission|Token|Session|User|Caller|Signature|ApiKey|Tenant)\w{0,40}\s*\(|\bUser\.Identity\??\.IsAuthenticated\b|\b(?:Unauthorized|Forbid|Challenge)\s*\(|StatusCodes\.Status40[13]|\bAuthorizeAsync\s*\(|\[FromHeader\(\s*Name\s*=\s*"(?:Authorization|X-Api-Key|X-[\w-]{0,60}(?:Token|Key|Signature)[\w-]{0,60})"/i;
// App-wide checks: a fallback policy, an AuthorizeFilter on every controller, or MapControllers().RequireAuthorization()
const CS_GLOBAL_GUARDS = [
  [/\bFallbackPolicy\s*=\s*(?!null\b)[^;]{0,500}?\bRequire/, 'a fallback authorization policy'],
  [/\bSetFallbackPolicy\s*\(\s*(?!null\b)[^;]{0,500}?\bRequire/, 'a fallback authorization policy'],
  [/\bFilters\.Add\s*(?:<\s*AuthorizeFilter\s*>|\(\s*new\s+AuthorizeFilter\b)/, 'an AuthorizeFilter on every controller'],
  [/\bMapControllers\s*\(\s*\)\s*\.\s*RequireAuthorization\s*\(/, 'MapControllers().RequireAuthorization()'],
];
// Custom attributes that check the caller: class FeatureAttribute : AuthorizeAttribute
const CS_AUTH_BASE = /^(AuthorizeAttribute|IAuthorizationFilter|IAsyncAuthorizationFilter|IAuthorizeData)$/;
// Framework base classes: following them further says nothing about the project's own checks
const CS_FRAMEWORK_BASE = /^(ControllerBase|Controller|Hub|PageModel|ComponentBase|object|Object|I[A-Z]\w*)$/;
// A method declaration on one line: modifiers, then a return type and the name before its (
const CS_METHOD = /^[ \t]*((?:(?:public|private|internal|protected|static|async|override|virtual|sealed|new)[ \t]+)+)([^\n(;={}]{1,300})\(/gm;

/** 1-based line of an offset, by binary search over the line starts. */
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/**
 * The source with comments blanked (`code`), and with strings blanked too (`flat`), both the same length
 * as the source and in one pass. Strings end at the line's end, as a regular one must.
 */
function csBlank(src) {
  const code = [];
  const flat = [];
  const n = src.length;
  const put = (inCode, inFlat) => { code.push(inCode); flat.push(inFlat); };
  for (let i = 0; i < n;) {
    const c = src[i];
    if (c === '"' || (c === '\'' && src[i + 2] === '\'') || (c === '\'' && src[i + 1] === '\\')) {
      const verbatim = c === '"' && (src[i - 1] === '@' || (src[i - 1] === '$' && src[i - 2] === '@'));
      let j = i + 1;
      while (j < n && src[j] !== '\n') {
        if (!verbatim && src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { if (verbatim && src[j + 1] === '"') { j += 2; continue; } break; }
        j++;
      }
      const s = src.slice(i, Math.min(j + 1, n));
      put(s, s.replace(/[^\n]/g, ' '));
      i += s.length;
      continue;
    }
    let end = -1;
    if (c === '/' && src[i + 1] === '*') { end = src.indexOf('*/', i + 2); end = end < 0 ? n : end + 2; }
    else if (c === '/' && src[i + 1] === '/') { end = src.indexOf('\n', i); if (end < 0) end = n; }
    if (end >= 0) { const b = src.slice(i, end).replace(/[^\n]/g, ' '); put(b, b); i = end; continue; }
    // plain text up to the next character that could start a string or a comment
    let j = i + 1;
    while (j < n && src[j] !== '"' && src[j] !== '\'' && src[j] !== '/') j++;
    const s = src.slice(i, j);
    put(s, s);
    i = j;
  }
  return { code: code.join(''), flat: flat.join('') };
}

/** Where each ( and { closes in `flat`, found once per file (-1: never). */
function closers(flat) {
  const close = new Int32Array(flat.length).fill(-1);
  const parens = [], braces = [];
  for (let i = 0; i < flat.length; i++) {
    const c = flat.charCodeAt(i);
    if (c === 40) parens.push(i);
    else if (c === 41 && parens.length) close[parens.pop()] = i;
    else if (c === 123) braces.push(i);
    else if (c === 125 && braces.length) close[braces.pop()] = i;
  }
  return close;
}

/**
 * Methods whose parameters or body check the caller, as `Class.Method` and as `Method`, so a
 * minimal-API endpoint mapped to `AccountEndpoints.AccountAsync` counts as checked even though the
 * handler lives in another file. Bodies are read up to a few times the file's length in all, so
 * methods nested in an unclosed one don't each read to the end of the file.
 */
function callerCheckingMethods({ code, flat }, types, at) {
  const close = closers(flat);
  const byLine = [...types].sort((a, b) => a.line - b.line);
  let budget = 3 * code.length + 100000;
  let semi = -2; // the next ; after an `=>` body, searched for again only once passed (-1: none)
  let t = 0;
  const out = [];
  for (const m of code.matchAll(CS_METHOD)) {
    // a return type and then the name (a constructor has no return type, and isn't an endpoint's handler)
    const head = csLastName(m[2]);
    if (!head || !head.before.trim()) continue;
    const open = m.index + m[0].length - 1;
    const closeAt = close[open];
    if (closeAt < 0) continue;
    const after = /\s*(?:where\b[^{=;]{0,300})?(\{|=>)/y;
    after.lastIndex = closeAt + 1;
    const b = after.exec(flat);
    if (!b) continue;
    let end;
    if (b[1] === '=>') {
      if (semi === -2 || (semi >= 0 && semi < after.lastIndex)) semi = flat.indexOf(';', after.lastIndex);
      end = semi < 0 ? flat.length : semi;
    } else end = close[after.lastIndex - 1] < 0 ? flat.length : close[after.lastIndex - 1];
    budget -= end - open;
    if (budget < 0) break;
    if (!CS_INLINE_CHECK.test(code.slice(open, end))) continue;
    const line = at(m.index);
    while (t < byLine.length && byLine[t].line <= line) t++;
    out.push({ method: head.name, owner: byLine[t - 1]?.name, line });
  }
  return out;
}

/** Findings for the app-wide checks a Program.cs or startup file sets up. */
function globalGuards(code, at, out) {
  for (const [re, name] of CS_GLOBAL_GUARDS) {
    const m = re.exec(code);
    if (m) out.push({ k: 'global-guard', framework: 'aspnet', name, line: at(m.index) });
  }
}

/** Custom auth attributes, base classes that carry [Authorize], and base-class chains the build follows. */
function typeFindings(types, out) {
  for (const t of types) {
    // an attribute that checks the caller, used as [Feature(...)]
    if (/Attribute$/.test(t.name) && t.bases.some((b) => CS_AUTH_BASE.test(b))) out.push({ k: 'guard-def', name: t.name.replace(/Attribute$/, ''), line: t.line });
    // a base controller or hub with [Authorize] protects every class built on it
    else if (/\bAuthorize\b/.test(t.attrs) && !/\bAllowAnonymous\b/.test(t.attrs)) out.push({ k: 'guard-def', name: t.name, line: t.line, wrapper: true, base: true });
    // Sub : Mid : SecureBase, so an endpoint on Sub can be followed up to SecureBase's [Authorize]
    const own = t.bases.filter((b) => !CS_FRAMEWORK_BASE.test(b));
    if (own.length && (t.abstract || /(Controller|ControllerBase|Hub|Base)$/.test(t.name))) out.push({ k: 'cs-base', name: t.name, bases: own, line: t.line });
  }
}

/** Who may call each endpoint in this file, as `route` findings for buildHealth. */
export function csRoutes(src, f, out, signatureCheck) {
  const lines = src.split('\n');
  const blanked = csBlank(src);
  const at = lineIndex(src);
  const types = f.csTypes || [];
  globalGuards(blanked.code, at, out);
  typeFindings(types, out);
  const checks = callerCheckingMethods(blanked, types, at);
  for (const c of checks) if (c.owner) out.push({ k: 'caller-check', name: `${c.owner}.${c.method}`, line: c.line });
  const checkingNames = new Set(checks.map((c) => c.method));
  const conventional = (f.conventionalActions || []).flatMap((a) => a.methods.map((method) => ({ ...a, method })));
  const routes = [...(f.routes || []).filter((r) => r.framework === 'aspnet'), ...conventional].sort((a, b) => a.line - b.line);
  // what each stretch of lines says, worked out once: many routes can share one line
  const read = new Map();
  const bodyFacts = (from, to) => {
    const key = `${from}|${to}`;
    if (!read.has(key)) {
      const body = lines.slice(from - 1, to - 1).join('\n');
      read.set(key, { checks: CS_INLINE_CHECK.test(body), signed: signatureCheck.test(body) || /\bConstructEvent\s*\(/.test(body) });
    }
    return read.get(key);
  };
  let after = 0; // the first route on a later line than the current one
  routes.forEach((r, idx) => {
    const rec = { k: 'route', line: r.line, method: r.method, fn: r.handler, decos: r.auth?.decos || [], ...(r.handlerRef ? { handlerRef: r.handlerRef } : {}) };
    if (r.auth?.anonymous) rec.public = true;
    else if (r.auth?.guard) Object.assign(rec, { guard: r.auth.guard, via: 'attribute' });
    if (after <= idx) after = idx + 1;
    while (after < routes.length && routes[after].line <= r.line) after++;
    // a method-group handler's code is elsewhere, so only the Map… line itself is this endpoint's
    const next = r.handlerRef ? r.line + 1 : routes[after]?.line || r.line + 80;
    const facts = bodyFacts(r.line, Math.max(r.line + 1, Math.min(next, r.line + 81)));
    // a handler named without its class (MapGet("/me", GetMe)) is a method in this file
    const local = r.handlerRef && !r.handlerRef.includes('.') && checkingNames.has(r.handlerRef);
    if (!rec.via && !rec.public && (facts.checks || local)) rec.via = 'inline';
    if (facts.signed) rec.signed = true;
    out.push(rec);
  });
}

// ---------- CORS and Stripe.net ----------

/** CORS that lets every site call the server. `add(index, how, credentials)` records one. */
export function csCors(src, add) {
  // a line that's commented out, or words in a string, set nothing up (both are blanked to spaces, so
  // positions stay the same; `code` keeps the strings, for WithOrigins("*"))
  const { code, flat } = csBlank(src);
  // ASP.NET Core refuses AllowAnyOrigin with AllowCredentials, but not an origin check that always says yes
  const credentials = /\.\s*AllowCredentials\s*\(\s*\)/.test(flat);
  for (const m of flat.matchAll(/\.\s*AllowAnyOrigin\s*\(\s*\)/g)) add(m.index, 'AllowAnyOrigin()', false);
  for (const m of code.matchAll(/\.\s*WithOrigins\s*\(\s*"\*"\s*\)/g)) add(m.index, 'WithOrigins("*")', false);
  for (const m of flat.matchAll(/\.\s*SetIsOriginAllowed\s*\(\s*(?:\w+|\(\s*\w*\s*\))\s*=>\s*true\s*\)/g)) add(m.index, 'SetIsOriginAllowed(_ => true)', credentials);
}

// Stripe.net names events as constants: EventTypes.CheckoutSessionCompleted is "checkout.session.completed"
const STRIPE_EVENT_CONST = /\b(?:EventTypes|Events)\.(CheckoutSessionCompleted|CheckoutSessionAsyncPaymentSucceeded|PaymentIntentSucceeded|InvoicePaid|InvoicePaymentSucceeded|InvoicePaymentFailed|CustomerSubscriptionCreated|CustomerSubscriptionUpdated|CustomerSubscriptionDeleted|ChargeSucceeded|ChargeRefunded)\b/g;
const STRIPE_EVENT_NAME = { CheckoutSessionCompleted: 'checkout.session.completed', CheckoutSessionAsyncPaymentSucceeded: 'checkout.session.async_payment_succeeded', PaymentIntentSucceeded: 'payment_intent.succeeded', InvoicePaid: 'invoice.paid', InvoicePaymentSucceeded: 'invoice.payment_succeeded', InvoicePaymentFailed: 'invoice.payment_failed', CustomerSubscriptionCreated: 'customer.subscription.created', CustomerSubscriptionUpdated: 'customer.subscription.updated', CustomerSubscriptionDeleted: 'customer.subscription.deleted', ChargeSucceeded: 'charge.succeeded', ChargeRefunded: 'charge.refunded' };
// EventUtility.ConstructEvent checks the signature; EventUtility.ParseEvent does not
const STRIPE_VERIFIED_CS = /\bConstructEvent(?:Async)?\s*\(|\bValidateSignature\s*\(/;

export const csStripeVerified = (src) => STRIPE_VERIFIED_CS.test(src);
export const csStripeEvents = (src) => [...src.matchAll(STRIPE_EVENT_CONST)].map((m) => ({ index: m.index, event: STRIPE_EVENT_NAME[m[1]] }));

// ---------- build: what only the whole scan knows ----------

/**
 * Facts across files: each file's project (an app-wide check covers its own .csproj folder only),
 * the access a route gets where it is mounted or inherited, methods that check the caller, and
 * base-class chains.
 */
export function csBuildContext(scan, findings) {
  const access = new Map();
  for (const r of scan.routes || []) if (r.access) access.set(`${r.file}|${r.line}|${r.method}|${r.path}`, r.access);
  const callerChecks = new Set();
  const baseOf = new Map();
  for (const f of scan.files) {
    if (f.lang !== 'csharp') continue;
    for (const x of findings(f.path)) {
      if (x.k === 'caller-check') callerChecks.add(x.name);
      if (x.k === 'cs-base') baseOf.set(x.name, [...(baseOf.get(x.name) || []), ...x.bases]);
    }
  }
  return { projectOf: csProjects(scan.files.map((f) => f.path)), access, callerChecks, baseOf };
}

/** Every base class above the ones listed, a few levels up, so [Authorize] on a grandparent counts. */
function withAncestors(names, baseOf) {
  const out = [...names];
  for (let i = 0; i < out.length && out.length < 40; i++) for (const b of baseOf.get(out[i]) || []) if (!out.includes(b)) out.push(b);
  return out;
}

/** A route finding completed with cross-file facts; a route inherited from a base controller gets one made up. */
export function csFinding(fnd, r, ctx) {
  const access = ctx.access.get(`${r.f}|${r.l}|${r.m}|${r.p}`);
  let x = fnd;
  if (!x && access?.inherited) {
    x = { k: 'route', line: r.l, method: r.m, fn: r.h, decos: access.decos };
    if (access.anonymous) x.public = true;
    else if (access.guard) Object.assign(x, { guard: access.guard, via: 'attribute' });
  }
  if (!x || x.via || x.public) return x;
  // the group a project mapper was called on: app.MapGroup("/api").RequireAuthorization().MapOrders()
  if (access?.mounted) return access.anonymous ? { ...x, public: true } : { ...x, guard: access.guard, via: 'group' };
  if (x.handlerRef && ctx.callerChecks.has(x.handlerRef)) return { ...x, via: 'inline' };
  return x.decos?.length ? { ...x, decos: withAncestors(x.decos, ctx.baseOf) } : x;
}
