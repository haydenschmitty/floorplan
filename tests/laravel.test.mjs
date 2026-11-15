// PHP and Laravel: namespaces and `use` imports resolved through composer's PSR-4 folders, Laravel's
// routes under their groups and route files, endpoints placed in the controller method that answers
// them, Wayfinder calls and Inertia pages linked to their endpoints, and Health's sign-in check reading
// route, group, controller and form-request checks (Laravel + Inertia + Wayfinder sample in fixtures/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { extract, stripPhp } = await lib('extract.mjs');
const php = (src, file = 'routes/web.php') => extract(src, 'php', file);
const keys = (r) => r.routes.map((x) => `${x.method} ${x.path}`);

let root, graph;
before(() => {
  root = makeProject({}, { arch: {
    project: { name: 'shop', summary: 'Test fixture.' },
    nodes: [
      { id: 'server', label: 'Server', kind: 'service', summary: 'The Laravel app.', paths: ['app/**', 'routes/**', 'bootstrap/**'] },
      { id: 'web', label: 'Website', kind: 'ui', summary: 'The Inertia pages.', paths: ['resources/**'] },
      { id: 'client', label: 'Phone app', kind: 'ui', summary: 'The phone app.', paths: ['client/**'] },
    ],
  } });
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'laravel-app'), root, { recursive: true });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('PHP: namespaces, use imports (grouped, aliased, traits) and the classes a file names', () => {
  const r = php([
    `<?php`,
    `namespace App\\Http\\Controllers;`,
    ``,
    `use App\\Models\\{Order, Product as Item};`,
    `use Illuminate\\Http\\Request;`,
    `use function App\\Support\\money;`,
    ``,
    `/** Everything about the customer's orders. */`,
    `final class OrderController extends Controller implements HasReports`,
    `{`,
    `    use Concerns\\PaysOut;`,
    ``,
    `    public function index(Request $request, ?Item $item): Response`,
    `    {`,
    `        $fn = function () use ($request) { return Helper::make(); };`,
    `        return new Presenter(\\Carbon\\Carbon::now());`,
    `    }`,
    `}`,
  ].join('\n'), 'app/Http/Controllers/OrderController.php');
  assert.deepEqual(r.imports.map((i) => i.spec).sort(), [
    'App\\Http\\Controllers\\Concerns\\PaysOut', 'App\\Http\\Controllers\\Controller', 'App\\Http\\Controllers\\HasReports',
    'App\\Http\\Controllers\\Helper', 'App\\Http\\Controllers\\Presenter', 'App\\Http\\Controllers\\Response',
    'App\\Models\\Order', 'App\\Models\\Product', 'Carbon\\Carbon', 'Illuminate\\Http\\Request',
  ]);
  assert.deepEqual(r.classes, ['App\\Http\\Controllers\\OrderController']);
  assert.equal(r.doc, "Everything about the customer's orders.");
  // its methods, for the endpoints they answer, with the classes their parameters take
  assert.deepEqual(r.methods.map((m) => [m.name, m.line, m.types]), [['index', 13, ['Illuminate\\Http\\Request', 'App\\Models\\Product']]]);
});

test('PHP: comments and the HTML around <?php … ?> are not code; attributes and heredocs are handled', () => {
  const src = `<p>Don't</p>\n<?php\n# a comment\n#[Route('/x')]\n$a = <<<EOT\nit's "here"\nEOT;\n// gone\n$b = 'it\\'s'; ?>\n<b>it's</b>`;
  const out = stripPhp(src);
  assert.equal(out.length, src.length, 'offsets are kept');
  assert.ok(!out.includes("Don't") && !out.includes('a comment') && !out.includes('gone') && !out.includes("<b>"));
  assert.ok(out.includes("#[Route('/x')]") && out.includes("$b = 'it\\'s';"));
  assert.ok(!out.includes('"here"'), 'a heredoc becomes a blank string');
});

