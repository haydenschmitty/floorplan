// Stands in for `omp` in tests: answers --version, and for `-p` logs what it was given (arguments, prompt,
// tools) to $FAKE_LOG, then prints the line-delimited JSON events a real `omp -p --mode=json` run emits.
// A prompt containing "SIGNED-OUT" ends the run with an error and no assistant message, the way omp does
// when the profile it runs under cannot reach a model.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('omp 0.0.0-test'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input }) + '\n');
  const out = (ev) => console.log(JSON.stringify(ev));
  const say = (text) => out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'session', version: 3, id: 'test-session', cwd: process.cwd() });
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  if (input.includes('SIGNED-OUT')) {
    out({ type: 'error', message: 'No model available for this profile.' });
    out({ type: 'agent_end', messages: [], isTerminal: true });
    return;
  }
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Refunds' } });
  say('Let me check the refund route.');
  const answer = JSON.stringify({
    title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
    items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }], steps: [], followups: ['Who can ask for one?'],
  });
  say(answer);
  out({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Refunds go through [[f:shop-api/routes/orders.js]].' }] } });
  out({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: answer }] }], isTerminal: true });
});
