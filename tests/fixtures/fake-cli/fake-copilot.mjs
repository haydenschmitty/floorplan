// Stands in for `copilot` in tests: answers --version, logs its arguments and prompt, then prints the
// JSONL events from Copilot's programmatic mode.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('GitHub Copilot CLI 0.0.0-test'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const inherited = Object.keys(process.env).filter((k) => /^COPILOT_(?:AGENT_SESSION_ID|ALLOW_ALL|ASSISTED_APPROVAL|CLI$|MCP_APPS|TRAMPOLINE_)/.test(k)).sort();
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, inherited }) + '\n');
  const out = (ev) => console.log(JSON.stringify(ev));
  if (input.includes('SIGNED-OUT')) {
    console.error('You are not logged in. Run copilot login.');
    out({ type: 'result', sessionId: 'test-copilot-session', exitCode: 1 });
    process.exitCode = 1;
    return;
  }
  out({ type: 'tool.execution_start', data: { toolName: 'rg', arguments: { pattern: 'refund' } } });
  out({ type: 'tool.execution_start', data: { toolName: 'view', arguments: { path: 'shop-api/routes/orders.js' } } });
  out({ type: 'assistant.message', data: { phase: 'final_answer', content: JSON.stringify({
    title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
    items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }], steps: [], followups: ['Who can ask for one?'],
  }) } });
  out({ type: 'result', sessionId: 'test-copilot-session', exitCode: 0 });
});
