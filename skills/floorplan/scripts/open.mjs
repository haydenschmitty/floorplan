#!/usr/bin/env node
// Show the map to the user after a build or refresh. Reuses this map's server if it's running (open tabs
// have already reloaded themselves), restarts it if serve.mjs changed, otherwise starts it in the
// background and opens a browser tab. Prints the URL and how to stop it.
// usage: node open.mjs [root] [--no-open] [--port N] [--engine claude|codex|cursor] [--model M] [--claude PATH] [--codex PATH] [--cursor PATH]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs, mapDir } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const dir = mapDir(root);
const serveFile = path.join(dir, 'serve.mjs');
const stateFile = path.join(dir, '.cache', 'server.json');
const rel = path.relative(process.cwd(), dir).replace(/\\/g, '/') || '.';
const IDLE_MINUTES = 120;

if (!fs.existsSync(path.join(dir, 'index.html')) || !fs.existsSync(serveFile)) {
  console.error('✗ No built map here yet. Run build.mjs first.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function api(s, p) {
  try {
    const r = await fetch(s.url + p, { headers: { 'x-floorplan-token': s.token }, signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
function openBrowser(u) {
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); return true; } catch { return false; }
}
const hash = crypto.createHash('sha1').update(fs.readFileSync(serveFile)).digest('hex').slice(0, 12);

let s = readState();
let status = s?.pid && alive(s.pid) ? await api(s, '/api/status') : null;
let restarted = false;
const hadTabs = status?.tabs > 0;

if (status && status.hash !== hash) {
  // a newer serve.mjs came with this build: restart so the map gets it; open tabs reconnect and reload
  try { process.kill(s.pid); } catch {}
  for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(150);
  status = null;
  restarted = true;
}

if (!status) {
  const pass = ['port', 'engine', 'model', 'claude', 'codex', 'cursor'].flatMap((k) => (args[k] ? ['--' + k, String(args[k])] : []));
  if (!args.port && s?.port) pass.push('--port', String(s.port)); // keep the address people have open
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const log = fs.openSync(path.join(dir, '.cache', 'server.log'), 'w');
  const prev = s?.pid;
  spawn(process.execPath, [serveFile, '--no-open', '--idle-exit', String(IDLE_MINUTES), ...pass], {
    cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true,
  }).unref();
  // finding the Claude Code, Codex or Cursor CLI takes a few seconds before the server listens
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const n = readState();
    if (n?.pid && n.pid !== prev && alive(n.pid)) { s = n; status = await api(s, '/api/status'); if (status) break; }
  }
  if (!status) {
    console.error(`✗ The map server didn't start. Its log is in ${rel}/.cache/server.log. The map still opens as a file: ${rel}/index.html`);
    process.exit(1);
  }
  // tabs from before a restart come back on their own within a few seconds
  if (restarted && hadTabs) for (let i = 0; i < 50 && !(status?.tabs > 0); i++) { await sleep(200); status = await api(s, '/api/status'); }
}

const health = await api(s, '/api/health');
let shown;
if (status.tabs > 0) shown = `already open in ${status.tabs === 1 ? 'a browser tab' : status.tabs + ' browser tabs'}, which reloaded with the latest map`;
else if (args['no-open']) shown = 'not opened in a browser (--no-open): open the URL yourself';
else shown = openBrowser(s.url) ? 'opened in the browser' : 'could not open a browser: open the URL yourself';

console.log(`FLOORPLAN  ${s.url}  (${shown})`);
const CLI = {
  claude: { name: 'the Claude Code CLI', docs: 'https://docs.claude.com/en/docs/claude-code' },
  codex: { name: 'Codex', docs: 'https://developers.openai.com/codex' },
  cursor: { name: 'the Cursor CLI', docs: 'https://cursor.com/docs/cli/overview' },
};
console.log(health?.cli
  ? `ASK  works: questions run through ${CLI[health.engine]?.name || 'the Claude Code CLI'}${health.version ? ' (' + health.version + ')' : ''}`
  : `ASK  needs ${(CLI[health?.want] || CLI.claude).name}, which was not found; the map itself works (${(CLI[health?.want] || CLI.claude).docs})`);
console.log(`SERVER  runs in the background, updates open tabs when the map is rebuilt, and stops ${IDLE_MINUTES / 60} hours after the last tab closes. Stop it now: node ${rel}/serve.mjs --stop`);
