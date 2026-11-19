// Serverless Framework: endpoints declared in serverless.yml (not in code) are placed in the file that
// answers them, through ${file(...)} includes, short and long event forms, and a handler that only wraps
// another file's function; the website's requests reach them, and Health reads their authorizers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { parseYaml, serverlessRoutes } = await lib('serverless.mjs');

let root, graph, summary;
before(() => {
  root = makeProject({}, { arch: {
    project: { name: 'serverless-app', summary: 'Test fixture.' },
    nodes: [
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      { id: 'api', label: 'API', kind: 'service', summary: 'The functions behind the website.', paths: ['api/**'] },
    ],
  } });
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'serverless-app'), root, { recursive: true });
  summary = run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

const where = (m, p) => { const r = graph.routes.find((x) => x.m === m && x.p === p); return r && `${r.f}:${r.l}`; };

test('endpoints come from serverless.yml and the files it includes, in short and long forms', () => {
  assert.deepEqual(routeKeys(graph), [
    'ANY /tasks/{id}/share', 'DELETE /account', 'DELETE /tasks/{id}', 'GET /', 'GET /status', 'GET /tasks',
    'POST /account/email', 'POST /account/signup', 'POST /admin/tasks/import', 'POST /tasks', 'POST /tasks/import',
  ]);
});

test("each endpoint sits in its handler's file, on the export's line", () => {
  assert.equal(where('GET', '/tasks'), 'api/src/tasks.ts:5');
  assert.equal(where('DELETE', '/tasks/{id}'), 'api/src/tasks.ts:9');
  assert.equal(where('GET', '/status'), 'api/src/status.ts:1');
  assert.equal(where('ANY', '/tasks/{id}/share'), 'api/src/share.ts:3');
});

test('a handler that only wraps another file’s function leads to that function', () => {
  // signUp = (event) => withEvent(event, opts, checkInput, accounts.registerUser): the last argument does the work
  assert.equal(where('POST', '/account/signup'), 'api/src/accounts.ts:2');
  // changeEmail hands on accounts.changeEmail: the same name in another file
  assert.equal(where('POST', '/account/email'), 'api/src/accounts.ts:7');
  assert.equal(graph.routes.find((r) => r.p === '/account/signup').h, 'registerUser');
});

