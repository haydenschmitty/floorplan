// skills/index.json: the OpenCode skill catalog. OpenCode downloads a skill listed in it from
// <base-url>/<name>/<file>, when an opencode.json points its "skills" at this repo's skills/ folder:
//   "skills": ["https://raw.githubusercontent.com/haydenschmitty/floorplan/main/skills/"]
// The version changes with each release, so OpenCode refreshes its cache then.
// usage: node tools/skill-catalog.mjs    write skills/index.json for this checkout
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const dir = path.join(REPO, 'skills', 'floorplan');
const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).replace(/\\/g, '/'))
  .sort();
fs.writeFileSync(path.join(REPO, 'skills', 'index.json'), `${JSON.stringify({
  skills: [{ name: 'floorplan', version, files }],
}, null, 2)}\n`);
console.log(`✓ wrote skills/index.json for Floorplan ${version} (${files.length} files)`);
