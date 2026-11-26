#!/usr/bin/env node
// usage: node home.mjs [--add PROJECT] [--register-only] [--no-open] [--port 4377] [--stop]
import { parseArgs, unattendedMode } from './lib/common.mjs';
import { registerMap, listMaps, removeMap, libraryDir } from './lib/map-library.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { scriptJson, withPolicy } from '../assets/page-safety.mjs';

const args = parseArgs(process.argv.slice(2));
if (unattendedMode(args)) {
  console.log('Unattended mode: not registering maps or starting the map home.');
  process.exit(0);
}
const dataDir = libraryDir();
const stateFile = path.join(dataDir, 'home-server.json');
const template = fs.readFileSync(new URL('../assets/home.html', import.meta.url), 'utf8');
const hash = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).update(template).update(fs.readFileSync(new URL('./lib/map-library.mjs', import.meta.url))).digest('hex').slice(0, 16);
const localURL = (url) => typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url);
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };

async function runningHome() {
  const s = readState();
  if (!s || !localURL(s.url) || typeof s.token !== 'string' || !/^[a-f0-9]{32}$/.test(s.token)) return null;
  try {
    const response = await fetch(s.url + '/api/status', { headers: { 'x-floorplan-token': s.token }, signal: AbortSignal.timeout(1000) });
    const status = response.ok ? await response.json() : null;
    return status?.home === 'floorplan' ? { ...s, hash: status.hash } : null;
  } catch { return null; }
}
function show(u) {
  console.log('FLOORPLAN HOME  ' + u);
  console.log('Your maps stay on this computer. Remove only forgets a map; it never deletes its files.');
  if (!args['no-open']) {
    const [cmd, values] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
    const child = spawn(cmd, values, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => console.error('Open the homepage address above in your browser.'));
    child.unref();
  }
}
const send = (response, status, data) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
};
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16384) { reject(Object.assign(new Error('That request is too large.'), { status: 413 })); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > 16384) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Send a valid JSON request.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

async function main() {
  if (args.add) {
    registerMap(args.add);
    console.log('Added the map to your local list.');
  }
  if (args['register-only']) process.exit(0);
  let previous = await runningHome();
  if (args.stop) {
    if (previous) {
      const s = previous;
      await fetch(s.url + '/api/stop', { method: 'POST', headers: { 'x-floorplan-token': s.token }, signal: AbortSignal.timeout(2000) });
    }
    console.log(previous ? 'Stopped the map home.' : 'The map home was not running.');
    return;
  }
  if (previous?.hash === hash) { show(previous.url); return; }
  if (previous) {
    const s = previous;
    await fetch(s.url + '/api/stop', { method: 'POST', headers: { 'x-floorplan-token': s.token }, signal: AbortSignal.timeout(2000) });
  }
  const wanted = args.port === undefined ? 4377 : Number(args.port);
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) throw new Error('Choose a port between 0 and 65535.');
  if (!args.serve) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(dataDir, 'home-server.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', '--no-open', '--port', String(wanted)], {
      detached: true, stdio: ['ignore', log, log], windowsHide: true,
    });
    fs.closeSync(log);
    let failed = false;
    child.on('error', () => { failed = true; });
    child.on('exit', (code) => { if (code) failed = true; });
    child.unref();
    for (let attempt = 0; attempt < 100 && !failed; attempt++) {
      const ready = await runningHome();
      if (ready?.hash === hash) { show(ready.url); return; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The map home could not start. Check home-server.log in your Floorplan data folder.');
  }
  const token = crypto.randomBytes(16).toString('hex');
  const page = withPolicy(template.replace('/*FLOORPLAN_HOME*/', scriptJson({ token })), 'local');
  const openings = new Map();
  const runNode = promisify(execFile);
  let port = wanted;
  const server = http.createServer(async (request, response) => {
    const host = request.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return send(response, 403, { error: 'This homepage is only available on this computer.' });
    let url;
    try { url = new URL(request.url, 'http://' + host); decodeURIComponent(url.pathname); }
    catch { return send(response, 400, { error: 'That address is not valid.' }); }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      return response.end(page);
    }
    if (!url.pathname.startsWith('/api/')) return send(response, 404, { error: 'Not found.' });
    if (request.headers['x-floorplan-token'] !== token || (request.headers.origin && request.headers.origin !== 'http://' + host)) return send(response, 403, { error: 'Open this homepage to use its map list.' });
    try {
      if (request.method === 'GET' && url.pathname === '/api/status') return send(response, 200, { home: 'floorplan', hash });
      if (request.method === 'GET' && url.pathname === '/api/maps') return send(response, 200, { maps: listMaps() });
      if (request.method === 'POST' && url.pathname === '/api/stop') {
        send(response, 200, { stopped: true });
        server.close();
        server.closeIdleConnections?.();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/maps') {
        const body = await readBody(request);
        if (!body || typeof body.root !== 'string' || !path.isAbsolute(body.root)) return send(response, 400, { error: 'Enter the full project folder path.' });
        return send(response, 200, registerMap(body.root));
      }
      const match = /^\/api\/maps\/([a-f0-9]{24})(\/open)?$/.exec(url.pathname);
      if (match && request.method === 'DELETE' && !match[2]) {
        removeMap(match[1]);
        return send(response, 200, { removed: true });
      }
      if (match && request.method === 'POST' && match[2]) {
        const map = listMaps().find((entry) => entry.id === match[1]);
        if (!map) return send(response, 404, { error: 'That map is not in your list.' });
        if (!map.available) return send(response, 400, { error: 'That map folder is missing. Add its new location or remove it from the list.' });
        if (!openings.has(map.id)) {
          const opening = runNode(process.execPath, [fileURLToPath(new URL('./open.mjs', import.meta.url)), map.root, '--no-open'], { timeout: 45000, maxBuffer: 256 * 1024, windowsHide: true })
            .then(({ stdout }) => {
              const target = /^FLOORPLAN  (http:\/\/127\.0\.0\.1:\d+) /m.exec(stdout)?.[1];
              if (!localURL(target)) throw new Error('The map did not provide a local address.');
              return target;
            }).finally(() => openings.delete(map.id));
          openings.set(map.id, opening);
        }
        try { return send(response, 200, { url: await openings.get(map.id) }); }
        catch { return send(response, 500, { error: 'The map could not be opened. Try opening it from its project folder.' }); }
      }
      return send(response, 404, { error: 'Not found.' });
    } catch (e) { send(response, e.status || 400, { error: e.status ? e.message : 'Could not update the map list. Check the project folder and try again.' }); }
  });
  const stop = () => { server.close(); server.closeIdleConnections?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('close', () => {
    if (readState()?.pid === process.pid) { try { fs.unlinkSync(stateFile); } catch {} }
  });
  server.on('error', async (e) => {
    if (e.code === 'EADDRINUSE' && port < Math.min(wanted + 20, 65535)) {
      previous = await runningHome();
      if (previous?.hash === hash) { show(previous.url); return; }
      port++;
      server.listen(port, '127.0.0.1');
    } else { console.error('The map home could not start: ' + e.message); process.exitCode = 1; }
  });
  server.on('listening', () => {
    port = server.address().port;
    const url = `http://127.0.0.1:${port}`;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, url, token, hash }) + '\n', { mode: 0o600 });
    show(url);
  });
  server.listen(port, '127.0.0.1');
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
