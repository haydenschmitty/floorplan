// Android: activities in AndroidManifest.xml and destinations in res/navigation graphs become screens,
// each linked to the one Kotlin or Java file declaring its class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, cleanup } from './helpers.mjs';

const { findScreens } = await lib('screens.mjs');

const M = 'app/src/main/';
const J = M + 'java/com/example/app/';

/** Scans and builds `files` as one git repo and returns its screens as "url -> file". */
function screens(files) {
  const arch = { project: { name: 'Trips', summary: 'A sample Android app.' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', summary: 'The Android app.', paths: ['**'] }] };
  const root = makeProject(files, { repos: ['.'], arch });
  try {
    scanAndBuild(root);
    return (readGraph(root).screens || []).filter((s) => s.fw === 'android').map((s) => `${s.url} -> ${s.file}`).sort();
  } finally { cleanup(root); }
}

const kt = (pkg, cls, body = '') => `package ${pkg}\n\nclass ${cls}${body}\n`;

test('Android: manifest activities named relative to the package, in full, and bare', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">',
      '  <application>',
      '    <activity android:name=".ui.MainActivity" android:exported="true" />',
      '    <activity android:name="com.example.app.settings.SettingsActivity" />',
      '    <activity android:name="AboutActivity" />',
      '  </application>',
      '</manifest>',
    ].join('\n'),
    [J + 'ui/MainActivity.kt']: kt('com.example.app.ui', 'MainActivity'),
    [J + 'settings/SettingsActivity.java']: 'package com.example.app.settings;\n\npublic class SettingsActivity {}\n',
    [J + 'AboutActivity.kt']: kt('com.example.app', 'AboutActivity'),
    // the same simple names in another package of the module: the manifest's package picks between them
    [M + 'java/com/vendor/ui/MainActivity.kt']: kt('com.vendor.ui', 'MainActivity'),
    [M + 'java/com/vendor/AboutActivity.kt']: kt('com.vendor', 'AboutActivity'),
  }), [
    'AboutActivity -> app/src/main/java/com/example/app/AboutActivity.kt',
    'MainActivity -> app/src/main/java/com/example/app/ui/MainActivity.kt',
    'SettingsActivity -> app/src/main/java/com/example/app/settings/SettingsActivity.java',
  ]);
});

test('Android: aliases, removed activities, placeholder names and a debug manifest repeating an activity add nothing', () => {
  assert.deepEqual(screens({
    // no package attribute: the namespace is set in Gradle, so the name is matched by its ending
    [M + 'AndroidManifest.xml']: [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">',
      '  <application>',
      '    <activity android:name=".MainActivity" />',
      '    <activity-alias android:name=".Launcher" android:targetActivity=".MainActivity" />',
      '    <activity android:name="${applicationId}.Placeholder" />',
      '    <!-- <activity android:name=".OldActivity" /> <activity android:name=".OlderActivity" /> -->',
      '  </application>',
      '</manifest>',
    ].join('\n'),
    'app/src/debug/AndroidManifest.xml': [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">',
      '  <application>',
      '    <activity android:name=".MainActivity" />',
      '    <activity android:name=".GoneActivity" tools:node="remove" />',
      '    <activity android:name=".AllGoneActivity" tools:node="removeAll" />',
      '  </application>',
      '</manifest>',
    ].join('\n'),
    [J + 'MainActivity.kt']: kt('com.example.app', 'MainActivity'),
    [J + 'Launcher.kt']: kt('com.example.app', 'Launcher'),
    [J + 'OldActivity.kt']: kt('com.example.app', 'OldActivity'),
    [J + 'OlderActivity.kt']: kt('com.example.app', 'OlderActivity'),
    [J + 'GoneActivity.kt']: kt('com.example.app', 'GoneActivity'),
    [J + 'AllGoneActivity.kt']: kt('com.example.app', 'AllGoneActivity'),
    // a test copy of the class doesn't make the name ambiguous
    'app/src/androidTest/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
  }), ['MainActivity -> app/src/main/java/com/example/app/MainActivity.kt']);
});

test('Android: navigation graph fragments and activities are screens, dialogs are not', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application /></manifest>\n',
    [M + 'res/navigation/nav_graph.xml']: [
      '<navigation xmlns:android="http://schemas.android.com/apk/res/android" xmlns:app="http://schemas.android.com/apk/res-auto">',
      '  <fragment android:id="@+id/home" android:name="com.example.app.home.HomeFragment" />',
      '  <activity android:id="@+id/player" android:name="com.example.app.player.PlayerActivity" />',
      '  <dialog android:id="@+id/confirm" android:name="com.example.app.home.ConfirmDialog" />',
      '</navigation>',
    ].join('\n'),
    [M + 'res/navigation-sw600dp/nav_graph.xml']: [
      '<navigation xmlns:android="http://schemas.android.com/apk/res/android">',
      '  <fragment android:id="@+id/wide" android:name="com.example.app.home.WideFragment" />',
      '</navigation>',
    ].join('\n'),
    [J + 'home/HomeFragment.kt']: kt('com.example.app.home', 'HomeFragment'),
    [J + 'home/WideFragment.kt']: kt('com.example.app.home', 'WideFragment'),
    [J + 'home/ConfirmDialog.kt']: kt('com.example.app.home', 'ConfirmDialog'),
    [J + 'player/PlayerActivity.kt']: kt('com.example.app.player', 'PlayerActivity'),
  }), [
    'HomeFragment -> app/src/main/java/com/example/app/home/HomeFragment.kt',
    'PlayerActivity -> app/src/main/java/com/example/app/player/PlayerActivity.kt',
    'WideFragment -> app/src/main/java/com/example/app/home/WideFragment.kt',
  ]);
});

