// The read boundary, the hand-written schema validator and the single-use tickets, with no Python
// anywhere: every case here is the Node half of the source-aware Ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Boundary, LIMITS, DECISION_SCHEMA, compileSchema, validateSchema, answerProblems, flowProblems,
  denyReason, frameProblem,
} from '../skills/floorplan/assets/hermes-boundary.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = new Function(`${fs.readFileSync(path.join(REPO, 'skills/floorplan/assets/graph-query.js'), 'utf8')};
  return { FLOORPLAN_ANSWER_SCHEMA, FLOORPLAN_FLOW_SCHEMA, FLOORPLAN_CHANGE_SCHEMA, createGraphQuery };`)();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 12);

/** A tiny project on disk with one scanned file per case; `extra` adds files not in the graph. */
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-boundary-'));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}
const graphFor = (root, entries) => ({
  project: { name: 'Shop', summary: 'A shop.' },
  nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: '', stats: { files: entries.length, loc: 10 } }],
  files: entries.map(([p, text]) => ({ p, n: 'api', l: 'javascript', loc: text.split('\n').length, name: path.basename(p), d: '' })),
  routes: [], links: [],
});
const fingerprintsFor = (root, entries) => new Map(entries.map(([p]) => [p, sha1(fs.readFileSync(path.join(root, p)))]));

/** The Python worker's side of the handshake, faithfully: reopen, hash, compare, redact, slice. */
function worker(root, { swap = null } = {}) {
  return {
    read: async (rel) => {
      const buf = fs.readFileSync(path.join(root, rel));
      if (swap) swap();
      return { ok: true, sha256: sha256(buf), bytes_base64: buf.toString('base64') };
    },
    ticket: async (t) => {
      let buf;
      try { buf = fs.readFileSync(path.join(root, t.path)); } catch { return { ok: false, reason: 'not_found' }; }
      const hash = sha256(buf);
      if (hash !== t.sha256) return { ok: false, reason: 'changed' };
      const lines = buf.toString('utf8').split('\n');
      if (t.redactLines.some((n) => n < 1 || n > lines.length)) return { ok: false, reason: 'changed' };
      for (const n of t.redactLines) lines[n - 1] = '[redacted: known secret]';
      const text = lines.slice(t.start - 1, t.end).join('\n');
      if (Buffer.byteLength(text) > t.byteLimit) return { ok: false, reason: 'too_large' };
      return { ok: true, sha256: hash, text };
    },
  };
}
function boundaryFor(root, entries, { blueprint = null, findings = () => [], findIssues = null, swap = null } = {}) {
  const graph = graphFor(root, entries);
  const w = worker(root, { swap });
  return new Boundary({
    root, graph, blueprint, query: core.createGraphQuery(graph), fingerprints: fingerprintsFor(root, entries),
    findIssues: findIssues || ((src, f) => findings(f.path, src)),
    read: w.read, ticket: w.ticket,
  });
}

const answer = (over = {}) => ({
  title: 'Refunds', answer: 'Refunds go through [[f:shop-api/app.js]].',
  items: [1, 2, 3].map((i) => ({ id: 'f:shop-api/app.js', note: `n${i}` })), ...over,
});
const exists = () => true;

test('the three shipped schemas compile, and their sample payloads pass', () => {
  for (const s of [core.FLOORPLAN_ANSWER_SCHEMA, core.FLOORPLAN_FLOW_SCHEMA, core.FLOORPLAN_CHANGE_SCHEMA]) compileSchema(s);
  assert.deepEqual(validateSchema(core.FLOORPLAN_ANSWER_SCHEMA, { title: 't', answer: 'a', items: [{ id: 'x', note: 'n' }] }), []);
  assert.deepEqual(validateSchema(core.FLOORPLAN_FLOW_SCHEMA, { title: 't', steps: [{ id: 'x', note: 'n' }] }), []);
  const change = { title: 't', summary: 's', plan: '{}', architecture: '{}', changes: [{ ref: 'a.js', change: 'new', note: 'n' }] };
  assert.deepEqual(validateSchema(core.FLOORPLAN_CHANGE_SCHEMA, change), []);
  compileSchema(DECISION_SCHEMA);
});

test('an unsupported assertion throws at construction, never silently skips', () => {
  assert.throws(() => compileSchema({ type: 'object', properties: { a: { type: 'string', pattern: '^x' } } }), /unsupported schema keyword "pattern"/);
  assert.throws(() => compileSchema({ type: 'number' }), /unsupported type "number"/);
  assert.throws(() => compileSchema({ type: 'object', additionalProperties: true }), /additionalProperties/);
});

test('shape: extra properties, wrong types and missing required fields are refused', () => {
  const s = core.FLOORPLAN_ANSWER_SCHEMA;
  assert.match(validateSchema(s, { title: 't', answer: 'a', items: [], extra: 1 })[0], /unexpected property "extra"/);
  assert.match(validateSchema(s, { title: 3, answer: 'a', items: [] })[0], /expected string/);
  assert.match(validateSchema(s, { answer: 'a', items: [] }).join(' '), /missing title/);
});

test('answer bounds: 3-14 items, 0-14 steps, 0-3 follow-ups, 120/4000/300 characters, known ids', () => {
  const items = (n) => Array.from({ length: n }, () => ({ id: 'f:shop-api/app.js', note: 'n' }));
  assert.ok(answerProblems(answer({ items: items(2) }), exists).length);
  assert.deepEqual(answerProblems(answer({ items: items(3) }), exists), []);
  assert.deepEqual(answerProblems(answer({ items: items(14) }), exists), []);
  assert.ok(answerProblems(answer({ items: items(15) }), exists).length);
  assert.ok(answerProblems(answer({ title: 'x'.repeat(121) }), exists).length);
  assert.ok(answerProblems(answer({ answer: 'x'.repeat(4001) }), exists).length);
  assert.ok(answerProblems(answer({ items: [{ id: 'f:shop-api/app.js', note: 'n'.repeat(301) }] }), exists).length);
  assert.ok(answerProblems(answer({ followups: ['a', 'b', 'c', 'd'] }), exists).length);
  assert.ok(answerProblems(answer({ steps: Array.from({ length: 15 }, () => ({ id: 'f:shop-api/app.js', note: 'n' })) }), exists).length);
  const unknown = () => false;
  assert.match(answerProblems(answer(), unknown).join(' '), /unknown id/);
  assert.match(answerProblems(answer({ answer: 'See [[f:nope.js]]' }), (id) => id !== 'f:nope.js').join(' '), /unknown \[\[f:nope\.js\]\]/);
});

test('flow bounds: 3-9 steps and known ids', () => {
  const flow = (n) => ({ title: 'f', steps: Array.from({ length: n }, () => ({ id: 'f:shop-api/app.js', note: 'n' })) });
  assert.ok(flowProblems(flow(2), exists).length);
  assert.deepEqual(flowProblems(flow(3), exists), []);
  assert.deepEqual(flowProblems(flow(9), exists), []);
  assert.ok(flowProblems(flow(10), exists).length);
  assert.ok(flowProblems({ title: 'f', steps: [{ id: 'f:no.js', note: 'n' }] }, exists).length >= 1);
});

test('the decision schema bounds each argument; the 200-line window is enforced by the boundary', () => {
  const s = DECISION_SCHEMA.properties.lookup.properties.args;
  assert.deepEqual(validateSchema(s, { path: 'a.js', start: 1, end: 200 }), []);
  assert.deepEqual(validateSchema(s, { path: 'a.js', start: 2, end: 201 }), []);
  assert.match(validateSchema(s, { path: 'a.js', start: 0, end: 5 })[0], /below 1/);
  assert.match(validateSchema(s, { path: 'a.js', start: 1, end: 1, extra: 1 })[0], /unexpected property/);
  assert.match(validateSchema(s, { words: 'x'.repeat(201) })[0], /longer than 200/);
});

test('the deny list refuses every class, and traversal in every form', () => {
  for (const p of ['.git/config', 'node_modules/x/index.js', '.env', '.env.local', 'AGENTS.md', 'SOUL.md',
    'CLAUDE.local.md', '.cursorrules', 'deploy/server.pem', 'id_rsa', 'credentials.json', 'service-account-x.json',
    'src/client_secret.json', 'app-key.json', 'config/tokens.json', 'src/passwords.yaml', 'secrets', 'floorplan/serve.mjs']) {
    assert.ok(denyReason(p), p);
  }
  for (const p of ['src/tokenizer.ts', 'src/tokens.css', 'src/passwordless.ts', 'config/tokens.js']) {
    assert.equal(denyReason(p), null, p); // ordinary words, not a secret store
  }
  for (const p of ['../outside.js', '/etc/passwd', 'C:\\secret.js', 'a\\b.js', 'a\0b', '', 'a//b', './a.js']) {
    assert.equal(denyReason(p), 'invalid_path', p);
  }
  assert.equal(denyReason('shop-api/app.js'), null);
});

test('blueprint mode opens exactly the plan, the architecture and the PRD it names', () => {
  const bp = { blueprint: { source: 'docs/prd.md' }, prdPath: 'docs/prd.md' };
  assert.equal(denyReason('floorplan/plan.json', bp), null);
  assert.equal(denyReason('floorplan/architecture.json', bp), null);
  assert.equal(denyReason('docs/prd.md', bp), null);
  assert.equal(denyReason('floorplan/serve.mjs', bp), 'denied_directory');
  assert.equal(denyReason('docs/other.md', bp), null); // a normal map file; eligibility still decides
  assert.ok(denyReason('floorplan/plan.json')); // outside blueprint mode it is wallpaper
});

test('a 200-line read passes, a 32 KiB one is refused, and start=2..201 is the same window later', async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
  const entries = [['shop-api/app.js', lines]];
  const root = project({ 'shop-api/app.js': lines });
  const b = boundaryFor(root, entries);
  const a = await b.lookup('read', { path: 'shop-api/app.js', start: 1, end: 200 }, 'L1');
  assert.equal(a.ok, true);
  assert.equal(a.data.text.split('\n').length, 200);
  const z = await b.lookup('read', { path: 'shop-api/app.js', start: 2, end: 201 }, 'L2');
  assert.equal(z.ok, true);
  assert.equal(z.data.text.split('\n')[0], 'line 2');
  const over = await b.lookup('read', { path: 'shop-api/app.js', start: 1, end: 201 }, 'L3');
  assert.equal(over.reason, 'bad_range');
  const fat = Array.from({ length: 200 }, () => 'x'.repeat(200)).join('\n');
  const root2 = project({ 'shop-api/app.js': fat });
  const b2 = boundaryFor(root2, [['shop-api/app.js', fat]]);
  const big = await b2.lookup('read', { path: 'shop-api/app.js', start: 1, end: 200 }, 'L4');
  assert.equal(big.ok, false);
  assert.equal(big.reason, 'too_large');
});

test('a known secret line is redacted; a private key or a throwing classifier denies the whole file', async () => {
  const text = 'const a = 1;\nconst KEY = "FAKE_SECRET_abc";\nconst b = 2;';
  const entries = [['shop-api/app.js', text]];
  const root = project({ 'shop-api/app.js': text });
  const b = boundaryFor(root, entries, { findings: (p) => (p === 'shop-api/app.js' ? [{ k: 'secret', line: 2, hint: 'sk-…' }] : []) });
  const r = await b.lookup('read', { path: 'shop-api/app.js', start: 1, end: 3 }, 'L1');
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.data.text, /FAKE_SECRET_abc/);
  assert.match(r.data.text, /\[redacted: known secret\]/);

  const key = boundaryFor(root, entries, { findings: () => [{ k: 'secret', line: 1, hint: 'private key block' }] });
  assert.equal((await key.lookup('read', { path: 'shop-api/app.js', start: 1, end: 1 }, 'L2')).reason, 'whole_file_secret');

  const badLine = boundaryFor(root, entries, { findings: () => [{ k: 'secret', line: 99, hint: 'x' }] });
  assert.equal((await badLine.lookup('read', { path: 'shop-api/app.js', start: 1, end: 1 }, 'L3')).reason, 'whole_file_secret');

  const broken = boundaryFor(root, entries, { findIssues: () => { throw new Error('scan'); } });
  assert.equal((await broken.lookup('read', { path: 'shop-api/app.js', start: 1, end: 1 }, 'L4')).reason, 'classifier_failed');
});

test('a stale scan fingerprint denies the whole file before any of it is read', async () => {
  const text = 'const a = 1;';
  const root = project({ 'shop-api/app.js': text });
  const b = boundaryFor(root, [['shop-api/app.js', text]]);
  b.fingerprints.set('shop-api/app.js', '000000000000');
  assert.equal((await b.lookup('read', { path: 'shop-api/app.js', start: 1, end: 1 }, 'L1')).reason, 'stale');
});

test('a regular-file swap between classification and the ticket is denied, and the canary never returns', async () => {
  const text = 'const a = 1;\nconst b = 2;';
  const root = project({ 'shop-api/app.js': text });
  let swapped = false;
  const b = boundaryFor(root, [['shop-api/app.js', text]], { swap: () => { if (!swapped) { swapped = true; fs.writeFileSync(path.join(root, 'shop-api/app.js'), 'CANARY_SWAPPED\n'); } } });
  const r = await b.lookup('read', { path: 'shop-api/app.js', start: 1, end: 2 }, 'L1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'changed');
  assert.doesNotMatch(JSON.stringify(r), /CANARY_SWAPPED/);
});

test('missing scan entries, files outside the graph and symlinks are refused', async () => {
  const text = 'const a = 1;';
  const root = project({ 'shop-api/app.js': text, 'shop-api/other.js': text });
  const b = boundaryFor(root, [['shop-api/app.js', text]]);
  assert.equal((await b.lookup('read', { path: 'shop-api/other.js', start: 1, end: 1 }, 'L1')).reason, 'not_in_graph');
  assert.equal((await b.lookup('read', { path: '../outside.js', start: 1, end: 1 }, 'L2')).reason, 'invalid_path');
  fs.symlinkSync(path.join(root, 'shop-api/app.js'), path.join(root, 'shop-api/link.js'));
  b.graph.files.push({ p: 'shop-api/link.js', n: 'api', l: 'javascript' });
  b.byPath.set('shop-api/link.js', { p: 'shop-api/link.js', l: 'javascript' });
  b.fingerprints.set('shop-api/link.js', sha1(fs.readFileSync(path.join(root, 'shop-api/app.js'))));
  assert.equal((await b.lookup('read', { path: 'shop-api/link.js', start: 1, end: 1 }, 'L3')).reason, 'symlink');
});

test('blueprint inputs classify without scan entries; any other unscanned path is refused', async () => {
  const plan = JSON.stringify({ source: 'docs/prd.md', files: [] }, null, 2);
  const arch = JSON.stringify({ nodes: [] }, null, 2);
  const prd = '# PRD\nRefunds are instant.';
  const root = project({ 'floorplan/plan.json': plan, 'floorplan/architecture.json': arch, 'docs/prd.md': prd, 'docs/other.md': '# other' });
  const entries = [];
  const b = boundaryFor(root, entries, { blueprint: { source: 'docs/prd.md' }, findIssues: () => [] });
  for (const [p, want] of [['floorplan/plan.json', 'source'], ['floorplan/architecture.json', 'nodes'], ['docs/prd.md', 'Refunds']]) {
    const r = await b.lookup('read', { path: p, start: 1, end: 5 }, `L-${p}`);
    assert.equal(r.ok, true, `${p}: ${r.reason}`);
    assert.match(r.data.text, new RegExp(want));
  }
  assert.equal((await b.lookup('read', { path: 'docs/other.md', start: 1, end: 1 }, 'L4')).reason, 'not_in_graph');
  assert.equal((await b.lookup('read', { path: 'floorplan/custom-flows.json', start: 1, end: 1 }, 'L5')).reason, 'denied_directory');
});

test('a blueprint secret is redacted from the plan; a symlinked input is refused', async () => {
  const plan = '{\n "source": "docs/prd.md",\n "key": "FAKE_SECRET_plan"\n}';
  const root = project({ 'floorplan/plan.json': plan, 'floorplan/architecture.json': '{}', 'docs/prd.md': '# PRD' });
  const b = boundaryFor(root, [], { blueprint: { source: 'docs/prd.md' }, findings: (p) => (p === 'floorplan/plan.json' ? [{ k: 'secret', line: 3, hint: 'x' }] : []) });
  const r = await b.lookup('read', { path: 'floorplan/plan.json', start: 1, end: 4 }, 'L1');
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.data.text, /FAKE_SECRET_plan/);
  fs.rmSync(path.join(root, 'docs/prd.md'));
  fs.symlinkSync(path.join(root, 'floorplan/plan.json'), path.join(root, 'docs/prd.md'));
  const s = await b.lookup('read', { path: 'docs/prd.md', start: 1, end: 1 }, 'L2');
  assert.equal(s.reason, 'symlink');
});

test('lookup ceilings and the 1 MiB frame cap hold', async () => {
  const text = 'const a = 1;';
  const root = project({ 'shop-api/app.js': text });
  const b = boundaryFor(root, [['shop-api/app.js', text]]);
  for (let i = 0; i < LIMITS.lookups; i++) assert.equal((await b.lookup('overview', {}, `L${i}`)).ok, true);
  await assert.rejects(() => b.lookup('overview', {}, 'Lx'), /lookup_ceiling/);
  assert.equal(frameProblem({ v: 1, id: 'a', type: 'result', seq: 0 }, { id: 'a', bytes: LIMITS.frameBytes + 1 }), 'frame_too_large');
  assert.equal(frameProblem({ v: 2, id: 'a', type: 'result', seq: 0 }, { id: 'a' }), 'bad_version');
  assert.equal(frameProblem({ v: 1, id: 'a', type: 'result', seq: 0 }, { id: 'b' }), 'id_mismatch');
  assert.equal(frameProblem({ v: 1, id: 'a', type: 'result', seq: 0 }, { id: 'a', lastSeq: 0 }), 'seq_not_increasing');
  assert.equal(frameProblem({ v: 1, id: 'a', type: 'nope', seq: 0 }, { id: 'a' }), 'bad_type');
  assert.equal(frameProblem({ v: 1, id: 'a', type: 'failure', seq: 0, code: 'nope' }, { id: 'a' }), 'bad_code');
});
