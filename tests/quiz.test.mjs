// The Quiz: starter questions written in architecture.json are checked by the build and kept in the map
// (and in an export with flows and the tour), and More questions asks the agent in its own quiz mode,
// held to the quiz schema. Stand-in CLIs (fixtures/fake-cli) record what they were given.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { REPO, shopApp, run, readJson, writeJson, readGraph, cleanup } from './helpers.mjs';

const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-cli');
const QUIZ = [
  { question: 'Which part keeps track of orders?', choices: ['Website', 'Server'], answer: 'Server', node: 'api', explain: 'The server stores orders and answers the website.' },
  { question: 'Where do refunds start?', choices: ['The orders file', 'The website', 'The notes file'], answer: 'The orders file', node: 'shop-api/routes/orders.js', explain: 'It holds the refund endpoint.' },
];
let root, arch, server;
const archFile = () => path.join(root, 'floorplan', 'architecture.json');
/** Builds with this quiz; returns { ok, out } instead of throwing when the build reports problems. */
function buildWith(quiz) {
  writeJson(archFile(), { ...arch, quiz });
  try { return { ok: true, out: run('build.mjs', root, '--no-claude-md', '--agent', 'claude') }; }
  catch (e) { return { ok: false, out: `${e.stdout}${e.stderr}` }; }
}

before(() => { root = shopApp(); arch = readJson(archFile()); run('scan.mjs', root); });
after(async () => {
  // wait for the server to exit first: on Windows its working folder can't be removed while it runs
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  cleanup(root);
});

test('starter questions are kept in the map, each pointing at the card that shows the answer', () => {
  const r = buildWith(QUIZ);
  assert.ok(r.ok, r.out);
  assert.deepEqual(readGraph(root).quiz, [
    { q: QUIZ[0].question, choices: QUIZ[0].choices, answer: 'Server', ref: 'n:api', explain: QUIZ[0].explain },
    { q: QUIZ[1].question, choices: QUIZ[1].choices, answer: 'The orders file', ref: 'f:shop-api/routes/orders.js', explain: QUIZ[1].explain },
  ]);
  const html = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.match(html, /\/\* ui\/45-quiz\.js \*\//);
});

test('a map without a quiz still builds, with an empty one', () => {
  writeJson(archFile(), arch);
  run('build.mjs', root, '--no-claude-md');
  assert.deepEqual(readGraph(root).quiz, []);
});

test('the build leaves out each broken question and says why, without failing the map', () => {
  const r = buildWith([
    { ...QUIZ[0], answer: 'Database' },
    { ...QUIZ[0], choices: ['Server', 'Server'] },
    { ...QUIZ[0], choices: ['Server'] },
    { ...QUIZ[0], node: 'shop-api/routes/gone.js' }, // a file renamed or deleted since the quiz was written
    { ...QUIZ[0], question: '' },
    QUIZ[1],
    { ...QUIZ[0], question: 'Which part is the server?' }, // gives its answer away
  ]);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /quiz\[0\] was left out: answer must be one of its choices/);
  assert.match(r.out, /quiz\[1\] was left out: choices has the same choice twice/);
  assert.match(r.out, /quiz\[2\] was left out: choices must be 2-4 strings/);
  assert.match(r.out, /quiz\[3\] was left out: node "shop-api\/routes\/gone\.js" is neither a node id nor an included file/);
  assert.match(r.out, /quiz\[4\] was left out: its question must be a string/);
  assert.match(r.out, /quiz\[6\] was left out: its answer is in the question/);
  assert.deepEqual(readGraph(root).quiz.map((x) => x.q), [QUIZ[1].question]);
  const notList = buildWith({ question: 'x' });
  assert.ok(notList.ok && /quiz must be an array/.test(notList.out));
});

test('an export keeps the starter questions along with flows and the tour, and drops them without', () => {
  assert.ok(buildWith(QUIZ).ok);
  const dataOf = (file) => JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(fs.readFileSync(file, 'utf8'))[1]);
  const serveJs = path.join(root, 'floorplan', 'serve.mjs');
  const withFlows = path.join(root, 'with.html'), without = path.join(root, 'without.html');
  const out = execFileSync(process.execPath, [serveJs, '--export', withFlows], { cwd: root, encoding: 'utf8' });
  assert.match(out, /flows, the tour and the quiz/);
  assert.equal(dataOf(withFlows).quiz.length, 2);
  execFileSync(process.execPath, [serveJs, '--export', without, '--include', 'notes'], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(dataOf(without).quiz, []);
});

test('More questions asks the agent in its quiz mode, held to the quiz schema', async () => {
  assert.ok(buildWith(QUIZ).ok);
  const log = path.join(root, 'fake.log');
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: '', FAKE_LOG: log, FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  const token = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(base + '/')).text())[1]).token;
  const r = await fetch(base + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': token }, body: JSON.stringify({ question: 'Write 4-6 new questions about the shop.', mode: 'quiz' }) });
  const events = (await r.text()).split('\n\n').filter(Boolean).map((b) => /^event: (\w+)/.exec(b)[1]);
  assert.ok(events.includes('answer'), events.join(','));

  const { args, input } = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema.required, ['questions']);
  assert.deepEqual(schema.properties.questions.items.required, ['question', 'choices', 'answer', 'id', 'explain']);
  const instructions = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(instructions, /You write quiz questions/);
  assert.match(instructions, /exactly one right/);
  assert.match(instructions, /Never let the question give the answer away/);
  assert.match(instructions, /You can read the source/, 'Claude Code can go past the map');
  assert.equal(input, 'Write 4-6 new questions about the shop.');
  assert.ok(!args.includes('--resume'), 'a quiz request does not continue the Ask conversation');
});
