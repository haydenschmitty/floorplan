// Unattended mode and the workflow file: running Floorplan without an agent session (in CI, in scripts, or
// from your own tooling). A tiny driver below follows skills/floorplan/workflow.json with canned model
// answers, using only the scripts' --json output and exit codes, the way a real driver would. The other tests
// check what such a driver relies on: nothing written outside floorplan/, a map that names no agent, loud
// failures when git can't list files, and that people using Floorplan in Claude Code or Codex see no change.
// If one of these fails, a program that runs Floorplan this way would break too: see docs/unattended.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SKILL, lib, shopApp, makeProject, run, readJson, writeJson, readGraph, cleanup } from './helpers.mjs';

const WORKFLOW = readJson(path.join(SKILL, 'workflow.json'));
const UNATTENDED = { ...WORKFLOW.conventions.environment };
const GUIDE = 'See docs/unattended.md.';

/** Runs a script with --json-style capture: { code, out, err, json }. `env` is added to (or, with clearEnv, replaces) this process's. */
function exec(script, root, args = [], { env = {}, baseEnv = process.env } = {}) {
  try {
    const out = execFileSync(process.execPath, [path.join(SKILL, 'scripts', script), root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...baseEnv, ...env } });
    return { code: 0, out, err: '', json: tryJson(out) };
  } catch (e) {
    if (e.status == null) throw e;
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || ''), json: tryJson(String(e.stdout || '')) };
  }
}
const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
/** A script run in unattended mode with --json; stdout must be exactly one JSON object. */
function unattended(script, root, ...args) {
  const r = exec(script, root, ['--json', ...args], { env: UNATTENDED });
  assert.ok(r.json && typeof r.json === 'object', `${script} --json must print exactly one JSON object on stdout. ${GUIDE}\nstdout: ${r.out.slice(0, 500)}\nstderr: ${r.err.slice(0, 500)}`);
  return r;
}
const commitAll = (dir, msg) => {
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });
  g('add', '-A'); g('commit', '-qm', msg);
};

// ---------- a tiny JSON Schema checker: exactly the keywords workflow.json promises a driver needs ----------
const KEYWORDS = new Set(['$schema', 'description', 'type', 'properties', 'required', 'items', 'enum', 'pattern', 'minItems', 'minLength', 'additionalProperties']);
function keywordsUsed(schema, at = '$', out = []) {
  for (const [k, v] of Object.entries(schema)) {
    if (!KEYWORDS.has(k)) out.push(`${at}.${k}`);
    if (k === 'properties') for (const [p, s] of Object.entries(v)) keywordsUsed(s, `${at}.properties.${p}`, out);
    if ((k === 'items' || k === 'additionalProperties') && v && typeof v === 'object') keywordsUsed(v, `${at}.${k}`, out);
  }
  return out;
}
function validate(schema, value, at = '$') {
  const t = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
  if (schema.type && ![].concat(schema.type).some((x) => x === t || (x === 'number' && t === 'integer'))) return [`${at}: expected ${schema.type}, got ${t}`];
  const errs = [];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (t === 'string') {
    if (schema.minLength && value.length < schema.minLength) errs.push(`${at}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: doesn't match ${schema.pattern}`);
  }
  if (t === 'array') {
    if (schema.minItems && value.length < schema.minItems) errs.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}: missing "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  return errs;
}

// ---------- the driver: follows workflow.json, nothing else ----------
/**
 * Runs workflow.json on a codebase. `model` holds a function per job, standing in for a real model: it gets
 * the job's inputs by name (and the item being worked on) and returns the answer. Returns what was saved
 * and a log of every step, so tests can check what ran.
 */
