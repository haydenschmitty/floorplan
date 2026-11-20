// Stands in for `opencode` in tests: answers --version, and for `run` logs what it was given (arguments,
// prompt, working directory, the config passed through the environment) to $FAKE_LOG, then prints the
// JSONL events a real run would. A prompt containing "SIGNED-OUT" fails the way OpenCode does when
// nobody is signed in.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.0.0-test'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
    args, input,
    pwd: process.env.PWD,
    config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'),
  }) + '\n');
  const out = (ev) => console.log(JSON.stringify(ev));
  const now = Date.now();
  const tool = (id, name, input) => out({ type: 'tool_use', timestamp: now, sessionID: 'ses_test', part: {
    partID: 'prt_' + id, sessionID: 'ses_test', messageID: 'msg_test', type: 'tool', id, tool: name,
    state: { status: 'completed', input, output: '', title: name, metadata: {}, time: { start: now, end: now } },
  } });
  if (input.includes('SIGNED-OUT')) {
    out({ type: 'error', timestamp: now, sessionID: 'ses_test', error: { type: 'unknown', message: 'You are not logged in. Run opencode auth login.' } });
    process.exitCode = 1;
    return;
  }
  tool('t0', 'shell', { command: 'node floorplan/query.mjs find "refund"' });
  tool('t1', 'read', { path: 'shop-api/routes/orders.js' });
  const answer = JSON.stringify({
    title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
    items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }], steps: [], followups: ['Who can ask for one?'],
  });
  // the answer arrives as text deltas, as the real run prints them
  const text = (t) => out({ type: 'text', timestamp: now, sessionID: 'ses_test', part: {
    id: 'prt_t2', sessionID: 'ses_test', messageID: 'msg_test', type: 'text', text: t, time: { start: now, end: now },
  } });
  text(answer.slice(0, 20));
  text(answer.slice(20));
});
