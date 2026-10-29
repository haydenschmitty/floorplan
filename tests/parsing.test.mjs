// What Floorplan reads out of source files: imports, endpoints, web requests and doc comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, run, readJson, cleanup } from './helpers.mjs';

const { extract, flattenTemplates, cleanDoc, findBigTreeRoot } = await lib('extract.mjs');
const routes = (src, lang, file) => extract(src, lang, file).routes.map((r) => `${r.method} ${r.path}`);

test('JavaScript: imports and Express endpoints', () => {
  const r = extract([
    `import express from 'express';`,
    `import { db, cache as c } from './db.js';`,
    `const router = express.Router();`,
    `router.get('/orders', list);`,
    `router.post('/orders/:id/refund', refund);`,
  ].join('\n'), 'javascript', 'api/orders.js');
  assert.deepEqual(r.imports.map((i) => i.spec), ['express', './db.js']);
  assert.deepEqual(r.imports[1].names, ['db', 'cache']);
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['GET /orders', 'POST /orders/:id/refund']);
  assert.equal(r.routes[0].var, 'router');
});

test('Next.js app router: each exported method is an endpoint at the folder path', () => {
  assert.deepEqual(
    routes(`export async function GET(req) { return Response.json([]) }\nexport async function POST(req) {}\n`, 'typescript', 'web/app/api/orders/route.ts'),
    ['GET /api/orders', 'POST /api/orders'],
  );
});

test('Flask: blueprint prefix, methods list and handler docstring', () => {
  const r = extract([
    `"""Order endpoints."""`,
    `from flask import Blueprint`,
    `bp = Blueprint('orders', __name__, url_prefix='/api')`,
    ``,
    `@bp.route('/orders', methods=['GET', 'POST'])`,
    `def list_orders():`,
    `    """List them."""`,
    `    return []`,
  ].join('\n'), 'python', 'api/orders.py');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['GET /orders', 'POST /orders']);
  assert.equal(r.routes[0].handler, 'list_orders');
  assert.equal(r.routes[0].doc, 'List them.');
  assert.deepEqual(r.routers, { bp: '/api' });
  assert.equal(r.doc, 'Order endpoints.');
});

test('FastAPI: router prefix and path parameters', () => {
  const r = extract([
    `from fastapi import APIRouter`,
    `router = APIRouter(prefix="/items")`,
    `@router.get("/{item_id}")`,
    `async def read_item(item_id: int):`,
    `    return {}`,
  ].join('\n'), 'python', 'api/items.py');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['GET /{item_id}']);
  assert.equal(r.routes[0].handler, 'read_item');
  assert.deepEqual(r.routers, { router: '/items' });
});

test('Go: grouped imports and http.HandleFunc endpoints', () => {
  const r = extract(`package main\nimport (\n  "net/http"\n  "example.com/app/store"\n)\nfunc main() { http.HandleFunc("/health", h) }\n`, 'go', 'cmd/main.go');
  assert.deepEqual(r.imports.map((i) => i.spec), ['net/http', 'example.com/app/store']);
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['ANY /health']);
});

test('web requests: fetch with template strings and axios with a method', () => {
  const r = extract([
    'export const load = (id) => fetch(`/api/orders/${id}`);',
    `export const pay = (id) => axios.post('/api/orders/' + id + '/pay');`,
  ].join('\n'), 'typescript', 'web/src/api.ts');
  const calls = r.calls.map((c) => `${c.method || '*'} ${c.path}`);
  assert.ok(calls.includes('* /api/orders/${x}'), calls.join(', '));
  assert.ok(calls.includes('POST /api/orders/'), calls.join(', '));
});

test('flattenTemplates replaces every ${…} with a placeholder, nested or not', () => {
  assert.equal(flattenTemplates('fetch(`${API}/users/${id}`)'), 'fetch(`${x}/users/${x}`)');
});

test('doc comments: JSDoc is cleaned, license headers are ignored', () => {
  assert.equal(cleanDoc('/**\n * Lists orders.\n * @param x\n */'), 'Lists orders.');
  assert.equal(cleanDoc('# Copyright 2020 Example Corp'), null);
});

// PHP is inspected as text; the fixtures deliberately include code that must never run.
test('PHP: literal includes resolve from the source directory, with real line numbers', () => {
  const r = extract(`<?php
// An introductory comment.
require 'local.php';
include_once(__DIR__ . '/shared.php');
require_once dirname(__FILE__) . '/../bootstrap.php';
include dirname(__DIR__, 2) . '/config.php';
`, 'php', 'app/pages/orders.php');
  assert.deepEqual(r.imports.map((i) => [i.exactPath, i.line]), [
    ['app/pages/local.php', 3], ['app/pages/shared.php', 4], ['app/bootstrap.php', 5], ['config.php', 6],
  ]);
});

test('PHP: examples, comments, HTML and dynamic includes are ignored', () => {
  const r = extract(`include 'html.php';
<?php
// require 'comment.php';
/* include 'block.php'; */
# require 'hash.php';
$example = "require 'string.php';";
$doc = <<<'TEXT'
require 'heredoc.php';
TEXT;
include $path;
include __DIR__ . '/prefix-' . $name;
include "interpolated-$name.php";
require '/outside.php';
require '../../../outside.php';
include SERVER_ROOT . 'unproven.php';
require 'real.php';
?> include 'html-again.php';`, 'php', 'app/page.php');
  assert.deepEqual(r.imports.map((i) => i.exactPath), ['app/real.php']);
});