function drive(root, model) {
  const results = {};
  const log = [];
  const get = (p, scope) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), { ...results, ...scope });
  const holds = (conds, scope) => conds.every((c) => {
    const v = get(c.path, scope);
    if (v === undefined) return false;
    switch (c.op) {
      case 'equals': return v === c.value;
      case 'notEquals': return v !== c.value;
      case 'lessThan': return v < c.value;
      case 'atMost': return v <= c.value;
      case 'greaterThan': return v > c.value;
      case 'in': return c.value.includes(v);
      default: throw new Error(`workflow.json uses an unknown condition op "${c.op}"`);
    }
  });
  const fill = (s, scope) => s.replace(/\{([\w.]+)\}/g, (m, p) => (p === 'now' ? new Date().toISOString() : String(get(p, scope))));
  const fillDeep = (v, scope) => JSON.parse(JSON.stringify(v), (k, x) => (typeof x === 'string' ? fill(x, scope) : x));
  const stepsOf = (name) => WORKFLOW.procedures[name] || WORKFLOW.workflows[name]?.steps || assert.fail(`workflow.json names "${name}", which is neither a procedure nor a workflow`);

  function runScript(step) {
    const r = exec(step.run, root, step.args, { env: WORKFLOW.conventions.environment });
    log.push(`run ${step.run} → ${r.code}`);
    assert.ok(r.json, `${step.run} ${step.args.join(' ')} must print one JSON object. ${GUIDE}\n${r.out.slice(0, 400)}\n${r.err.slice(0, 400)}`);
    if (r.code !== 0 && !step.allowFailure) throw new Error(`step ${step.id} (${step.run}) failed with exit ${r.code}: ${JSON.stringify(r.json.errors)}`);
    if (step.save) results[step.save] = r.json;
    for (const [name, field] of Object.entries(step.saveFields || {})) results[name] = r.json[field];
  }
  function runJob(name, scope) {
    const job = WORKFLOW.jobs[name];
    assert.ok(job, `workflow.json has no job "${name}"`);
    for (const ref of job.read) assert.ok(fs.existsSync(path.join(SKILL, ref)), `job ${name} reads ${ref}, which doesn't exist`);
    const inputs = {};
    for (const inp of job.input) {
      let v;
      if (inp.from) v = get(inp.from, scope);
      else { const f = path.join(root, fill(inp.file, scope)); v = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined; }
      if (v === undefined) { assert.ok(inp.optional, `job ${name}: its input "${inp.name}" (${inp.from || inp.file}) is missing`); continue; }
      inputs[inp.name] = v;
    }
    const answer = model[name]({ inputs, scope });
    const errs = validate(WORKFLOW.schemas[job.schema], answer);
    assert.deepEqual(errs, [], `the answer for job ${name} doesn't match schemas.${job.schema}`);
    Object.assign(answer, fillDeep(job.set || {}, scope));
    writeJson(path.join(root, fill(job.writes, scope)), answer);
    log.push(`job ${name}${scope.worksheet ? ` (${scope.worksheet.key})` : scope.item ? ` (${scope.item.code})` : ''}`);
  }
  function runStep(step, scope) {
    if (step.when && !holds(step.when, scope)) { log.push(`skip ${step.id}`); return; }
    if (step.run) return runScript(step);
    if (step.job) {
      if (!step.forEach) return runJob(step.job, scope);
      const items = get(step.forEach, scope);
      assert.ok(Array.isArray(items), `${step.id}: forEach ${step.forEach} is not a list`);
      for (const it of items) runJob(step.job, { ...scope, [step.as]: it }); // a real driver may run these in parallel
      return;
    }
    if (step.write) { writeJson(path.join(root, fill(step.write, scope)), fillDeep(step.value, scope)); log.push(`write ${step.write}`); return; }
    if (step.repeat) {
      for (let i = 0; ; i++) {
        if (holds(step.until, scope)) return;
        if (i >= step.maxAttempts) throw new Error(`${step.id}: ${step.failMessage}`);
        for (const s of step.repeat) runStep(s, scope);
      }
    }
    if (step.use) { for (const s of stepsOf(step.use)) runStep(s, scope); return; }
    if (step.next) {
      for (const item of get(step.next, scope) || []) {
        const h = step.handlers[item.code];
        if (!h) throw new Error(`no handler in workflow.json for NEXT code "${item.code}"`);
        if (h.fail) throw new Error(h.fail);
        if (h.skip) continue;
        for (const s of stepsOf(h)) runStep(s, { ...scope, item });
      }
      return;
    }
    throw new Error(`workflow.json has a step of an unknown kind: ${JSON.stringify(step)}`);
  }

  // start: status picks the workflow
  runScript({ id: 'start', ...WORKFLOW.start });
  const pick = WORKFLOW.start.choose.find((c) => holds(c.when, {}));
  assert.ok(pick, `no workflow for status state "${results.status?.state}"`);
  if (pick.fail) throw new Error(pick.fail);
  const wf = WORKFLOW.workflows[pick.workflow];
  log.push(`workflow ${pick.workflow}`);
  for (const s of wf.steps) runStep(s, {});
  assert.ok(holds(wf.done, {}), `workflow ${pick.workflow} finished but its done conditions don't hold: ${JSON.stringify(results.build?.errors)}`);
  return { results, log };
}

