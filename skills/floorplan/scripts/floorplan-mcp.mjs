#!/usr/bin/env node
// floorplan-mcp: a small MCP server (stdio) that exposes the answering engines Floorplan
// supports — Claude Code CLI, Codex CLI, Devin CLI — as tools. No API keys: each engine
// is driven through its installed, already-authenticated CLI, exactly like serve.mjs does.
//
//   node floorplan-mcp.mjs
//
// Tools:
//   floorplan_engines                       -> engines, install status, current choice
//   floorplan_ask(question, engine?)        -> run one question through the chosen engine's CLI
//   floorplan_set_engine(engine)            -> persist the engine choice in ~/.floorplan/settings.json
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const settingsFile = path.join(HOME, '.floorplan', 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
const saveSettings = (patch) => { const st = { ...readSettings(), ...patch }; fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(st, null, 2)); };

const which = (name) => {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try { return execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
  catch { return []; }
};
const fileExists = (p) => { try { return p && fs.statSync(p).isFile() ? p : null; } catch { return null; } };

// Same lookup rules as serve.mjs's ENGINES, reduced to "find the exe, run one prompt".
const ENGINES = {
  claude: {
    name: 'Claude Code CLI',
    find: () => fileExists([...which('claude'),
      path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
      ...(process.platform === 'win32' ? [path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')] : []),
    ].find((p) => fileExists(p))),
    ask: (exe, q) => spawnSync(exe, ['-p', q, '--output-format', 'text'], opts()),
  },
  codex: {
    name: 'Codex',
    find: () => fileExists([...which('codex')].find((p) => fileExists(p))),
    ask: (exe, q) => spawnSync(exe, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', q], opts()),
  },
  devin: {
    name: 'Devin',
    find: () => fileExists([process.env.DEVIN_CLI || '', ...which('devin'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Devin', 'resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', process.platform === 'win32' ? 'devin.exe' : 'devin'),
    ].find((p) => fileExists(p))),
    ask: (exe, q) => spawnSync(exe, ['-p', q], opts()),
  },
  devincloud: {
    name: 'Devin Cloud API',
    find: () => {
      const helper = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'assets', 'devin-api.mjs');
      const has = (f) => { try { return /^\s*DEVIN_API_KEY\s*=/m.test(fs.readFileSync(f, 'utf8')); } catch { return false; } };
      return fileExists(helper) && (process.env.DEVIN_API_KEY || has(path.join(process.cwd(), '.env')) || has(path.join(os.homedir(), '.floorplan', '.env'))) ? helper : null;
    },
    ask: (helper, q) => spawnSync(process.execPath, [helper], { ...opts(), input: q, cwd: process.cwd() }),
  },
};
const opts = () => ({ encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });

const TOOLS = [
  { name: 'floorplan_engines', description: 'List Floorplan answering engines (Claude Code, Codex, Devin), whether each CLI is installed, and the saved choice.', inputSchema: { type: 'object', properties: {} } },
  { name: 'floorplan_ask', description: 'Ask a question through one of the Floorplan engines’ CLIs. Uses the installed CLI’s own auth — no API key needed.', inputSchema: { type: 'object', properties: { question: { type: 'string' }, engine: { type: 'string', enum: Object.keys(ENGINES) } }, required: ['question'] } },
  { name: 'floorplan_set_engine', description: 'Persist the preferred answering engine in ~/.floorplan/settings.json.', inputSchema: { type: 'object', properties: { engine: { type: 'string', enum: Object.keys(ENGINES) } }, required: ['engine'] } },
  { name: 'floorplan_set_model', description: 'Persist the model for one engine (settings.models).', inputSchema: { type: 'object', properties: { engine: { type: 'string', enum: Object.keys(ENGINES) }, model: { type: 'string' } }, required: ['engine', 'model'] } },
  { name: 'floorplan_auth_check', description: 'Check whether the current engine can answer (CLI signed in / API key present).', inputSchema: { type: 'object', properties: { engine: { type: 'string', enum: Object.keys(ENGINES) } } } },
  { name: 'floorplan_auth_start', description: 'Start the sign-in flow for a CLI engine (logout + open its login).', inputSchema: { type: 'object', properties: { engine: { type: 'string', enum: Object.keys(ENGINES) } } } },
];
const AUTH = { devin: { check: ['auth', 'status'], start: [['auth', 'logout'], ['auth', 'login']] }, claude: { check: ['auth', 'status'], start: [['auth', 'login']] }, codex: { check: ['login', 'status'], start: [['login']] } };

const installed = () => Object.fromEntries(Object.entries(ENGINES).map(([k, e]) => [k, e.find() || null]));
const pickEngine = (id) => (id && ENGINES[id]) ? id : (ENGINES[readSettings().engine] ? readSettings().engine : Object.keys(installed())[0]);

function callTool(name, args = {}) {
  if (name === 'floorplan_engines') {
    const inst = installed();
    return { engines: Object.keys(ENGINES).map((k) => ({ id: k, name: ENGINES[k].name, installed: !!inst[k], path: inst[k] })), saved: readSettings().engine || null };
  }
  if (name === 'floorplan_set_engine') {
    if (!ENGINES[args.engine]) throw new Error(`unknown engine: ${args.engine}`);
    saveSettings({ engine: args.engine });
    const exe = ENGINES[args.engine].find();
    return { ok: true, engine: args.engine, installed: !!exe, note: exe ? undefined : 'saved, but this CLI is not installed' };
  }
  if (name === 'floorplan_set_model') {
    if (!ENGINES[args.engine] || typeof args.model !== 'string' || !args.model.trim()) throw new Error('engine and model are required');
    saveSettings({ models: { ...(readSettings().models || {}), [args.engine]: args.model.trim() } });
    return { ok: true, engine: args.engine, model: args.model.trim() };
  }
  if (name === 'floorplan_auth_check') {
    const id = args.engine || pickEngine();
    if (id === 'devincloud') return { engine: id, loggedIn: !!ENGINES.devincloud.find() };
    const exe = ENGINES[id]?.find();
    if (!exe) return { engine: id, loggedIn: false, reason: 'not installed' };
    const c = AUTH[id]?.check;
    if (!c) return { engine: id, loggedIn: !!exe };
    const r = spawnSync(exe, c, opts());
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    return { engine: id, loggedIn: r.status === 0 && !/not logged in|not signed in|unauthori[sz]ed|401/i.test(out), detail: out.slice(0, 300) };
  }
  if (name === 'floorplan_auth_start') {
    const id = args.engine || pickEngine();
    const exe = ENGINES[id]?.find();
    if (!exe || !AUTH[id]) throw new Error(`${id} is not a CLI engine or is not installed`);
    const steps = AUTH[id].start.map((cmd) => {
      try { const r = spawnSync(exe, cmd, { ...opts(), timeout: 30000 }); return { cmd: cmd.join(' '), ok: r.status === 0 }; }
      catch { return { cmd: cmd.join(' '), ok: false }; }
    });
    try { const login = AUTH[id].start.at(-1); spawn(exe, login, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
    return { ok: true, steps, note: 'sign-in opened — finish it in your browser' };
  }
  if (name === 'floorplan_ask') {
    if (typeof args.question !== 'string' || !args.question.trim()) throw new Error('question is required');
    const id = pickEngine(args.engine);
    const exe = ENGINES[id].find();
    if (!exe) throw new Error(`${ENGINES[id].name} is not installed on this machine`);
    const r = ENGINES[id].ask(exe, args.question);
    if (r.error) throw new Error(`${id} failed: ${r.error.message}`);
    const out = (r.stdout || '').trim();
    if (r.status !== 0) throw new Error(`${id} exited ${r.status}: ${(r.stderr || out).trim().slice(0, 500)}`);
    return { engine: id, answer: out || '(empty answer)' };
  }
  throw new Error(`unknown tool: ${name}`);
}

// --- JSON-RPC 2.0 over stdio (MCP): one message per line ---
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // notification: ignore
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') reply(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'floorplan', version: '1.0.0' } });
      else if (method === 'ping') reply(id, {});
      else if (method === 'tools/list') reply(id, { tools: TOOLS });
      else if (method === 'tools/call') {
        const result = callTool(params?.name, params?.arguments);
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      }
      else fail(id, -32601, `method not found: ${method}`);
    } catch (e) {
      if (method === 'tools/call') reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      else fail(id, -32603, e.message);
    }
  }
});
