// floorplan/hermes-boundary.mjs: what Hermes Ask may read, how a decision is validated, and the
// single-use ticket that binds a read. Hand-written JSON-schema validator: no dependency, and an
// unsupported assertion throws at server start instead of being silently skipped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = {
  decisions: 8, lookups: 7, question: 4000, turns: 4, turnQuestion: 500, turnAnswer: 1500,
  readLines: 200, readBytes: 32768, rawBytes: 512 * 1024, sourceBytes: 128 * 1024,
  frameBytes: 1024 * 1024, deadlineMs: 180000, searchFiles: 20,
};

export const FAILURE_CODES = new Set([
  'cli_missing', 'cli_error', 'not_logged_in', 'rate_limited', 'timeout', 'cancelled', 'busy',
  'model_override_denied', 'profile_mismatch', 'unsupported_runtime', 'plugin_missing',
  'lookup_denied', 'invalid_json', 'session_expired', 'change_invalid', 'upstream_error', 'conflict',
]);

const TYPES = new Set(['object', 'array', 'string', 'integer', 'boolean']);
const KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'additionalProperties',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'description']);

/** Checks every node of a schema once; an unsupported keyword or type throws. */
export function compileSchema(schema) {
  const walk = (node, where) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${where}: a schema node must be an object`);
    for (const k of Object.keys(node)) if (!KEYS.has(k)) throw new Error(`${where}: unsupported schema keyword "${k}"`);
    if (node.description !== undefined && typeof node.description !== 'string') throw new Error(`${where}.description must be a string`);
    if (node.type !== undefined && !TYPES.has(node.type)) throw new Error(`${where}: unsupported type "${node.type}"`);
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) throw new Error(`${where}.additionalProperties must be false`);
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length)) throw new Error(`${where}.enum must be a non-empty array`);
    for (const [k, v] of Object.entries(node.properties || {})) walk(v, `${where}.${k}`);
    if (node.items !== undefined) {
      if (node.type !== 'array') throw new Error(`${where}.items without type array`);
      walk(node.items, `${where}[]`);
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== 'string')) throw new Error(`${where}.required must be strings`);
      for (const r of node.required) if (node.properties && !node.properties[r]) throw new Error(`${where}: required "${r}" is not a property`);
    }
    if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'].some((k) => node[k] !== undefined && !Number.isInteger(node[k]))) {
      throw new Error(`${where}: length/number bounds must be integers`);
    }
  };
  walk(schema, 'schema');
  return schema;
}

/** Payload problems, as strings. Empty means valid. */
export function validateSchema(schema, value, at = '$') {
  const errs = [];
  const typeOk = (t) => t === 'object' ? value && typeof value === 'object' && !Array.isArray(value)
    : t === 'array' ? Array.isArray(value)
    : t === 'integer' ? Number.isInteger(value)
    : t === 'string' ? typeof value === 'string'
    : t === 'boolean' ? typeof value === 'boolean' : true;
  if (schema.type && !typeOk(schema.type)) return [`${at}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateSchema(schema.items, v, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${at}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validateSchema(schema.properties[k], v, `${at}.${k}`));
      else if (schema.properties || schema.additionalProperties === false) errs.push(`${at}: unexpected property "${k}"`);
    }
  }
  return errs;
}

const itemShape = {
  type: 'object',
  properties: { id: { type: 'string' }, note: { type: 'string' } },
  required: ['id', 'note'],
  additionalProperties: false,
};

/** One lookup, or the mode's final payload. */
export const DECISION_SCHEMA = compileSchema({
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['lookup', 'final'] },
    lookup: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['overview', 'find', 'show', 'path', 'read', 'search'] },
        args: {
          type: 'object',
          properties: {
            words: { type: 'string', minLength: 1, maxLength: 200 },
            kind: { type: 'string', enum: ['module', 'file', 'endpoint', 'symbol'] },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
            id: { type: 'string', minLength: 1, maxLength: 300 },
            from: { type: 'string', minLength: 1, maxLength: 300 },
            to: { type: 'string', minLength: 1, maxLength: 300 },
            path: { type: 'string', minLength: 1, maxLength: 1024 },
            start: { type: 'integer', minimum: 1 },
            end: { type: 'integer', minimum: 1 },
            text: { type: 'string', minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
      required: ['kind', 'args'],
      additionalProperties: false,
    },
    payload: { type: 'object' },
  },
  required: ['kind'],
  additionalProperties: false,
});

