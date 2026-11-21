// Spring: a method's @GetMapping, @PostMapping… with no path of its own (bare, empty or with only other
// attributes) answers at the class's @RequestMapping path, and annotations that do name a path still
// count once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const routes = (lines, lang = 'java', file = 'src/main/java/com/example/ItemController.java') =>
  extract(lines.join('\n'), lang, file).routes.map((r) => `${r.method} ${r.path} :${r.line}`);

test('a mapping without a path answers at the class path (#158)', () => {
  assert.deepEqual(routes([
    '@RestController',
    '@RequestMapping("/api/items")',
    'public class ItemController {',
    '    @GetMapping',
    '    public List<Item> list() { return items; }',
    '',
    '    @PostMapping',
    '    public Item create(@RequestBody Item i) { return i; }',
    '',
    '    @GetMapping("/{id}")',
    '    public Item get(@PathVariable Integer id) { return null; }',
    '',
    '    @PutMapping()',
    '    public Item replace(@RequestBody Item i) { return i; }',
    '',
    '    @PatchMapping(consumes = "application/merge-patch+json")',
    '    public Item patch(@RequestBody Item i) { return i; }',
    '',
    '    @DeleteMapping(',
    '        produces = MediaType.APPLICATION_JSON_VALUE',
    '    )',
    '    public void clear() { }',
    '}',
  ]).sort(), [
    'DELETE /api/items :19', 'GET /api/items :4', 'GET /api/items/{id} :10', 'PATCH /api/items :16', 'POST /api/items :7', 'PUT /api/items :13',
  ]);
});

test('without a class path, a bare mapping is the root, in Kotlin too', () => {
  assert.deepEqual(routes([
    '@RestController',
    'class HealthController {',
    '    @GetMapping',
    '    fun health() = "ok"',
    '}',
  ], 'kotlin', 'src/main/kotlin/com/example/HealthController.kt'), ['GET / :3']);
});

test("an attribute whose text holds 'value=' or 'path=' doesn't hide the route, and a Kotlin path with settings counts once", () => {
  assert.deepEqual(routes([
    '@RestController',
    '@RequestMapping("/api/reports")',
    'class ReportController {',
    '    @GetMapping(params = "value=1")',
    '    fun byValue() = listOf<String>()',
    '    @PostMapping(headers = ["path=x"])',
    '    fun byHeader() = Unit',
    '    @GetMapping("/latest", produces = ["application/json"])',
    '    fun latest() = "ok"',
    '}',
  ], 'kotlin', 'src/main/kotlin/com/example/ReportController.kt').sort(), [
    'GET /api/reports :4', 'GET /api/reports/latest :8', 'POST /api/reports :6',
  ]);
});

test('a mapping that names its path is not counted at the class path, and look-alikes are left alone', () => {
  // array and constant paths, and `value` after another setting, aren't read yet: they must not land at the class path either
  assert.deepEqual(routes([
    '@RestController',
    '@RequestMapping("/api/orders")',
    'public class OrderController {',
    '    @GetMapping(value = "/open")',
    '    public List<Order> open() { return null; }',
    '    @GetMapping(path = "/closed", produces = "application/json")',
    '    public List<Order> closed() { return null; }',
    '    @PostMapping({"/a", "/b"})',
    '    public void many() { }',
    '    @PutMapping(OrderPaths.REPLACE)',
    '    public void replace() { }',
    '    @DeleteMapping(params = "all", value = "/all")',
    '    public void clear() { }',
    '    // @GetMapping',
    '    /* @PostMapping */',
    '    private static final String HINT = "use @GetMapping here";',
    '    @GetMappingAlias',
    '    public void alias() { }',
    '}',
  ]).sort(), ['GET /api/orders/closed :6', 'GET /api/orders/open :4']);
});