test('Android: a class in two modules links to the one beside the manifest, and stays unlinked when neither is', () => {
  const both = (p) => kt('com.example.shared', 'ShareActivity') + p;
  assert.deepEqual(screens({
    'feature/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".ShareActivity" /></application></manifest>\n',
    'feature/src/main/java/com/example/shared/ShareActivity.kt': both(''),
    'legacy/src/main/java/com/example/shared/ShareActivity.kt': both('// legacy\n'),
    // a third module naming it in full can't tell the two apart
    'app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name="com.example.shared.OtherActivity" /></application></manifest>\n',
    'feature/src/main/java/com/example/shared/OtherActivity.kt': kt('com.example.shared', 'OtherActivity'),
    'legacy/src/main/java/com/example/shared/OtherActivity.kt': kt('com.example.shared', 'OtherActivity'),
  }), ['ShareActivity -> feature/src/main/java/com/example/shared/ShareActivity.kt']);
});

test('Android: an activity declared in a Kotlin file of another name links to that file', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".ui.MainActivity" /></application></manifest>\n',
    [J + 'ui/Screens.kt']: 'package com.example.app.ui\n\nclass MainActivity\n\nclass DetailActivity\n',
  }), ['MainActivity -> app/src/main/java/com/example/app/ui/Screens.kt']);
});

test('Android: a name built from a Gradle placeholder is not read as a class', () => {
  const xml = '<manifest><application><activity android:name="${applicationId}.Placeholder" /><activity android:name=".MainActivity" /></application></manifest>';
  const hints = findScreens(xml, { category: 'config', lang: 'xml', path: 'app/src/main/AndroidManifest.xml' });
  assert.deepEqual(hints.map((h) => h.cls), ['.MainActivity']);
});

test('Android: attributes in single quotes or holding a ">" are read, and tools:node="merge" keeps an activity', () => {
  const xml = [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">',
    "  <activity android:name='.Single' />",
    '  <activity android:label="Settings > Advanced" android:name=".Advanced" />',
    '  <activity android:name=".Merged" tools:node="merge" />',
    '</manifest>',
  ].join('\n');
  const hints = findScreens(xml, { category: 'config', lang: 'xml', path: 'app/src/main/AndroidManifest.xml' });
  assert.deepEqual(hints.map((h) => h.cls), ['.Single', '.Advanced', '.Merged']);
});

test('Android manifests and navigation graphs built to slow the reading down are still read quickly', () => {
  const mb = (unit) => unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
  const manifest = { category: 'config', lang: 'xml', path: 'app/src/main/AndroidManifest.xml' };
  const graph = { category: 'config', lang: 'xml', path: 'app/src/main/res/navigation/nav_graph.xml' };
  const cases = {
    '<activity with no >': [manifest, mb('<activity ')],
    '<!-- with no -->': [manifest, mb('<!--')],
    '<manifest with no >': [manifest, mb('<manifest ')],
    'an unclosed quote': [manifest, '<activity android:name="' + mb('a ')],
    'one tag of attributes with no values': [manifest, '<activity ' + mb('a=') + '>'],
    'one tag of spaces before an =': [manifest, '<activity ' + mb(' ') + '=>'],
    'closed tags': [manifest, mb('<activity android:name=".A"/>')],
    '<fragment with no >': [graph, mb('<fragment ')],
  };
  for (const [name, [file, src]] of Object.entries(cases)) {
    const t = performance.now();
    findScreens(src, file);
    const ms = performance.now() - t;
    assert.ok(ms < 2000, `${name} took ${Math.round(ms)} ms`);
  }
});

test('Android: build variant test folders are not the class, and a package folder named stories is', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /><activity android:name=".stories.StoriesActivity" /></application></manifest>\n',
    [J + 'MainActivity.kt']: kt('com.example.app', 'MainActivity'),
    'app/src/testDebug/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
    'app/src/androidTestFree/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
    [J + 'stories/StoriesActivity.kt']: kt('com.example.app.stories', 'StoriesActivity'),
  }), [
    'MainActivity -> app/src/main/java/com/example/app/MainActivity.kt',
    'StoriesActivity -> app/src/main/java/com/example/app/stories/StoriesActivity.kt',
  ]);
});

