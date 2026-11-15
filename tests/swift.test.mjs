// Swift: imports name a module (a Swift package target), and files of one module use each other's
// code without importing it. Both become links to the files that declare the top-level names used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, makeProject, run, SKILL } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const scanOf = (files) => {
  const root = makeProject(files);
  try {
    run('scan.mjs', root);
    return JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
const linksOf = (scan) => scan.edges.map((e) => `${e.from} -> ${e.to}`).sort();

test('Swift: module imports, attributes, declared types and the top-level names other files can use', () => {
  const r = extract([
    'import SwiftUI',
    '@testable import Core',
    '@preconcurrency import struct Billing.Invoice',
    '// import Commented',
    'let text = "import NotAnImport"',
    'public final class Checkout {',
    '  class func make() -> Checkout { Checkout() }',
    '  enum Kind { case card }',
    '  let total: Money',
    '}',
    'actor Ledger {}',
    'private struct Helper {}',
    'public protocol Pricing {}',
    'typealias Money = Decimal',
    'func formatTotal(_ c: Checkout) -> String { "Rate: \\(Settings.rate)" }',
    'fileprivate func scratch() {}',
    'public private(set) var lastOrder: Checkout?',
  ].join('\n'), 'swift', 'App/Checkout.swift');
  assert.deepEqual(r.imports.filter((i) => !i.implicit).map((i) => i.spec), ['SwiftUI', 'Core', 'Billing']);
  assert.ok(r.imports.some((i) => i.implicit), 'every file uses its own module');
  assert.deepEqual(r.symbols.map((s) => `${s.kind} ${s.name}`),
    ['class Checkout', 'enum Kind', 'actor Ledger', 'struct Helper', 'protocol Pricing']);
  // nested (Kind, total), private (Helper, scratch) and the file's string contents are left out
  assert.deepEqual(r.decls, ['text', 'Checkout', 'Ledger', 'Pricing', 'Money', 'formatTotal', 'lastOrder']);
  const mentions = r.mentions.split(' ');
  assert.ok(mentions.includes('Decimal') && mentions.includes('String'));
  assert.ok(!mentions.includes('Checkout') && !mentions.includes('Money'), 'its own names');
  assert.ok(!mentions.includes('NotAnImport') && !mentions.includes('Commented') && !mentions.includes('Billing'), 'strings, comments and import lines');
});

test('the map draws protocols and actors with the type icon, like classes and interfaces', () => {
  const viewer = fs.readFileSync(path.join(SKILL, 'assets', 'viewer.html'), 'utf8');
  const kinds = /const symIcon = \(kind\) => \(\[([^\]]*)\]/.exec(viewer)?.[1] || '';
  for (const k of ['class', 'interface', 'protocol', 'actor', 'struct']) assert.ok(kinds.includes(`'${k}'`), k);
});

test('Swift package: imports link to the target files declaring what is used, and files of one module link to each other', () => {
  const scan = scanOf({
    'Package.swift': [
      'import PackageDescription',
      'let package = Package(name: "Shop", dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.0.0")],',
      '  targets: [',
      '    .target(name: "Core", dependencies: [], path: "Shared/Core"),',
      '    .target(name: "Checkout", dependencies: [.target(name: "Core"), "Sparkle"]),',
      '    // .target(name: "Parked", dependencies: ["Core"]),',
      '    /* .target(name: "Old", path: "Old") */',
      '    .testTarget(name: "CheckoutTests", dependencies: ["Checkout"]),',
      '  ])',
    ].join('\n'),
    'Shared/Core/Settings.swift': 'import Foundation\npublic struct Settings { public enum Kind { case a } }\n',
    'Shared/Core/Theme.swift': 'public enum Theme {}\n',
    'Shared/Core/Format.swift': 'public func formatPrice(_ v: Double) -> String { "" }\npublic typealias Cents = Int\nprivate func helper() {}\n',
    'Shared/Core/Extensions.swift': 'extension String { public var trimmed: String { self } }\n',
    'Sources/Checkout/Cart.swift': 'import Core\nimport Sparkle\nstruct Cart { let s: Settings; let p = Pricing(); let c: Cents = 0 }\n',
    'Sources/Checkout/Pricing.swift': 'import Core\nstruct Pricing { enum Kind { case net }; func label() -> String { formatPrice(1) } }\n',
    'Sources/Checkout/Receipt.swift': 'import Core\nstruct Receipt { let k: Kind; let t = "x".trimmed; func h() { helper() } }\n',
    'Tests/CheckoutTests/CartTests.swift': 'import XCTest\n@testable import Checkout\nfinal class CartTests: XCTestCase { let c: Cart? = nil }\n',
  });
  assert.deepEqual(linksOf(scan), [
    'Sources/Checkout/Cart.swift -> Shared/Core/Format.swift', // a type alias, through the target's own path
    'Sources/Checkout/Cart.swift -> Shared/Core/Settings.swift', // a type
    'Sources/Checkout/Cart.swift -> Sources/Checkout/Pricing.swift', // same module, no import
    'Sources/Checkout/Pricing.swift -> Shared/Core/Format.swift', // a top-level function
    'Tests/CheckoutTests/CartTests.swift -> Sources/Checkout/Cart.swift', // @testable import
  ]);
  // Receipt imports Core but uses only a nested Kind, an extension and a private function: no file of
  // Core stands for the whole module, and Core isn't an outside package either
  assert.deepEqual(scan.externals.map((e) => e.id), ['swiftpm:Sparkle']);
});

test('Swift: a name the file\'s own module declares wins over the same name in a module it imports', () => {
  const scan = scanOf({
    'Package.swift': 'import PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "Core"), .target(name: "App", dependencies: ["Core"])])\n',
    'Sources/Core/Theme.swift': 'public struct Theme {}\n',
    'Sources/Core/Palette.swift': 'public struct Palette {}\n',
    'Sources/App/Theme.swift': 'struct Theme {}\n',
    'Sources/App/Screen.swift': 'import Core\nstruct Screen { let t = Theme(); let p = Palette() }\n',
  });
  assert.deepEqual(linksOf(scan), [
    'Sources/App/Screen.swift -> Sources/App/Theme.swift',
    'Sources/App/Screen.swift -> Sources/Core/Palette.swift',
  ]);
});

test('Xcode app without a package: its folders link through the names they use, and only tests see test helpers', () => {
  const scan = scanOf({
    'Notes.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{}\n',
    'Notes/NotesApp.swift': 'import SwiftUI\n@main struct NotesApp: App { var body: some Scene { WindowGroup { NoteList() } } }\n',
    'Notes/Views/NoteList.swift': 'import SwiftUI\nstruct NoteList: View { let store = NoteStore(); let m = MockNotes.self; var body: some View { Text("Notes") } }\n',
    'Notes/Models/NoteStore.swift': 'import Foundation\nfinal class NoteStore { var notes: [Note] = [] }\nstruct Note { let title: String }\n',
    'NotesTests/MockNotes.swift': 'enum MockNotes { static let one = Note(title: "a") }\n',
    'NotesTests/NoteStoreTests.swift': 'import XCTest\n@testable import Notes\nfinal class NoteStoreTests: XCTestCase { let s = NoteStore(); let m = MockNotes.one }\n',
  });
  assert.deepEqual(linksOf(scan), [
    'Notes/NotesApp.swift -> Notes/Views/NoteList.swift',
    'Notes/Views/NoteList.swift -> Notes/Models/NoteStore.swift',
    'NotesTests/MockNotes.swift -> Notes/Models/NoteStore.swift',
    'NotesTests/NoteStoreTests.swift -> Notes/Models/NoteStore.swift',
    'NotesTests/NoteStoreTests.swift -> NotesTests/MockNotes.swift',
  ]);
  assert.deepEqual(scan.externals, []);
});

test('Swift files of unclosed strings, long attribute runs and unclosed comments are still read quickly', () => {
  const mb = (unit) => unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
  const cases = {
    'unclosed strings with escapes': mb('"x\\'),
    'unclosed multi-line strings': mb('"""x'),
    'attribute runs with no declaration': mb('@A(x) @B '.repeat(20) + '\n'),
    'modifier runs': mb('public final '.repeat(20) + '\n'),
    'unclosed comments': mb('/* import A '),
    'one long name': mb('A'),
  };
  for (const [name, src] of Object.entries(cases)) {
    const t = performance.now();
    extract(src, 'swift', 'Sources/Slow/Slow.swift');
    const ms = performance.now() - t;
    assert.ok(ms < 2000, `${name} took ${Math.round(ms)} ms`);
  }
});