test('Laravel: groups give their prefix, name and middleware to the routes inside, and resources expand', () => {
  const r = php([
    `<?php`,
    `use App\\Http\\Controllers\\{OrderController, PhotoController, PingController};`,
    `Route::prefix('shop')->name('shop.')->middleware(['auth', 'verified'])->group(function () {`,
    `    Route::get('/orders', [OrderController::class, 'index'])->name('orders.index');`,
    `    Route::match(['get', 'post'], 'orders/search', [OrderController::class, 'search'])->middleware('throttle:10,1');`,
    `    Route::group(['prefix' => 'admin', 'as' => 'admin.', 'middleware' => 'can:manage'], function () {`,
    `        Route::delete('orders/{order}', [OrderController::class, 'destroy'])->withoutMiddleware('verified')->name('orders.destroy');`,
    `    });`,
    `    Route::controller(OrderController::class)->prefix('legacy')->group(function () {`,
    `        Route::get('list', 'index');`,
    `    });`,
    `});`,
    `Route::resource('photos', PhotoController::class)->only(['index', 'show', 'update']);`,
    `Route::apiResource('photos.comments', PhotoController::class)->except(['destroy']);`,
    `Route::get('/ping', PingController::class);`,
    `Route::get('/old', 'LegacyController@show');`,
    `Route::view('/welcome', 'welcome');`,
    `Route::get('/go', fn () => redirect('/shop/orders'));`,
    `Route::get('/count', fn () => DB::table('orders')->count());`,
    `Route::bind('order', fn ($v) => $v);`,
  ].join('\n'));
  assert.deepEqual(keys(r), [
    'GET /shop/orders', 'GET /shop/orders/search', 'POST /shop/orders/search', 'DELETE /shop/admin/orders/{order}', 'GET /shop/legacy/list',
    'GET /photos', 'GET /photos/{photo}', 'PUT /photos/{photo}', 'PATCH /photos/{photo}',
    'GET /photos/{photo}/comments', 'POST /photos/{photo}/comments', 'GET /photos/{photo}/comments/{comment}', 'PUT /photos/{photo}/comments/{comment}', 'PATCH /photos/{photo}/comments/{comment}',
    'GET /ping', 'GET /old', 'GET /welcome', 'GET /go', 'GET /count',
  ]);
  const at = (k) => r.routes.find((x) => `${x.method} ${x.path}` === k);
  assert.equal(at('GET /shop/orders').routeName, 'shop.orders.index');
  assert.deepEqual(at('GET /shop/orders').mw, ['auth', 'verified']);
  assert.deepEqual(at('POST /shop/orders/search').mw, ['auth', 'verified', 'throttle:10,1']);
  // the older array form, and withoutMiddleware taking one back
  assert.equal(at('DELETE /shop/admin/orders/{order}').routeName, 'shop.admin.orders.destroy');
  assert.deepEqual(at('DELETE /shop/admin/orders/{order}').mw, ['auth', 'can:manage']);
  // controller groups take the method name alone; an invokable controller answers with __invoke
  assert.deepEqual(at('GET /shop/legacy/list').action, { cls: 'App\\Http\\Controllers\\OrderController', fn: 'index' });
  assert.deepEqual(at('GET /ping').action, { cls: 'App\\Http\\Controllers\\PingController', fn: '__invoke' });
  assert.deepEqual(at('GET /old').action, { cls: 'App\\Http\\Controllers\\LegacyController', fn: 'show' });
  assert.equal(at('PUT /photos/{photo}').routeName, 'photos.update');
  // a closure that only redirects or a plain view has nothing to protect; one that reads the database does
  assert.equal(at('GET /go').quiet, true);
  assert.equal(at('GET /welcome').quiet, true);
  assert.equal(at('GET /count').quiet, undefined);
});

test('Laravel: route files loaded inside a group are mounts that carry the group with them', () => {
  const web = php([
    `<?php`,
    `Route::middleware('auth')->prefix('app')->name('app.')->group(function () {`,
    `    require __DIR__.'/app/orders.php';`,
    `    foreach (['billing', 'team'] as $area) {`,
    `        if (is_file($path = __DIR__.'/app/'.$area.'.php')) { require $path; }`,
    `    }`,
    `});`,
    `Route::prefix('admin')->middleware('can:admin')->group(base_path('routes/admin.php'));`,
    `require __DIR__.'/auth.php';`,
  ].join('\n'));
  assert.deepEqual(web.mounts.map((m) => `${m.spec} ${m.prefix} ${m.as || ''} ${(m.mw || []).join(',')}`), [
    '@base/routes/admin.php admin  can:admin',
    './app/orders.php app app. auth',
    './auth.php   ',
    './app/billing.php app app. auth',
    './app/team.php app app. auth',
  ]);
  // bootstrap/app.php: api routes live under /api with the api group, web routes get the web group
  const boot = php(`<?php\nreturn Application::configure(basePath: dirname(__DIR__))\n  ->withRouting(web: __DIR__.'/../routes/web.php', api: __DIR__.'/../routes/api.php', apiPrefix: 'api/v1')\n  ->create();\n`, 'bootstrap/app.php');
  assert.deepEqual(boot.mounts.map((m) => `${m.spec} ${m.prefix} ${m.mw.join(',')}`), ['./../routes/web.php  web', './../routes/api.php api/v1 api']);
});

test('Inertia: the page each controller method renders', () => {
  const r = php(`<?php\nnamespace App\\Http\\Controllers;\nclass OrderController {\n    public function index() { return Inertia::render('orders/index', []); }\n    public function show() { return inertia('Orders/Show'); }\n}\n`, 'app/Http/Controllers/OrderController.php');
  assert.deepEqual(r.inertia.map((x) => `${x.fn} ${x.page}`), ['index orders/index', 'show Orders/Show']);
});

test('endpoints get the prefix, name and middleware of every group and route file around them', () => {
  assert.deepEqual(routeKeys(graph), [
    'DELETE /admin/products/{product}', 'GET /', 'GET /about', 'GET /admin/products', 'GET /api/v1/me', 'GET /api/v1/orders', 'GET /api/v1/orders/{order}',
    'GET /api/v1/ping', 'GET /legal/terms', 'GET /login', 'GET /orders', 'GET /orders/{order}', 'GET /reports', 'GET /reports/{report}', 'GET /stats',
    'PATCH /api/v1/orders/{order}', 'PATCH /orders/{order}', 'POST /admin/products', 'POST /api/v1/orders', 'POST /api/v1/webhooks/carrier',
    'POST /feedback', 'POST /login', 'POST /orders', 'POST /quotes', 'PUT /api/v1/orders/{order}',
  ]);
});

