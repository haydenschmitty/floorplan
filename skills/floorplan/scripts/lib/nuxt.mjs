// Nuxt auto-imports. A Nuxt page uses components (<WorkspaceTeam />) and composables (useProjects()) with no
// import line, so following imports alone leaves most pages connected to nothing. Nuxt writes the name → file
// lists to .nuxt/components.d.ts and .nuxt/imports.d.ts once the app has been built or started; when they're
// there, those two files are read (only those: .nuxt/ itself is never part of the map). Without them, Nuxt's
// own conventions are followed: components/ (named with their folder prefixes), composables/ and utils/.
// Matching is by name, so a name the file defines or imports itself is left alone.
import fs from 'node:fs';
import path from 'node:path';
import { blankBlockComments } from './common.mjs';

const CONFIG = /(^|\/)nuxt\.config\.(ts|js|mjs|cjs|mts)$/;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const COMPONENT_EXT = /\.(vue|tsx|jsx|ts|js)$/;
const SCRIPT_EXT = /\.(ts|js|mjs|mts|tsx|jsx)$/;
const TRY_EXT = ['', '.ts', '.js', '.mjs', '.mts', '.tsx', '.jsx', '.vue', '/index.ts', '/index.js', '/index.mjs'];

const posix = path.posix;
const words = (s) => s.split(/[-_./\s]+/).flatMap((w) => w.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) || []);
const pascal = (parts) => parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('');
const kebabToPascal = (tag) => pascal(tag.split('-').filter(Boolean));

/**
 * A component's name from its place under components/, the way Nuxt names it: the folders become a prefix,
 * without repeating words the file name already starts with (base/BaseButton.vue → BaseButton,
 * workspace/Team.vue → WorkspaceTeam, form/index.vue → Form).
 */
export function componentName(relPath) {
  const segs = relPath.split('/');
  const file = segs.pop().replace(COMPONENT_EXT, '').replace(/\.(client|server)$/, '');
  const fileParts = file.toLowerCase() === 'index' ? [] : words(file);
  const fileContent = fileParts.join('/').toLowerCase();
  const nameParts = segs.flatMap(words);
  const suffix = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    suffix.unshift(...words(segs[i]).map((p) => p.toLowerCase()));
    const s = suffix.join('/');
    if (fileContent === s || fileContent.startsWith(s + '/')) nameParts.length = segs.slice(0, i).flatMap(words).length;
  }
  const parts = [...nameParts, ...fileParts];
  return parts.length ? pascal(parts) : null;
}

