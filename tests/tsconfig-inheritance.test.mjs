// Local tsconfig inheritance: an alias must keep pointing at its source file, not an npm package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lib, makeProject, run, readJson, cleanup } from './helpers.mjs';

const { createResolver } = await lib('resolve.mjs');
const json = JSON.stringify;
const source = { 'src/main.ts': "import { value } from '@lib/value';\n", 'src/lib/value.ts': 'export const value = 42;\n' };

function resolve(files, spec = '@lib/value') {
  const root = makeProject({ ...source, ...files });
  try {
    const paths = Object.keys({ ...source, ...files }).map((p) => ({ path: p }));
    return createResolver(root, paths)({ path: 'src/main.ts', lang: 'typescript' }, { spec });
  } finally { cleanup(root); }
}

test('scan: array-form extends preserves internal aliases (#126)', () => {
  const root = makeProject({
    ...source,
    'tsconfig.json': json({ extends: ['./tsconfig.base.json', './tsconfig.aliases.json'] }),
    'tsconfig.base.json': json({ compilerOptions: { strict: true } }),
    'tsconfig.aliases.json': json({ compilerOptions: { paths: { '@lib/*': ['./src/lib/*'] } } }),
  });
  try {
    run('scan.mjs', root);
    const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.equal(scan.edges.length, 1);
    assert.equal(scan.externals.length, 0);
    const edge = scan.edges[0];
    assert.equal(edge.from, 'src/main.ts');
    assert.equal(edge.to, 'src/lib/value.ts');
  } finally { cleanup(root); }
});

test('inherited paths stay relative to the config that declares them, through nested arrays', () => {
  assert.deepEqual(resolve({
    'tsconfig.json': json({ extends: ['./configs/shared.json'] }),
    'configs/shared.json': json({ extends: ['./aliases.json'] }),
    'configs/aliases.json': json({ compilerOptions: { paths: { '@lib/*': ['../src/lib/*'] } } }),
  }), { file: 'src/lib/value.ts' });
});

test('a later paths map replaces an earlier map rather than merging its aliases', () => {
  const files = {
    'tsconfig.json': json({ extends: ['./first.json', './second.json'] }),
    'first.json': json({ compilerOptions: { paths: { '@lib/*': ['./wrong/*'], '@old/*': ['./src/lib/*'] } } }),
    'second.json': json({ compilerOptions: { paths: { '@lib/*': ['./src/lib/*'] } } }),
    'wrong/value.ts': 'export const value = 0;\n',
  };
  assert.deepEqual(resolve(files), { file: 'src/lib/value.ts' });
  assert.deepEqual(resolve(files, '@old/value'), { external: '@old/value', eco: 'npm' });
});

test('a later config without paths does not erase aliases from an earlier config', () => {
  assert.deepEqual(resolve({
    'tsconfig.json': json({ extends: ['./aliases.json', './strict.json'] }),
    'aliases.json': json({ compilerOptions: { paths: { '@lib/*': ['./src/lib/*'] } } }),
    'strict.json': json({ compilerOptions: { strict: true } }),
  }), { file: 'src/lib/value.ts' });
});

test('child paths override inherited paths, including an explicitly empty map', () => {
  const base = {
    'aliases.json': json({ compilerOptions: { paths: { '@lib/*': ['./wrong/*'] } } }),
    'wrong/value.ts': 'export const value = 0;\n',
  };
  assert.deepEqual(resolve({ ...base,
    'tsconfig.json': json({ extends: ['./aliases.json'], compilerOptions: { paths: { '@lib/*': ['./src/lib/*'] } } }),
  }), { file: 'src/lib/value.ts' });
  assert.deepEqual(resolve({ ...base,
    'tsconfig.json': json({ extends: ['./aliases.json'], compilerOptions: { paths: {} } }),
  }), { external: '@lib/value', eco: 'npm' });
});

test('legacy baseUrl keeps its declaring directory when inherited beside a paths map', () => {
  assert.deepEqual(resolve({
    'tsconfig.json': json({ extends: ['./configs/location.json', './aliases.json'] }),
    'configs/location.json': json({ compilerOptions: { baseUrl: '../src' } }),
    'aliases.json': json({ compilerOptions: { paths: { '@lib/*': ['lib/*'] } } }),
  }), { file: 'src/lib/value.ts' });
});

test('a child can override baseUrl and retain inherited paths', () => {
  assert.deepEqual(resolve({
    'tsconfig.json': json({ extends: ['./aliases.json'], compilerOptions: { baseUrl: './src' } }),
    'aliases.json': json({ compilerOptions: { baseUrl: './wrong', paths: { '@lib/*': ['lib/*'] } } }),
    'wrong/lib/value.ts': 'export const value = 0;\n',
  }), { file: 'src/lib/value.ts' });
});

test('single-string extends still resolves aliases', () => {
  assert.deepEqual(resolve({
    'tsconfig.json': json({ extends: './aliases.json' }),
    'aliases.json': json({ compilerOptions: { paths: { '@lib/*': ['./src/lib/*'] } } }),
  }), { file: 'src/lib/value.ts' });
});

test('cycles in extends arrays terminate while independent bases remain usable', () => {
  assert.deepEqual(resolve({
    'tsconfig.json': json({ extends: ['./loop.json', './aliases.json'] }),
    'loop.json': json({ extends: ['./tsconfig.json'] }),
    'aliases.json': json({ compilerOptions: { paths: { '@lib/*': ['./src/lib/*'] } } }),
  }), { file: 'src/lib/value.ts' });
});
