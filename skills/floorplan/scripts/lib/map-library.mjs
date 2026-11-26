// A private, local list of maps someone has opened. A file per map keeps simultaneous opens independent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskSecrets } from './health.mjs';
import { readRegularFile } from './local-files.mjs';

export const libraryDir = () => path.resolve(process.env.FLOORPLAN_DATA_DIR || path.join(os.homedir(), '.floorplan'));
const mapId = (root) => crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
const directory = (options) => path.join(options.dataDir || libraryDir(), 'maps');
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
function readJson(file, limit) {
  try {
    const bytes = readRegularFile(file, limit);
    return bytes ? JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) : null;
  } catch { return null; }
}

/** Remember an existing map. This does not scan, rebuild or open it. */
export function registerMap(folder, options = {}) {
  if (typeof folder !== 'string' || !folder.trim() || folder.length > 4096) throw new Error('Enter the project folder that contains your floorplan map.');
  let root;
  try { root = fs.realpathSync(path.resolve(folder)); } catch { throw new Error('That project folder could not be found.'); }
  if (!isFile(path.join(root, 'floorplan', 'index.html')) || !isFile(path.join(root, 'floorplan', 'serve.mjs'))) {
    throw new Error('There is no built Floorplan map in that folder. Choose the project folder that contains floorplan/.');
  }
  const entry = { id: mapId(root), root, openedAt: new Date().toISOString() };
  const dir = directory(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${entry.id}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(entry) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(dir, entry.id + '.json'));
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return entry;
}

/** Read names and timestamps from the maps themselves, so the home never keeps an outdated copy. */
export function listMaps(options = {}) {
  const dir = directory(options);
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const maps = [];
  for (const file of files) {
    if (!/^[a-f0-9]{24}\.json$/.test(file)) continue;
    const entry = readJson(path.join(dir, file), 16384);
    if (!entry || typeof entry.root !== 'string' || !path.isAbsolute(entry.root) || !validId(entry.id) || file !== entry.id + '.json' || mapId(entry.root) !== entry.id) continue;
    const folder = path.join(entry.root, 'floorplan');
    const project = readJson(path.join(folder, 'architecture.json'), 1024 * 1024)?.project;
    const available = isFile(path.join(folder, 'index.html')) && isFile(path.join(folder, 'serve.mjs'));
    let updatedAt = null;
    if (available) { try { updatedAt = fs.statSync(path.join(folder, 'index.html')).mtime.toISOString(); } catch {} }
    maps.push({
      id: entry.id, root: entry.root,
      name: typeof project?.name === 'string' && project.name.trim() ? maskSecrets(project.name).slice(0, 300) : path.basename(entry.root),
      summary: typeof project?.summary === 'string' ? maskSecrets(project.summary).slice(0, 2000) : '',
      openedAt: typeof entry.openedAt === 'string' ? entry.openedAt : null,
      updatedAt, available,
    });
  }
  return maps.sort((a, b) => (Date.parse(b.openedAt) || 0) - (Date.parse(a.openedAt) || 0) || a.name.localeCompare(b.name));
}

/** Forget an entry, without modifying the project or its map. */
export function removeMap(id, options = {}) {
  if (!validId(id)) throw new Error('That map is not in your list.');
  fs.rmSync(path.join(directory(options), id + '.json'), { force: true });
}