// ---------- canned model answers ----------
const SHOP_ARCH = {
  project: { name: 'Shop', summary: 'A small shop: a website where customers see their orders, and the server behind it.' },
  nodes: [
    { id: 'api', label: 'Main server', kind: 'service', summary: 'Keeps orders and answers the website.', paths: ['shop-api/**'] },
    { id: 'web', label: 'Website', kind: 'ui', summary: 'The pages customers use.', paths: ['shop-web/**'] },
  ],
  flows: [{ id: 'remove-customer', title: 'Staff remove a customer', steps: [{ node: 'web', note: 'Staff ask to remove someone.' }, { node: 'shop-api/routes/admin.js', note: 'The server removes them.' }] }],
  tour: [
    { node: 'web', title: 'The website', note: 'Where customers see their orders.' },
    { node: 'api', title: 'The main server', note: 'Everything the website asks for is answered here.' },
    { node: 'shop-web/src/App.jsx', title: 'The orders screen', note: 'The one screen, with a refund button.' },
  ],
};
const calls = [];
const model = {
  architecture({ inputs }) {
    calls.push({ job: 'architecture', inputs });
    // first try: forget the website, so the build reports it unassigned and the driver has to ask again
    if (!inputs['What the last build said about it']) return { ...SHOP_ARCH, nodes: SHOP_ARCH.nodes.slice(0, 1), flows: [], tour: [] };
    return structuredClone(SHOP_ARCH);
  },
  descriptions({ inputs }) {
    assert.match(inputs.Worksheet, /^# Worksheet /, 'the worksheet is given to the model');
    assert.match(inputs["Who you're writing for"], /^Audience: everyone/);
    const d = JSON.parse(inputs['The file to fill in, as it stands']);
    const fill = (k, v) => ({ name: v.name || path.posix.basename(k), description: `Looks after ${k} for the shop.` });
    return { files: Object.fromEntries(Object.entries(d.files).map(([k, v]) => [k, fill(k, v)])), ...(d.routes ? { routes: Object.fromEntries(Object.entries(d.routes).map(([k, v]) => [k, fill(k, v)])) } : {}) };
  },
  recent_work({ inputs }) {
    calls.push({ job: 'recent_work', inputs });
    return { tasks: [{ title: 'Order screens', request: 'Show customers their orders', summary: 'The orders list and refunds are in place.', items: [{ ref: 'shop-api/routes/orders.js', change: 'new', note: 'Lists a customer’s orders and refunds one.' }] }] };
  },
  update_architecture({ inputs, scope }) {
    calls.push({ job: 'update_architecture', code: scope.item.code, inputs });
    const arch = JSON.parse(inputs['The current architecture.json']);
    if (scope.item.code === 'fix_build') arch.flows = [];
    if (scope.item.code === 'assign_new_files') arch.nodes.push({ id: 'scripts', label: 'Scripts', kind: 'script', summary: 'Jobs run by hand.', paths: ['scripts/**'] });
    return arch;
  },
};

// ---------- following the workflow file ----------
let root;
before(() => {
  root = shopApp();
  fs.rmSync(path.join(root, 'floorplan'), { recursive: true }); // a fresh codebase: no map yet
  commitAll(path.join(root, 'shop-api'), 'Add the shop server');
});
after(() => cleanup(root));

test('a whole first map, following workflow.json with canned model answers', () => {
  const { results, log } = drive(root, model);
  assert.ok(log.includes('workflow first_map'), log.join('\n'));
  // the first architecture left the website unassigned; the second try got the build's report
  const arch = calls.filter((c) => c.job === 'architecture');
  assert.equal(arch.length, 2, 'the build check sent the model back once');
  assert.match(arch[1].inputs['What the last build said about it'], /unassigned, by directory[\s\S]*shop-web/);
  assert.match(arch[0].inputs['Scan summary'], /^Floorplan scan of /);
  assert.deepEqual(log.filter((l) => l.startsWith('job descriptions')).sort(), ['job descriptions (api)', 'job descriptions (web)']);
  const b = results.build;
  assert.equal(b.ok, true);
  assert.equal(b.files.unassigned, 0);
  assert.equal(b.descriptions.complete, true);
  assert.deepEqual(b.descriptions.files, { described: 8, total: 8 });
  assert.equal(b.recentWork.cards, 1);
  assert.equal(b.agent, 'none');
  const g = readGraph(root);
  assert.equal(g.meta.agent, 'none');
  assert.ok(g.files.every((f) => !f.auto), 'every file has a description');
  assert.match(readJson(path.join(root, 'floorplan', 'recent-work.json')).updatedAt, /^\d{4}-\d\d-\d\dT/);
});

test('a refresh, following workflow.json: run refresh, then only what NEXT asks', () => {
  // a file a flow points at is deleted (the build fails), a loose script lands outside every part,
  // and an endpoint is added to a described file (its description needs review)
  fs.rmSync(path.join(root, 'shop-api/routes/admin.js'));
  const server = path.join(root, 'shop-api/server.js');
  fs.writeFileSync(server, fs.readFileSync(server, 'utf8').replace(/^import admin.*\n/m, '').replace(/^app\.use\('\/admin'.*\n/m, ''));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/seed.js'), 'export function seed() { return 1; }\n');
  const notes = path.join(root, 'shop-api/routes/notes.js');
  fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace('export default', `router.get('/notes', async (req, res) => { res.json([]); });\nexport default`));
  calls.length = 0;

  // what refresh says on its own, as a driver sees it
  const r = unattended('refresh.mjs', root);
  assert.equal(r.code, 1, 'in unattended mode a refresh whose build failed exits non-zero');
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.next.map((n) => n.code), ['fix_build', 'assign_new_files', 'describe', 'recent_work']);
  assert.ok(r.json.build && r.json.build.ok === false && r.json.build.errors.some((e) => /admin\.js/.test(e)), JSON.stringify(r.json.build?.errors));
  assert.deepEqual(r.json.next[1].directories, [{ dir: 'scripts', files: 1 }]);
  assert.equal(r.json.changes.files.deleted, 1);

  const { results, log } = drive(root, model);
  assert.ok(log.includes('workflow refresh'), log.join('\n'));
  assert.deepEqual(log.filter((l) => l.startsWith('job ')), [
    'job update_architecture (fix_build)',
    'job update_architecture (assign_new_files)',
    'job descriptions (api)',
    'job descriptions (scripts)',
    'job recent_work (recent_work)',
  ], log.join('\n'));
  assert.match(calls[0].inputs['What to do (from the refresh\'s NEXT list)'], /Fix the build errors/);
  assert.match(calls.find((c) => c.job === 'recent_work').inputs['Recent work facts'], /CHANGED SINCE THE PREVIOUS MAP[\s\S]*deleted {2}shop-api\/routes\/admin\.js/);
  const b = results.build;
  assert.equal(b.ok, true);
  assert.equal(b.files.unassigned, 0);
  assert.equal(b.descriptions.complete, true);
  assert.equal(b.descriptions.review, 0, 'the review flag on notes.js was dealt with');
  assert.ok(readGraph(root).routes.some((r) => r.p === '/api/notes' && r.m === 'GET' && !r.auto));

  // and a refresh with nothing new asks only for recent work, then describe has nothing to do
  const again = unattended('refresh.mjs', root);
  assert.equal(again.code, 0);
  assert.deepEqual(again.json.next.map((n) => n.code), ['recent_work']);
  const d = unattended('describe.mjs', root);
  assert.equal(d.code, 0, '"nothing to do" is success');
  assert.equal(d.json.nothingToDo, true);
  assert.deepEqual(d.json.worksheets, []);
});

