#!/usr/bin/env node
// devin-api.mjs — helper for the "Devin Cloud (API)" engine. Reads a prompt on stdin,
// opens a Devin Cloud session over the REST API (https://api.devin.ai/v1/sessions),
// polls until Devin answers, and prints the last devin_message to stdout.
// Auth: DEVIN_API_KEY env var, or a .env file in the project (searched upward), or ~/.floorplan/.env.
// The key is never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://api.devin.ai';
const FINISHED = new Set(['finished', 'blocked', 'stopped', 'suspended', 'expired', 'failed']);
const TIMEOUT_MS = 240000, POLL_MS = 5000;

function findKey() {
  if (process.env.DEVIN_API_KEY) return process.env.DEVIN_API_KEY;
  const candidates = [path.join(process.cwd(), '.env')];
  let d = process.cwd();
  for (let i = 0; i < 4; i++) { d = path.dirname(d); if (d === path.dirname(d)) break; candidates.push(path.join(d, '.env')); }
  candidates.push(path.join(os.homedir(), '.floorplan', '.env'));
  for (const f of candidates) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*DEVIN_API_KEY\s*=\s*(.+?)\s*$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch {}
  }
  return null;
}

const req = async (method, p, body, key) => {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`api.devin.ai ${r.status}: ${text.slice(0, 300)}`);
  return data;
};

async function main() {
  const prompt = (await new Promise((res) => { let b = ''; process.stdin.on('data', (d) => (b += d)); process.stdin.on('end', () => res(b)); })).trim();
  if (!prompt) { console.error('empty prompt'); process.exit(1); }
  const key = findKey();
  if (!key) { console.error('DEVIN_API_KEY not found (env, .env in project, or ~/.floorplan/.env)'); process.exit(1); }
  const model = process.argv[2] || '';
  let session;
  try { session = await req('POST', '/v1/sessions', model ? { prompt, model } : { prompt }, key); }
  catch (e) { if (!model) throw e; session = await req('POST', '/v1/sessions', { prompt }, key); }
  const id = session.session_id || session.id;
  if (!id) { console.error('no session_id in response: ' + JSON.stringify(session).slice(0, 300)); process.exit(1); }
  process.stderr.write(`session ${id} — waiting for Devin…\n`);
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let s;
    try { s = await req('GET', `/v1/sessions/${id}`, null, key); } catch { continue; }
    const msgs = s.messages || [];
    const devinMsgs = msgs.filter((m) => m.type === 'devin_message').map((m) => m.message || '');
    if (devinMsgs.length) last = devinMsgs[devinMsgs.length - 1];
    const status = s.status_enum || s.status || '';
    if (FINISHED.has(status) && last) break;
    if (devinMsgs.length && /blocked|stopped|expired/.test(status)) break;
  }
  if (!last) { console.error('Devin did not answer in time'); process.exit(1); }
  process.stdout.write(last);
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
