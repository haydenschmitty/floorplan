// Runs the plugin's Python suite (tests/hermes_runner_test.py) with this machine's interpreter.
// CI runs `node --test`, which only sees JavaScript; this is the one command that runs the Python half,
// and it prints the exact argv so a receipt shows what actually ran.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON || 'python3';
const argv = ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'hermes_runner_test.py'];
console.log(`${python} ${argv.join(' ')}`);
const run = spawnSync(python, argv, { cwd: repo, stdio: 'inherit' });
if (run.error) { console.error(run.error.message); process.exit(1); }
process.exit(run.status ?? 1);