test('a refresh gives a new file a home even when unassigned files stay under the 10% check', () => {
  // twenty files in one part, then one new file in a folder no part covers: 1 in 21 is under 10%,
  // so the repeat's check already holds, but the new file still deserves a place on the map
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`app/src/m${i}.js`, `export const m${i} = ${i};\n`]));
  const p = makeProject(files, { repos: ['app'] });
  try {
    commitAll(path.join(p, 'app'), 'First version');
    const arch = { project: { name: 'App', summary: 'An app.' }, nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'The app.', paths: ['app/src/**'] }] };
    const fill = ({ inputs }) => {
      const d = JSON.parse(inputs['The file to fill in, as it stands']);
      return { files: Object.fromEntries(Object.keys(d.files).map((k) => [k, { name: path.posix.basename(k), description: `Holds ${k}.` }])) };
    };
    const seen = [];
    const m = {
      architecture: () => structuredClone(arch),
      descriptions: fill,
      recent_work: () => ({ tasks: [] }),
      update_architecture: ({ inputs, scope }) => {
        seen.push(scope.item.code);
        const a = JSON.parse(inputs['The current architecture.json']);
        a.nodes.push({ id: 'tools', label: 'Tools', kind: 'script', summary: 'Jobs run by hand.', paths: ['app/tools/**'] });
        return a;
      },
    };
    drive(p, m);
    fs.mkdirSync(path.join(p, 'app', 'tools'));
    fs.writeFileSync(path.join(p, 'app', 'tools', 'seed.js'), 'export function seed() { return 1; }\n');
    commitAll(path.join(p, 'app'), 'Add a seed script');
    const { results } = drive(p, m);
    assert.deepEqual(seen, ['assign_new_files'], 'one update_architecture job placed the new file');
    assert.equal(results.build.files.unassigned, 0);
  } finally { cleanup(p); }
});

test('a first map hands developer words in labels back to the model once, and never fails over them', () => {
  const JARGON_ARCH = { ...structuredClone(SHOP_ARCH), nodes: [
    { id: 'api', label: 'Express backend', kind: 'service', summary: 'The REST API and its middleware.', paths: ['shop-api/**'] },
    { id: 'web', label: 'React frontend', kind: 'ui', summary: 'The pages customers use.', paths: ['shop-web/**'] },
  ] };
  for (const rewords of [true, false]) {
    const p = shopApp();
    try {
      fs.rmSync(path.join(p, 'floorplan'), { recursive: true });
      const seen = [];
      const m = {
        ...model,
        architecture: ({ inputs }) => {
          seen.push(inputs['What the last build said about it'] || null);
          return structuredClone(seen.length > 1 && rewords ? SHOP_ARCH : JARGON_ARCH);
        },
        recent_work: () => ({ tasks: [] }),
      };
      const { results, log } = drive(p, m);
      assert.equal(seen.length, 2, `the model was asked once more, and only once (${rewords ? 'it rewords' : 'it doesn\'t'})`);
      assert.equal(seen[0], null);
      assert.match(seen[1], /plain language: node "api" uses developer words: "Express backend" in its label[\s\S]*plain language: node "web"/);
      assert.ok(log.includes('run build.mjs → 0'));
      assert.equal(results.build.ok, true);
      assert.equal(results.build.descriptions.complete, true, 'the map was finished either way');
      assert.equal(results.build.plainLanguage.count, rewords ? 0 : 2);
      assert.equal(readJson(path.join(p, 'floorplan', 'architecture.json')).nodes[0].label, rewords ? 'Main server' : 'Express backend');
    } finally { cleanup(p); }
  }
});

