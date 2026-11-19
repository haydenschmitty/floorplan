// Resolve import specifiers to files in the codebase, or to named external packages.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonLoose, stripJsonComments, MAX_CONFIG_BYTES } from './common.mjs';

const P = path.posix;

const NODE_BUILTINS = new Set(['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'test']);
const PY_STDLIB = new Set('__future__ abc argparse array ast asyncio atexit base64 bisect builtins bz2 calendar cgi cmath codecs collections colorsys concurrent configparser contextlib contextvars copy csv ctypes curses dataclasses datetime decimal difflib dis email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox math mimetypes mmap multiprocessing netrc numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile pstats pty queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess sys sysconfig syslog tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing typing_extensions unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg wsgiref xml xmlrpc zipfile zipimport zlib zoneinfo'.split(' '));
const RUST_STD = new Set(['std', 'core', 'alloc', 'crate', 'self', 'super']);
// Modules that come with Swift or Apple's SDKs: imported everywhere, never part of the codebase.
const SWIFT_SYSTEM = new Set(('Swift Foundation FoundationEssentials FoundationNetworking Dispatch Darwin Glibc Musl WinSDK ObjectiveC os OSLog Observation Synchronization ' +
  'RegexBuilder Distributed Cxx CxxStdlib System MachO XCTest Testing PackageDescription PackagePlugin SwiftUI SwiftData UIKit AppKit Cocoa Carbon WatchKit ' +
  'Combine CoreGraphics CoreFoundation CoreData CoreImage CoreText CoreML CoreLocation CoreMedia CoreVideo CoreAudio CoreAudioKit CoreAudioTypes CoreBluetooth ' +
  'CoreServices CoreSpotlight CoreTransferable CoreWLAN CoreMotion CoreMIDI CoreHaptics CoreNFC CoreTelephony QuartzCore Quartz ApplicationServices ColorSync ' +
  'AVFoundation AVFAudio AVKit AudioToolbox AudioUnit Accelerate Accessibility AppIntents AuthenticationServices BackgroundTasks Charts CloudKit Contacts ContactsUI ' +
  'CryptoKit CommonCrypto DeveloperToolsSupport DiskArbitration EventKit EventKitUI ExtensionFoundation ExtensionKit FileProvider FoundationModels GameController ' +
  'GameKit GameplayKit HealthKit HomeKit Hypervisor IOKit IOBluetooth IOSurface ImageIO ImageCaptureCore InputMethodKit Intents IntentsUI LinkPresentation ' +
  'LocalAuthentication MapKit MediaPlayer MessageUI Metal MetalKit MetalPerformanceShaders MultipeerConnectivity MusicKit NaturalLanguage Network NetworkExtension ' +
  'NotificationCenter OpenDirectory OSAKit PDFKit Photos PhotosUI QuickLook QuickLookThumbnailing QuickLookUI RealityKit ReplayKit SafariServices SceneKit ' +
  'ScreenCaptureKit ScriptingBridge Security SecurityFoundation SecurityInterface ServiceManagement ShazamKit SoundAnalysis Speech SpriteKit StoreKit ' +
  'SystemConfiguration SystemExtensions TipKit Translation UniformTypeIdentifiers UserNotifications UserNotificationsUI VideoToolbox Virtualization Vision ' +
  'VisionKit WebKit WidgetKit ARKit Automator zlib SQLite3 simd MetricKit CoreMediaIO').split(' '));

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.d.ts', '.json'];

/** What `*` stands for when `spec` matches `pattern` ('' for an exact match), or null if it doesn't match. */
function matchStarPattern(pattern, spec) {
  const star = pattern.indexOf('*');
  if (star === -1) return spec === pattern ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
  return spec.slice(star, spec.length - suffix.length);
}

/**
 * The package.json "imports" entry Node would use for `spec`: an exact key first, otherwise the
 * matching `*` key with the longest text before the `*` (then the longest key).
 */
function bestSubpathImport(entries, spec) {
  const exact = entries.find(([key]) => key === spec);
  if (exact) return { target: exact[1], matched: '' };
  let best = null;
  for (const [key, target] of entries) {
    if (!key.includes('*')) continue;
    const matched = matchStarPattern(key, spec);
    if (!matched) continue; // Node needs `*` to stand for at least one character here, unlike tsconfig paths
    const prefixLength = key.indexOf('*');
    if (!best || prefixLength > best.prefixLength || (prefixLength === best.prefixLength && key.length > best.key.length)) {
      best = { key, target, matched, prefixLength };
    }
  }
  return best;
}

/**
 * Every path an "imports" target can point to, in order. Which conditions apply isn't known
 * statically, so all are tried; "types" goes last because Node never picks it, but it is often
 * the only target that points at source rather than a build folder.
 */
function subpathTargets(target, depth = 0) {
  if (typeof target === 'string') return [target];
  // A package.json in code you didn't write can nest arrays and conditions without end; real ones go a few levels.
  if (depth > 16) return [];
  if (Array.isArray(target)) return target.flatMap((t) => subpathTargets(t, depth + 1));
  if (!target || typeof target !== 'object') return [];
  const conditions = Object.entries(target);
  return [...conditions.filter(([c]) => c !== 'types'), ...conditions.filter(([c]) => c === 'types')].flatMap(([, t]) => subpathTargets(t, depth + 1));
}

/** The folder of the nearest .csproj above each path, or null. */
export function csProjects(paths) {
  const projects = new Set(paths.filter((p) => p.endsWith('.csproj')).map((p) => P.dirname(p)));
  return (p) => {
    for (let d = P.dirname(p); ; d = P.dirname(d)) {
      if (projects.has(d)) return d;
      if (d === '.' || d === '/' || d === P.dirname(d)) return null;
    }
  };
}

/** A C# `global using` puts its namespace in scope for every file of the same project. */
export function applyGlobalUsings(files) {
  const cs = files.filter((f) => f.lang === 'csharp' && f.imports);
  if (!cs.some((f) => f.imports.some((i) => i.global))) return;
  const projectOf = csProjects(files.map((f) => f.path));
  const globals = new Map(); // project -> [{ spec, from }]
  for (const f of cs) for (const imp of f.imports) {
    if (!imp.global) continue;
    const k = projectOf(f.path) ?? '';
    globals.set(k, [...(globals.get(k) || []), { spec: imp.spec, from: f.path }]);
  }
  for (const f of cs) {
    const own = new Set(f.imports.map((i) => i.spec));
    for (const g of globals.get(projectOf(f.path) ?? '') || []) {
      if (g.from === f.path || own.has(g.spec)) continue;
      own.add(g.spec);
      f.imports.push({ spec: g.spec, names: [], line: 1, implicit: true });
    }
  }
}

export function createResolver(root, files) {
  const fileSet = new Set(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const dirsWith = (name) => files.filter((f) => P.basename(f.path) === name).map((f) => P.dirname(f.path));

  // ---- JS: tsconfig/jsconfig paths, package.json imports, workspace packages ----
  const tsconfigCache = new Map();
  const loadTsconfig = (file) => {
    if (tsconfigCache.has(file)) return tsconfigCache.get(file);
    // Marked as "nothing" while it's being read, so a config whose "extends" leads back to itself (directly
    // or through others) ends there instead of going round until the scan runs out of stack.
    tsconfigCache.set(file, null);
    let cfg = null;
    const json = readJsonLoose(path.join(root, file));
    if (json) {
      const dir = P.dirname(file);
      const opts = json.compilerOptions || {};
      let paths;
      let pathsDir = dir;
      let baseUrl;
      // Later bases override earlier ones, then the child overrides both. Paths and baseUrl
      // can come from different configs, so keep their declaring directories separately.
      const bases = Array.isArray(json.extends) ? json.extends : [json.extends];
      for (const ext of bases) {
        if (typeof ext !== 'string' || !ext.startsWith('.')) continue;
        const extFile = P.normalize(P.join(dir, ext.endsWith('.json') ? ext : ext + '.json'));
        const base = fileSet.has(extFile) ? loadTsconfig(extFile) : null;
        if (base?.hasPaths) { paths = base.paths; pathsDir = base.pathsDir; }
        if (base?.hasBaseUrl) baseUrl = base.baseDir;
      }
      if (opts.paths) { paths = Object.entries(opts.paths); pathsDir = dir; }
      if (typeof opts.baseUrl === 'string') baseUrl = P.normalize(P.join(dir, opts.baseUrl));
      cfg = { paths: paths || [], pathsDir, hasPaths: paths !== undefined,
        baseDir: baseUrl ?? pathsDir, hasBaseUrl: baseUrl !== undefined };
    }
    tsconfigCache.set(file, cfg);
    return cfg;
  };
  const nearestCache = new Map();
  const nearestTsconfig = (dir) => {
    if (nearestCache.has(dir)) return nearestCache.get(dir);
    let found = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const f = dir === '.' ? name : `${dir}/${name}`;
      if (fileSet.has(f)) { found = loadTsconfig(f); if (found) break; }
    }
    if (!found && dir !== '.' && dir !== '') found = nearestTsconfig(P.dirname(dir));
    nearestCache.set(dir, found);
    return found;
  };
  const packageJsons = new Map(dirsWith('package.json').map((dir) => [dir, readJsonLoose(path.join(root, dir, 'package.json'))]));
  const workspacePkgs = new Map();
  for (const [dir, pj] of packageJsons) if (pj?.name) workspacePkgs.set(pj.name, { dir, pj });

  const tryJsFile = (p) => {
    p = P.normalize(p);
    if (fileSet.has(p) && !p.endsWith('/')) return p;
    for (const ext of JS_EXTS) if (fileSet.has(p + ext)) return p + ext;
    const jsToTs = p.replace(/\.(m|c)?jsx?$/, '');
    if (jsToTs !== p) for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (fileSet.has(jsToTs + ext)) return jsToTs + ext;
    for (const ext of JS_EXTS) if (fileSet.has(`${p}/index${ext}`)) return `${p}/index${ext}`;
    return null;
  };

  // Node subpath imports ("#lib/x") resolve through the "imports" field of the nearest package.json.
  const subpathScopeCache = new Map();
  const nearestPackageScope = (dir) => {
    if (subpathScopeCache.has(dir)) return subpathScopeCache.get(dir);
    let scope = null;
    if (packageJsons.has(dir)) {
      const imports = packageJsons.get(dir)?.imports;
      scope = { dir, imports: imports && typeof imports === 'object' && !Array.isArray(imports) ? Object.entries(imports) : [] };
    }
    else if (dir !== '.' && dir !== '') scope = nearestPackageScope(P.dirname(dir));
    subpathScopeCache.set(dir, scope);
    return scope;
  };
  const resolveSubpathImport = (from, spec) => {
    const scope = nearestPackageScope(P.dirname(from));
    const entry = scope && bestSubpathImport(scope.imports, spec);
    if (!entry) return null;
    for (const t of subpathTargets(entry.target)) {
      const hit = tryJsFile(P.join(scope.dir, t.split('*').join(entry.matched)));
      if (hit) return hit;
    }
    return null;
  };

  const resolveJs = (from, spec) => {
    if (spec.startsWith('.')) {
      const hit = tryJsFile(P.join(P.dirname(from), spec));
      return hit ? { file: hit } : { unresolved: true };
    }
    if (spec.startsWith('#')) {
      const hit = resolveSubpathImport(from, spec);
      if (hit) return { file: hit };
    }
    const cfg = nearestTsconfig(P.dirname(from));
    const mapped = []; // where a path alias points, when nothing is there
    if (cfg) {
      for (const [pattern, targets] of cfg.paths) {
        const matched = matchStarPattern(pattern, spec);
        if (matched === null || !Array.isArray(targets)) continue;
        for (const t of targets) {
          if (typeof t !== 'string') continue;
          const cand = P.join(cfg.baseDir, t.split('*').join(matched));
          const hit = tryJsFile(cand);
          if (hit) return { file: hit };
          mapped.push(P.normalize(cand));
        }
      }
      if (cfg.hasBaseUrl) { const hit = tryJsFile(P.join(cfg.baseDir, spec)); if (hit) return { file: hit }; }
    }
    const wf = wayfinder(from, mapped.length ? mapped : /^[@~#]\/(actions|routes|wayfinder)(\/|$)/.test(spec) ? [spec.slice(2)] : []);
    if (wf) return wf;
    if (spec.startsWith('node:')) return { builtin: true };
    const parts = spec.split('/');
    const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
    const ws = workspacePkgs.get(pkgName);
    if (ws) {
      if (sub) { const hit = tryJsFile(P.join(ws.dir, sub)) || tryJsFile(P.join(ws.dir, 'src', sub)); if (hit) return { file: hit }; }
      const exp = ws.pj.exports;
      const entries = [ws.pj.source, typeof exp === 'string' ? exp : exp?.['.']?.import || exp?.['.']?.default || (typeof exp?.['.'] === 'string' ? exp['.'] : null), ws.pj.module, ws.pj.main, 'src/index', 'index'];
      for (const e of entries) { if (typeof e !== 'string') continue; const hit = tryJsFile(P.join(ws.dir, e)); if (hit) return { file: hit }; }
    }
    if (NODE_BUILTINS.has(pkgName)) return { builtin: true };
    if (/^[@a-z0-9]/i.test(pkgName)) return { external: pkgName, eco: 'npm' };
    return { unresolved: true };
  };

  // ---- Python ----
  const pyRootsCache = new Map();
  const pyRootsFor = (from, repoPath) => {
    const dir = P.dirname(from);
    const key = dir + '|' + repoPath;
    if (pyRootsCache.has(key)) return pyRootsCache.get(key);
    const roots = [];
    const repoRoot = repoPath === '.' ? '' : repoPath;
    let d = dir;
    while (true) {
      roots.push(d === '.' ? '' : d);
      if (d === repoRoot || d === '.' || d === '') break;
      d = P.dirname(d);
    }
    roots.push(repoRoot ? repoRoot + '/src' : 'src');
    pyRootsCache.set(key, roots);
    return roots;
  };
  const tryPyModule = (base) => {
    const b = base.replace(/^\/+/, '');
    if (fileSet.has(b + '.py')) return b + '.py';
    if (fileSet.has(b + '/__init__.py')) return b + '/__init__.py';
    if (fileSet.has(b + '.pyi')) return b + '.pyi';
    return null;
  };
  const resolvePy = (from, imp, repoPath) => {
    const spec = imp.spec;
    if (spec.startsWith('.')) {
      const dots = spec.match(/^\.+/)[0].length;
      let base = P.dirname(from);
      for (let i = 1; i < dots; i++) base = P.dirname(base);
      const rest = spec.slice(dots).replace(/\./g, '/');
      const modBase = rest ? P.join(base, rest) : base;
      const mod = rest ? tryPyModule(modBase) : null;
      const subs = (imp.names || []).map((n) => tryPyModule(P.join(modBase, n))).filter(Boolean);
      if (subs.length) return { files: subs, names: imp.names, module: mod };
      if (mod) return { file: mod };
      if (!rest) { const init = tryPyModule(base); if (init) return { file: init }; }
      return { unresolved: true };
    }
    const top = spec.split('.')[0];
    const modPath = spec.replace(/\./g, '/');
    const roots = pyRootsFor(from, repoPath);
    for (const r of roots) {
      const base = r ? `${r}/${modPath}` : modPath;
      if (imp.from && imp.names?.length) {
        const subs = imp.names.map((n) => tryPyModule(`${base}/${n}`)).filter(Boolean);
        if (subs.length) return { files: subs, names: imp.names, module: tryPyModule(base) };
      }
      const hit = tryPyModule(base);
      if (hit) return { file: hit };
    }
    // `import a.b.c` where only a/b exists. Only once no root has the whole module, and the longest prefix
    // in any root wins: otherwise a nearer root's short prefix is taken first (`apps.orders.models`
    // imported inside a Django app hits that app's own apps.py).
    const parts = modPath.split('/').slice(0, 20); // no real module path is deeper; each try joins them again
    for (let k = parts.length - 1; k >= 1; k--) {
      const prefix = parts.slice(0, k).join('/');
      for (const r of roots) {
        const h = tryPyModule(r ? `${r}/${prefix}` : prefix);
        if (h) return { file: h };
      }
    }
    if (PY_STDLIB.has(top)) return { builtin: true };
    return { external: top, eco: 'pypi' };
  };

  // ---- Go ----
  const goMods = dirsWith('go.mod').map((dir) => {
    const txt = fs.readFileSync(path.join(root, dir, 'go.mod'), 'utf8');
    return { dir, module: /^module\s+(\S+)/m.exec(txt)?.[1] };
  }).filter((m) => m.module).sort((a, b) => b.module.length - a.module.length);
  const goDirFiles = new Map();
  for (const f of files) if (f.path.endsWith('.go') && !f.path.endsWith('_test.go')) {
    const d = P.dirname(f.path);
    if (!goDirFiles.has(d)) goDirFiles.set(d, []);
    goDirFiles.get(d).push(f.path);
  }
  const resolveGo = (from, spec) => {
    for (const m of goMods) {
      if (spec === m.module || spec.startsWith(m.module + '/')) {
        const dir = P.normalize(P.join(m.dir, spec.slice(m.module.length)));
        const list = goDirFiles.get(dir === '' ? '.' : dir);
        if (list?.length) {
          const pref = list.find((p) => P.basename(p, '.go') === P.basename(dir)) || list.sort()[0];
          return { file: pref };
        }
        return { unresolved: true };
      }
    }
    if (!spec.split('/')[0].includes('.')) return { builtin: true };
    return { external: spec.split('/').slice(0, 3).join('/'), eco: 'go' };
  };

  // ---- Rust ----
  const crateRoots = dirsWith('Cargo.toml').map((d) => (d === '.' ? 'src' : `${d}/src`)).sort((a, b) => b.length - a.length);
  const resolveRust = (from, imp) => {
    const dir = P.dirname(from);
    const stem = P.basename(from, '.rs');
    if (imp.kind === 'mod') {
      const base = ['mod', 'lib', 'main'].includes(stem) ? dir : `${dir}/${stem}`;
      for (const c of [`${base}/${imp.spec}.rs`, `${base}/${imp.spec}/mod.rs`]) if (fileSet.has(c)) return { file: c };
      return { unresolved: true };
    }
    const segs = imp.spec.split('::');
    if (segs[0] === 'crate') {
      const cr = crateRoots.find((r) => from.startsWith(r + '/'));
      if (!cr) return { unresolved: true };
      const rest = segs.slice(1, 21);
      for (let k = rest.length; k >= 1; k--) {
        const b = `${cr}/${rest.slice(0, k).join('/')}`;
        for (const c of [b + '.rs', b + '/mod.rs']) if (fileSet.has(c)) return { file: c };
      }
      return { unresolved: true };
    }
    if (RUST_STD.has(segs[0])) return { builtin: true };
    return { external: segs[0], eco: 'cargo' };
  };

  // ---- JVM ----
  // `<package>.<name>` -> the files declaring it: each file's own name, and every top-level class, function,
  // value and type alias in it (a Kotlin file often holds several, none named after the file)
  const jvmIndex = new Map();
  const addJvm = (key, file) => { const l = jvmIndex.get(key); if (!l) jvmIndex.set(key, [file]); else if (!l.includes(file)) l.push(file); };
  // package -> top-level name -> the files declaring it, for names a file uses without importing them
  const jvmPackages = new Map();
  for (const f of files) {
    if (!f.pkg) continue;
    addJvm(`${f.pkg}.${P.basename(f.path).replace(/\.\w+$/, '')}`, f.path);
    if (!jvmPackages.has(f.pkg)) jvmPackages.set(f.pkg, new Map());
    const names = jvmPackages.get(f.pkg);
    for (const d of f.decls || []) {
      addJvm(`${f.pkg}.${d}`, f.path);
      if (!names.has(d)) names.set(d, []);
      names.get(d).push(f.path);
    }
  }
  const jvmHit = (list) => (list.length === 1 ? { file: list[0] } : { files: list });
  // Tests see the code they test, but nothing outside them sees a test's helpers
  const JVM_TEST = /(^|\/)(src\/(test|androidTest|testFixtures|\w+Test)|tests?)\//;
  /**
   * The files of package `pkg` whose top-level names `file` mentions: what Kotlin and Java see without an
   * import in their own package, or through `import pkg.*`. Looked up name by name, so a big package costs
   * no more than a small one.
   */
  const jvmMentioned = (file, pkg, shadowedBy) => {
    const names = jvmPackages.get(pkg);
    if (!names?.size || !file.mentions) return [];
    // An explicit import of the same simple name wins over the package (and, for `pkg.*`, so does the file's own package)
    const imported = new Set((file.imports || []).filter((i) => !i.spec.endsWith('*')).map((i) => i.spec.split('.').pop()));
    const own = shadowedBy ? jvmPackages.get(shadowedBy) : null;
    const fromTest = JVM_TEST.test(file.path);
    const out = new Set();
    for (const n of file.mentions.split(' ')) {
      const hits = names.get(n);
      if (!hits || imported.has(n) || own?.has(n)) continue;
      for (const h of hits) if (h !== file.path && (fromTest || !JVM_TEST.test(h))) out.add(h);
    }
    return [...out].sort();
  };
  const resolveJvm = (file, imp) => {
    const spec = imp.spec;
    if (spec.endsWith('.*') && jvmPackages.has(spec.slice(0, -2))) {
      const pkg = spec.slice(0, -2);
      const hits = jvmMentioned(file, pkg, imp.implicit || pkg === file.pkg ? null : file.pkg);
      // a package of the project's own: linked to what's used from it, never an external package
      return hits.length ? jvmHit(hits) : { internal: true };
    }
    if (imp.implicit) return { internal: true };
    if (jvmIndex.has(spec)) return jvmHit(jvmIndex.get(spec));
    if (/^(java|javax|kotlin|scala|jdk|sun)\./.test(spec)) return { builtin: true };
    const parts = spec.split('.').slice(0, 20);
    // `Outer.Inner`, `Util.CONSTANT` (static imports), `Foo.Companion.bar`: the longest prefix that names a
    // declaration. A package declared in the scanned code is the project's own, so reaching one first means
    // a name missing from it, never an external package.
    for (let k = parts.length - 1; k >= 1; k--) {
      const prefix = parts.slice(0, k).join('.');
      if (jvmPackages.has(prefix)) return { unresolved: true };
      if (k >= 2 && jvmIndex.has(prefix)) return jvmHit(jvmIndex.get(prefix));
    }
    return { external: parts.slice(0, Math.min(3, parts.length - 1)).join('.'), eco: 'maven' };
  };

  // ---- Swift ----
  // A Swift import names a module (a Swift package target), and the files of one module use each other's
  // code without importing anything. So a file links to the files declaring the top-level names it uses,
  // in its own module and in the modules it imports. Targets come from every Package.swift: `path:` when
  // given, else Sources/<name> (Tests/<name> for test targets). Code outside every package is one module
  // per Xcode project (else per repo), and an import no target answers falls back to a folder named like it.
  const swiftModules = new Map();
  for (const dir of dirsWith('Package.swift')) {
    let txt;
    try {
      const file = path.join(root, dir, 'Package.swift');
      if (fs.statSync(file).size > MAX_CONFIG_BYTES) continue;
      txt = stripJsonComments(fs.readFileSync(file, 'utf8'));
    } catch { continue; }
    let skipUntil = -1; // `.target(name: "B")` inside another target's dependencies is a reference, not a target
    for (const m of txt.matchAll(/\.(target|executableTarget|testTarget|macro|plugin|systemLibrary|binaryTarget)\s*\(/g)) {
      if (m.index < skipUntil) continue;
      const body = balancedArgs(txt, m.index + m[0].length - 1);
      skipUntil = m.index + m[0].length + body.length;
      const name = /\bname\s*:\s*"([^"]+)"/.exec(body)?.[1];
      if (!name || swiftModules.has(name)) continue;
      const given = /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1];
      const base = m[1] === 'testTarget' ? 'Tests' : m[1] === 'plugin' ? 'Plugins' : 'Sources';
      swiftModules.set(name, P.normalize(P.join(dir, given ?? `${base}/${name}`)));
    }
  }
  const swiftFiles = files.filter((f) => f.lang === 'swift');
  const swiftDirByName = new Map();
  for (const f of swiftFiles) {
    for (let d = P.dirname(f.path); d && d !== '.'; d = P.dirname(d)) {
      const b = P.basename(d);
      if (!swiftDirByName.has(b)) swiftDirByName.set(b, d);
      else if (swiftDirByName.get(b) !== d) swiftDirByName.set(b, null);
    }
  }
  const targetDirs = [...new Set(swiftModules.values())].sort((a, b) => b.length - a.length);
  const isTarget = new Set(targetDirs);
  const under = (p, dir) => dir === '.' || p.startsWith(dir + '/');
  // Code outside any package belongs to the Xcode project around it (the folder holding the
  // .xcodeproj), else to its repo: a whole app target is one module, whatever its folders.
  const xcodeRoots = files.map((f) => /^(?:(.*)\/)?[^/]+\.xcodeproj\/project\.pbxproj$/.exec(f.path)).filter(Boolean)
    .map((m) => m[1] || '.').sort((a, b) => b.length - a.length);
  const ownModule = (file) => targetDirs.find((d) => under(file.path, d)) || xcodeRoots.find((d) => under(file.path, d)) || file.repo || '.';
  // module folder -> top-level name -> the files declaring it
  const swiftNames = new Map();
  const namesIn = (dir) => {
    if (swiftNames.has(dir)) return swiftNames.get(dir);
    const names = new Map();
    // a target is its folder; an Xcode app or loose code is its folder minus the packages inside it
    for (const f of swiftFiles) if (under(f.path, dir) && (isTarget.has(dir) || !targetDirs.some((d) => under(f.path, d)))) {
      for (const n of f.decls || []) { if (!names.has(n)) names.set(n, []); names.get(n).push(f.path); }
    }
    swiftNames.set(dir, names);
    return names;
  };
  // Tests see the code they test, but nothing outside them sees a test's helpers (in an Xcode app, the
  // test folders sit in the same module as the app)
  const SWIFT_TEST = /(^|\/)(Tests|\w+Tests)\/|Tests?\.swift$/;
  /** The files of module `dir` declaring names `file` mentions; `shadow`: a module whose names win (the file's own). */
  const swiftMentioned = (file, dir, shadow) => {
    const names = namesIn(dir);
    if (!names.size || !file.mentions) return [];
    const own = shadow ? namesIn(shadow) : null;
    const fromTest = SWIFT_TEST.test(file.path);
    const out = new Set();
    for (const n of file.mentions.split(' ')) {
      const hits = names.get(n);
      if (!hits || own?.has(n)) continue;
      for (const h of hits) if (h !== file.path && (fromTest || !SWIFT_TEST.test(h))) out.add(h);
    }
    return [...out].sort();
  };
  const resolveSwift = (file, imp) => {
    const own = ownModule(file);
    // A module of the project's own is linked to what's used from it, and never listed as an outside
    // package. Nothing used from it (only its extensions or nested types, say) means no link: no one file
    // stands for a whole module.
    const link = (dir) => { const hits = swiftMentioned(file, dir, dir === own ? null : own); return hits.length ? { files: hits } : { internal: true }; };
    if (imp.implicit) return link(own);
    if (swiftModules.has(imp.spec)) return link(swiftModules.get(imp.spec));
    if (SWIFT_SYSTEM.has(imp.spec) || imp.spec.startsWith('_')) return { builtin: true };
    const dir = swiftDirByName.get(imp.spec);
    if (dir) return link(dir);
    return { external: imp.spec, eco: 'swiftpm' };
  };

  // ---- C# ----
  // A `using` names a namespace, not a file, so it links only the files in that namespace that
  // declare a type this file mentions.
  const csTypes = new Map(); // namespace -> Map(type name -> [files])
  for (const f of files) for (const ns of f.lang === 'csharp' ? f.namespaces || [] : []) {
    if (!csTypes.has(ns)) csTypes.set(ns, new Map());
    const byName = csTypes.get(ns);
    for (const s of f.symbols || []) byName.set(s.name, [...(byName.get(s.name) || []), f.path]);
  }
  const csRoots = new Set([...csTypes.keys()].map((ns) => ns.split('.')[0]));
  const CS_BUILTIN = /^(System|Microsoft\.(AspNetCore|Extensions|CSharp|VisualBasic|Win32|NET))(\.|$)/;
  const resolveCs = (file, imp) => {
    const byName = csTypes.get(imp.spec);
    if (byName) {
      const targets = new Map(); // file -> the first type it supplies
      for (const [name, paths] of byName) if (file.typeRefs?.has(name)) for (const p of paths) if (p !== file.path && !targets.has(p)) targets.set(p, name);
      return targets.size ? { files: [...targets.keys()], names: [...targets.values()] } : { unused: true };
    }
    // `using static Orders.Domain.OrderRules;` names a type
    const dot = imp.spec.lastIndexOf('.');
    const declaring = (csTypes.get(imp.spec.slice(0, dot))?.get(imp.spec.slice(dot + 1)) || []).filter((p) => p !== file.path);
    if (declaring.length) return { files: declaring };
    // the project's own namespace that declares no types itself, or a using it doesn't need
    if (imp.implicit || csRoots.has(imp.spec.split('.')[0])) return { unused: true };
    if (CS_BUILTIN.test(imp.spec)) return { builtin: true };
    return { external: imp.spec.split('.').slice(0, 2).join('.'), eco: 'nuget' };
  };

  // ---- generic relative (C, Ruby, PHP, CSS) ----
  const byBasename = new Map();
  for (const f of files) { const b = P.basename(f.path); byBasename.set(b, byBasename.has(b) ? null : f.path); }
  const resolveRelative = (from, spec, exts) => {
    const base = P.normalize(P.join(P.dirname(from), spec));
    for (const e of ['', ...exts]) if (fileSet.has(base + e)) return { file: base + e };
    const uniq = byBasename.get(P.basename(spec));
    if (uniq) return { file: uniq };
    return { unresolved: true };
  };

  // ---- Shopify themes ----
  const resolveLiquid = (from, imp) => {
    const app = /^shopify:\/\/apps\/([\w-]+)/.exec(imp.spec);
    if (app) return { external: app[1], eco: 'shopify-app' };
    const p = P.normalize(P.join(P.dirname(from), imp.spec));
    for (const c of [p, p + '.liquid']) if (fileSet.has(c)) return { file: c };
    return imp.kind === 'theme-block' ? { builtin: true } : { unresolved: true }; // a block from its section's schema has no file
  };

  // ---- PHP: classes by full name (namespace + class), then composer's PSR-4 folders; files by path ----
  const phpIndex = new Map();
  for (const f of files) if (f.lang === 'php') for (const c of f.classes || []) if (!phpIndex.has(c.toLowerCase())) phpIndex.set(c.toLowerCase(), f.path);
  const composerRoots = dirsWith('composer.json').map((dir) => {
    const j = readJsonLoose(path.join(root, dir, 'composer.json')) || {};
    const psr4 = [...Object.entries(j.autoload?.['psr-4'] || {}), ...Object.entries(j['autoload-dev']?.['psr-4'] || {})]
      .flatMap(([ns, d]) => [].concat(d).map((x) => [ns.replace(/\\+$/, ''), x]))
      .sort((a, b) => b[0].length - a[0].length);
    return { dir, psr4, laravel: !!(j.require?.['laravel/framework'] || j['require-dev']?.['laravel/framework']) };
  }).sort((a, b) => b.dir.length - a.dir.length);
  const composerFor = (p) => composerRoots.find((c) => c.dir === '.' || p.startsWith(c.dir + '/'));
  const resolvePhp = (from, imp, repoPath) => {
    const spec = imp.spec;
    if (imp.kind === 'class') {
      const hit = phpIndex.get(spec.toLowerCase());
      if (hit) return { file: hit };
      const c = composerFor(from);
      for (const [ns, d] of c?.psr4 || []) {
        if (ns && !spec.startsWith(ns + '\\')) continue;
        const p = P.normalize(P.join(c.dir, d, (ns ? spec.slice(ns.length + 1) : spec).replace(/\\/g, '/') + '.php'));
        if (fileSet.has(p)) return { file: p };
      }
      // under one of the project's own namespaces but nowhere to be found: a same-namespace name PHP's
      // built-ins answer (or a typo); not worth counting as a missed import
      if (!spec.includes('\\') || c?.psr4.some(([ns]) => ns && spec.startsWith(ns + '\\'))) return { builtin: true };
      const segs = spec.split('\\');
      // vendor namespaces: Illuminate\…, Inertia\…, and Laravel\Sanctum, Spatie\Permission… (vendors with many packages)
      return { external: segs.slice(0, /^(Laravel|Spatie|League|Symfony)$/.test(segs[0]) && segs.length > 2 ? 2 : 1).join('\\'), eco: 'composer' };
    }
    if (spec.startsWith('@base/')) {
      const base = composerFor(from)?.dir ?? (repoPath && repoPath !== '.' ? repoPath : '.');
      const p = P.normalize(P.join(base, spec.slice(6)));
      return fileSet.has(p) ? { file: p } : { unresolved: true };
    }
    return resolveRelative(from, spec, ['.php']);
  };

  /**
   * Laravel Wayfinder: `import { show } from '@/routes/posts'` and `import PostController from
   * '@/actions/App/Http/Controllers/PostController'` point at files Wayfinder generates and git usually
   * ignores. They stand for named routes and controller actions, which routes.mjs matches to endpoints.
   */
  function wayfinder(from, mapped) {
    const app = composerRoots.find((c) => c.laravel && (c.dir === '.' || from.startsWith(c.dir + '/')));
    if (!app) return null;
    for (const m of mapped) {
      const w = /(?:^|\/)(actions|routes|wayfinder)(?:\/(.*))?$/.exec(m);
      if (!w) continue;
      const rest = (w[2] || '').replace(/(^|\/)index$/, '');
      if (w[1] === 'wayfinder') return { builtin: true };
      if (w[1] === 'actions' && rest) return { wayfinder: { kind: 'action', cls: rest.split('/').join('\\') } };
      if (w[1] === 'routes') return { wayfinder: { kind: 'route', prefix: rest ? rest.split('/').join('.') : '' } };
    }
    return null;
  }

  return function resolve(file, imp) {
    const lang = file.lang;
    switch (lang) {
      case 'typescript': case 'javascript': case 'vue': case 'svelte': case 'astro': return resolveJs(file.path, imp.spec);
      case 'python': return resolvePy(file.path, imp, file.repo);
      case 'go': return resolveGo(file.path, imp.spec);
      case 'rust': return resolveRust(file.path, imp);
      case 'java': case 'kotlin': case 'scala': case 'groovy': return resolveJvm(file, imp);
      case 'swift': return resolveSwift(file, imp);
      case 'csharp': return resolveCs(file, imp);
      case 'ruby': return resolveRelative(file.path, imp.spec, ['.rb']);
      case 'php': return resolvePhp(file.path, imp, file.repo);
      case 'liquid': return resolveLiquid(file.path, imp);
      case 'css': return resolveRelative(file.path, imp.spec, ['.css', '.scss', '.sass', '.less']).file ? resolveRelative(file.path, imp.spec, ['.css', '.scss']) : resolveRelative(file.path, P.join(P.dirname(imp.spec), '_' + P.basename(imp.spec)), ['.scss', '.sass']);
      default: return resolveRelative(file.path, imp.spec, []);
    }
  };
}

// The text between the parenthesis at `open` and its match, skipping strings.
function balancedArgs(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { i++; while (i < src.length && src[i] !== '"' && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}
