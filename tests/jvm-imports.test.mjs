// Kotlin and Java: imports of top-level declarations not named after their file, names a file uses from
// its own package without importing them, and the project's own packages never listed as external.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { lib, makeProject, run, readJson, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { createResolver } = await lib('resolve.mjs');

const M = 'app/src/main/java/com/example/app/';
const T = 'app/src/test/java/com/example/app/';

/** Scans `files` and returns its edges as "from -> to" (paths shortened) and its external packages. */
function scan(files) {
  // a git repo, since loose files this deep aren't collected
  const root = makeProject(files, { repos: ['.'] });
  try {
    run('scan.mjs', root);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    const short = (p) => p.replace(M, 'main/').replace(T, 'test/');
    return { edges: s.edges.map((e) => `${short(e.from)} -> ${short(e.to)}`).sort(), externals: s.externals.map((e) => e.id).sort() };
  } finally { cleanup(root); }
}

test('Kotlin: top-level declarations not named after their file, and same-package use without an import (#115)', () => {
  const { edges, externals } = scan({
    [M + 'domain/PlannedTrip.kt']: [
      'package com.example.app.domain',
      '',
      'data class PlannedTrip(val stops: List<PlannedStop>)',
      'data class PlannedStop(val name: String)',
      'fun <T> List<T>.goesOverTheWeighbridge(): Boolean = isNotEmpty()',
      'typealias StopId = String',
      'const val MAX_STOPS = 12',
    ].join('\n'),
    [M + 'ui/trip/TripList.kt']: [
      'package com.example.app.ui.trip',
      '',
      'import com.example.app.domain.PlannedStop',
      'import com.example.app.domain.goesOverTheWeighbridge',
      'import com.squareup.moshi.Moshi',
      '',
      'fun tripList(stops: List<PlannedStop>) = stops.goesOverTheWeighbridge()',
    ].join('\n'),
    [M + 'ui/trip/Banner.kt']: 'package com.example.app.ui.trip\n\n@Composable\nfun Banner() {}\n',
    [M + 'ui/trip/TripScreen.kt']: [
      'package com.example.app.ui.trip',
      '',
      'import androidx.compose.runtime.Composable',
      '',
      '@Composable',
      'fun TripScreen() {',
      '    Banner()',
      '}',
    ].join('\n'),
    // a typealias and a top-level value, each imported by name
    [M + 'data/Ids.kt']: 'package com.example.app.data\n\nimport com.example.app.domain.StopId\nimport com.example.app.domain.MAX_STOPS\n\nval first: StopId = "a" + MAX_STOPS\n',
  });
  assert.deepEqual(edges, [
    'main/data/Ids.kt -> main/domain/PlannedTrip.kt',
    'main/ui/trip/TripList.kt -> main/domain/PlannedTrip.kt',
    'main/ui/trip/TripScreen.kt -> main/ui/trip/Banner.kt',
  ]);
  // the app's own packages are never an external package; real libraries still are
  assert.deepEqual(externals, ['maven:androidx.compose.runtime', 'maven:com.squareup.moshi']);
});

test('Kotlin: what a file can\'t see, or only names, stays unlinked', () => {
  const { edges, externals } = scan({
    [M + 'ui/trip/Banner.kt']: 'package com.example.app.ui.trip\n\nfun Banner() {}\nprivate fun helper() {}\n',
    [M + 'ui/trip/Alert.kt']: 'package com.example.app.ui.trip\n\nclass Alert\n',
    [M + 'ui/trip/Header.kt']: 'package com.example.app.ui.trip\n\nclass Header\n',
    // named only in a comment and a string, and a private function of another file
    [M + 'ui/trip/Notes.kt']: 'package com.example.app.ui.trip\n\n// Banner goes here later\nval label = "Alert"\nfun notes() = helper()\n',
    // an explicit import of the same simple name wins over the package's own Header
    [M + 'ui/trip/Page.kt']: 'package com.example.app.ui.trip\n\nimport com.example.design.Header\n\nfun page() = Header()\n',
    // another package doesn't see Banner without an import
    [M + 'ui/home/Home.kt']: 'package com.example.app.ui.home\n\nfun home() = Banner()\n',
    // a name missing from the project's own package: not found, but not an external package either
    [M + 'ui/home/Old.kt']: 'package com.example.app.ui.home\n\nimport com.example.app.ui.trip.Removed\n',
  });
  assert.deepEqual(edges, []);
  assert.deepEqual(externals, ['maven:com.example.design']);
});