// ---------- nothing outside the map folder ----------
/** Every file under root except the map folder (git's own files included), with a hash of its contents. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      if (rel === 'floorplan') continue;
      if (e.isDirectory()) { out[rel + '/'] = 'dir'; walk(p); }
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const OLD_BLOCK = 'Team notes.\n\n<!-- floorplan:start -->\nan old Floorplan section\n<!-- floorplan:end -->\n';

test('unattended mode writes nothing outside floorplan/, even with an old Floorplan section in CLAUDE.md', () => {
  const p = shopApp();
  try {
    fs.writeFileSync(path.join(p, 'CLAUDE.md'), OLD_BLOCK);
    commitAll(path.join(p, 'shop-api'), 'Add the shop server');
    const before = snapshot(p);
    assert.equal(unattended('status.mjs', p).code, 0);
    assert.equal(unattended('scan.mjs', p).code, 0);
    const b = unattended('build.mjs', p);
    assert.equal(b.code, 0);
    assert.match(b.json.notes.claudeLocalMd, /left alone/);
    assert.ok(b.json.wrote.every((f) => f.startsWith('floorplan/')), b.json.wrote.join(', '));
    assert.equal(unattended('describe.mjs', p).code, 0);
    assert.equal(unattended('recent.mjs', p).code, 0);
    // --unattended on the command line reaches the build that refresh runs
    const r = exec('refresh.mjs', p, ['--unattended']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^NEXT/m);
    assert.match(exec('open.mjs', p, [], { env: UNATTENDED }).out, /not starting the map's server/);
    assert.deepEqual(snapshot(p), before, 'nothing outside floorplan/ changed: no CLAUDE.local.md, no .git/info/exclude, CLAUDE.md as it was');
    assert.ok(!fs.existsSync(path.join(p, 'floorplan', '.cache', 'server.json')), 'open.mjs started no server');
  } finally { cleanup(p); }
});

test('without unattended mode the same project behaves as before: the old section moves into CLAUDE.local.md', () => {
  const p = shopApp();
  try {
    fs.writeFileSync(path.join(p, 'CLAUDE.md'), OLD_BLOCK);
    run('scan.mjs', p);
    const out = run('build.mjs', p, '--agent', 'claude');
    assert.match(out, /CLAUDE\.LOCAL\.MD {2}created CLAUDE\.local\.md; moved the Floorplan section out of CLAUDE\.md/);
    assert.equal(fs.readFileSync(path.join(p, 'CLAUDE.md'), 'utf8'), 'Team notes.\n');
    assert.match(fs.readFileSync(path.join(p, 'CLAUDE.local.md'), 'utf8'), /floorplan\/query\.mjs/);
    assert.equal(readGraph(p).meta.agent, 'claude');
  } finally { cleanup(p); }
});

test('unattended mode leaves a map from before the rename (show-code/) where it is', () => {
  const make = () => {
    const p = makeProject({ 'app/index.js': 'export const x = 1;\n' }, { repos: ['app'] });
    writeJson(path.join(p, 'show-code', 'architecture.json'), { project: { name: 'Old' }, nodes: [{ id: 'app', label: 'App', kind: 'service', paths: ['app/**'] }] });
    return p;
  };
  const p = make(), q = make();
  try {
    assert.equal(unattended('scan.mjs', p).code, 0);
    assert.ok(fs.existsSync(path.join(p, 'show-code', 'architecture.json')), 'show-code/ untouched');
    run('scan.mjs', q);
    assert.ok(!fs.existsSync(path.join(q, 'show-code')) && fs.existsSync(path.join(q, 'floorplan', 'architecture.json')), 'without unattended mode it is still moved');
  } finally { cleanup(p); cleanup(q); }
});

// ---------- a map that names no agent ----------
/** The viewer's agent labels, as the built page works them out (run against a pretend window). */
function agentLabels(html, { server, agent }) {
  const code = /const AGENT_ID = [\s\S]*?signIn: 'Run <code>claude<\/code>[^\n]*\n/.exec(html)?.[0];
  assert.ok(code, 'the page works out its agent labels in one place (const AGENT_ID … const AGENT)');
  return vm.runInNewContext(code + '\nAGENT', { window: { FLOORPLAN_SERVER: server }, G: { meta: { agent } } });
}

test('a map made in unattended mode records agent "none", and its page names no agent', () => {
  const p = shopApp();
  try {
    unattended('scan.mjs', p);
    const b = unattended('build.mjs', p);
    assert.equal(b.json.agent, 'none');
    assert.match(b.json.report, /AGENT {2}none/);
    assert.equal(readGraph(p).meta.agent, 'none');
    const html = fs.readFileSync(path.join(p, 'floorplan', 'index.html'), 'utf8');
    assert.match(html, /"agent":"none"/);
    const A = agentLabels(html, { agent: 'none' });
    // what Health's and the blueprint's buttons and hints say: "Fix with …", "paste it into …"
    for (const shown of [`Fix with ${A.name}`, `Build this with ${A.name}`, `Copied. Paste it into ${A.app}.`]) assert.doesNotMatch(shown, /Claude|Codex/, shown);
    assert.equal(A.id, 'none');
    // the map's server, when it runs, still decides: it names the CLI it found
    assert.equal(agentLabels(html, { agent: 'none', server: { engine: 'codex' } }).name, 'Codex');
    // and maps made by Claude Code or Codex are labelled as before
    assert.equal(agentLabels(html, { agent: 'claude' }).name, 'Claude');
    assert.equal(agentLabels(html, { agent: 'codex' }).name, 'Codex');
  } finally { cleanup(p); }
});

