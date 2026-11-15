// Imports through package.json "imports" (Node subpath imports, like `#lib/money`) link to the
// file they point at, using the package.json nearest to the importing file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const { createResolver } = await lib('resolve.mjs');

/** Resolves `spec` imported from `from` in a throwaway project made of `files`. */
function resolveIn(files, from, spec) {
  const root = makeProject(files);
  try {
    return createResolver(root, Object.keys(files).map((p) => ({ path: p })))({ path: from, lang: 'typescript' }, { spec });
  } finally { cleanup(root); }
}

const ARCH = { project: { name: 'App', summary: 'A sample app.' }, nodes: [{ id: 'app', label: 'App', kind: 'service', summary: 'The app.', paths: ['**'] }] };

test('subpath imports: "#…" specifiers link to the files package.json "imports" points at', () => {
  const root = makeProject({
    'package.json': JSON.stringify({
      name: 'shop',
      imports: {
        '#*': ['./generated/*', './src/*'],
        '#internal/*': './internal/*.ts',
        '#db': { node: './src/db/postgres.ts', default: './src/db/memory.ts' },
        '#schema': { types: './src/schema/source.ts', default: './dist/schema.js' },
        '#config': { types: './src/config.d.ts', default: './src/config.ts' },
      },
    }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#legacy/*': ['./old/*'] } } }),
    'src/main.ts': [
      "import { money } from '#lib/money';",
      "import { orders } from '#orders';",
      "import { audit } from '#internal/audit';",
      "import { db } from '#db';",
      "import { schema } from '#schema';",
      "import { legacy } from '#legacy/report';",
      "import { config } from '#config';",
      'console.log(money, orders, audit, db, schema, legacy, config);',
    ].join('\n'),
    'src/lib/money.ts': 'export const money = 1;',
    'src/orders/index.ts': 'export const orders = [];',
    'src/internal/audit.ts': 'export const audit = "wrong file: the more specific #internal/* key wins";',
    'internal/audit.ts': 'export const audit = true;',
    'src/db/postgres.ts': 'export const db = "pg";',
    'src/db/memory.ts': 'export const db = "memory";',
    'src/schema/source.ts': 'export const schema = {};',
    'src/config.ts': 'export const config = {};',
    'src/config.d.ts': 'export declare const config: object;',
    'old/report.ts': 'export const legacy = true;',
    'packages/billing/package.json': JSON.stringify({ name: 'billing', imports: { '#*': './lib/*.ts' } }),
    'packages/billing/lib/invoice.ts': "import { tax } from '#tax';\nexport const invoice = tax;",
    'packages/billing/lib/tax.ts': 'export const tax = 0.2;',
  }, { repos: ['.'], arch: ARCH });
  try {
    scanAndBuild(root);
    const imports = readGraph(root).links.filter((l) => l.k === 'import').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)}`).sort();
    assert.deepEqual(imports, [
      'packages/billing/lib/invoice.ts -> packages/billing/lib/tax.ts',
      'src/main.ts -> internal/audit.ts',
      'src/main.ts -> old/report.ts',
      'src/main.ts -> src/config.ts',
      'src/main.ts -> src/db/postgres.ts',
      'src/main.ts -> src/lib/money.ts',
      'src/main.ts -> src/orders/index.ts',
      'src/main.ts -> src/schema/source.ts',
    ]);
  } finally {
    cleanup(root);
  }
});

test('subpath imports: near misses stay unlinked instead of reaching the wrong file', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'shop', imports: { '#*': './src/*', '#db': './src/db.ts' } }),
    'src/main.ts': '',
    'src/db.ts': '',
    'src/index.ts': '',
    // A package of its own with no "imports": Node doesn't look further up, and neither do we
    'packages/tools/package.json': JSON.stringify({ name: 'tools' }),
    'packages/tools/run.ts': '',
  };
  // `*` must stand for something: "#" alone isn't "#*" with nothing in place of the star
  assert.deepEqual(resolveIn(files, 'src/main.ts', '#'), { unresolved: true });
  // No key matches: unresolved, and never an npm package
  assert.deepEqual(resolveIn({ ...files, 'package.json': JSON.stringify({ imports: { '#db': './src/db.ts' } }) }, 'src/main.ts', '#lib/money'), { unresolved: true });
  assert.deepEqual(resolveIn(files, 'packages/tools/run.ts', '#db'), { unresolved: true });
  // The key exists but its file doesn't
  assert.deepEqual(resolveIn(files, 'src/main.ts', '#lib/missing'), { unresolved: true });
  assert.deepEqual(resolveIn(files, 'src/main.ts', '#db'), { file: 'src/db.ts' });
});

test('subpath imports: odd package.json and tsconfig shapes in code you did not write never stop the scan', () => {
  // Written as text: nested this deep, JSON.stringify would run out of stack itself
  const deep = '[{"node":'.repeat(2500) + '"./src/db.ts"' + '}]'.repeat(2500);
  const odd = {
    'src/main.ts': '',
    'src/db.ts': '',
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@x/*': 5, '@y/*': [null, 7, './src/*'] } } }),
  };
  assert.deepEqual(resolveIn({ ...odd, 'package.json': `{"imports":{"#db":${deep}}}` }, 'src/main.ts', '#db'), { unresolved: true });
  assert.deepEqual(resolveIn({ ...odd, 'package.json': JSON.stringify({ imports: ['#db'] }) }, 'src/main.ts', '#db'), { unresolved: true });
  assert.deepEqual(resolveIn({ ...odd, 'package.json': JSON.stringify({ imports: '#db' }) }, 'src/main.ts', '#db'), { unresolved: true });
  assert.deepEqual(resolveIn({ ...odd, 'package.json': '{}' }, 'src/main.ts', '@x/db'), { external: '@x/db', eco: 'npm' });
  assert.deepEqual(resolveIn({ ...odd, 'package.json': '{}' }, 'src/main.ts', '@y/db'), { file: 'src/db.ts' });
});
