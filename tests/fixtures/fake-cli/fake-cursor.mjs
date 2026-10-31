// Stands in for `cursor-agent` in tests: answers --version, and for `-p` logs its arguments and the prompt
// (read from stdin) to $FAKE_LOG, then prints the stream-json events a real run would. A prompt containing
// "SIGNED-OUT" fails the way the Cursor CLI does when nobody is signed in: a message on stderr, exit code 1.
// "NEEDS-TRUST" fails the way it does in a folder it hasn't been told to trust.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2026.10.0-test'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8'); // the prompt arrives on stdin
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, env: { agent: process.env.CURSOR_AGENT || null } }) + '\n');
if (input.includes('SIGNED-OUT')) {
  console.error("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.");
  process.exit(1);
}
if (input.includes('NEEDS-TRUST')) {
  console.error("\n⚠ Workspace Trust Required\n\n  Cursor Agent can execute code and access files in this directory.\n  Do you trust the contents of this directory?\n\n    /some/folder\n\n  To proceed, you can either:\n    • Run 'agent' interactively to decide\n    • Pass --trust, --yolo, or -f if you trust this directory");
  process.exit(1);
}
if (input.includes('OVER-LIMIT')) {
  console.error("ActionRequiredError: You've hit your hard limit Increase your hard limit to keep going.");
  process.exit(1);
}
// The real CLI leaves background worker processes that inherit its pipes; a prompt with LINGERING does the same
// (LINGERING-FAIL then fails like a CLI that stopped with an error).
if (input.includes('LINGERING')) {
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
  if (input.includes('LINGERING-FAIL')) { console.error('Error: the model could not be reached'); process.exit(1); }
}
const out = (ev) => console.log(JSON.stringify(ev));
const sid = 'cursor-test-session';
const answer = JSON.stringify({
  title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
  items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }], steps: [], followups: ['Who can ask for one?'],
});
out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: 'Test', permissionMode: 'default' });
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input }] }, session_id: sid });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me check the {refund} route.' }] }, session_id: sid });
out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'node floorplan/query.mjs find "refund"' } } }, session_id: sid });
out({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'node floorplan/query.mjs find "refund"' }, result: { success: {} } } }, session_id: sid });
out({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { readToolCall: { args: { path: process.cwd() + '/shop-api/routes/orders.js' } } }, session_id: sid });
out({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { readToolCall: { args: { path: 'x' }, result: { success: {} } } }, session_id: sid });
out({ type: 'tool_call', subtype: 'started', call_id: 'c3', tool_call: { grepToolCall: { args: { pattern: 'refund' } } }, session_id: sid });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '```json\n' + answer + '\n```' }] }, session_id: sid });
out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, result: 'Let me check the {refund} route.```json\n' + answer + '\n```', session_id: sid });