test('Kotlin: a wildcard import links to the files whose names are used, and tests see the code but not the other way round', () => {
  const { edges } = scan({
    [M + 'domain/Trip.kt']: 'package com.example.app.domain\n\nclass Trip\n',
    [M + 'domain/Stop.kt']: 'package com.example.app.domain\n\nclass Stop\n',
    [M + 'domain/Unused.kt']: 'package com.example.app.domain\n\nclass Unused\n',
    [M + 'ui/List.kt']: 'package com.example.app.ui\n\nimport com.example.app.domain.*\n\nfun list(t: Trip) = t\n',
    [M + 'domain/Planner.kt']: 'package com.example.app.domain\n\nfun plan(stop: Stop) = fakeTrip\n',
    [T + 'domain/Fakes.kt']: 'package com.example.app.domain\n\nval fakeTrip = Trip()\n',
  });
  assert.deepEqual(edges, [
    'main/domain/Planner.kt -> main/domain/Stop.kt',
    'main/ui/List.kt -> main/domain/Trip.kt',
    'test/domain/Fakes.kt -> main/domain/Trip.kt',
  ]);
});

test('Java: package-private classes beside the public one, and same-package use without an import', () => {
  const { edges, externals } = scan({
    'src/main/java/com/shop/orders/OrderService.java': 'package com.shop.orders;\n\npublic class OrderService {\n  private final OrderRepo repo = new OrderRepo();\n}\n\nclass OrderRules {}\n',
    'src/main/java/com/shop/orders/OrderRepo.java': 'package com.shop.orders;\n\nimport java.util.List;\n\npublic class OrderRepo {}\n',
    'src/main/java/com/shop/api/OrderController.java': 'package com.shop.api;\n\nimport com.shop.orders.OrderRules;\nimport static com.shop.orders.OrderService.LIMIT;\nimport org.springframework.web.bind.annotation.RestController;\n\n@RestController\npublic class OrderController {}\n',
  });
  assert.deepEqual(edges, [
    'src/main/java/com/shop/api/OrderController.java -> src/main/java/com/shop/orders/OrderService.java',
    'src/main/java/com/shop/orders/OrderService.java -> src/main/java/com/shop/orders/OrderRepo.java',
  ]);
  assert.deepEqual(externals, ['maven:org.springframework.web']);
});

test('Kotlin: the top-level names a file declares', () => {
  const r = extract([
    'package com.example.app',
    '@file:JvmName("Utils")',
    'import kotlinx.coroutines.flow.Flow',
    '',
    '@Suppress("unused") inline fun <reified T : Comparable<T>> List<T>.largest(): T? = maxOrNull()',
    'suspend fun String?.orBlank() = this ?: ""',
    'val Context.dataStore by preferencesDataStore("prefs")',
    'internal var counter: Int = 0',
    'enum class Color { RED }',
    'sealed interface Event',
    'fun interface Listener { fun on() }',
    'object Registry',
    'annotation class Marker',
    'private val secret = 1',
    'class Outer {',
    '    class Nested',
    '    fun member() {}',
    '}',
  ].join('\n'), 'kotlin', 'app/src/main/java/com/example/app/Utils.kt');
  assert.deepEqual(r.decls, ['largest', 'orBlank', 'dataStore', 'counter', 'Color', 'Event', 'Listener', 'Registry', 'Marker', 'Outer']);
});

test('Kotlin: a package of thousands of files is looked up by name, not file by file', () => {
  const files = [];
  for (let i = 0; i < 3000; i++) {
    const p = `src/main/kotlin/com/big/Part${i}.kt`;
    files.push({ path: p, lang: 'kotlin', ...extract(`package com.big\n\nclass Part${i}\nfun helper${i}() = ${i}\n`, 'kotlin', p) });
  }
  const user = 'src/main/kotlin/com/big/User.kt';
  files.push({ path: user, lang: 'kotlin', ...extract('package com.big\n\nfun use() = Part7().also { helper42() }\n', 'kotlin', user) });
  const resolve = createResolver(path.join(os.tmpdir(), 'floorplan-no-such-project'), files);
  const started = Date.now();
  let linked = [];
  for (const f of files) for (const imp of f.imports) {
    const res = resolve(f, imp);
    if (f.path === user && (res.file || res.files)) linked = res.files || [res.file];
  }
  assert.deepEqual(linked, ['src/main/kotlin/com/big/Part42.kt', 'src/main/kotlin/com/big/Part7.kt']);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});


test('Kotlin files of unclosed strings, long modifier runs and deep generics are still read quickly', () => {
  const mb = (unit) => 'package com.slow\n' + unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
  const cases = {
    'unclosed strings with escapes': mb('"x\\'),
    'unclosed raw strings': mb('"""x'),
    'modifier runs': mb('public '.repeat(30) + '\n'),
    'annotations with no declaration': mb('@A(x) @B(y) '.repeat(10) + '\n'),
    'unclosed generics': mb('fun ' + '<'.repeat(300) + '\n'),
    'long receivers': mb('val ' + 'a.'.repeat(150) + ' by \n'),
  };
  for (const [name, src] of Object.entries(cases)) {
    const t = performance.now();
    extract(src, 'kotlin', 'src/main/kotlin/com/slow/Slow.kt');
    const ms = performance.now() - t;
    assert.ok(ms < 2000, `${name} took ${Math.round(ms)} ms`);
  }
});
