import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shopApp, scanAndBuild, cleanup } from './helpers.mjs';

test('hostile model name stays data in the inline server script', async () => {
  const root = shopApp();
  let server;
  try {
    scanAndBuild(root);
    const model = '</script><script>globalThis.injected=true</script>\u2028\u2029';
    const port = 20000 + Math.floor(Math.random() * 20000);
    server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--no-open', '--port', String(port), '--model', model], {
      cwd: root,
      env: { ...process.env, FLOORPLAN_ENGINE: 'codex', FLOORPLAN_CODEX: path.join(root, 'missing-cli'), FLOORPLAN_NO_PROMPTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const privateUrl = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10000);
      server.stdout.on('data', (chunk) => { out += chunk; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
      server.stderr.on('data', (chunk) => { out += chunk; });
      server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
    });
    const url = new URL(privateUrl);
    const bootstrap = await fetch(url.origin + '/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
    assert.equal(bootstrap.status, 204);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(url.origin + '/', { headers: { cookie } })).text();
    const match = /window\.FLOORPLAN_SERVER=(.*?);<\/script>/s.exec(html);
    assert.ok(match, 'server data remains within its original script');
    assert.doesNotMatch(match[1], /<|\u2028|\u2029/);
    assert.equal(JSON.parse(match[1]).model, model);
  } finally {
    if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
    cleanup(root);
  }
});
