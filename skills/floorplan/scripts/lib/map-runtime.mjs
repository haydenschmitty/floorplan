// A remembered folder is not permission to run helper programs supplied by that folder.
import fs from 'node:fs';
import path from 'node:path';
import { readRegularFile } from './local-files.mjs';

const asset = (name) => fs.readFileSync(new URL('../../assets/' + name, import.meta.url));
const programs = new Map([
  ['serve.mjs', asset('serve.mjs')],
  ['page-safety.mjs', asset('page-safety.mjs')],
  ['query.mjs', Buffer.from(`${asset('graph-query.js').toString('utf8')}\n// ---- cli ----\n${asset('query-cli.mjs').toString('utf8')}`)],
]);

/** Older or edited helper programs need a trusted rebuild before they can be launched from the home. */
export function matchesMapRuntime(root) {
  for (const [name, expected] of programs) {
    const actual = readRegularFile(path.join(root, 'floorplan', name), expected.length);
    if (!actual || !actual.equals(expected)) return false;
  }
  return true;
}