const refs = (s) => [...String(s || '').matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
const REFUSED = (m) => ({ ok: false, code: 'lookup_denied', reason: m });

/** Semantic bounds the shape check cannot express; everything here is a hard refusal, never a trim. */
export function answerProblems(a, exists) {
  const p = [];
  if ((a.items || []).length < 3 || (a.items || []).length > 14) p.push('items must be 3-14');
  if ((a.steps || []).length > 14) p.push('steps must be 0-14');
  if ((a.followups || []).length > 3) p.push('followups must be 0-3');
  if (String(a.title || '').length > 120) p.push('title is over 120 characters');
  if (String(a.answer || '').length > 4000) p.push('answer is over 4000 characters');
  for (const x of [...(a.items || []), ...(a.steps || [])]) {
    if (!exists(String(x.id || ''))) p.push(`unknown id "${x.id}"`);
    if (String(x.note || '').length > 300) p.push(`note on ${x.id} is over 300 characters`);
  }
  for (const r of refs(a.answer)) if (!exists(r.trim())) p.push(`unknown [[${r}]] in the answer`);
  return p;
}

export function flowProblems(f, exists) {
  const p = [];
  if ((f.steps || []).length < 3 || (f.steps || []).length > 9) p.push('steps must be 3-9');
  if (String(f.title || '').length > 120) p.push('title is over 120 characters');
  for (const s of f.steps || []) {
    if (!exists(String(s.id || ''))) p.push(`unknown id "${s.id}"`);
    if (String(s.note || '').length > 300) p.push(`note on ${s.id} is over 300 characters`);
  }
  return p;
}

// ---------- the deny list ----------
const DENY_DIR = new Set(['.git', '.hg', '.svn', '.hermes', '.ssh', '.aws', '.gnupg', '.cache',
  'node_modules', 'bower_components', '.venv', 'venv', '__pycache__', '.pytest_cache', 'dist',
  'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo']);
const DENY_FILE = /^(AGENTS|SOUL|CLAUDE[^/]*)\.md$|^\.cursorrules$|^\.env/i;
const CREDENTIAL = /\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)$|^service[-_]?account.*\.json$|^credentials?\.json$|^firebase-adminsdk.*\.json$|^client_secret.*\.json$|-key\.json$/i;
const SECRET_STORE = /^\.?(tokens?|secrets?|passwords?)(\.(json|ya?ml|txt|env|ini|conf|cfg))?$/i;

/** Why `rel` may never be read, or null when it may. Blueprint mode opens exactly three extra inputs. */
export function denyReason(rel, { blueprint = null, prdPath = null } = {}) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return 'invalid_path';
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return 'invalid_path';
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return 'invalid_path';
  for (const p of parts) {
    if (DENY_DIR.has(p.toLowerCase())) return 'denied_directory';
    if (p === '.env' || p.startsWith('.env.') || p.startsWith('.env')) return 'denied_file';
    if (DENY_FILE.test(p)) return 'denied_file';
    if (CREDENTIAL.test(p) || SECRET_STORE.test(p)) return 'denied_file';
  }
  const blueprintInputs = ['floorplan/plan.json', 'floorplan/architecture.json', prdPath].filter(Boolean);
  if (blueprintInputs.includes(rel)) return blueprint ? null : 'denied_file';
  if (rel === 'floorplan' || rel.startsWith('floorplan/')) return 'denied_directory';
  return null;
}

