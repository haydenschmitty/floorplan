// Symfony: endpoints from #[Route] attributes (and legacy @Route docblocks) on controller methods and
// invokable classes, under the prefixes of the route imports that load them (config/routes.yaml,
// config/routes/*.yaml and *.php, or an overridden Kernel::configureRoutes()), following Symfony's own
// rules: a controller no import loads, an abstract class, or a dev-only import serves nothing. The
// front controller isn't a page, and the website's requests reach the controller that answers them
// (Symfony sample in fixtures/). Health doesn't judge Symfony sign-in yet, and says so.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const ARCH = { arch: {
  project: { name: 'shop', summary: 'Test fixture.' },
  nodes: [
    { id: 'server', label: 'Server', kind: 'service', summary: 'The Symfony app.', paths: ['src/**', 'config/**', 'public/**'] },
    { id: 'client', label: 'Phone app', kind: 'ui', summary: 'The phone app.', paths: ['client/**'] },
  ],
} };

let root, graph, scanOut;
before(() => {
  root = makeProject({}, ARCH);
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'symfony-app'), root, { recursive: true });
  scanOut = run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

const at = (k) => graph.routes.find((r) => `${r.m} ${r.p}` === k);

/** A small Symfony app written by the test: its endpoints, and what the scan printed. */
function symfony(files) {
  const dir = makeProject({ 'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }), ...files }, ARCH);
  try {
    const out = run('scan.mjs', dir);
    run('build.mjs', dir, '--no-claude-md');
    return { keys: routeKeys(readGraph(dir)), out };
  } finally { cleanup(dir); }
}
const controller = (ns, cls, body) => `<?php\nnamespace ${ns};\n\nuse Symfony\\Component\\Routing\\Attribute\\Route;\n\nclass ${cls}\n{\n${body}\n}\n`;

test("endpoints follow Symfony's rules: what the route imports load, under their prefixes, and nothing else", () => {
  assert.deepEqual(routeKeys(graph), [
    'ANY /',
    'GET /about', 'GET /admin/reports', 'GET /api/products', 'GET /api/products/{slug}', 'GET /health', 'GET /legacy/cart',
    'GET /orders', 'GET /orders/{id}', 'GET /ping', 'GET /status', 'GET /team',
    'PATCH /orders/{id}/address',
    'POST /checkout', 'POST /orders',
    'PUT /orders/{id}/address',
  ]);
  // left out on purpose, each for the reason Symfony has:
  //   /base           an abstract class
  //   /menu           the app's own Route attribute, not Symfony's
  //   /admin/ping     admin.php adds /ping itself: the prefix is only on its import
  //   /api/status     StatusController is excluded from the /api import and loaded again without the prefix
  //   /profiler       the Debug folder is only imported in dev (when@dev, and $routes->env() in admin.php)
  //   /webhooks/…     no import loads the Webhook folder
  //   public/index.php  the front controller (it loads vendor/autoload_runtime.php)
});

test('an endpoint sits at the method that answers it, with its doc comment; an invokable class at the class', () => {
  const where = (k) => [at(k).f, at(k).l, at(k).h];
  assert.deepEqual(where('ANY /'), ['src/Controller/HomeController.php', 12, 'index'], 'not the front controller');
  assert.deepEqual(where('GET /orders/{id}'), ['src/Controller/OrderController.php', 23, 'show']);
  assert.deepEqual(where('PUT /orders/{id}/address'), ['src/Controller/OrderController.php', 40, 'address'], 'a Route attribute over several lines');
  assert.equal(at('PUT /orders/{id}/address').doc, 'Changes where an order is delivered, until it ships.');
  assert.deepEqual(where('POST /checkout'), ['src/Controller/CheckoutController.php', 11, '__invoke']);
  assert.equal(at('POST /checkout').doc, 'Turns the cart into an order and starts the payment.');
  assert.deepEqual(where('GET /status'), ['src/Api/StatusController.php', 9, '__invoke']);
  // two Route attributes on one method: two endpoints, same place, same doc
  assert.deepEqual(where('GET /about'), where('GET /team'));
  assert.equal(at('GET /team').doc, "The shop's story and the people behind it.");
  assert.deepEqual(where('GET /legacy/cart'), ['src/Controller/LegacyController.php', 15, 'cart']);
});

test('a route defined in route config (YAML path and controller, PHP add()) sits at the controller method it names', () => {
  const where = (k) => [at(k).f, at(k).l, at(k).h];
  assert.deepEqual(where('GET /health'), ['src/Controller/HealthController.php', 10, '__invoke']);
  assert.equal(at('GET /health').doc, 'Tells the load balancer the shop is up.');
  assert.deepEqual(where('GET /ping'), ['src/Admin/ReportController.php', 17, 'ping']);
});

test('route names: the class name prefix and the import name prefix', () => {
  const scan = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8'));
  const name = (m, p) => scan.routes.find((r) => r.method === m && r.path === p)?.routeName;
  assert.equal(name('GET', '/orders/{id}'), 'order_show');
  assert.equal(name('GET', '/api/products/{slug}'), 'api_product_show');
  assert.equal(name('GET', '/admin/reports'), 'admin_reports');
  assert.equal(name('GET', '/status'), 'status');
});

test("the phone app's requests reach the controllers that answer them", () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${[...l.labels].sort().join(', ')}`).sort();
  assert.deepEqual(http, [
    'client/src/api.ts -> src/Api/ProductController.php GET /api/products, GET /api/products/{slug}',
    'client/src/api.ts -> src/Controller/OrderController.php GET /orders/{id}',
  ]);
});

test('the scan says how many Symfony endpoints it found and where their imports are', () => {
  assert.match(scanOut, /SYMFONY {2}16 endpoints/);
});

test("Health doesn't judge Symfony sign-in yet, says so, and no longer calls #[Route] unreadable", () => {
  assert.deepEqual(openEndpoints(graph), []);
  const endpoints = graph.health.checked.find((c) => c.check === 'endpoints');
  assert.match(endpoints.text, /Symfony/);
  assert.doesNotMatch(JSON.stringify(graph.health), /declares routes with #\[Route\]/);
});

test('path parameters: requirements and defaults written inline are left out of the address', () => {
  const { keys } = symfony({
    'config/routes.yaml': 'c:\n    resource: ../src/Controller/\n    type: attribute\n',
    'src/Controller/BlogController.php': controller('App\\Controller', 'BlogController',
      "    #[Route('/blog/{page<\\d+>?1}', methods: ['GET'])]\n    public function list() {}\n\n" +
      "    #[Route('/blog/{year<\\d{4}>}/{slug}', methods: ['GET'])]\n    public function show() {}"),
  });
  assert.deepEqual(keys, ['GET /blog/{page}', 'GET /blog/{year}/{slug}']);
});

test('a route name loaded twice: the later import wins, as in Symfony', () => {
  const { keys } = symfony({
    'config/routes.yaml': [
      'site:', '    resource: ../src/Controller/', '    type: attribute',
      'beta:', '    resource: App\\Beta\\HomeController', '    type: attribute', '    prefix: /beta',
    ].join('\n') + '\n',
    'src/Controller/HomeController.php': controller('App\\Controller', 'HomeController', "    #[Route('/', name: 'home')]\n    public function index() {}"),
    'src/Beta/HomeController.php': controller('App\\Beta', 'HomeController', "    #[Route('/', name: 'home')]\n    public function index() {}"),
  });
  assert.deepEqual(keys, ['ANY /beta']);
});

test("a Kernel that overrides configureRoutes() loads only what it imports, from the project's folder", () => {
  const { keys } = symfony({
    'src/Kernel.php': [
      '<?php', 'namespace App;', '',
      'use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;',
      'use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;',
      'use Symfony\\Component\\Routing\\Loader\\Configurator\\RoutingConfigurator;', '',
      'class Kernel extends BaseKernel', '{', '    use MicroKernelTrait;', '',
      '    protected function configureRoutes(RoutingConfigurator $routes): void',
      '    {',
      "        $routes->import($this->getProjectDir().'/src/Controller/', 'attribute')->prefix('/shop');",
      '    }', '}',
    ].join('\n') + '\n',
    // never read: the Kernel no longer imports config/routes.yaml
    'config/routes.yaml': 'c:\n    resource: ../src/Controller/\n    type: attribute\n    prefix: /ignored\n',
    'src/Controller/CartController.php': controller('App\\Controller', 'CartController', "    #[Route('/cart', methods: ['GET'])]\n    public function show() {}"),
  });
  assert.deepEqual(keys, ['GET /shop/cart']);
});

test('the Kernel of a Symfony 4 app: imports built from a variable, a class constant and the environment', () => {
  const { keys } = symfony({
    'src/Kernel.php': [
      '<?php', 'namespace App;', '',
      'use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;',
      'use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;',
      'use Symfony\\Component\\Routing\\RouteCollectionBuilder;', '',
      'class Kernel extends BaseKernel', '{', '    use MicroKernelTrait;', '',
      "    private const CONFIG_EXTS = '.{php,xml,yaml,yml}';", '',
      '    protected function configureRoutes(RouteCollectionBuilder $routes): void',
      '    {',
      "        $confDir = $this->getProjectDir().'/config';",
      "        $routes->import($confDir.'/{routes}/'.$this->environment.'/**/*'.self::CONFIG_EXTS, '/', 'glob');",
      "        $routes->import($confDir.'/{routes}/*'.self::CONFIG_EXTS, '/', 'glob');",
      "        $routes->import($confDir.'/{routes}'.self::CONFIG_EXTS, '/', 'glob');",
      '    }', '}',
    ].join('\n') + '\n',
    'config/routes/annotations.yaml': 'controllers:\n    resource: ../../src/Controller/\n    type: annotation\n    prefix: /api\n',
    'config/routes/prod/shop.yaml': 'shop:\n    path: /shop\n    controller: App\\Controller\\CartController::show\n',
    'config/routes/dev/debug.yaml': 'debug:\n    path: /debug\n    controller: App\\Controller\\CartController::show\n',
    'src/Controller/CartController.php': controller('App\\Controller', 'CartController', "    #[Route('/cart', methods: ['GET'])]\n    public function show() {}"),
  });
  assert.deepEqual(keys, ['ANY /shop', 'GET /api/cart']);
});

test("Sensio's @Route and @Method; API Platform's and bundles' imports aren't the app's files, and aren't unreadable", () => {
  const { keys, out } = symfony({
    'config/routes.yaml': [
      'controllers:', '    resource: ../src/Controller/', '    type: annotation',
      'api_platform:', '    resource: .', '    type: api_platform', '    prefix: /api',
      'errors:', "    resource: '@FrameworkBundle/Resources/config/routing/errors.xml'", '    prefix: /_error',
    ].join('\n') + '\n',
    'src/Controller/CartController.php': [
      '<?php', 'namespace App\\Controller;', '',
      'use Sensio\\Bundle\\FrameworkExtraBundle\\Configuration\\Method;',
      'use Sensio\\Bundle\\FrameworkExtraBundle\\Configuration\\Route;', '',
      '/**', ' * @Route("/cart")', ' */',
      'class CartController', '{',
      '    /**', '     * @Route("/items/{id}", name="cart_item")', '     * @Method({"PUT", "DELETE"})', '     */',
      '    public function item() {}', '}',
    ].join('\n') + '\n',
  });
  assert.deepEqual(keys, ['DELETE /cart/items/{id}', 'PUT /cart/items/{id}']);
  assert.doesNotMatch(out, /couldn't read/);
});

test('route config that imports itself in circles, or is very large, is read quickly', () => {
  const cart = { 'src/Controller/CartController.php': controller('App\\Controller', 'CartController', "    #[Route('/cart', methods: ['GET'])]\n    public function show() {}") };
  // twelve files each importing all of them (themselves included): Symfony refuses a file already being read
  const circles = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`config/routes/r${i}.yaml`, 'all:\n    resource: ./*.yaml\n    prefix: /x\nc:\n    resource: ../../src/Controller/\n    type: attribute\n']));
  let t = performance.now();
  const a = symfony({ ...circles, ...cart });
  assert.ok(a.keys.includes('GET /cart'), a.keys.slice(0, 3).join(', '));
  assert.ok(performance.now() - t < 20000, `circular imports took ${Math.round(performance.now() - t)} ms`);
  // a megabyte of routes
  const big = Array.from({ length: 20000 }, (_, i) => `r${i}:\n    path: /r${i}\n    controller: App\\Controller\\CartController::show\n`).join('');
  t = performance.now();
  const b = symfony({ 'config/routes.yaml': big, ...cart });
  assert.equal(b.keys.length, 20000);
  assert.ok(performance.now() - t < 20000, `a large routes.yaml took ${Math.round(performance.now() - t)} ms`);
});

test("an import whose path can't be read: its routes are kept at their own address, and the scan says why", () => {
  const { keys, out } = symfony({
    'config/routes.php': "<?php\nuse Symfony\\Component\\Routing\\Loader\\Configurator\\RoutingConfigurator;\n\nreturn static function (RoutingConfigurator $routes): void {\n    $routes->import(CONTROLLERS_DIR, 'attribute')->prefix('/v2');\n};\n",
    'src/Controller/CartController.php': controller('App\\Controller', 'CartController', "    #[Route('/cart', methods: ['GET'])]\n    public function show() {}"),
  });
  assert.deepEqual(keys, ['GET /cart']);
  assert.match(out, /SYMFONY[\s\S]*config\/routes\.php[\s\S]*(?:can't|couldn't) read/);
});