test("the website's requests reach the serverless endpoints", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${[...l.labels].sort().join(', ')}`).sort();
  assert.deepEqual(http, [
    'web/src/api.ts -> api/src/accounts.ts POST /account/signup',
    'web/src/api.ts -> api/src/tasks.ts DELETE /tasks/{id}, GET /tasks',
  ]);
});

test('Health: an authorizer, an API key, a check handed to the wrapper or one in the handler protects an endpoint; none leaves it open', () => {
  // changeEmail's wrapper is given requireUser; signUp's only checkInput, and a sign-up page is public anyway.
  // deleteUser's own name sounds like a check but isn't one; importAll answers at two addresses, and only
  // /tasks/import is behind an API key
  assert.deepEqual(openEndpoints(graph), ['DELETE /account', 'DELETE /tasks/{id}', 'POST /admin/tasks/import']);
  const checked = graph.health.checked.find((c) => c.check === 'endpoints');
  assert.equal(checked.checked, true, checked.text);
  assert.match(checked.text, /11 endpoints/);
});

test('background functions are listed in the scan summary', () => {
  assert.match(summary, /SERVERLESS {2}11 endpoints from 1 config file\(s\) \(api\/serverless\.yml\), 3 behind an authorizer or API key, 2 background/);
  assert.match(summary, /nightlyCleanup {2}schedule "rate\(1 day\)" {2}api\/src\/jobs\.ts:2/);
  assert.match(summary, /nightlyCleanup {2}sqs {2}api\/src\/jobs\.ts:2/);
});

test('YAML: CloudFormation tags, variables, anchors, flow lists and text blocks are read without failing', () => {
  const doc = parseYaml([
    'base: &base',
    '  memorySize: 256',
    'fn:',
    '  <<: *base',
    '  handler: src/a.run',
    '  role: !GetAtt [Role, Arn]',
    '  env: !Sub "arn:${AWS::Region}:x"',
    '  stage: ${opt:stage, "dev"}',
    '  list: [a, "b, c", { k: v }]',
    '  note: |',
    '    text: that looks like a key',
    '    - and a list',
    '  joined: !Join',
    "    - ''",
    '    - - a',
    '      - b',
    'after: yes # a comment',
  ].join('\n'));
  assert.equal(doc.fn.memorySize, 256);
  assert.equal(doc.fn.role, '!GetAtt [Role, Arn]');
  assert.equal(doc.fn.stage, '${opt:stage, "dev"}');
  assert.deepEqual(doc.fn.list, ['a', 'b, c', { k: 'v' }]);
  assert.equal(doc.fn.note, '');
  assert.deepEqual(doc.fn.joined, ['', ['a', 'b']]);
  assert.equal(doc.after, 'yes');
  // nonsense is text, never an error
  for (const junk of ['{ unclosed', '- - - :', ': : :', '"open quote', '&a *b !c', '\t\tkey:\n  - x\n y: [']) assert.doesNotThrow(() => parseYaml(junk));
});

test('YAML: stray brackets and very long lines are read quickly, never forever', { timeout: 10000 }, () => {
  for (const junk of ['key: [}]', 'key: {]}', 'cors: { origin: * ] }', 'k: [[[}}}]]]', 'k: {{{]]]}}}']) assert.doesNotThrow(() => parseYaml(junk));
  const t0 = Date.now();
  parseYaml(['a' + ' '.repeat(200000) + 'b', 'k' + ':x'.repeat(100000), 'key: ' + '['.repeat(5000)].join('\n'));
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.deepEqual(parseYaml('Fn::ImportValue: x\n"quoted key": y\n-dash: z'), { 'Fn::ImportValue': 'x', 'quoted key': 'y', '-dash': 'z' });
});

test('includes that loop back, handlers that are missing, and events without an address are skipped', () => {
  const src = {
    'serverless.yml': 'functions:\n  - ${file(./a.yml)}\n  - gone:\n      handler: src/missing.run\n      events:\n        - http: GET /gone\n  - odd:\n      handler: src/ok.run\n      events:\n        - http:\n            method: get\n        - httpApi: ${self:custom.route}\n        - http: POST /ok',
    'a.yml': 'loop: ${file(./serverless.yml):functions}',
    'src/ok.ts': 'export const run = async () => ({});',
  };
  const files = Object.keys(src).map((p) => ({ path: p, symbols: p.endsWith('.ts') ? [{ name: 'run', line: 1 }] : [] }));
  const out = serverlessRoutes(files, (p) => src[p] || '');
  assert.deepEqual(out.routes.map((r) => `${r.method} ${r.path} ${r.file}`), ['POST /ok src/ok.ts']);
  assert.deepEqual(out.unresolved.map((u) => u.name), ['gone']);
});

test('a sample config in a test folder, and one too big for the scan to read, add no endpoints', () => {
  const yml = 'functions:\n  list:\n    handler: src/ok.run\n    events:\n      - http: GET /items\n';
  const src = { 'serverless.yml': yml, 'tests/fixtures/serverless.yml': yml, 'e2e/serverless-e2e.yml': yml, 'big/serverless.yml': yml, 'src/ok.ts': 'export const run = async () => ({});', 'big/src/ok.ts': 'export const run = async () => ({});' };
  const files = Object.keys(src).map((p) => ({ path: p, symbols: p.endsWith('.ts') ? [{ name: 'run', line: 1 }] : [], ...(p === 'big/serverless.yml' ? { tooLarge: true } : {}) }));
  const out = serverlessRoutes(files, (p) => src[p] || '');
  assert.deepEqual(out.routes.map((r) => `${r.method} ${r.path} ${r.config}`), ['GET /items serverless.yml']);
  assert.deepEqual(out.configs, ['serverless.yml']);
});
