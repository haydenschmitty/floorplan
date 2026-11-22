// Stands in for `kilo` in tests: answers --version, and for `kilo run --format json …` logs its arguments,
// prompt and the KILO_* environment it saw to $FAKE_LOG, then prints the JSONL events a real run would
// (one JSON object per line, straight to stdout). With $FAKE_KILO_IGNORE_CONFIG set it behaves as though
// the inline read-only agent never registered — the fallback warning kilo prints on stderr, then an answer
// — so the server's fail-closed path can be tested. A prompt containing "SIGNED-OUT" fails the way Kilo
// does when nobody is signed in.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('7.7.5'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const config = process.env.KILO_CONFIG_CONTENT ? JSON.parse(process.env.KILO_CONFIG_CONTENT) : null;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
    args,
    input,
    env: {
      KILO_NO_DAEMON: process.env.KILO_NO_DAEMON || null,
      config,
      // the parent session's variables must not reach the child
      parent: ['KILO', 'KILO_APP_NAME', 'KILOCODE_VERSION', 'OPENCODE'].filter((k) => process.env[k] !== undefined),
    },
  }) + '\n');
  if (process.env.FAKE_KILO_IGNORE_CONFIG) console.error('WARN agent "floorplan-ask" not found. Falling back to default agent');
  const out = (type, part) => console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID: 'ses_testsession123', ...(part !== undefined ? { part } : {}) }));
  out('step_start', { type: 'step-start' });
  if (input.includes('SIGNED-OUT')) {
    console.log(JSON.stringify({ type: 'error', timestamp: Date.now(), sessionID: 'ses_testsession123', error: { name: 'AuthError', data: { message: 'Kilo credentials are required; run `kilo auth login`' } } }));
    process.exit(1);
  }
  out('tool_use', { tool: 'bash', state: { status: 'completed', input: { command: 'node floorplan/query.mjs overview' } } });
  out('tool_use', { tool: 'read', state: { status: 'completed', input: { filePath: 'shop-api/routes/orders.js' } } });
  out('text', { type: 'text', text: 'Let me check the refund route.', time: { end: Date.now() } });
  out('step_finish', { type: 'step-finish', cost: 0 });
  out('text', { type: 'text', text: JSON.stringify({
    title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
    items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }], steps: [], followups: ['Who can ask for one?'],
  }), time: { end: Date.now() } });
  out('step_finish', { type: 'step-finish', cost: 0 });
});
