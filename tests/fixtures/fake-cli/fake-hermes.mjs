// Stands in for `hermes` in tests: answers --version, the model-free probe, and `floorplan ask` in
// protocol v1. The question text picks the behaviour, so one server can run a normal ask and a stuck one:
// "HANG …" never answers, "SLOW …" answers late, "FAIL:<code> …" fails, anything else answers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL = path.join(REPO, 'skills', 'floorplan');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
const profile = opt('--profile');
// the real CLI answers on its own active profile when no --profile is passed, so this stand-in has one too
const activeProfile = profile || 'default-profile';
const log = (o) => { if (process.env.FAKE_HERMES_LOG) fs.appendFileSync(process.env.FAKE_HERMES_LOG, JSON.stringify(o) + '\n'); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (args.includes('--version')) { console.log('0.22.5-test'); process.exit(0); }
if (args.includes('probe')) {
  console.log(JSON.stringify({ plugin: 'floorplan', protocol: 1, profile: activeProfile, skill_dir: SKILL, ask: 'ready' }));
  process.exit(0);
}

const root = opt('--root') || process.cwd();
const readPath = process.env.FAKE_HERMES_READ || '';
let id = '';
let seq = 0;
let fact = '';
let mode = 'ask';
const changeState = { reply: null, reads: [], sent: 0, waiting: false };
const send = (frame) => process.stdout.write(JSON.stringify({ v: 1, id, seq: seq++, ...frame }) + '\n');

/** The next scripted Change reply, shared across the attempts of one test through a counter file. */
function nextChangeReply() {
  const file = process.env.FAKE_HERMES_CHANGES;
  if (!file) return { payload: {} };
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  const usedFile = `${file}.used`;
  let used = 0;
  try { used = Number(fs.readFileSync(usedFile, 'utf8')) || 0; } catch {}
  fs.writeFileSync(usedFile, String(used + 1));
  const reply = list[used] ?? { payload: {} };
  return reply && reply.payload ? reply : { payload: reply };
}

/** A Change drives its own reads first, then returns the scripted plan and architecture. */
function pumpChange() {
  if (changeState.sent < changeState.reads.length) {
    const path = changeState.reads[changeState.sent++];
    changeState.waiting = true;
    send({ type: 'lookup', lookup_id: `${id}-${changeState.sent - 1}`, lookup: { kind: 'read', args: { path, start: 1, end: 200 } } });
    return;
  }
  const { reads, ...payload } = changeState.reply.payload || {};
  send({ type: 'result', payload, provider: 'fake-provider', model: 'fake-model-1' });
}

function answerPayload() {
  const graph = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', 'graph.json'), 'utf8'));
  const ids = graph.files.map((f) => 'f:' + f.p);
  const cite = readPath && ids.includes('f:' + readPath) ? 'f:' + readPath : ids[0];
  const items = [cite, ...ids.filter((x) => x !== cite)].slice(0, 3).map((x, i) => ({ id: x, note: `item ${i + 1}` }));
  while (items.length < 3) items.push({ id: ids[0], note: 'the same module again' });
  return {
    title: 'Canary answer',
    answer: fact ? `The source says: ${fact}. See [[${cite}]].` : `Nothing to add. See [[${cite}]].`,
    items, steps: [], followups: ['What else does it do?'],
  };
}

function hang({ termIgnoringChild = false } = {}) {
  const ready = path.join(root, 'child-ready');
  // the stubborn child arms itself and says so: the pids below are only published once it cannot miss SIGTERM
  const code = termIgnoringChild
    ? `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'1');setInterval(() => {}, 1000)`
    : 'setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  const stat = (pid) => {
    try {
      const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
      return { pid, start: fields[21] };
    } catch { return { pid, start: null }; }
  };
  const publish = () => fs.writeFileSync(process.env.FAKE_HERMES_PIDS || path.join(root, 'pids.json'),
    JSON.stringify({ main: stat(process.pid), child: stat(child.pid) }));
  if (!termIgnoringChild) publish();
  else { const wait = setInterval(() => { if (fs.existsSync(ready)) { clearInterval(wait); publish(); } }, 10); }
  if (!termIgnoringChild) process.on('SIGTERM', () => {}); // only the group SIGKILL, 2 s later, ends this
}