test('Android: a manifest with no package takes the Gradle namespace, and one with a package never matches by ending', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity" /></application></manifest>\n',
    'app/build.gradle.kts': 'android {\n    namespace = "com.example.app"\n}\n',
    [J + 'MainActivity.kt']: kt('com.example.app', 'MainActivity'),
    [M + 'java/com/vendor/MainActivity.kt']: kt('com.vendor', 'MainActivity'),
    'lib/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".LibActivity" /></application></manifest>\n',
    'lib/build.gradle': "android {\n    namespace 'com.example.lib'\n}\n",
    'lib/src/main/java/com/example/lib/LibActivity.kt': kt('com.example.lib', 'LibActivity'),
    'lib/src/main/java/com/example/lib/old/LibActivity.kt': kt('com.example.lib.old', 'LibActivity'),
    'pay/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.pay"><application><activity android:name=".PayActivity" /></application></manifest>\n',
    'pay/src/main/java/com/other/PayActivity.kt': kt('com.other', 'PayActivity'),
  }), [
    'LibActivity -> lib/src/main/java/com/example/lib/LibActivity.kt',
    'MainActivity -> app/src/main/java/com/example/app/MainActivity.kt',
  ]);
});

test('Android: a name matches only a whole Kotlin or Java class name at the end of a package when no package is known', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".ui.MainActivity" /><activity android:name=".HomeActivity" /></application></manifest>\n',
    [J + 'ui/MainActivity.kt']: kt('com.example.app.ui', 'MainActivity'),
    [J + 'legacy/MainActivity.kt']: kt('com.example.app.legacy', 'MainActivity'),
    [M + 'java/com/example/gui/MainActivity.kt']: kt('com.example.gui', 'MainActivity'),
    'feature/src/main/java/com/example/home/HomeActivity.kt': kt('com.example.home', 'HomeActivity'),
    'server/Home/HomeActivity.cs': 'namespace Shop.Home { public class HomeActivity {} }\n',
  }), [
    'HomeActivity -> feature/src/main/java/com/example/home/HomeActivity.kt',
    'MainActivity -> app/src/main/java/com/example/app/ui/MainActivity.kt',
  ]);
});

test('Android: two classes of one simple name are two screens, each named with enough of its package', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application /></manifest>\n',
    [M + 'res/navigation/nav_graph.xml']: [
      '<navigation xmlns:android="http://schemas.android.com/apk/res/android">',
      '  <fragment android:id="@+id/search" android:name="com.example.app.search.MainFragment" />',
      '  <fragment android:id="@+id/profile" android:name="com.example.app.profile.MainFragment" />',
      '  <fragment android:id="@+id/again" android:name="com.example.app.search.MainFragment" />',
      '</navigation>',
    ].join('\n'),
    [J + 'search/MainFragment.kt']: kt('com.example.app.search', 'MainFragment'),
    [J + 'profile/MainFragment.kt']: kt('com.example.app.profile', 'MainFragment'),
  }), [
    'profile.MainFragment -> app/src/main/java/com/example/app/profile/MainFragment.kt',
    'search.MainFragment -> app/src/main/java/com/example/app/search/MainFragment.kt',
  ]);
});

test('Android: copies of one class in product flavors link the first, two different classes do not', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".BillingActivity" /></application></manifest>\n',
    'app/src/paid/java/com/example/app/BillingActivity.kt': kt('com.example.app', 'BillingActivity'),
    'app/src/free/java/com/example/app/BillingActivity.kt': kt('com.example.app', 'BillingActivity'),
    'other/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".ShopActivity" /></application></manifest>\n',
    'other/src/main/java/com/a/ShopActivity.kt': kt('com.a', 'ShopActivity'),
    'other/src/main/java/com/b/ShopActivity.kt': kt('com.b', 'ShopActivity'),
  }), ['BillingActivity -> app/src/free/java/com/example/app/BillingActivity.kt']);
});

test('Android: an activity that only hosts a React Native, Flutter, Capacitor, Cordova or Tauri app is not a screen', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application>',
      '<activity android:name=".MainActivity" /><activity android:name=".FlutterHost" /><activity android:name=".HomeActivity" />',
      '<activity android:name=".RnHost" /><activity android:name=".CordovaHost" /><activity android:name=".TauriHost" /><activity android:name=".RnJavaHost" />',
      '</application></manifest>',
    ].join('\n'),
    [J + 'MainActivity.java']: 'package com.example.app;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n',
    [J + 'FlutterHost.kt']: 'package com.example.app\n\nimport io.flutter.embedding.android.FlutterActivity\n\nclass FlutterHost: FlutterActivity()\n',
    [J + 'HomeActivity.kt']: 'package com.example.app\n\nclass HomeActivity : AppCompatActivity() {\n  val host: ReactActivity? = null\n}\n',
    [J + 'RnHost.kt']: 'package com.example.app\n\nimport com.facebook.react.ReactActivity\n\nclass RnHost : ReactActivity()\n',
    [J + 'CordovaHost.java']: 'package com.example.app;\n\nimport org.apache.cordova.CordovaActivity;\n\npublic class CordovaHost extends CordovaActivity {}\n',
    [J + 'RnJavaHost.java']: 'package com.example.app;\n\npublic class RnJavaHost extends com.facebook.react.ReactActivity {}\n',
    [J + 'TauriHost.kt']: 'package com.example.app\n\nclass TauriHost : TauriActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(savedInstanceState)\n  }\n}\n',
  }), ['HomeActivity -> app/src/main/java/com/example/app/HomeActivity.kt']);
});

