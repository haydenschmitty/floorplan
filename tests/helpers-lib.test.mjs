// The small helpers everything else leans on: globs in architecture.json, file classification,
// command-line flags, fallback names, and endpoint path matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const { compileGlob, classify, parseArgs } = await lib('common.mjs');
const { humanize, fallbackFileName, fallbackRouteName } = await lib('names.mjs');
const { routeSegments } = await lib('routes.mjs');

test('globs: ** spans folders, * stays in one, braces and bare folders work', () => {
  const g = (glob, p) => compileGlob(glob).test(p);
  assert.ok(g('src/**/*.ts', 'src/a/b.ts'));
  assert.ok(g('src/**/*.ts', 'src/b.ts'));
  assert.ok(!g('src/*.ts', 'src/a/b.ts'));
  assert.ok(g('src/{a,b}', 'src/b/z.js'), 'a braced folder claims everything under it');
  assert.ok(g('src/components', 'src/components/x/y.tsx'), 'a plain folder claims everything under it');
  assert.ok(!g('src/components', 'src/components-old/y.tsx'));
  assert.ok(g('**/*.test.ts', 'x.test.ts'));
  assert.ok(g('./src/', 'src/a.ts'), 'leading ./ and trailing / are ignored');
});

test('globs: a bracketed folder name ([id], [...slug]) is a folder, not a character class', () => {
  const g = (glob, p) => compileGlob(glob).test(p);
  assert.ok(g('app/orders/[id]/**', 'app/orders/[id]/page.tsx'));
  assert.ok(!g('app/orders/[id]/**', 'app/orders/i/page.tsx'));
  assert.ok(g('app/[...slug]', 'app/[...slug]/page.tsx'));
  assert.ok(g('app/[[...slug]]/page.tsx', 'app/[[...slug]]/page.tsx'));
  assert.ok(g('pages/orders/[id].tsx', 'pages/orders/[id].tsx'), 'dynamic route file matches literally');
  assert.ok(!g('pages/orders/[id].tsx', 'pages/orders/i.tsx'), 'dynamic route file is not a character class');
  assert.ok(g('server/api/users/[id].get.ts', 'server/api/users/[id].get.ts'), 'Nuxt multi-extension dynamic route matches literally');
  assert.ok(g('pages/docs/[[...slug]].tsx', 'pages/docs/[[...slug]].tsx'), 'optional catch-all route file matches literally');
  assert.ok(g('src/[a-z].ts', 'src/k.ts'), 'single-char range at file start remains a character class');
  assert.ok(g('src/file[12].ts', 'src/file2.ts'), 'inside a name, brackets still match one character');
});

test('globs: a more specific pattern scores higher', () => {
  assert.ok(compileGlob('api/routes/**').specificity > compileGlob('api/**').specificity);
});

test('classify: code, docs, lock files, assets and generated files', () => {
  assert.deepEqual(classify('src/a.ts', 100), { category: 'code', lang: 'typescript' });
  assert.deepEqual(classify('app/main.py', 100), { category: 'code', lang: 'python' });
  assert.equal(classify('README.md', 10).category, 'docs');
  assert.equal(classify('package-lock.json', 10).category, 'lock');
  assert.equal(classify('logo.png', 10).category, 'asset');
  assert.equal(classify('dist/app.min.js', 10).category, 'generated');
});

test('parseArgs: positionals, --flag value, --flag=value and bare flags', () => {
  assert.deepEqual(parseArgs(['root', '--port', '9', '--no-open', '--x=1']), { _: ['root'], port: '9', 'no-open': true, x: '1' });
});

test('fallback names read like plain words', () => {
  assert.equal(humanize('order_service'), 'Order service');
  assert.equal(humanize('OrderService'), 'Order service');
  assert.equal(fallbackFileName('api/routes/order_service.py'), 'Order service');
  assert.equal(fallbackRouteName({ method: 'POST', path: '/orders/:id/refund' }), 'Create orders refund');
});

test('endpoint paths: parameters in every framework style match anything', () => {
  assert.deepEqual(routeSegments('/orders/:id/refund'), ['orders', '*', 'refund']);
  assert.deepEqual(routeSegments('/orders/{id}'), ['orders', '*']);
});
