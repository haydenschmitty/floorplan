// Swift: imports name a module (a Swift package target), and files of one module use each other's
// types without importing them. Both become links to the files that declare the types used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, makeProject, run } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

test('Swift: module imports, attributes and declared types', () => {
  const r = extract([
    'import SwiftUI',
    '@testable import Core',
    '@preconcurrency import struct Billing.Invoice',
    '// import Commented',
    'let text = "import NotAnImport"',
    'public final class Checkout {',
    '  class func make() -> Checkout { Checkout() }',
    '  enum Kind { case card }',
    '}',
    'actor Ledger {}',
    'private struct Helper {}',
  ].join('\n'), 'swift', 'App/Checkout.swift');
  assert.deepEqual(r.imports.filter((i) => i.kind !== 'own-module').map((i) => i.spec), ['SwiftUI', 'Core', 'Billing']);
  assert.deepEqual(r.symbols.map((s) => `${s.kind} ${s.name}${s.local ? ' (local)' : ''}`),
    ['class Checkout', 'enum Kind (local)', 'actor Ledger', 'struct Helper (local)']);
});

test('Swift package: imports link to the target files declaring the types used, and files of one module link to each other', () => {
  const root = makeProject({
    'Package.swift': [
      'import PackageDescription',
      'let package = Package(name: "Shop", dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.0.0")],',
      '  targets: [',
      '    .target(name: "Core", dependencies: [], path: "Shared/Core"),',
      '    .target(name: "Checkout", dependencies: [.target(name: "Core"), "Sparkle"]),',
      '    // .target(name: "Parked", dependencies: ["Core"]),',
      '    .testTarget(name: "CheckoutTests", dependencies: ["Checkout"]),',
      '  ])',
    ].join('\n'),
    'Shared/Core/Settings.swift': 'import Foundation\npublic struct Settings { public enum Kind { case a } }\n',
    'Shared/Core/Theme.swift': 'public enum Theme {}\n',
    'Sources/Checkout/Cart.swift': 'import Core\nimport Sparkle\nstruct Cart { let s: Settings; let p = Pricing() }\n',
    'Sources/Checkout/Pricing.swift': 'struct Pricing { enum Kind { case net } }\n',
    'Sources/Checkout/Receipt.swift': 'import Core\nstruct Receipt { let k: Kind }\n',
    'Tests/CheckoutTests/CartTests.swift': 'import XCTest\n@testable import Checkout\nfinal class CartTests: XCTestCase { let c: Cart? = nil }\n',
  });
  try {
    run('scan.mjs', root);
    const scan = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8'));
    const links = scan.edges.map((e) => `${e.from} -> ${e.to}`).sort();
    assert.deepEqual(links, [
      'Sources/Checkout/Cart.swift -> Shared/Core/Settings.swift', // import, through the target's own path
      'Sources/Checkout/Cart.swift -> Sources/Checkout/Pricing.swift', // same module, no import
      'Sources/Checkout/Receipt.swift -> Shared/Core/Settings.swift', // only a nested Kind: links to the module, through its first file
      'Tests/CheckoutTests/CartTests.swift -> Sources/Checkout/Cart.swift', // @testable import
    ].sort());
    assert.deepEqual(scan.externals.map((e) => e.id), ['swiftpm:Sparkle']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Xcode app without a package: files in different folders of the app link through the types they use', () => {
  const root = makeProject({
    'Notes.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{}\n',
    'Notes/NotesApp.swift': 'import SwiftUI\n@main struct NotesApp: App { var body: some Scene { WindowGroup { NoteList() } } }\n',
    'Notes/Views/NoteList.swift': 'import SwiftUI\nstruct NoteList: View { let store = NoteStore(); var body: some View { Text("Notes") } }\n',
    'Notes/Models/NoteStore.swift': 'import Foundation\nfinal class NoteStore { var notes: [Note] = [] }\nstruct Note { let title: String }\n',
  });
  try {
    run('scan.mjs', root);
    const scan = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8'));
    assert.deepEqual(scan.edges.map((e) => `${e.from} -> ${e.to}`).sort(), [
      'Notes/NotesApp.swift -> Notes/Views/NoteList.swift',
      'Notes/Views/NoteList.swift -> Notes/Models/NoteStore.swift',
    ]);
    assert.deepEqual(scan.externals, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
