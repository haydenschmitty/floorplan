// Plain PHP sites, with no framework routing: each script under the document root (public/, public_html/,
// www/, htdocs/) is an endpoint at its own address, while scripts other scripts include, files under _ or .
// folders, and a framework's front controller (an index.php loading Composer's autoloader, itself or through a
// file it requires) are not.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, run, readJson, cleanup } from './helpers.mjs';
import path from 'node:path';

const roots = [];
after(() => roots.forEach(cleanup));
const scan = (files) => {
  const root = makeProject(files);
  roots.push(root);
  run('scan.mjs', root);
  return readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
};
const keys = (s) => s.routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line}`).sort();

test('each script under the document root is a page at its own address; included scripts are not', () => {
  const s = scan({
    'site/public_html/index.php': '<?php\nrequire __DIR__ . "/includes/db.php";\ninclude __DIR__ . "/_partials/header.php";\n?>\n<h1>Orders</h1>\n',
    'site/public_html/orders/save.php': '<?php\nrequire __DIR__ . "/../includes/db.php";\nif ($_SERVER["REQUEST_METHOD"] === "POST") { echo "ok"; }\n',
    'site/public_html/orders/index.php': '<html>\n<?php\nrequire_once __DIR__ . "/../includes/db.php";\necho json_encode([]);\n',
    'site/public_html/includes/db.php': '<?php\n$db = new PDO("sqlite:orders.db");\n',
    'site/public_html/_partials/header.php': '<?php echo "<header></header>";\n',
    'site/public_html/.well-known/check.php': '<?php echo "ok";\n',
    'site/lib/mail.php': '<?php\nfunction send_mail() {}\n',
    'site/public_html/js/app.js': 'export const save = () => fetch("/orders/save.php", { method: "POST" });\nexport const list = () => fetch("/orders");\n',
  });
  assert.deepEqual(keys(s), [
    'ANY / site/public_html/index.php:1',
    'ANY /orders site/public_html/orders/index.php:2',
    'ANY /orders/save.php site/public_html/orders/save.php:1',
  ]);
  const http = s.http.map((e) => `${e.from} -> ${e.to} ${e.path}`).sort();
  assert.deepEqual(http, [
    'site/public_html/js/app.js -> site/public_html/orders/index.php /orders',
    'site/public_html/js/app.js -> site/public_html/orders/save.php /orders/save.php',
  ]);
});

test("a framework's front controller is not a page, and its routes stay the framework's", () => {
  const s = scan({
    'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
    'public/index.php': "<?php\nrequire __DIR__.'/../vendor/autoload.php';\n$app = require_once __DIR__.'/../bootstrap/app.php';\n$app->handleRequest(Illuminate\\Http\\Request::capture());\n",
    'public/health.php': '<?php echo "ok";\n',
    'bootstrap/app.php': '<?php\nreturn 1;\n',
    'routes/web.php': "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/orders', fn () => view('orders'));\n",
  });
  assert.deepEqual(keys(s).map((k) => k.split(' ').slice(0, 2).join(' ')), ['GET /orders']);
});

test("Symfony's front controllers are not pages: Composer's autoloader through autoload_runtime.php, or through a file index.php requires", () => {
  for (const [index, extra] of [
    ["<?php\nuse App\\Kernel;\nrequire_once dirname(__DIR__).'/vendor/autoload_runtime.php';\nreturn fn (array $context) => new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);\n", {}],
    ["<?php\nuse App\\Kernel;\nrequire dirname(__DIR__).'/config/bootstrap.php';\n$kernel = new Kernel($_SERVER['APP_ENV'], (bool) $_SERVER['APP_DEBUG']);\n", { 'config/bootstrap.php': "<?php\nrequire dirname(__DIR__).'/vendor/autoload.php';\n" }],
  ]) {
    const s = scan({ 'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }), 'public/index.php': index, ...extra });
    assert.deepEqual(keys(s), []);
  }
  // a site whose index.php requires a file that loads nothing still has its pages
  const s = scan({ 'public/index.php': "<?php\nrequire __DIR__.'/../lib/db.php';\necho 'home';\n", 'lib/db.php': '<?php\n$db = 1;\n' });
  assert.deepEqual(keys(s).map((k) => k.split(' ').slice(0, 2).join(' ')), ['ANY /']);
});