test('Android: a nested activity links to the file of the class around it and is shown by its own name', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".SettingsActivity$GeneralActivity" /></application></manifest>\n',
    [J + 'SettingsActivity.java']: 'package com.example.app;\n\npublic class SettingsActivity {\n  public static class GeneralActivity {}\n}\n',
  }), ['GeneralActivity -> app/src/main/java/com/example/app/SettingsActivity.java']);
});

function behindOf(files, url) {
  const arch = { project: { name: 'Trips', summary: 'A sample app.' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', summary: 'The app.', paths: ['**'] }] };
  const root = makeProject(files, { repos: ['.'], arch });
  try {
    scanAndBuild(root);
    const screen = (readGraph(root).screens || []).find((s) => s.url === url);
    return screen ? screen.behind.map((b) => b.id.replace(/^f:/, '')).sort() : null;
  } finally { cleanup(root); }
}

test('Android: a screen lists its own parts kept under ui/, but not a components/ui or primitives kit', () => {
  assert.deepEqual(behindOf({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".ui.home.HomeActivity" /></application></manifest>\n',
    [J + 'ui/home/HomeActivity.kt']: 'package com.example.app.ui.home\n\nimport com.example.app.ui.adapter.TrackAdapter\nimport com.example.app.ui.components.ui.Chip\nimport com.example.app.primitives.Box\n\nclass HomeActivity {\n  val tracks = TrackAdapter()\n  val chip = Chip()\n  val box = Box()\n}\n',
    [J + 'ui/adapter/TrackAdapter.kt']: kt('com.example.app.ui.adapter', 'TrackAdapter'),
    [J + 'ui/components/ui/Chip.kt']: kt('com.example.app.ui.components.ui', 'Chip'),
    [J + 'primitives/Box.kt']: kt('com.example.app.primitives', 'Box'),
  }, 'HomeActivity'), [J + 'ui/adapter/TrackAdapter.kt', J + 'ui/home/HomeActivity.kt']);
});

test('Android: a module kept under a theme folder lists its parts, and a theme package inside a source set is left out', () => {
  const T = 'feature/theme/src/main/java/com/example/picker/';
  assert.deepEqual(behindOf({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /></application></manifest>\n',
    [J + 'MainActivity.kt']: 'package com.example.app\n\nimport com.example.picker.ThemePicker\nimport com.example.app.ui.theme.Theme\n\nclass MainActivity {\n  val picker = ThemePicker()\n  val theme = Theme()\n}\n',
    [T + 'ThemePicker.kt']: kt('com.example.picker', 'ThemePicker'),
    [J + 'ui/theme/Theme.kt']: kt('com.example.app.ui.theme', 'Theme'),
  }, 'MainActivity'), [J + 'MainActivity.kt', T + 'ThemePicker.kt']);
});

test('Android: outside a src/<set> layout, one copy of a class links and two copies make no screen', () => {
  const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /></application></manifest>\n';
  assert.deepEqual(screens({
    'app/AndroidManifest.xml': manifest,
    'app/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
  }), ['MainActivity -> app/java/com/example/app/MainActivity.kt']);
  assert.deepEqual(screens({
    'app/AndroidManifest.xml': manifest,
    'app/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
    'legacy/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
  }), []);
});

test('Android: a dotted name does not match a package that only ends in the same letters when no package is known', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name="ui.MainActivity" /></application></manifest>\n',
    [M + 'java/com/example/ui/MainActivity.kt']: kt('com.example.ui', 'MainActivity'),
    [M + 'java/com/example/xui/MainActivity.kt']: kt('com.example.xui', 'MainActivity'),
  }), ['MainActivity -> app/src/main/java/com/example/ui/MainActivity.kt']);
});

test('a web screen still leaves out a component kept in a ui/ folder', () => {
  assert.deepEqual(behindOf({
    'src/router.tsx': "import { createBrowserRouter } from 'react-router-dom';\nimport Home from './pages/Home';\n\nexport const router = createBrowserRouter([{ path: '/', element: <Home /> }]);\n",
    'src/pages/Home.tsx': "import Button from '../ui/Button';\nimport Card from '../parts/Card';\n\nexport default function Home() {\n  return <Card><Button /></Card>;\n}\n",
    'src/ui/Button.tsx': 'export default function Button() {\n  return <button />;\n}\n',
    'src/parts/Card.tsx': 'export default function Card({ children }) {\n  return <div>{children}</div>;\n}\n',
  }, '/'), ['src/pages/Home.tsx', 'src/parts/Card.tsx']);
});

test('Android: a screen in a package named stories lists its own parts, and an app kept under tests/ is not one', () => {
  assert.deepEqual(behindOf({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".stories.StoriesActivity" /></application></manifest>\n',
    [J + 'stories/StoriesActivity.kt']: 'package com.example.app.stories\n\nclass StoriesActivity {\n  val list = StoryAdapter()\n}\n',
    [J + 'stories/StoryAdapter.kt']: kt('com.example.app.stories', 'StoryAdapter'),
  }, 'StoriesActivity'), [J + 'stories/StoriesActivity.kt', J + 'stories/StoryAdapter.kt']);
  assert.deepEqual(screens({
    'tests/fixtures/demo/app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.demo"><application><activity android:name=".DemoActivity" /></application></manifest>\n',
    'tests/fixtures/demo/app/src/main/java/com/example/demo/DemoActivity.kt': kt('com.example.demo', 'DemoActivity'),
  }), []);
});

