// Stands in for `agy` in tests: answers --version, and for `--print=...` logs its arguments,
// prompt, and schema to $FAKE_LOG, then prints the stream-json events a real run would. A prompt
// containing "SIGNED-OUT" fails with an unauthenticated error.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.5.9'); process.exit(0); }

const flag = (name) => {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};

const schemaFile = flag('--json-schema');
const schemaText = schemaFile && fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf8') : '{}';
const prompt = flag('--print');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, prompt, schema: JSON.parse(schemaText) }) + '\n');

const out = (ev) => console.log(JSON.stringify(ev));
out({ event: 'init', conversation_id: 'agy-test-conv' });

if (prompt.includes('SIGNED-OUT')) {
  out({ event: 'result', result: { conversation_id: 'agy-test-conv', status: 'ERROR', response: '', error: 'Not logged in. Please sign in to Antigravity.' } });
  process.exit(0);
}

if (process.env.FAKE_CHANGES && schemaText.includes('"architecture"')) {
  const replies = JSON.parse(fs.readFileSync(process.env.FAKE_CHANGES, 'utf8'));
  const counter = process.env.FAKE_CHANGES + '.n';
  const n = fs.existsSync(counter) ? +fs.readFileSync(counter, 'utf8') : 0;
  fs.writeFileSync(counter, String(n + 1));
  out({ event: 'step_update', step_update: { conversation_id: 'agy-test-conv', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'floorplan/plan.json' } } } });
  out({ event: 'result', result: { conversation_id: 'agy-test-conv', status: 'SUCCESS', response: '', structured_output: replies[Math.min(n, replies.length - 1)] } });
  process.exit(0);
}

out({ event: 'step_update', step_update: { conversation_id: 'agy-test-conv', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'node floorplan/query.mjs find "refund"' } } } });
out({ event: 'step_update', step_update: { conversation_id: 'agy-test-conv', step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'shop-api/routes/orders.js' } } } });
out({
  event: 'result',
  result: {
    conversation_id: 'agy-test-conv',
    status: 'SUCCESS',
    response: '',
    structured_output: {
      title: 'Refunds',
      answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
      items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }],
      steps: [],
      followups: ['Who can ask for one?'],
    },
  },
});