test('FLOORPLAN_AGENT=none works on its own, and unattended mode implies it unless an agent is named', async () => {
  const { detectAgent } = await lib('agent.mjs');
  assert.equal(detectAgent({}, { FLOORPLAN_AGENT: 'none' }), 'none');
  assert.equal(detectAgent({}, { FLOORPLAN_UNATTENDED: '1' }), 'none');
  assert.equal(detectAgent({}, { FLOORPLAN_UNATTENDED: '1', CODEX_THREAD_ID: 'x' }), 'none');
  assert.equal(detectAgent({ agent: 'codex' }, { FLOORPLAN_UNATTENDED: '1' }), 'codex');
  assert.equal(detectAgent({}, { FLOORPLAN_UNATTENDED: '0' }), 'claude', 'only a yes switches it on');
  const p = shopApp();
  try {
    run('scan.mjs', p);
    const out = execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'build.mjs'), p], { encoding: 'utf8', env: { ...process.env, FLOORPLAN_AGENT: 'none' } });
    assert.doesNotMatch(out, /CLAUDE\.LOCAL\.MD/, 'a map made without an agent session offers no Claude Code note');
    assert.ok(!fs.existsSync(path.join(p, 'CLAUDE.local.md')));
  } finally { cleanup(p); }
});

// ---------- failing loudly ----------
/** Breaks a repo so git can't list its files: its .git points at a folder that doesn't exist. */
function breakRepo(dir) {
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(dir, 'no-such-git-dir').replace(/\\/g, '/')}\n`);
}

test('a repo git cannot list: the scan says so for everyone, and fails in unattended mode', () => {
  const p = shopApp();
  try {
    breakRepo(path.join(p, 'shop-web'));
    const plain = exec('scan.mjs', p);
    assert.equal(plain.code, 0, 'without unattended mode the scan still finishes');
    assert.match(plain.out, /! PROBLEMS \(1\)[\s\S]*shop-web adds no files to the map: git could not read this repo/);
    assert.match(plain.out, /shop-web +0 files .*! git could not list its files/);
    fs.rmSync(path.join(p, 'floorplan', '.cache'), { recursive: true });

    const r = unattended('scan.mjs', p);
    assert.equal(r.code, 1, 'unattended mode fails instead of making a map without shop-web');
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.problems.map((x) => [x.code, x.repo]), [['git_failed', 'shop-web']]);
    assert.match(r.json.errors[0], /^shop-web adds no files to the map: git could not read this repo \(fatal: /);
    assert.ok(!fs.existsSync(path.join(p, 'floorplan', '.cache', 'scan.json')), 'no scan written');
    const text = exec('scan.mjs', p, [], { env: UNATTENDED });
    assert.equal(text.code, 1);
    assert.match(text.err, /✗ shop-web adds no files to the map: git could not read this repo/);
  } finally { cleanup(p); }
});

test('git missing altogether: unattended mode names the cause', () => {
  const p = shopApp();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-nogit-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
    const r = exec('scan.mjs', p, ['--json'], { baseEnv: { ...env, PATH: empty }, env: UNATTENDED });
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /shop-api adds no files to the map: git is not installed here, or not on PATH/);
  } finally { cleanup(p); cleanup(empty); }
});

test('"dubious ownership" is explained with the command that fixes it', async () => {
  const { explainGitError } = await lib('common.mjs');
  const msg = explainGitError("fatal: detected dubious ownership in repository at '/work/app'", '/work/app');
  assert.match(msg, /different user owns the folder/);
  assert.match(msg, /git config --global --add safe\.directory "\/work\/app"/);
});

test('no files at all: unattended mode fails, and the plain scan says so', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-empty-'));
  try {
    const r = unattended('scan.mjs', p);
    assert.equal(r.code, 1);
    assert.deepEqual(r.json.problems.map((x) => x.code), ['no_files']);
    assert.match(exec('scan.mjs', p).out, /! No files found under/);
  } finally { cleanup(p); }
});

test('a refresh whose scan fails exits non-zero in unattended mode, with NEXT fix_scan', () => {
  const p = shopApp();
  try {
    run('scan.mjs', p); run('build.mjs', p, '--no-claude-md');
    breakRepo(path.join(p, 'shop-web'));
    const r = unattended('refresh.mjs', p);
    assert.equal(r.code, 1);
    assert.deepEqual(r.json.next.map((n) => n.code), ['fix_scan']);
    assert.match(r.json.errors[0], /shop-web/);
  } finally { cleanup(p); }
});

// ---------- exit codes: unattended mode is reliable, everyone else sees no change ----------
test('refresh exit codes: unattended mode fails on no map and on a failed build; default mode still exits 0', () => {
  const p = shopApp();
  try {
    // no map yet
    assert.equal(exec('refresh.mjs', p).code, 0, 'default: no map is not an error');
    const none = unattended('refresh.mjs', p);
    assert.equal(none.code, 1);
    assert.equal(none.json.map, false);
    assert.deepEqual(none.json.next.map((n) => n.code), ['first_map']);

    // a map whose build will fail: a flow points at a file that's then deleted
    const arch = readJson(path.join(p, 'floorplan', 'architecture.json'));
    writeJson(path.join(p, 'floorplan', 'architecture.json'), { ...arch, flows: [{ id: 'f', title: 'Notes', steps: [{ node: 'web', note: 'a' }, { node: 'shop-api/routes/notes.js', note: 'b' }] }] });
    run('scan.mjs', p); run('build.mjs', p, '--no-claude-md');
    fs.rmSync(path.join(p, 'shop-api/routes/notes.js'));
    const plain = exec('refresh.mjs', p);
    assert.equal(plain.code, 0, 'default: the failed build is a NEXT item, not an exit code');
    assert.match(plain.out, /^NEXT\n {2}1\. Fix the build errors above/m);
    assert.equal(tryJson(plain.out), undefined, 'default output is the human report');
    const failed = unattended('refresh.mjs', p);
    assert.equal(failed.code, 1);
    assert.equal(failed.json.next[0].code, 'fix_build');
    assert.equal(failed.json.build.ok, false);
    // --json alone changes only what's printed
    assert.equal(exec('refresh.mjs', p, ['--json']).code, 0);
  } finally { cleanup(p); }
});

test('build --json reports errors as data, and exits 1 like the plain build', () => {
  const p = shopApp();
  try {
    run('scan.mjs', p);
    writeJson(path.join(p, 'floorplan', 'architecture.json'), { project: { name: 'Shop' }, nodes: [{ id: 'api', label: 'Server', kind: 'server', paths: ['shop-api/**'] }] });
    const r = unattended('build.mjs', p);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.errors[0], /kind "server" must be one of ui, service/);
    assert.deepEqual(r.json.wrote, []);
    assert.match(r.json.report, /Fix the errors above and run build again\.$/);
    fs.writeFileSync(path.join(p, 'floorplan', 'architecture.json'), '{ not json');
    const bad = unattended('build.mjs', p);
    assert.equal(bad.code, 1);
    assert.match(bad.json.errors[0], /architecture\.json is not valid JSON/);
  } finally { cleanup(p); }
});

test('--json and --unattended never swallow the codebase root that follows them', async () => {
  const { parseArgs } = await lib('common.mjs');
  assert.deepEqual(parseArgs(['--json', '/work/app', '--unattended', '--days', '3']), { _: ['/work/app'], json: true, unattended: true, days: '3' });
});

// ---------- the workflow file itself ----------
/** Every step anywhere in the file, with where it is. */
function allSteps() {
  const out = [];
  const walk = (steps, where) => steps.forEach((s) => { out.push({ s, where: `${where} → ${s.id}` }); if (s.repeat) walk(s.repeat, `${where} → ${s.id}`); });
  for (const [n, w] of Object.entries(WORKFLOW.workflows)) walk(w.steps, `workflows.${n}`);
  for (const [n, steps] of Object.entries(WORKFLOW.procedures)) walk(steps, `procedures.${n}`);
  return out;
}

test('workflow.json: every script, reference file, job, schema and procedure it names exists', () => {
  assert.equal(WORKFLOW.schema, 'floorplan/workflow@1');
  const scripts = fs.readdirSync(path.join(SKILL, 'scripts')).filter((n) => n.endsWith('.mjs'));
  const runs = [{ s: WORKFLOW.start, where: 'start' }, ...allSteps()].filter((x) => x.s.run);
  assert.ok(runs.length >= 5);
  for (const { s, where } of runs) {
    assert.ok(scripts.includes(s.run), `${where}: scripts/${s.run} doesn't exist`);
    assert.ok(s.args.includes('--json'), `${where}: every script step passes --json, so its output can be read`);
  }
  for (const { s, where } of allSteps()) {
    if (s.job) assert.ok(WORKFLOW.jobs[s.job], `${where}: no job "${s.job}"`);
    if (s.use) assert.ok(WORKFLOW.procedures[s.use] || WORKFLOW.workflows[s.use], `${where}: no procedure or workflow "${s.use}"`);
    if (s.repeat) assert.ok(s.until?.length && s.maxAttempts > 0 && s.failMessage, `${where}: a repeat needs until, maxAttempts and failMessage`);
    for (const h of Object.values(s.handlers || {})) if (typeof h === 'string') assert.ok(WORKFLOW.procedures[h] || WORKFLOW.workflows[h], `${where}: no handler "${h}"`);
  }
  for (const c of WORKFLOW.start.choose) assert.ok(c.fail || WORKFLOW.workflows[c.workflow], `start: no workflow "${c.workflow}"`);
  for (const [name, job] of Object.entries(WORKFLOW.jobs)) {
    for (const ref of job.read) assert.ok(fs.existsSync(path.join(SKILL, ref)), `jobs.${name} reads ${ref}, which doesn't exist`);
    assert.ok(WORKFLOW.schemas[job.schema], `jobs.${name}: every model job has an answer schema (schemas.${job.schema} is missing)`);
    assert.ok(job.writes && job.instructions.length && job.input.length, `jobs.${name} needs writes, instructions and input`);
    for (const inp of job.input) assert.ok(inp.name && (inp.from || inp.file), `jobs.${name}: each input has a name and a from or file`);
    assert.doesNotMatch(job.instructions.join('\n'), /\bask the user\b|conversation with/i, `jobs.${name}: there's nobody to ask`);
  }
});