test('Android: an activity does not list the activity it opens, or that one\'s parts', () => {
  assert.deepEqual(behindOf({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".ui.MainActivity" /><activity android:name=".ui.SettingsActivity" /></application></manifest>\n',
    [J + 'ui/MainActivity.kt']: 'package com.example.app.ui\n\nimport com.example.app.ui.adapter.TrackAdapter\n\nclass MainActivity {\n  val tracks = TrackAdapter()\n  val next = SettingsActivity::class.java\n}\n',
    [J + 'ui/SettingsActivity.kt']: 'package com.example.app.ui\n\nimport com.example.app.ui.adapter.SettingsAdapter\n\nclass SettingsActivity {\n  val rows = SettingsAdapter()\n}\n',
    [J + 'ui/adapter/TrackAdapter.kt']: kt('com.example.app.ui.adapter', 'TrackAdapter'),
    [J + 'ui/adapter/SettingsAdapter.kt']: kt('com.example.app.ui.adapter', 'SettingsAdapter'),
  }, 'MainActivity'), [J + 'ui/MainActivity.kt', J + 'ui/adapter/TrackAdapter.kt']);
});

test('Android: a Gradle file over 1 MB is not read for the namespace', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity" /></application></manifest>\n',
    'app/build.gradle.kts': 'android {\n    namespace = "com.example.app"\n}\n' + '// padding\n'.repeat(100 * 1024),
    [J + 'MainActivity.kt']: kt('com.example.app', 'MainActivity'),
    [M + 'java/com/vendor/MainActivity.kt']: kt('com.vendor', 'MainActivity'),
  }), []);
});

test('Android: the same class in a phone and a wear module is two screens, named by module', () => {
  const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /></application></manifest>\n';
  assert.deepEqual(screens({
    'phone/src/main/AndroidManifest.xml': manifest,
    'phone/src/main/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
    'wear/src/main/AndroidManifest.xml': manifest,
    'wear/src/main/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
  }), [
    'MainActivity (phone) -> phone/src/main/java/com/example/app/MainActivity.kt',
    'MainActivity (wear) -> wear/src/main/java/com/example/app/MainActivity.kt',
  ]);
});

test('Android: two classes whose packages end the same way are named with as much package as tells them apart', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name="com.a.ui.HomeActivity" /><activity android:name="com.b.ui.HomeActivity" /></application></manifest>\n',
    [M + 'java/com/a/ui/HomeActivity.kt']: kt('com.a.ui', 'HomeActivity'),
    [M + 'java/com/b/ui/HomeActivity.kt']: kt('com.b.ui', 'HomeActivity'),
  }), [
    'a.ui.HomeActivity -> app/src/main/java/com/a/ui/HomeActivity.kt',
    'b.ui.HomeActivity -> app/src/main/java/com/b/ui/HomeActivity.kt',
  ]);
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name="com.a.x.ui.HomeActivity" /><activity android:name="com.b.x.ui.HomeActivity" /></application></manifest>\n',
    [M + 'java/com/a/x/ui/HomeActivity.kt']: kt('com.a.x.ui', 'HomeActivity'),
    [M + 'java/com/b/x/ui/HomeActivity.kt']: kt('com.b.x.ui', 'HomeActivity'),
  }), [
    'a.x.ui.HomeActivity -> app/src/main/java/com/a/x/ui/HomeActivity.kt',
    'b.x.ui.HomeActivity -> app/src/main/java/com/b/x/ui/HomeActivity.kt',
  ]);
});

test('Android: an app at the repo root and a wear module beside it keep a screen each', () => {
  const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /></application></manifest>\n';
  assert.deepEqual(screens({
    'src/main/AndroidManifest.xml': manifest,
    'src/main/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
    'wear/src/main/AndroidManifest.xml': manifest,
    'wear/src/main/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
  }), [
    'MainActivity (wear) -> wear/src/main/java/com/example/app/MainActivity.kt',
    'MainActivity -> src/main/java/com/example/app/MainActivity.kt',
  ]);
});

test('Android: a navigation graph name relative to the app is matched by its ending, not completed with the Gradle namespace', () => {
  assert.deepEqual(screens({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>\n',
    'app/build.gradle.kts': 'android {\n    namespace = "com.example.app"\n}\n',
    [M + 'res/navigation/nav_graph.xml']: '<navigation xmlns:android="http://schemas.android.com/apk/res/android"><fragment android:id="@+id/home" android:name=".home.HomeFragment" /></navigation>\n',
    [M + 'java/com/example/trips/home/HomeFragment.kt']: kt('com.example.trips.home', 'HomeFragment'),
  }), ['HomeFragment -> app/src/main/java/com/example/trips/home/HomeFragment.kt']);
});

