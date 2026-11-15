// Imports through package.json "imports" (Node subpath imports, like `#lib/money`) link to the
// file they point at, using the package.json nearest to the importing file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

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
