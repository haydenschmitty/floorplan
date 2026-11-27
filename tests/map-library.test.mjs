import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILL, makeProject, writeJson, cleanup } from './helpers.mjs';
import { FAKE_PASSWORD } from './helpers.mjs';

const library = () => import('../skills/floorplan/scripts/lib/map-library.mjs');
function fixture(t, name = 'A sample app') {
  const root = makeProject({ 'floorplan/index.html': '<!doctype html><title>Map</title>', 'floorplan/serve.mjs': '// floorplan/serve.mjs\n' });
  writeJson(path.join(root, 'floorplan/architecture.json'), { project: { name, summary: 'What this app does.' } });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-library-'));
  t.after(() => { cleanup(root); cleanup(dataDir); });
  return { root, dataDir };
}

test('registering a map exposes its current name, folder and modification time', async (t) => {
  const { registerMap, listMaps } = await library();
  const { root, dataDir } = fixture(t);
  const registered = registerMap(root, { dataDir });
  const [map] = listMaps({ dataDir });
  assert.equal(map.id, registered.id);
  assert.equal(map.root, fs.realpathSync(root));
  assert.equal(map.name, 'A sample app');
  assert.equal(map.summary, 'What this app does.');
  assert.equal(map.available, true);
  assert.ok(Number.isFinite(Date.parse(map.updatedAt)));
  writeJson(path.join(root, 'floorplan/architecture.json'), { project: { name: 'A new name' } });
  assert.equal(listMaps({ dataDir })[0].name, 'A new name');
});

test('a map opened through a symlink appears only once', async (t) => {
  const { registerMap, listMaps } = await library();
  const { root, dataDir } = fixture(t);
  const alias = path.join(dataDir, 'project-link');
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(registerMap(root, { dataDir }).id, registerMap(alias, { dataDir }).id);
  assert.equal(listMaps({ dataDir }).length, 1);
});

test('separate processes registering different maps preserve both entries', async (t) => {
  const { listMaps } = await library();
  const first = fixture(t, 'First app');
  const second = fixture(t, 'Second app');
  const source = `import {registerMap} from ${JSON.stringify(new URL('../skills/floorplan/scripts/lib/map-library.mjs', import.meta.url).href)}; registerMap(process.argv[1], {dataDir: process.argv[2]});`;
  const { spawn } = await import('node:child_process');
  await Promise.all([first.root, second.root].map((root) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, first.dataDir], { stdio: 'pipe' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`registration exited ${code}`)));
  })));
  assert.deepEqual(listMaps({ dataDir: first.dataDir }).map((m) => m.name).sort(), ['First app', 'Second app']);
});

test('missing maps remain removable without deleting any project files', async (t) => {
  const { registerMap, listMaps, removeMap } = await library();
  const { root, dataDir } = fixture(t);
  const { id } = registerMap(root, { dataDir });
  fs.unlinkSync(path.join(root, 'floorplan/index.html'));
  assert.equal(listMaps({ dataDir })[0].available, false);
  removeMap(id, { dataDir });
  assert.deepEqual(listMaps({ dataDir }), []);
  assert.equal(fs.existsSync(path.join(root, 'floorplan/architecture.json')), true);
});

test('invalid registration and entry IDs cannot read or remove unrelated files', async (t) => {
  const { registerMap, listMaps, removeMap } = await library();
  const { dataDir } = fixture(t);
  assert.throws(() => registerMap(dataDir, { dataDir }), /map/i);
  assert.throws(() => registerMap(null, { dataDir }), /folder/i);
  const unrelated = path.join(dataDir, 'settings.json');
  fs.writeFileSync(unrelated, '{"theme":"dark"}');
  assert.throws(() => removeMap('../settings', { dataDir }), /map/i);
  assert.deepEqual(listMaps({ dataDir }), []);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), '{"theme":"dark"}');
});

test('corrupt entries and large or invalid metadata do not break the map list', async (t) => {
  const { registerMap, listMaps } = await library();
  const { root, dataDir } = fixture(t);
  registerMap(root, { dataDir });
  fs.writeFileSync(path.join(dataDir, 'maps', 'a'.repeat(24) + '.json'), '{not json');
  fs.writeFileSync(path.join(root, 'floorplan/architecture.json'), ' '.repeat(1024 * 1024 + 1));
  assert.equal(listMaps({ dataDir }).length, 1);
  assert.equal(listMaps({ dataDir })[0].available, true);
  assert.equal(listMaps({ dataDir })[0].name, path.basename(root));
});

test('the homepage CLI can add an older map without starting a server', (t) => {
  const { root, dataDir } = fixture(t);
  const output = execFileSync(process.execPath, [path.join(SKILL, 'scripts/home.mjs'), '--add', root, '--register-only'], {
    encoding: 'utf8', env: { ...process.env, FLOORPLAN_DATA_DIR: dataDir },
  });
  assert.match(output, /Added/);
  assert.equal(fs.readdirSync(path.join(dataDir, 'maps')).filter((f) => f.endsWith('.json')).length, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'home-server.json')), false);
});

test('map names and summaries mask secrets before shortening the text', async (t) => {
  const { registerMap, listMaps } = await library();
  const { root, dataDir } = fixture(t);
  writeJson(path.join(root, 'floorplan/architecture.json'), { project: { name: `DB_PASSWORD="${FAKE_PASSWORD}"`, summary: 'x'.repeat(1980) + ` DB_PASSWORD="${FAKE_PASSWORD}"` } });
  registerMap(root, { dataDir });
  const [map] = listMaps({ dataDir });
  assert.equal(JSON.stringify(map).includes(FAKE_PASSWORD), false);
  assert.equal(map.summary.includes(FAKE_PASSWORD.slice(0, 5)), false);
});

test('a metadata pipe cannot block the whole map list', async (t) => {
  if (process.platform === 'win32') { t.skip('named pipe fixture uses mkfifo'); return; }
  const { registerMap } = await library();
  const { root, dataDir } = fixture(t);
  registerMap(root, { dataDir });
  const metadata = path.join(root, 'floorplan/architecture.json');
  fs.unlinkSync(metadata);
  execFileSync('mkfifo', [metadata]);
  const source = `import {listMaps} from ${JSON.stringify(new URL('../skills/floorplan/scripts/lib/map-library.mjs', import.meta.url).href)}; console.log(listMaps({dataDir:process.argv[1]}).length);`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source, dataDir], { encoding: 'utf8', timeout: 2000 });
  assert.equal(output.trim(), '1');
});
