// Stands in for an ACP agent in tests: newline-delimited JSON-RPC over stdio. Logs every inbound
// request to $FAKE_LOG, answers initialize/session/new/session/prompt, and during a prompt probes the
// client's read-only surface (a file read inside and outside the codebase, a write, an allowed and a
// forbidden terminal command, and a permission request for a write), recording the outcomes in the
// log so the tests can check the policy. A prompt containing "SIGNED-OUT" fails the way an agent
// that isn't signed in would.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--version')) { console.log('fake-acp 0.0.0-test'); process.exit(0); }

const log = (m) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\n');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let seq = 0;
const pending = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  pending.set(++seq, { resolve, reject });
  send({ jsonrpc: '2.0', id: seq, method, params });
});
const tryReq = async (method, params) => {
  try { return { ok: true, result: await request(method, params) }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
};

let cwd = null;
const ANSWER = JSON.stringify({
  title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
  items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }],
  steps: [], followups: ['Who can ask for one?'],
});

async function prompt(req) {
  const sid = req.params.sessionId;
  const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: u } });
  update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', status: 'in_progress',
    rawInput: { command: 'node floorplan/query.mjs find "refund"' } });
  const probes = {};
  probes.readInside = await tryReq('fs/read_text_file', { sessionId: sid, path: path.join(cwd, 'shop-api', 'package.json') });
  probes.readOutside = await tryReq('fs/read_text_file', { sessionId: sid, path: fileURLToPath(import.meta.url) });
  probes.write = await tryReq('fs/write_text_file', { sessionId: sid, path: path.join(cwd, 'nope.txt'), content: 'x' });
  const term = await tryReq('terminal/create', { sessionId: sid, command: process.execPath, args: ['floorplan/query.mjs', 'overview'], cwd });
  if (term.ok) {
    const terminalId = term.result.terminalId;
    probes.terminal = {
      exit: (await tryReq('terminal/wait_for_exit', { sessionId: sid, terminalId })).result,
      out: (await tryReq('terminal/output', { sessionId: sid, terminalId })).result?.output?.length,
    };
    await tryReq('terminal/release', { sessionId: sid, terminalId });
  } else probes.terminal = term;
  probes.dangerous = await tryReq('terminal/create', { sessionId: sid, command: 'rm', args: ['-rf', cwd] });
  probes.permission = await tryReq('session/request_permission', {
    sessionId: sid,
    toolCall: { toolCallId: 't2', kind: 'edit', title: 'Write file', rawInput: {} },
    options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }],
  });
  log({ probes });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ANSWER.slice(0, ANSWER.length >> 1) } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ANSWER.slice(ANSWER.length >> 1) } });
}

async function onMessage(msg) {
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p?.reject(msg.error); else p?.resolve(msg.result);
    return;
  }
  if (!msg.method || msg.id === undefined) return;
  log({ method: msg.method, params: msg.params });
  try {
    let result;
    if (msg.method === 'initialize') {
      result = { protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '0.0.0-test' }, agentCapabilities: {} };
    } else if (msg.method === 'session/new') {
      cwd = msg.params.cwd;
      result = { sessionId: 'fake-session' };
    } else if (msg.method === 'session/prompt') {
      if (String(msg.params.prompt?.[0]?.text || '').includes('SIGNED-OUT')) throw new Error('You are not logged in. Sign in to your agent.');
      await prompt(msg);
      result = { stopReason: 'end_turn' };
    } else throw new Error('no such method');
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e.message || e) } });
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    onMessage(msg);
  }
});