test('PHP: document-root scripts use the first PHP statement as their source location', () => {
  const src = '<h1>Welcome</h1>\n<?php\n/* Page description. */\n\necho "Hello";';
  const r = extract(src, 'php', 'app/public/index.php');
  assert.deepEqual(r.routes.map((r) => [r.path, r.line]), [['/', 5]]);
  assert.deepEqual(routes(src, 'php', 'app/public/health.php'), ['ANY /health.php']);
  assert.deepEqual(routes(src, 'php', 'app/private/health.php'), []);
  assert.deepEqual(routes(src, 'php', 'app/public/_shared.php'), []);
  assert.deepEqual(routes(src, 'php', 'custom/admin/modules/orders/default.php'), []);
});

test('BigTree: detection requires framework code in a site folder', () => {
  assert.equal(findBigTreeRoot('<?php BigTreeAutoModule::clearCache();', 'cms/custom/admin/modules/orders/_header.php'), 'cms');
  assert.equal(findBigTreeRoot('<?php BigTree::getPage();', 'templates/basic.php'), '');
  assert.equal(findBigTreeRoot('<?php // BigTree::getPage();', 'cms/templates/basic.php'), null);
  assert.equal(findBigTreeRoot('<?php $s = "BigTree::getPage()";', 'cms/templates/basic.php'), null);
  assert.equal(findBigTreeRoot('<?php BigTree::getPage();', 'other.php'), null);
});

test('BigTree: office pages, AJAX handlers and shared wrappers stay within the site', () => {
  const files = new Set([
    'cms/custom/admin/modules/orders/_header.php', 'cms/custom/admin/modules/orders/_footer.php',
    'cms/custom/admin/modules/orders/refund/_header.php', 'cms/custom/admin/modules/orders/refund/_footer.php',
    'cms/custom/admin/modules/orders/refund/default.php', 'cms/templates/ajax/_header.php',
  ]);
  const options = { bigtreeRoot: 'cms', files };
  const src = '<?php\n// Handles a refund.\nrequire SERVER_ROOT . "custom/shared.php";\necho "Done";';
  const r = extract(src, 'php', 'cms/custom/admin/modules/orders/refund/default.php', options);
  assert.deepEqual(r.routes.map((r) => [r.path, r.line]), [['/admin/orders/refund', 3]]);
  assert.deepEqual(r.imports.map((i) => i.exactPath), [
    'cms/custom/shared.php', 'cms/custom/admin/modules/orders/_header.php',
    'cms/custom/admin/modules/orders/refund/_header.php', 'cms/custom/admin/modules/orders/refund/_footer.php',
    'cms/custom/admin/modules/orders/_footer.php',
  ]);
  assert.deepEqual(extract(src, 'php', 'cms/custom/admin/modules/orders/refund.php', options).routes, []);
  assert.deepEqual(extract(src, 'php', 'cms/custom/admin/modules/orders/_header.php', options).routes, []);
  assert.equal(extract(src, 'php', 'cms/custom/admin/ajax/search.php', options).routes[0].path, '/admin/ajax/search');
  assert.equal(extract(src, 'php', 'cms/templates/ajax/search.php', options).routes[0].path, '/ajax/search');
  assert.equal(extract(src, 'php', 'cms/site/health.php', options).routes[0].path, '/health.php');
  assert.deepEqual(extract(src, 'php', 'other/custom/admin/modules/orders/default.php', options).routes, []);
  assert.deepEqual(extract(src, 'php', 'cms/templates/basic.php', options).routes, []);
});

test('PHP scan: BigTree rules are site-scoped; malformed old config and PHP never stop scanning', () => {
  const root = makeProject({
    'cms/custom/admin/modules/orders/_header.php': '<?php BigTreeAutoModule::clearCache();',
    'cms/custom/admin/modules/orders/default.php': '<?php\n// Orders.\ninclude __DIR__ . "/_header.php";\necho "Orders";',
    'cms/site/health.php': '<?php\n// Health.\necho "OK";',
    'cms/templates/basic.php': '<?php echo "Page";',
    'other/custom/admin/modules/orders/default.php': '<?php include "helper.php";',
    'other/custom/admin/modules/orders/helper.php': '<?php echo "Helper";',
    'other/public/status.php': '<?php\nexit(99);',
    'broken.php': '<?php $broken = "unterminated',
    'floorplan/php-cms.json': '{ malformed old configuration',
    'floorplan/architecture.json': JSON.stringify({ project: { name: 'PHP sample' }, nodes: [{ id: 'app', label: 'Application', kind: 'service', paths: ['**'] }] }),
  });
  try {
    run('scan.mjs', root);
    const scan = readJson(root + '/floorplan/.cache/scan.json');
    assert.deepEqual(scan.routes.map((r) => [r.path, r.line]).sort(), [
      ['/admin/orders', 3], ['/health.php', 3], ['/status.php', 2],
    ]);
    assert.ok(scan.files.some((f) => f.path === 'broken.php'));
    assert.ok(scan.edges.some((e) => e.from === 'other/custom/admin/modules/orders/default.php' && e.to === 'other/custom/admin/modules/orders/helper.php'));
    assert.ok(scan.edges.some((e) => e.from === 'cms/custom/admin/modules/orders/default.php' && e.to === 'cms/custom/admin/modules/orders/_header.php'));
    run('build.mjs', root, '--no-claude-md');
  } finally { cleanup(root); }
});