test('workflow.json handles every NEXT code refresh.mjs can print, and every status state', () => {
  const src = fs.readFileSync(path.join(SKILL, 'scripts', 'refresh.mjs'), 'utf8');
  const codes = [...new Set([...src.matchAll(/code: '(\w+)'/g)].map((m) => m[1]))].sort();
  assert.ok(codes.length >= 8, codes.join(', '));
  const handlers = allSteps().find((x) => x.s.next).s.handlers;
  assert.deepEqual(Object.keys(handlers).sort(), codes, 'a new NEXT code in refresh.mjs needs a handler in workflow.json (and a line in docs/unattended.md)');
  const status = fs.readFileSync(path.join(SKILL, 'scripts', 'status.mjs'), 'utf8');
  const states = [...new Set([...status.matchAll(/'(none|unbuilt|blueprint-started|blueprint|map|unknown)'/g)].map((m) => m[1]))].sort();
  const covered = WORKFLOW.start.choose.flatMap((c) => c.when[0].value).sort();
  assert.deepEqual(covered, states);
});

test("workflow.json's answers keep their shape: the files a model writes are the ones existing drivers expect", () => {
  const S = WORKFLOW.schemas;
  assert.deepEqual(Object.keys(S).sort(), ['architecture', 'descriptions', 'recent_work']);
  assert.deepEqual(Object.keys(S.architecture.properties).sort(), ['$schema', 'annotations', 'audience', 'edges', 'flows', 'ignore', 'include', 'nodes', 'project', 'tour']);
  assert.deepEqual(Object.keys(S.architecture.properties.nodes.items.properties).sort(), ['details', 'exclude', 'hosts', 'id', 'kind', 'label', 'packages', 'parent', 'paths', 'summary', 'tags']);
  for (const k of ['files', 'routes']) assert.deepEqual(S.descriptions.properties[k].additionalProperties, { type: 'object', required: ['name', 'description'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 }, review: { type: 'string' } } });
  assert.deepEqual(S.recent_work.properties.tasks.items.required, ['title', 'request', 'summary', 'items']);
  // the descriptions job is told to say what the code does today, and the build's words reach the architecture job
  assert.match(WORKFLOW.jobs.descriptions.instructions.join('\n'), /Say what it does today/);
  assert.match(WORKFLOW.jobs.architecture.instructions.join('\n'), /"plain language:" warning/);
});