test('Android: a part from a ui module is listed until so many files import it that it is a shared building block', () => {
  const files = {
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".HomeActivity" /></application></manifest>\n',
    [J + 'HomeActivity.kt']: 'package com.example.app\n\nimport com.example.app.ui.adapter.TrackAdapter\nimport com.example.core.ui.NewsCard\n\nclass HomeActivity {\n  val tracks = TrackAdapter()\n  val card = NewsCard()\n}\n',
    [J + 'ui/adapter/TrackAdapter.kt']: kt('com.example.app.ui.adapter', 'TrackAdapter'),
    'core/ui/src/main/java/com/example/core/ui/NewsCard.kt': kt('com.example.core.ui', 'NewsCard'),
  };
  assert.deepEqual(behindOf(files, 'HomeActivity'), [J + 'HomeActivity.kt', J + 'ui/adapter/TrackAdapter.kt', 'core/ui/src/main/java/com/example/core/ui/NewsCard.kt']);
  for (const n of [1, 2, 3, 4, 5]) files[J + `rows/Row${n}.kt`] = `package com.example.app.rows\n\nimport com.example.core.ui.NewsCard\n\nclass Row${n} {\n  val card = NewsCard()\n}\n`;
  assert.deepEqual(behindOf(files, 'HomeActivity'), [J + 'HomeActivity.kt', J + 'ui/adapter/TrackAdapter.kt']);
});

test('Android: a module folder named stories or spec is an ordinary module', () => {
  assert.deepEqual(screens({
    'feature/stories/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.stories"><application><activity android:name=".StoryActivity" /></application></manifest>\n',
    'feature/stories/src/main/java/com/example/stories/StoryActivity.kt': kt('com.example.stories', 'StoryActivity'),
    'spec/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.spec"><application><activity android:name=".SpecActivity" /></application></manifest>\n',
    'spec/src/main/java/com/example/spec/SpecActivity.kt': kt('com.example.spec', 'SpecActivity'),
  }), [
    'SpecActivity -> spec/src/main/java/com/example/spec/SpecActivity.kt',
    'StoryActivity -> feature/stories/src/main/java/com/example/stories/StoryActivity.kt',
  ]);
});

test('Android: a Java screen lists its own parts kept under ui/, and a Java module folder named stories is an ordinary module', () => {
  assert.deepEqual(behindOf({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".ui.home.HomeActivity" /></application></manifest>\n',
    [J + 'ui/home/HomeActivity.java']: 'package com.example.app.ui.home;\n\nimport com.example.app.ui.adapter.TrackAdapter;\n\npublic class HomeActivity {\n  TrackAdapter tracks = new TrackAdapter();\n}\n',
    [J + 'ui/adapter/TrackAdapter.java']: 'package com.example.app.ui.adapter;\n\npublic class TrackAdapter {}\n',
  }, 'HomeActivity'), [J + 'ui/adapter/TrackAdapter.java', J + 'ui/home/HomeActivity.java']);
  assert.deepEqual(screens({
    'feature/stories/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.stories"><application><activity android:name=".StoryActivity" /></application></manifest>\n',
    'feature/stories/src/main/java/com/example/stories/StoryActivity.java': 'package com.example.stories;\n\npublic class StoryActivity {}\n',
  }), ['StoryActivity -> feature/stories/src/main/java/com/example/stories/StoryActivity.java']);
});

test('Android: a Gradle namespace on one line or with Windows line endings is read, and one built by joining strings is not', () => {
  const manifest = (cls) => `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".${cls}" /></application></manifest>\n`;
  assert.deepEqual(screens({
    'one/src/main/AndroidManifest.xml': manifest('OneActivity'),
    'one/build.gradle.kts': 'android { namespace = "com.example.one" }\n',
    'one/src/main/java/com/example/one/OneActivity.kt': kt('com.example.one', 'OneActivity'),
    'one/src/main/java/com/vendor/OneActivity.kt': kt('com.vendor', 'OneActivity'),
    'semi/src/main/AndroidManifest.xml': manifest('SemiActivity'),
    'semi/build.gradle.kts': 'android { compileSdk = 34; namespace = "com.example.semi" }\n',
    'semi/src/main/java/com/example/semi/SemiActivity.kt': kt('com.example.semi', 'SemiActivity'),
    'semi/src/main/java/com/vendor/SemiActivity.kt': kt('com.vendor', 'SemiActivity'),
    'crlf/src/main/AndroidManifest.xml': manifest('CrlfActivity'),
    'crlf/build.gradle': "android {\r\n    namespace 'com.example.crlf'\r\n}\r\n",
    'crlf/src/main/java/com/example/crlf/CrlfActivity.kt': kt('com.example.crlf', 'CrlfActivity'),
    'crlf/src/main/java/com/vendor/CrlfActivity.kt': kt('com.vendor', 'CrlfActivity'),
    // only the first string would be read, so the namespace counts as unknown and the name is matched by its ending
    'home/src/main/AndroidManifest.xml': manifest('HomeActivity'),
    'home/build.gradle.kts': 'android {\n    namespace = "com.example" + ".home"\n}\n',
    'home/src/main/java/com/example/home/HomeActivity.kt': kt('com.example.home', 'HomeActivity'),
  }), [
    'CrlfActivity -> crlf/src/main/java/com/example/crlf/CrlfActivity.kt',
    'HomeActivity -> home/src/main/java/com/example/home/HomeActivity.kt',
    'OneActivity -> one/src/main/java/com/example/one/OneActivity.kt',
    'SemiActivity -> semi/src/main/java/com/example/semi/SemiActivity.kt',
  ]);
});