function handle(frame) {
  log(frame);
  if (frame.type === 'start') {
    id = frame.id;
    seq = 0;
    mode = frame.mode || 'ask';
    // the real runner refuses any start frame whose profile is not the CLI's own (runner.py:279)
    if (frame.profile !== activeProfile) { send({ type: 'failure', code: 'profile_mismatch', message: 'profile_mismatch' }); return; }
    const q = String(frame.question || '');
    if (q.startsWith('FAIL:')) { send({ type: 'failure', code: q.slice(5).split(' ')[0], message: 'scripted failure' }); return; }
    if (q.startsWith('CRASH')) {
      // a Python traceback names an absolute install path: the server must log it, never forward it
      process.stderr.write('Traceback (most recent call last):\n  File "/opt/hermes-install/plugin/hermes/runner.py", line 1, in <module>\nSystemExit\n');
      process.exit(1);
    }
    if (q.startsWith('HANG2')) { hang({ termIgnoringChild: true }); return; }
    if (q.startsWith('HANG')) { hang(); return; }
    send({ type: 'ready', profile: activeProfile, plugin: 'floorplan', protocol: 1 });
    if (mode === 'change') {
      changeState.reply = nextChangeReply();
      changeState.reads = Array.isArray(changeState.reply.payload?.reads) ? changeState.reply.payload.reads.map(String) : [];
      changeState.sent = 0;
      changeState.waiting = false;
      pumpChange();
      return;
    }
    if (q.startsWith('HOLD')) {
      // answer once <root>/release exists, so a test can release the answer after a rebuild
      const release = path.join(root, 'release');
      const wait = setInterval(() => {
        if (!fs.existsSync(release)) return;
        clearInterval(wait);
        send({ type: 'result', payload: answerPayload(), provider: 'fake-provider', model: 'fake-model-1' });
      }, 10);
      return;
    }
    if (q.startsWith('SLOW')) {
      // a result after the tab has already stopped: the server must drop it
      setTimeout(() => send({ type: 'result', payload: answerPayload(), provider: 'fake-provider', model: 'fake-model-1' }), 1500);
      return;
    }
    if (readPath) send({ type: 'lookup', lookup_id: `${id}-0`, lookup: { kind: 'read', args: { path: readPath, start: 1, end: 40 } } });
    else send({ type: 'result', payload: answerPayload(), provider: 'fake-provider', model: 'fake-model-1' });
    return;
  }
  if (frame.type === 'source_ticket') {
    const buf = fs.readFileSync(path.join(root, frame.path));
    const lines = buf.toString('utf8').split('\n');
    for (const n of frame.redact_lines || []) lines[n - 1] = '[redacted: known secret]';
    const text = lines.slice(frame.start - 1, frame.end).join('\n');
    const line = text.split('\n').find((l) => l.includes('CANARY_FACT'));
    fact = line ? line.replace(/^.*CANARY_FACT[^=]*=\s*/, '').replace(/[;"',]+$/, '').trim() : '';
    send({ type: 'lookup_result', lookup_id: frame.lookup_id, ok: true, sha256: sha256(buf), text });
    if (mode !== 'change') send({ type: 'result', payload: answerPayload(), provider: 'fake-provider', model: 'fake-model-1' });
    return;
  }
  if (frame.type === 'lookup_result') {
    if (mode === 'change') { changeState.waiting = false; pumpChange(); }
    return;
  }
  if (frame.type === 'classify_read') {
    let buf;
    try { buf = fs.readFileSync(path.join(root, frame.path)); } catch {
      send({ type: 'source_bytes', lookup_id: frame.lookup_id, path: frame.path, ok: false, reason: 'not_found' });
      return;
    }
    send({ type: 'source_bytes', lookup_id: frame.lookup_id, path: frame.path, ok: true,
      sha256: sha256(buf), bytes_base64: buf.toString('base64') });
    return;
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    handle(frame);
  }
});