test("workflow.json's answer schemas use only the keywords it promises, and accept real files", () => {
  for (const [name, schema] of Object.entries(WORKFLOW.schemas)) assert.deepEqual(keywordsUsed(schema), [], `schemas.${name} uses a keyword the conventions don't list`);
  const ok = (name, value, what) => assert.deepEqual(validate(WORKFLOW.schemas[name], value), [], `schemas.${name} rejects ${what}`);
  // the sample shop's architecture, and the full example in references/schema.md
  ok('architecture', SHOP_ARCH, 'the sample architecture');
  const p = shopApp();
  try { ok('architecture', readJson(path.join(p, 'floorplan', 'architecture.json')), "the test helpers' sample architecture"); } finally { cleanup(p); }
  const ref = fs.readFileSync(path.join(SKILL, 'references', 'schema.md'), 'utf8');
  ok('architecture', JSON.parse(/## Full example[\s\S]*?```json\n([\s\S]*?)```/.exec(ref)[1]), 'the full example in schema.md');
  ok('recent_work', JSON.parse(/## recent work[\s\S]*?```json\n([\s\S]*?)```/i.exec(ref)[1]), 'the recent-work example in schema.md');
  const guide = fs.readFileSync(path.join(SKILL, 'references', 'writing-descriptions.md'), 'utf8');
  ok('descriptions', JSON.parse(/```json\n([\s\S]*?)```/.exec(guide)[1]), 'the example in writing-descriptions.md');
  // the files the workflow run above wrote, and a description refresh.mjs flagged for review
  const map = path.join(root, 'floorplan');
  ok('architecture', readJson(path.join(map, 'architecture.json')), 'the architecture.json the run wrote');
  for (const f of fs.readdirSync(path.join(map, 'descriptions'))) ok('descriptions', readJson(path.join(map, 'descriptions', f)), `descriptions/${f}`);
  ok('recent_work', readJson(path.join(map, 'recent-work.json')), 'the recent-work.json the run wrote');
  ok('descriptions', { files: { 'a.js': { name: 'A', description: 'Does a.', review: 'new exports: b' } } }, 'an entry flagged for review');
  // and they do say no
  assert.notDeepEqual(validate(WORKFLOW.schemas.architecture, { project: { name: 'X' }, nodes: [{ id: 'a', label: 'A', kind: 'server' }] }), []);
  assert.notDeepEqual(validate(WORKFLOW.schemas.descriptions, { files: { 'a.js': { name: 'A' } } }), []);
  assert.notDeepEqual(validate(WORKFLOW.schemas.recent_work, { tasks: [{ title: 'T', summary: 'S', items: [{ ref: 'a.js', change: 'moved', note: 'n' }] }] }), []);
});