test('Android: a screen in a module kept under a ui folder lists its own parts', () => {
  const K = 'feature/home/ui/src/main/kotlin/com/example/home/';
  assert.deepEqual(behindOf({
    'feature/home/ui/src/main/res/navigation/home.xml': '<navigation xmlns:android="http://schemas.android.com/apk/res/android"><fragment android:name="com.example.home.HomeFragment" /></navigation>\n',
    [K + 'HomeFragment.kt']: 'package com.example.home\n\nimport com.example.home.list.HomeAdapter\n\nclass HomeFragment {\n  val list = HomeAdapter()\n}\n',
    [K + 'list/HomeAdapter.kt']: 'package com.example.home.list\n\nimport com.example.home.list.row.HomeRow\n\nclass HomeAdapter {\n  val row = HomeRow()\n}\n',
    [K + 'list/row/HomeRow.kt']: kt('com.example.home.list.row', 'HomeRow'),
  }, 'HomeFragment'), [K + 'HomeFragment.kt', K + 'list/HomeAdapter.kt', K + 'list/row/HomeRow.kt']);
});

test('Android: an activity lists the parts of a feature module kept under a ui folder, and what they use', () => {
  const K = 'feature/home/ui/src/main/kotlin/com/example/home/';
  assert.deepEqual(behindOf({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /></application></manifest>\n',
    [J + 'MainActivity.kt']: 'package com.example.app\n\nimport com.example.home.HomeScreen\n\nclass MainActivity {\n  val home = HomeScreen()\n}\n',
    [K + 'HomeScreen.kt']: 'package com.example.home\n\nimport com.example.home.card.HomeCard\n\nclass HomeScreen {\n  val card = HomeCard()\n}\n',
    [K + 'card/HomeCard.kt']: kt('com.example.home.card', 'HomeCard'),
  }, 'MainActivity'), [J + 'MainActivity.kt', K + 'HomeScreen.kt', K + 'card/HomeCard.kt']);
});

test('Android: an app module kept under a components/common folder lists its own parts', () => {
  const A = 'components/common/app/src/main/java/com/example/app/';
  assert.deepEqual(behindOf({
    'components/common/app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /></application></manifest>\n',
    [A + 'MainActivity.kt']: 'package com.example.app\n\nimport com.example.app.ui.FeedAdapter\nimport com.example.app.home.HomeRow\n\nclass MainActivity {\n  val feed = FeedAdapter()\n  val row = HomeRow()\n}\n',
    [A + 'ui/FeedAdapter.kt']: kt('com.example.app.ui', 'FeedAdapter'),
    [A + 'home/HomeRow.kt']: kt('com.example.app.home', 'HomeRow'),
  }, 'MainActivity'), [A + 'MainActivity.kt', A + 'home/HomeRow.kt', A + 'ui/FeedAdapter.kt']);
});

