// Health's checks for C# / ASP.NET Core: who may call each endpoint, CORS and Stripe.net webhooks.
// Per-file findings have the same shapes as the Python and JS ones (route, guard-def, global-guard),
// so buildHealth treats them alike; csBuildContext and csFinding add what only the whole scan knows.
import { csProjects } from './resolve.mjs';

// A handler that checks the caller itself, or rejects one with 401/403
// (also a call like TenantAccessGate.CheckAsync(…), VerifyApiKey(…), EnsureCallerAllowed(…))
const CS_INLINE_CHECK = /\b\w*(?:Auth|Access|Permission|Tenant|Session|Token|Login|ApiKey|Signature)\w*\.(?:Check|Verify|Require|Ensure|Validate|Authorize|Authenticate)\w*\s*\(|\b(?:Check|Verify|Require|Ensure|Validate|Authorize|Authenticate)\w*(?:Auth|Access|Permission|Token|Session|User|Caller|Signature|ApiKey|Tenant)\w*\s*\(|\bUser\.Identity\??\.IsAuthenticated\b|\b(?:Unauthorized|Forbid|Challenge)\s*\(|StatusCodes\.Status40[13]|\bAuthorizeAsync\s*\(|\[FromHeader\(\s*Name\s*=\s*"(?:Authorization|X-Api-Key|X-[\w-]*(?:Token|Key|Signature)[\w-]*)"/i;
// App-wide checks: a fallback policy, an AuthorizeFilter on every controller, or MapControllers().RequireAuthorization()
const CS_GLOBAL_GUARDS = [
  [/\bFallbackPolicy\s*=\s*(?!null\b)[^;]*\bRequire/, 'a fallback authorization policy'],
  [/\bSetFallbackPolicy\s*\(\s*(?!null\b)[^;]*\bRequire/, 'a fallback authorization policy'],
  [/\bFilters\.Add\s*(?:<\s*AuthorizeFilter\s*>|\(\s*new\s+AuthorizeFilter\b)/, 'an AuthorizeFilter on every controller'],
  [/\bMapControllers\s*\(\s*\)\s*\.\s*RequireAuthorization\s*\(/, 'MapControllers().RequireAuthorization()'],
];
// Custom attributes that check the caller: class FeatureAttribute : AuthorizeAttribute
const CS_AUTH_BASE = /^(AuthorizeAttribute|IAuthorizationFilter|IAsyncAuthorizationFilter|IAuthorizeData)$/;
// Framework base classes: following them further says nothing about the project's own checks
const CS_FRAMEWORK_BASE = /^(ControllerBase|Controller|Hub|PageModel|ComponentBase|object|Object|I[A-Z]\w*)$/;
// A method declaration: modifiers, a return type, the name, then its parameters
const CS_METHOD = /^[ \t]*(?:(?:public|private|internal|protected|static|async|override|virtual|sealed|new)\s+)+[\w<>[\],.?() ]+?\s+(\w+)\s*(?:<[^>]*>)?\s*\(/gm;

const lineAt = (src, i) => src.slice(0, i).split('\n').length;
const blankComments = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
const blankStrings = (src) => src.replace(/@?\$?"(?:[^"\\\n]|\\.|"")*"/g, (m) => m.replace(/[^\n]/g, ' '));

/** The end of a parenthesised list starting at `open` (an index of "("), or -1. */
function closeParen(flat, open) {
  let depth = 0;
  for (let i = open; i < flat.length; i++) {
    if (flat[i] === '(') depth++;
    else if (flat[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** A method's body after its parameter list: a { … } block, or an `=> …;` expression. */
function bodyEnd(flat, from) {
  const head = /\s*(?:where\b[^{=;]*)?(\{|=>)/y;
  head.lastIndex = from;
  const m = head.exec(flat);
  if (!m) return -1;
  if (m[1] === '=>') { const semi = flat.indexOf(';', head.lastIndex); return semi < 0 ? flat.length : semi; }
  let depth = 0;
  for (let i = head.lastIndex - 1; i < flat.length; i++) {
    if (flat[i] === '{') depth++;
    else if (flat[i] === '}' && --depth === 0) return i;
  }
  return flat.length;
}

/**
 * Methods whose parameters or body check the caller, as `Class.Method` and as `Method`, so a
 * minimal-API endpoint mapped to `AccountEndpoints.AccountAsync` counts as checked even though the
 * handler lives in another file.
 */
function callerCheckingMethods(src, types) {
  const code = blankComments(src);
  const flat = blankStrings(code);
  const out = [];
  for (const m of code.matchAll(CS_METHOD)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(flat, open);
    if (close < 0) continue;
    const end = bodyEnd(flat, close + 1);
    if (end < 0 || !CS_INLINE_CHECK.test(code.slice(open, end))) continue;
    const line = lineAt(src, m.index);
    const owner = types.filter((t) => t.line <= line).pop()?.name;
    out.push({ method: m[1], owner, line });
  }
  return out;
}

/** Findings for the app-wide checks a Program.cs or startup file sets up. */
function globalGuards(code, out) {
  for (const [re, name] of CS_GLOBAL_GUARDS) {
    const m = re.exec(code);
    if (m) out.push({ k: 'global-guard', framework: 'aspnet', name, line: lineAt(code, m.index) });
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
  const code = blankComments(src);
  const types = f.csTypes || [];
  globalGuards(code, out);
  typeFindings(types, out);
  const checks = callerCheckingMethods(src, types);
  for (const c of checks) if (c.owner) out.push({ k: 'caller-check', name: `${c.owner}.${c.method}`, line: c.line });
  const conventional = (f.conventionalActions || []).flatMap((a) => a.methods.map((method) => ({ ...a, method })));
  const routes = [...(f.routes || []).filter((r) => r.framework === 'aspnet'), ...conventional].sort((a, b) => a.line - b.line);
  routes.forEach((r, idx) => {
    const rec = { k: 'route', line: r.line, method: r.method, fn: r.handler, decos: r.auth?.decos || [], ...(r.handlerRef ? { handlerRef: r.handlerRef } : {}) };
    if (r.auth?.anonymous) rec.public = true;
    else if (r.auth?.guard) Object.assign(rec, { guard: r.auth.guard, via: 'attribute' });
    // a method-group handler's code is elsewhere, so only the Map… line itself is this endpoint's
    const next = r.handlerRef ? r.line + 1 : routes.slice(idx + 1).find((x) => x.line > r.line)?.line || r.line + 80;
    const body = lines.slice(r.line - 1, Math.min(next - 1, r.line + 80)).join('\n');
    // a handler named without its class (MapGet("/me", GetMe)) is a method in this file
    const local = r.handlerRef && !r.handlerRef.includes('.') && checks.some((c) => c.method === r.handlerRef);
    if (!rec.via && !rec.public && (CS_INLINE_CHECK.test(body) || local)) rec.via = 'inline';
    if (signatureCheck.test(body) || /\bConstructEvent\s*\(/.test(body)) rec.signed = true;
    out.push(rec);
  });
}

// ---------- CORS and Stripe.net ----------

/** CORS that lets every site call the server. `add(index, how, credentials)` records one. */
export function csCors(src, add) {
  // ASP.NET Core refuses AllowAnyOrigin with AllowCredentials, but not an origin check that always says yes
  const credentials = /\.\s*AllowCredentials\s*\(\s*\)/.test(src);
  for (const m of src.matchAll(/\.\s*AllowAnyOrigin\s*\(\s*\)/g)) add(m.index, 'AllowAnyOrigin()', false);
  for (const m of src.matchAll(/\.\s*WithOrigins\s*\(\s*"\*"\s*\)/g)) add(m.index, 'WithOrigins("*")', false);
  for (const m of src.matchAll(/\.\s*SetIsOriginAllowed\s*\(\s*(?:\w+|\(\s*\w*\s*\))\s*=>\s*true\s*\)/g)) add(m.index, 'SetIsOriginAllowed(_ => true)', credentials);
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