/** Nuxt apps in the file list: the folder of each nuxt.config, and its source folder (app/ in Nuxt 4, or srcDir). */
function nuxtApps(root, files) {
  const apps = [];
  for (const f of files) {
    if (!CONFIG.test(f.path)) continue;
    const dir = posix.dirname(f.path) === '.' ? '' : posix.dirname(f.path);
    const under = (d) => (d ? d + '/' : '');
    let src = dir;
    let config = '';
    try { config = fs.readFileSync(path.join(root, f.path), 'utf8').slice(0, 200000); } catch { /* unreadable: use the defaults */ }
    const srcDir = /\bsrcDir\s*:\s*['"]([^'"\n]{1,200})['"]/.exec(config)?.[1];
    if (srcDir) src = posix.normalize(posix.join(dir, srcDir.replace(/^\.\//, ''))).replace(/\/$/, '').replace(/^\.$/, '');
    else if (files.some((x) => x.path.startsWith(under(dir) + 'app/') && /^(pages|components|composables|layouts)\//.test(x.path.slice(under(dir).length + 4)))) src = under(dir) + 'app';
    apps.push({ dir, src });
  }
  // the innermost app owns a file
  return apps.sort((a, b) => b.dir.length - a.dir.length);
}

function readList(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_LIST_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/** A path from a .nuxt/*.d.ts, as one of the scanned files (or null for a package or a file not on the map). */
function target(app, spec, known) {
  if (!/^\.{1,2}\//.test(spec)) return null;
  const base = posix.normalize(posix.join(app.dir, '.nuxt', spec));
  if (base.startsWith('..') || /(^|\/)(node_modules|\.nuxt)(\/|$)/.test(base)) return null;
  for (const ext of TRY_EXT) if (known.has(base + ext)) return base + ext;
  return null;
}

/** The name → file lists Nuxt wrote, or null where the file isn't there. */
function generatedLists(root, app, known) {
  const comps = readList(path.join(root, app.dir, '.nuxt', 'components.d.ts'));
  const imps = readList(path.join(root, app.dir, '.nuxt', 'imports.d.ts'));
  let components = null, functions = null;
  if (comps != null) {
    components = new Map();
    for (const m of comps.matchAll(/['"]?([A-Z][\w$]{0,200})['"]?\s*:\s*(?:\w{1,60}<\s*)?typeof\s+import\(\s*["']([^"'\n]{1,500})["']\s*\)/g)) {
      const to = target(app, m[2], known);
      if (to && !components.has(m[1])) components.set(m[1], to);
    }
  }
  if (imps != null) {
    functions = new Map();
    for (const m of imps.matchAll(/\bexport\s*\{([^}]{0,20000})\}\s*from\s*['"]([^'"\n]{1,500})['"]/g)) {
      const to = target(app, m[2], known);
      if (!to) continue;
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !functions.has(name)) functions.set(name, to);
      }
    }
    for (const m of imps.matchAll(/\bconst\s+([A-Za-z_$][\w$]{0,200})\s*:\s*typeof\s+import\(\s*['"]([^'"\n]{1,500})['"]\s*\)/g)) {
      const to = target(app, m[2], known);
      if (to && !functions.has(m[1])) functions.set(m[1], to);
    }
  }
  return { components, functions };
}

/** The same lists from Nuxt's conventions, for an app that hasn't been built or started yet. */
function conventionLists(app, files) {
  const src = app.src ? app.src + '/' : '';
  const components = new Map(), functions = new Map();
  for (const f of files) {
    if (!f.path.startsWith(src)) continue;
    const rest = f.path.slice(src.length);
    if (rest.startsWith('components/') && COMPONENT_EXT.test(rest) && !/\.d\.ts$|\.(test|spec|stories)\./.test(rest)) {
      const name = componentName(rest.slice('components/'.length));
      if (name && !components.has(name)) components.set(name, f.path);
    }
    // composables/ and utils/: the files at the top, and index files one folder down
    if (/^(composables|utils)\/([^/]+|[^/]+\/index\.[a-z]+)$/.test(rest) && SCRIPT_EXT.test(rest) && !/\.d\.ts$|\.(test|spec)\./.test(rest)) {
      for (const s of f.symbols || []) {
        if (s.default) {
          const stem = posix.basename(rest).replace(/\.[^.]+$/, '');
          const name = stem === 'index' ? posix.basename(posix.dirname(rest)) : stem;
          const camel = words(name).map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p.toLowerCase())).join('');
          if (camel && !functions.has(camel)) functions.set(camel, f.path);
        } else if (['function', 'const'].includes(s.kind) && !functions.has(s.name)) functions.set(s.name, f.path);
      }
    }
  }
  return { components, functions };
}

/** Code without comments (block, line and HTML), keeping its length. */
function uncomment(src) {
  return blankBlockComments(src.replace(/<!--[\s\S]{0,100000}?-->/g, (m) => m.replace(/[^\n]/g, ' ')))
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
}

/** Names a file defines or imports itself, which win over an auto-import of the same name. */
function ownNames(code) {
  const own = new Set();
  for (const m of code.matchAll(/\b(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) own.add(m[1]);
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([^'";]{0,5000}?)\s+from\s+['"]/g)) for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) own.add(n);
  return own;
}

/**
 * Links from files in Nuxt apps to the components their templates use and the composables they call.
 * Returns { edges: [{ from, to, names }], apps: [{ dir, source, components, functions, files, links }] }.
 */
export function nuxtAutoImports(root, files) {
  const apps = nuxtApps(root, files);
  if (!apps.length) return { edges: [], apps: [] };
  const known = new Set(files.map((f) => f.path));
  const edges = [];
  const report = [];
  for (const app of apps) {
    const gen = generatedLists(root, app, known);
    const conv = gen.components && gen.functions ? null : conventionLists(app, files);
    const components = gen.components || conv.components;
    const functions = gen.functions || conv.functions;
    const source = gen.components && gen.functions ? '.nuxt' : gen.components || gen.functions ? 'mixed' : 'conventions';
    const info = { dir: app.dir || '.', source, components: components.size, functions: functions.size, files: 0, links: 0 };
    report.push(info);
    if (!components.size && !functions.size) continue;
    const inApp = app.dir ? app.dir + '/' : '';
    const owner = (p) => apps.find((a) => !a.dir || p.startsWith(a.dir + '/'));
    for (const f of files) {
      if (!f.path.startsWith(inApp) || owner(f.path) !== app) continue;
      if (f.category !== 'code' || f.tooLarge || !['vue', 'typescript', 'javascript'].includes(f.lang)) continue;
      // server code has Nitro's auto-imports, not the app's
      if (/^server\//.test(f.path.slice(inApp.length)) || /\.d\.ts$/.test(f.path) || CONFIG.test(f.path)) continue;
      if (!f.bytes || f.bytes > MAX_SOURCE_BYTES) continue;
      let src;
      try { src = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
      const code = uncomment(src);
      const own = ownNames(code);
      const uses = new Map(); // to -> Set(names)
      const use = (name, to) => { if (!to || to === f.path) return; if (!uses.has(to)) uses.set(to, new Set()); uses.get(to).add(name); };
      // components, from the template's tags (.vue) or JSX (.tsx, .jsx)
      const template = f.lang === 'vue' ? (/<template\b[\s\S]*<\/template>/.exec(code)?.[0] || '') : /\.(tsx|jsx)$/.test(f.path) ? code : '';
      for (const m of template.matchAll(/<([A-Za-z][\w-]{0,200})(?=[\s/>])/g)) {
        const tag = m[1];
        if (!/[A-Z]/.test(tag[0]) && !tag.includes('-')) continue; // a plain HTML element
        const name = tag.includes('-') ? kebabToPascal(tag) : tag;
        if (own.has(name)) continue;
        const to = components.get(name) || (/^Lazy[A-Z]/.test(name) ? components.get(name.slice(4)) : null);
        use(name.replace(/^Lazy(?=[A-Z])/, ''), to);
      }
      // composables and utils, from the functions it calls
      for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{0,200})\s*\(/g)) {
        const name = m[1];
        if (own.has(name) || !functions.has(name)) continue;
        use(name, functions.get(name));
      }
      for (const [to, names] of uses) { edges.push({ from: f.path, to, names: [...names].sort() }); info.links++; }
      if (uses.size) info.files++;
    }
  }
  return { edges, apps: report };
}