test('Android: modules kept together under a ui folder list each other\'s parts', () => {
  const U = 'ui/android/';
  assert.deepEqual(behindOf({
    [U + 'app/src/main/AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /></application></manifest>\n',
    [U + 'app/src/main/java/com/example/app/MainActivity.kt']: 'package com.example.app\n\nimport com.example.feed.FeedAdapter\nimport com.example.core.ui.NewsCard\n\nclass MainActivity {\n  val feed = FeedAdapter()\n  val card = NewsCard()\n}\n',
    [U + 'feature/feed/src/main/java/com/example/feed/FeedAdapter.kt']: kt('com.example.feed', 'FeedAdapter'),
    [U + 'core/ui/src/main/java/com/example/core/ui/NewsCard.kt']: kt('com.example.core.ui', 'NewsCard'),
  }, 'MainActivity'), [U + 'app/src/main/java/com/example/app/MainActivity.kt', U + 'core/ui/src/main/java/com/example/core/ui/NewsCard.kt', U + 'feature/feed/src/main/java/com/example/feed/FeedAdapter.kt']);
});

test('Android: modules kept under a folder of their own named src are told apart', () => {
  const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".MainActivity" /></application></manifest>\n';
  assert.deepEqual(screens({
    'client/src/phone/src/main/AndroidManifest.xml': manifest,
    'client/src/phone/src/main/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
    'client/src/wear/src/main/AndroidManifest.xml': manifest,
    'client/src/wear/src/main/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
  }), [
    'MainActivity (client/src/phone) -> client/src/phone/src/main/java/com/example/app/MainActivity.kt',
    'MainActivity (client/src/wear) -> client/src/wear/src/main/java/com/example/app/MainActivity.kt',
  ]);
});

test('Android: an app at the repo root takes the Gradle namespace from the root build file', () => {
  assert.deepEqual(screens({
    'src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity" /></application></manifest>\n',
    'build.gradle.kts': 'android {\n    namespace = "com.example.app"\n}\n',
    'src/main/java/com/example/app/MainActivity.kt': kt('com.example.app', 'MainActivity'),
    'src/main/java/com/vendor/MainActivity.kt': kt('com.vendor', 'MainActivity'),
  }), ['MainActivity -> src/main/java/com/example/app/MainActivity.kt']);
});

test('a web file on a path like src/x/java/ keeps the web rules for ui and test folders', () => {
  assert.deepEqual(behindOf({
    'src/router.tsx': "import { createBrowserRouter } from 'react-router-dom';\nimport Lesson from './pages/java/Lesson';\n\nexport const router = createBrowserRouter([{ path: '/', element: <Lesson /> }]);\n",
    'src/pages/java/Lesson.tsx': "import Button from './ui/Button';\nimport sample from './fixtures/sample';\nimport Card from '../../parts/Card';\n\nexport default function Lesson() {\n  return <Card><Button>{sample}</Button></Card>;\n}\n",
    'src/pages/java/ui/Button.tsx': 'export default function Button({ children }) {\n  return <button>{children}</button>;\n}\n',
    'src/pages/java/fixtures/sample.ts': "export default 'class Hello {}';\n",
    'src/parts/Card.tsx': 'export default function Card({ children }) {\n  return <div>{children}</div>;\n}\n',
  }, '/'), ['src/pages/java/Lesson.tsx', 'src/parts/Card.tsx']);
});

test('Android: a class takes its file\'s written name only when it is the file\'s own class', () => {
  const arch = { project: { name: 'Trips', summary: 'A sample Android app.' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', summary: 'The Android app.', paths: ['**'] }] };
  const root = makeProject({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".HomeActivity" /><activity android:name=".RouteDetailActivity" /><activity android:name=".PageViewerActivity" /><activity android:name=".ui.LoginActivity" /><activity android:name=".ui.SignupActivity" /></application></manifest>\n',
    [J + 'HomeActivity.kt']: kt('com.example.app', 'HomeActivity'),
    [J + 'RouteDetailActivity.kt']: kt('com.example.app', 'RouteDetailActivity'),
    [J + 'PageViewerActivity.kt']: kt('com.example.app', 'PageViewerActivity'),
    [J + 'ui/AuthScreens.kt']: 'package com.example.app.ui\n\nclass LoginActivity\n\nclass SignupActivity\n',
    'floorplan/descriptions/app.json': JSON.stringify({ files: {
      [J + 'HomeActivity.kt']: { name: 'Home', description: 'The first screen people see.' },
      [J + 'ui/AuthScreens.kt']: { name: 'Sign in screens', description: 'Where people sign in or make an account.' },
    } }),
  }, { repos: ['.'], arch });
  try {
    scanAndBuild(root);
    assert.deepEqual((readGraph(root).screens || []).map((s) => `${s.url}: ${s.name} | ${s.description}`).sort(), [
      'HomeActivity: Home | The first screen people see.',
      'LoginActivity: Login activity | ',
      'PageViewerActivity: Page viewer activity | ',
      'RouteDetailActivity: Route detail activity | ',
      'SignupActivity: Signup activity | ',
    ]);
  } finally { cleanup(root); }
});

test('Android: a manifest in a test source set makes no screen', () => {
  assert.deepEqual(screens({
    'app/src/test/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".ProbeActivity" /></application></manifest>\n',
    'app/src/androidTestDebug/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".ProbeTwoActivity" /></application></manifest>\n',
    [J + 'ProbeActivity.kt']: kt('com.example.app', 'ProbeActivity'),
    [J + 'ProbeTwoActivity.kt']: kt('com.example.app', 'ProbeTwoActivity'),
  }), []);
});

test('Android: an app kept under a tests folder or a fixtures folder alone is not one', () => {
  const app = (dir, pkg, cls) => ({
    [dir + 'app/src/main/AndroidManifest.xml']: `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}"><application><activity android:name=".${cls}" /></application></manifest>\n`,
    [dir + `app/src/main/java/${pkg.replace(/\./g, '/')}/${cls}.kt`]: kt(pkg, cls),
  });
  assert.deepEqual(screens({ ...app('tests/demo/', 'com.example.one', 'OneActivity'), ...app('fixtures/demo/', 'com.example.two', 'TwoActivity') }), []);
});

test('Android: nested activities in one file are each named by their own class', () => {
  const arch = { project: { name: 'Trips', summary: 'A sample Android app.' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', summary: 'The Android app.', paths: ['**'] }] };
  const root = makeProject({
    [M + 'AndroidManifest.xml']: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".SettingsActivity" /><activity android:name=".SettingsActivity$GeneralActivity" /><activity android:name=".SettingsActivity$DataSyncActivity" /></application></manifest>\n',
    [J + 'SettingsActivity.java']: 'package com.example.app;\n\npublic class SettingsActivity {\n  public static class GeneralActivity {}\n  public static class DataSyncActivity {}\n}\n',
  }, { repos: ['.'], arch });
  try {
    scanAndBuild(root);
    assert.deepEqual((readGraph(root).screens || []).map((s) => `${s.url}: ${s.name}`).sort(), [
      'DataSyncActivity: Data sync activity',
      'GeneralActivity: General activity',
      'SettingsActivity: Settings activity',
    ]);
  } finally { cleanup(root); }
});
