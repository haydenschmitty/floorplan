// Blueprints: a map planned from a PRD before any code exists. plan.mjs turns floorplan/plan.json
// into a scan, and build.mjs draws it like a code map, with a design review instead of the code checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, makeProject, run, readGraph, readJson, writeJson, routeKeys, cleanup } from './helpers.mjs';

const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'blueprint');
let root, graph, planOut, buildOut;
before(() => {
  root = makeProject({});
  fs.cpSync(FIXTURE, root, { recursive: true });
  planOut = run('plan.mjs', root);
  buildOut = run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

/** A copy of the sample with plan.json changed, for the error cases. */
function withPlan(change) {
  const r = makeProject({});
  fs.cpSync(FIXTURE, r, { recursive: true });
  const file = path.join(r, 'floorplan', 'plan.json');
  const plan = readJson(file);
  change(plan);
  writeJson(file, plan);
  return r;
}
const fails = (fn) => { try { fn(); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } assert.fail('expected the script to fail'); };

test('the planned files and endpoints are on the map, named as the plan names them', () => {
  assert.match(planOut, /BLUEPRINT {2}21 planned files · 11 endpoints · 9 calls to planned endpoints · 5 links to services and data/);
  assert.equal(graph.files.length, 21);
  assert.equal(graph.files.filter((f) => f.auto).length, 0, 'every file is described');
  assert.equal(graph.routes.length, 11);
  assert.equal(graph.files.find((f) => f.p === 'web/app/page.tsx').name, 'Home page');
  const book = graph.routes.find((r) => r.m === 'POST' && r.p === '/api/bookings');
  assert.equal(book.name, 'Book a walk');
  assert.equal(book.access, 'signed-in');
  assert.deepEqual(graph.meta.blueprint.stack.slice(0, 2), ['Next.js websites for owners and walkers', 'Node.js + Express server']);
  assert.equal(graph.meta.blueprint.source, 'docs/prd.md');
  assert.match(buildOut, /DESCRIPTIONS {2}files 21\/21 · routes 11\/11/);
  assert.match(buildOut, /BLUEPRINT {2}planned, not built yet/);
});

test('screens call endpoints, and files reach outside services and the database', () => {
  const http = graph.links.filter((l) => l.k === 'http' && l.labels?.length && l.a.startsWith('f:web/app/bookings')).map((l) => `${l.b.slice(2)} ${l.labels.join(', ')}`);
  assert.deepEqual(http, ['api/src/routes/bookings.ts GET /api/bookings, POST /api/bookings/:id/cancel']);
  const toNodes = graph.links.filter((l) => l.b.startsWith('n:')).map((l) => `${l.a.slice(2)} ${l.k} ${l.b.slice(2)}`).sort();
  assert.deepEqual(toNodes, [
    'api/src/db/bookings.ts data db', 'api/src/db/users.ts data db', 'api/src/db/walkers.ts data db',
    'api/src/services/email.ts http postmark', 'api/src/services/payments.ts http stripe',
  ]);
});

test('blueprint builds report that files are planned under both coding agents', async (t) => {
  for (const agent of ['codex', 'claude']) {
    await t.test(agent, () => {
      const r = makeProject({});
      try {
        fs.cpSync(FIXTURE, r, { recursive: true });
        run('plan.mjs', r, '--agent', agent);
        const output = run('build.mjs', r, '--agent', agent, '--claude-md');
        assert.equal(readGraph(r).meta.agent, agent);
        assert.match(output, /BLUEPRINT {2}planned, not built yet/);
        if (agent === 'codex') assert.match(output, /AGENT {2}Codex/);
        assert.doesNotMatch(output, /CLAUDE\.LOCAL\.MD/);
        assert.ok(!fs.existsSync(path.join(r, 'CLAUDE.local.md')), 'blueprints do not add project notes');
      } finally { cleanup(r); }
    });
  }
});

test('Screens show what each planned page relies on, down to Stripe', () => {
  assert.deepEqual(graph.screens.map((s) => s.url).sort(), ['/', '/book/:walkerId', '/bookings', '/login', '/schedule']);
  const book = graph.screens.find((s) => s.url === '/book/:walkerId');
  const behind = book.behind.map((b) => `${b.kind} ${b.id}`);
  assert.ok(behind.includes('server f:api/src/routes/bookings.ts'));
  assert.ok(behind.includes('outside n:stripe'));
});

test('Health is a design review of the plan', () => {
  const issues = graph.health.issues;
  const titles = issues.map((i) => `${i.severity} ${i.title}`);
  assert.deepEqual(titles, [
    'medium Anyone could change data through one planned endpoint',
    'medium The plan doesn’t say who may use one endpoint',
    'medium Can owners cancel a walk for free, and up to when?',
    'low Nothing in the plan uses one endpoint',
    'low One planned file isn’t connected to anything',
  ]);
  const routesOf = (i) => i.items.filter((id) => id.startsWith('r:')).map((id) => `${graph.routes[+id.slice(2)].m} ${graph.routes[+id.slice(2)].p}`).sort();
  // sign-in is open on purpose (publicBecause says why), so only sign-up is flagged
  assert.deepEqual(routesOf(issues[0]), ['POST /api/auth/signup']);
  assert.deepEqual(routesOf(issues[1]), ['DELETE /api/walkers/:id']);
  assert.deepEqual(issues[2].items.sort(), ['f:web/app/bookings/page.tsx', `r:${graph.routes.findIndex((r) => r.p === '/api/bookings/:id/cancel')}`].sort());
  assert.deepEqual(routesOf(issues[3]), ['DELETE /api/walkers/:id']);
  assert.deepEqual(issues[4].items, ['f:api/src/lib/geo.ts']);
  assert.match(issues[0].fix, /floorplan\/plan\.json/);
  // each item also has a request to settle it from the map, for the person to finish or edit
  assert.deepEqual(issues.map((i) => i.change), [
    'Review who may use POST /api/auth/signup: anyone can change data through it now. ',
    'Decide who may use DELETE /api/walkers/:id, going by the PRD. ',
    'Open question: "Can owners cancel a walk for free, and up to when?" My answer: ',
    'Nothing calls DELETE /api/walkers/:id. Add the screen or service that should use it, or remove it if not needed. ',
    'api/src/lib/geo.ts isn’t connected to anything. Connect it to what should use it, or remove it. ',
  ]);
  assert.match(buildOut, /DESIGN REVIEW {2}0 important · 3 worth fixing · 2 minor/);
});

test('the map page marks it as a blueprint, and Ask knows there is no code to read', () => {
  const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.ok(html.includes('/* ui/06-blueprint.js */'));
  assert.ok(html.includes('"blueprint":{"source":"docs/prd.md"'));
  const query = fs.readFileSync(path.join(root, 'floorplan', 'query.mjs'), 'utf8');
  assert.ok(query.includes('This map is a blueprint'));
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.local.md')));
});

test('an endpoint says which signed-in people may use it', () => {
  const r = graph.routes.find((x) => x.p === '/api/walker/schedule');
  assert.equal(r.access, 'signed-in');
  assert.equal(r.who, 'walkers');
  assert.match(graph.routes.find((x) => x.p === '/api/auth/login').publicBecause, /sign in before they are signed in/);
});

test('a project holding only plan.json can be planned before architecture.json exists', () => {
  const r = makeProject({ 'PRD.md': '# A plan' });
  try {
    fs.mkdirSync(path.join(r, 'floorplan'));
    fs.copyFileSync(path.join(FIXTURE, 'floorplan', 'plan.json'), path.join(r, 'floorplan', 'plan.json'));
    assert.match(run('status.mjs', r), /a blueprint was started \(plan\.json\) but never drawn/);
    assert.match(run('plan.mjs', r), /run build\.mjs once floorplan\/architecture\.json is written/);
  } finally { cleanup(r); }
});

test('plan.mjs names what is wrong with a plan', () => {
  const r = withPlan((p) => {
    p.files[0].uses.push('web/components/WalkerCrad.tsx');
    p.endpoints[0].access = 'everyone';
    p.endpoints[1].file = 'api/src/routes/walker.ts';
    p.files[1].calls.push('POST /api/payments');
    p.files[2].calls.push('cancel it');
    p.endpoints[2].access = 'staff';
    p.files.find((f) => f.services).services = ['strpe'];
  });
  try {
    const out = fails(() => run('plan.mjs', r));
    assert.match(out, /files "web\/app\/page\.tsx"\.uses "web\/components\/WalkerCrad\.tsx" is not one of the planned files/);
    assert.match(out, /access "everyone" must be one of public, signed-in, team, webhook, internal/);
    assert.match(out, /\.file "api\/src\/routes\/walker\.ts" is not one of the planned files/);
    assert.match(out, /calls "cancel it" must look like "POST \/api\/orders"/);
    assert.match(out, /calls "POST \/api\/payments" matches no planned endpoint/);
    assert.match(out, /access "staff" must be one of .* \("team" is your own team; for some of the app’s users, use "signed-in" with "who"\)/);
    assert.match(out, /services "strpe" is not a node id in architecture\.json \(did you mean "stripe"\?\)/);
  } finally { cleanup(r); }
});

test('build.mjs catches a service that is not a node', () => {
  const r = withPlan((p) => { p.files.find((f) => f.services).services = ['strpe']; });
  try {
    // plan.mjs checks this when architecture.json exists; without it, the build is the safety net
    const arch = path.join(r, 'floorplan', 'architecture.json'), saved = fs.readFileSync(arch);
    fs.rmSync(arch);
    run('plan.mjs', r);
    fs.writeFileSync(arch, saved);
    const out = fails(() => run('build.mjs', r, '--no-claude-md'));
    assert.match(out, /error\(s\) in floorplan.architecture\.json or plan\.json/);
    assert.match(out, /names "strpe" in its services, which is not a node id in architecture\.json — did you mean "stripe"\?/);
  } finally { cleanup(r); }
});

test('plan.mjs --out stages the scan elsewhere and leaves the live map alone', () => {
  const r = withPlan(() => {});
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-stage-'));
  try {
    run('plan.mjs', r);
    run('build.mjs', r, '--no-claude-md');
    const liveScan = fs.readFileSync(path.join(r, 'floorplan', '.cache', 'scan.json'), 'utf8');
    fs.copyFileSync(path.join(r, 'floorplan', 'plan.json'), path.join(stage, 'plan.json'));
    fs.copyFileSync(path.join(r, 'floorplan', 'architecture.json'), path.join(stage, 'architecture.json'));
    const out = run('plan.mjs', r, '--out', stage, '--plan', path.join(stage, 'plan.json'));
    assert.match(out, /wrote .*change|wrote /);
    assert.ok(fs.existsSync(path.join(stage, '.cache', 'scan.json')));
    assert.equal(fs.readFileSync(path.join(r, 'floorplan', '.cache', 'scan.json'), 'utf8'), liveScan);
    assert.match(run('build.mjs', r, '--out', stage, '--check'), /ASSIGNMENT/);
    assert.ok(!fs.existsSync(path.join(stage, 'index.html')), '--check writes nothing');
  } finally {
    cleanup(r);
    cleanup(stage);
  }
});

test('refresh redraws a blueprint from plan.json, and --from-code maps the real code instead', () => {
  const r = withPlan(() => {});
  try {
    run('plan.mjs', r);
    run('build.mjs', r, '--no-claude-md');
    assert.match(run('status.mjs', r), /a blueprint \(planned, not built, from docs\/prd\.md\)/);
    const plan = readJson(path.join(r, 'floorplan', 'plan.json'));
    plan.endpoints.push({ method: 'GET', path: '/api/health', file: 'api/src/server.ts', name: 'Health check', access: 'public' });
    writeJson(path.join(r, 'floorplan', 'plan.json'), plan);
    assert.match(run('refresh.mjs', r, '--no-claude-md'), /redrawn from floorplan\/plan\.json/);
    assert.ok(routeKeys(readGraph(r)).includes('GET /api/health'));

    fs.mkdirSync(path.join(r, 'api', 'src'), { recursive: true });
    fs.writeFileSync(path.join(r, 'api', 'src', 'server.ts'), `import express from 'express';\nconst app = express();\napp.get('/api/health', (req, res) => res.send('ok'));\napp.listen(3000);\n`);
    // the blueprint's flows point at files that aren't written yet, so the map of the code gets its own
    writeJson(path.join(r, 'floorplan', 'architecture.json'), { project: { name: 'Pawprint', summary: 'Being built.' }, nodes: [{ id: 'api', label: 'Main server', kind: 'service', summary: 'The server.', paths: ['api/**'] }] });
    run('refresh.mjs', r, '--from-code', '--no-claude-md');
    const g = readGraph(r);
    assert.equal(g.meta.blueprint, undefined);
    assert.deepEqual(routeKeys(g), ['GET /api/health']);
    assert.ok(fs.existsSync(path.join(r, 'floorplan', 'plan.json')), 'the plan is kept');
  } finally { cleanup(r); }
});
