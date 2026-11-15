// Stands in for `claude` in tests: answers --version, and for `-p` logs its arguments and prompt to
// $FAKE_LOG, then prints the stream-json events a real run would. With $FAKE_MANY_MCP set it acts like a
// machine with many MCP servers set up: unless it's told to use only the (empty) list of servers it's given,
// their tool descriptions fill the context and the run fails with "Prompt is too long".
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.0.0 (Claude Code, test)'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input }) + '\n');
  const out = (ev) => console.log(JSON.stringify(ev));
  out({ type: 'system', subtype: 'init', session_id: 'test-session' });
  const mcp = args.indexOf('--mcp-config');
  let servers = null;
  try { servers = mcp >= 0 ? Object.keys(JSON.parse(args[mcp + 1]).mcpServers) : null; } catch {}
  if (process.env.FAKE_MANY_MCP && !(args.includes('--strict-mcp-config') && servers?.length === 0)) {
    out({ type: 'result', subtype: 'success', is_error: true, session_id: 'test-session', result: 'Prompt is too long' });
    return;
  }
  // a change to a blueprint: answer with the next reply in $FAKE_CHANGES (a JSON array), one per run
  const schema = args[args.indexOf('--json-schema') + 1] || '';
  if (process.env.FAKE_CHANGES && schema.includes('"architecture"')) {
    const replies = JSON.parse(fs.readFileSync(process.env.FAKE_CHANGES, 'utf8'));
    const counter = process.env.FAKE_CHANGES + '.n';
    const n = fs.existsSync(counter) ? +fs.readFileSync(counter, 'utf8') : 0;
    fs.writeFileSync(counter, String(n + 1));
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'floorplan/plan.json' } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'test-session', structured_output: replies[Math.min(n, replies.length - 1)] });
    return;
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node floorplan/query.mjs overview' } }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'shop-api/routes/orders.js' } }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: 'test-session', structured_output: {
    title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
    items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }],
  } });
});