/** Every component below the root must be a real directory and the leaf a regular file, no symlink. */
function symlinkInPath(root, rel) {
  let dir = root;
  for (const part of rel.split('/')) {
    dir = path.join(dir, part);
    let st;
    try { st = fs.lstatSync(dir); } catch { return 'not_found'; }
    if (st.isSymbolicLink()) return 'symlink';
  }
  try { if (!fs.lstatSync(dir).isFile()) return 'not_regular'; } catch { return 'not_found'; }
  return null;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const decode = (base64) => Buffer.from(String(base64 || ''), 'base64');
const within = (root, rel) => path.resolve(root, rel).startsWith(root + path.sep);

/**
 * One Ask request's read boundary. `read` and `ticket` are the Python round trips; injectable so the
 * boundary is testable without a Python worker.
 */
export class Boundary {
  constructor({ root, graph, blueprint = null, mode = 'ask', fingerprints = new Map(), query, findIssues, read, ticket, now = Date.now }) {
    this.root = path.resolve(root);
    this.graph = graph;
    this.blueprint = blueprint;
    this.mode = mode;
    this.fingerprints = fingerprints;
    this.prdPath = blueprint?.source || null;
    this.query = query;
    this.findIssues = findIssues;
    this.read = read;
    this.ticket = ticket;
    this.now = now;
    this.lookups = 0;
    this.decisions = 0;
    this.returned = 0;
    this.pinState = 'new';
    this.byPath = new Map(graph.files.map((f) => [f.p, f]));
  }

  opts() { return { blueprint: this.blueprint, prdPath: this.prdPath }; }

  /**
   * Blueprint only: pin the one PRD path from the plan bytes this request classifies, never from the
   * model or from a stale map. A plan that changed since the build authorizes only what it names now.
   */
  async pinSource() {
    if (!this.blueprint) return null;
    this.prdPath = null;
    let raw;
    try { raw = await this.read('floorplan/plan.json', 'pin'); } catch { return null; }
    if (!raw?.ok) return null;
    const buf = decode(raw.bytes_base64);
    if (raw.sha256 !== sha256(buf) || buf.length > LIMITS.rawBytes) return null;
    const src = buf.toString('utf8');
    if (Buffer.from(src, 'utf8').compare(buf) !== 0 || src.includes('\0')) return null;
    let plan;
    try { plan = JSON.parse(src); } catch { return null; }
    const rel = typeof plan?.source === 'string' ? plan.source.trim() : '';
    if (!rel || denyReason(rel)) return null;
    this.prdPath = rel;
    return rel;
  }

  /** Refuses a path that the deny list or the map does not admit; null when readable. */
  eligible(rel) {
    const why = denyReason(rel, this.opts());
    if (why) return why;
    if (!within(this.root, rel)) return 'invalid_path';
    const linked = symlinkInPath(this.root, rel);
    if (linked) return linked;
    if (this.blueprint && ['floorplan/plan.json', 'floorplan/architecture.json', this.prdPath].includes(rel)) return null;
    const entry = this.byPath.get(rel);
    if (!entry) return 'not_in_graph';
    if (entry.healthError) return 'scan_error';
    if (!this.fingerprints.has(rel)) return 'missing_scan_entry';
    if (!this.findIssues) return 'plugin_missing';
    return null;
  }

  category(rel) {
    if (rel === 'floorplan/plan.json' || rel === 'floorplan/architecture.json') return { category: 'config', lang: null };
    if (rel === this.prdPath) return { category: 'docs', lang: null };
    const e = this.byPath.get(rel);
    const l = e?.l;
    return ['config', 'docs', 'code'].includes(l) ? { category: l, lang: null } : { category: 'code', lang: l || null };
  }

  /**
   * Reads one file through the private handshake: Python's bytes are classified here, the ticket
   * carries their full SHA-256, and the returned text must come back from that same buffer.
   */
  async readFile(rel, start, end, lookupId) {
    // the PRD is authorized only by the plan bytes this request classified, pinned on first need
    if (this.blueprint && this.pinState !== 'done' && rel !== 'floorplan/plan.json' && rel !== 'floorplan/architecture.json') {
      this.pinState = 'done';
      await this.pinSource();
    }
    const why = this.eligible(rel);
    if (why) return REFUSED(why);
    if ((end - start + 1) > LIMITS.readLines) return REFUSED('too_many_lines');
    const raw = await this.read(rel, lookupId);
    if (!raw?.ok) return REFUSED(raw?.reason || 'unreadable');
    const buf = decode(raw.bytes_base64);
    if (buf.length > LIMITS.rawBytes) return REFUSED('too_large');
    if (raw.sha256 !== sha256(buf)) return REFUSED('changed');
    const hint = this.fingerprints.get(rel);
    if (hint && sha1(buf).slice(0, 12) !== hint) return REFUSED('stale');
    let src;
    try { src = buf.toString('utf8'); } catch { return REFUSED('decode'); }
    if (src.includes('\0')) return REFUSED('binary');
    if (Buffer.from(src, 'utf8').compare(buf) !== 0) return REFUSED('decode');
    let findings;
    try { findings = this.findIssues(src, { path: rel, ...this.category(rel) }) || []; } catch { return REFUSED('classifier_failed'); }
    const redact = [];
    for (const f of findings) {
      if (f.k !== 'secret') continue;
      if (f.hint === 'whole file' || f.hint === 'private key block' || !Number.isInteger(f.line) || f.line < 1 || f.line > src.split('\n').length) {
        return REFUSED('whole_file_secret');
      }
      redact.push(f.line);
    }
    const got = await this.ticket({ lookupId, path: rel, rootDigest: sha256(this.root), mode: this.mode,
      sha256: raw.sha256, start, end, redactLines: redact, byteLimit: LIMITS.readBytes });
    if (!got?.ok) return REFUSED(got?.reason || 'changed');
    if (got.sha256 !== raw.sha256) return REFUSED('changed');
    const text = String(got.text ?? '');
    const lines = text === '' ? 0 : text.split('\n').length;
    if (lines > LIMITS.readLines || Buffer.byteLength(text) > LIMITS.readBytes) return REFUSED('too_large');
    this.returned += Buffer.byteLength(text);
    if (this.returned > LIMITS.sourceBytes) return REFUSED('source_cap');
    return { ok: true, data: { path: rel, start, end, text } };
  }

  async lookup(kind, args = {}, lookupId = '') {
    this.lookups++;
    if (this.lookups > LIMITS.lookups) throw new Error('lookup_ceiling');
    switch (kind) {
      case 'overview': return { ok: true, data: this.query.overview() };
      case 'find': return { ok: true, data: this.query.find(args.words, args.kind, args.limit) };
      case 'show': {
        if (typeof args.id !== 'string' || !args.id || args.id.length > 300) return REFUSED('bad_id');
        try { return { ok: true, data: this.query.show(args.id) }; } catch { return REFUSED('unknown_id'); }
      }
      case 'path': {
        if (typeof args.from !== 'string' || typeof args.to !== 'string') return REFUSED('bad_id');
        try { return { ok: true, data: this.query.path(args.from, args.to) }; } catch { return REFUSED('unknown_id'); }
      }
      case 'read': {
        if (typeof args.path !== 'string' || args.path.length > 1024) return REFUSED('invalid_path');
        const start = args.start, end = args.end;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start + 1 > LIMITS.readLines) return REFUSED('bad_range');
        return this.readFile(args.path, start, end, lookupId);
      }
      case 'search': {
        if (typeof args.text !== 'string' || !args.text || args.text.length > 200) return REFUSED('bad_query');
        const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 20) : 20;
        const hits = [];
        let seen = 0;
        for (const f of this.graph.files) {
          if (hits.length >= limit || seen >= LIMITS.searchFiles || this.returned >= LIMITS.sourceBytes) break;
          if (this.eligible(f.p)) continue;
          seen++;
          // shortcut: literal search reads 200 lines of the first 20 eligible files; widen when maps grow.
          const r = await this.readFile(f.p, 1, LIMITS.readLines, `${lookupId}:${f.p}`);
          if (!r.ok) continue;
          r.data.text.split('\n').forEach((line, i) => { if (line.includes(args.text)) hits.push({ path: f.p, line: i + 1, text: line.slice(0, 300) }); });
        }
        return { ok: true, data: { matches: hits.slice(0, limit) } };
      }
      default: return REFUSED('unknown_lookup');
    }
  }
}

const FRAME_TYPES = new Set(['ready', 'lookup', 'progress', 'result', 'failure', 'start', 'lookup_result', 'classify_read', 'source_bytes', 'source_ticket']);

/** A protocol frame problem, or null. `bytes` is the raw line length (the 1 MiB frame cap). */
export function frameProblem(frame, { id, lastSeq = -1, bytes = 0 } = {}) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return 'not_an_object';
  if (bytes > LIMITS.frameBytes) return 'frame_too_large';
  if (frame.v !== 1) return 'bad_version';
  if (typeof frame.id !== 'string' || !frame.id || frame.id.length > 64) return 'bad_id';
  if (id !== undefined && frame.id !== id) return 'id_mismatch';
  if (!FRAME_TYPES.has(frame.type)) return 'bad_type';
  if (!Number.isInteger(frame.seq) || frame.seq < 0) return 'bad_seq';
  if (frame.seq <= lastSeq) return 'seq_not_increasing';
  if (frame.type === 'failure' && !FAILURE_CODES.has(frame.code)) return 'bad_code';
  return null;
}
