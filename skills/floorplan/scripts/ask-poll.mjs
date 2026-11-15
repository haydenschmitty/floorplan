#!/usr/bin/env node
// Pick up one question from a map made in Cursor, or send an answer back.
// The map never starts Cursor. This only talks to the map server already running on this computer.
// usage:
//   node ask-poll.mjs [root]
//   node ask-poll.mjs [root] --reply <id> --file <answer.json>
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const replyAt = argv.indexOf('--reply');
const fileAt = argv.indexOf('--file');
const replyId = replyAt >= 0 ? argv[replyAt + 1] : '';
const replyFile = fileAt >= 0 ? argv[fileAt + 1] : '';
const rootArg = argv.find((a, i) => !a.startsWith('--') && i !== replyAt + 1 && i !== fileAt + 1);
const root = path.resolve(rootArg || '.');
const stateFile = path.join(root, 'floorplan', '.cache', 'server.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}
let state;
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')); }
catch { fail(`No map server is recorded at ${stateFile}. Open the map first.`); }
let base;
try { base = new URL(state.url); }
catch { fail('The recorded map server address could not be read.'); }
if (base.protocol !== 'http:' || (base.hostname !== '127.0.0.1' && base.hostname !== 'localhost')) fail('The map server address is not on this computer.');
if (!state.token) fail('The recorded map server has no token.');

async function talk(pathname, options = {}) {
  const address = state.url + pathname;
  const res = await fetch(address, {
    ...options,
    headers: { 'x-floorplan-token': state.token, ...(options.headers || {}) },
    signal: AbortSignal.timeout(260000),
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, body };
}

if (replyAt >= 0 || fileAt >= 0) {
  if (!replyId || replyId.startsWith('--') || !replyFile || replyFile.startsWith('--')) fail('Usage: node ask-poll.mjs [root] --reply <id> --file <answer.json>');
  let answer;
  try { answer = JSON.parse(fs.readFileSync(replyFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { fail(`Could not read the answer file: ${e.message}`); }
  let sent;
  try { sent = await talk('/api/cursor-ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: replyId, answer }) }); }
  catch (e) { fail(`Could not reach the map server: ${e.message}`); }
  if (!sent.ok) fail(sent.body.error || `The map server refused the answer (${sent.status}).`);
  console.log('Answer sent to the map.');
  process.exit(0);
}

for (;;) {
  let polled;
  try { polled = await talk('/api/cursor-ask?timeout=50000'); }
  catch (e) { fail(`Could not reach the map server: ${e.message}`); }
  if (polled.status === 404) fail('This map is not waiting on the Cursor chat. It was not built in Cursor, or the server was started with --engine.');
  if (!polled.ok) fail(polled.body.error || `The map server returned ${polled.status}.`);
  if (polled.body.question) {
    console.log('CURSOR ASK');
    console.log(JSON.stringify(polled.body.question));
    process.exit(0);
  }
}