test('an endpoint answered by a controller method sits in that controller, at the method, with its doc comment', () => {
  const at = (k) => graph.routes.find((r) => `${r.m} ${r.p}` === k);
  assert.deepEqual([at('GET /orders/{order}').f, at('GET /orders/{order}').l, at('GET /orders/{order}').h], ['app/Http/Controllers/OrderController.php', 26, 'show']);
  assert.equal(at('GET /orders/{order}').doc, 'One order with its items.');
  assert.equal(at('GET /api/v1/me').f, 'app/Http/Controllers/Api/AccountController.php', 'a file loaded in a loop still gets its group');
  // a closure stays where it's written
  assert.deepEqual([at('GET /').f, at('GET /').l], ['routes/web.php', 17]);
});

test("PHP files link to the classes they use, through composer's PSR-4 folders; outside packages are named by vendor", () => {
  const imports = new Set(graph.links.filter((l) => l.k === 'import').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)}`));
  for (const want of [
    'app/Http/Controllers/OrderController.php -> app/Http/Requests/StoreOrderRequest.php',
    'app/Http/Controllers/OrderController.php -> app/Models/Order.php',
    'app/Models/Order.php -> app/Models/OrderItem.php', // OrderItem::class in the same namespace, no `use`
    'bootstrap/app.php -> app/Http/Middleware/EnsureUserIsStaff.php',
    'bootstrap/app.php -> routes/web.php',
    'routes/api.php -> routes/v1/orders.php',
  ]) assert.ok(imports.has(want), want);
  const scan = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8'));
  assert.deepEqual(scan.externals.filter((e) => e.eco === 'composer').map((e) => e.name).sort(), ['Illuminate', 'Inertia']);
});

test("Wayfinder calls, plain requests and the phone app's requests reach the endpoints that answer them", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${[...l.labels].sort().join(', ')}`).sort();
  assert.deepEqual(http, [
    'client/src/api.ts -> app/Http/Controllers/Api/AccountController.php GET /api/v1/me',
    'client/src/api.ts -> app/Http/Controllers/Api/OrderController.php GET /api/v1/orders, GET /api/v1/orders/{order}',
    'resources/js/pages/about.tsx -> routes/web.php GET /about',
    'resources/js/pages/admin/products/index.tsx -> app/Http/Controllers/Admin/ProductController.php DELETE /admin/products/{product}, GET /admin/products',
    'resources/js/pages/auth/login.tsx -> app/Http/Controllers/Auth/LoginController.php GET /login, POST /login',
    'resources/js/pages/orders/index.tsx -> app/Http/Controllers/OrderController.php GET /orders, GET /orders/{order}',
    'resources/js/pages/orders/show.tsx -> app/Http/Controllers/OrderController.php GET /orders, GET /orders/{order}, PATCH /orders/{order}',
  ]);
});

test('each Inertia page is a screen at the address of the endpoint that renders it', () => {
  assert.deepEqual(graph.screens.map((s) => `${s.url} ${s.file}`).sort(), [
    '/about resources/js/pages/about.tsx',
    '/admin/products resources/js/pages/admin/products/index.tsx',
    '/login resources/js/pages/auth/login.tsx',
    '/orders resources/js/pages/orders/index.tsx',
    '/orders/:order resources/js/pages/orders/show.tsx',
  ]);
  // behind the orders screen: the controller that serves it and the data it reads
  const orders = graph.screens.find((s) => s.url === '/orders');
  const behind = orders.behind.map((b) => b.id);
  assert.ok(behind.includes('f:app/Http/Controllers/OrderController.php'), JSON.stringify(behind));
});

test('Health: a Laravel endpoint is protected by its middleware, its groups, its controller, its form request or a check inside it', () => {
  // protected: the auth group (/orders), an alias inside a group of the app's own (/admin, back-office → staff),
  // controller middleware for show() only, a form request that checks the user (/quotes), Gate::authorize (/stats),
  // auth:sanctum around files loaded in a loop (/api/v1/*); public on purpose: guest pages, redirects, plain pages, ping, legal
  assert.deepEqual(openEndpoints(graph), ['GET /reports', 'POST /api/v1/webhooks/carrier', 'POST /feedback']);
  const feedback = graph.health.issues.find((i) => i.id === 'open-endpoints:app/Http/Controllers/FeedbackController.php');
  assert.equal(feedback.severity, 'high', 'a form request that allows everyone is no check');
  assert.match(feedback.fix, /POST \/feedback — app\/Http\/Controllers\/FeedbackController\.php:10 \(store\), route registered in routes\/web\.php:\d+/);
  assert.match(feedback.fix, /the '(auth|staff|can)' middleware|the same check/);
});
