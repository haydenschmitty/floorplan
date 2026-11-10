// Shared helpers: paths, globs, file classification, git, and codebase discovery.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const toPosix = (p) => p.replace(/\\/g, '/');
export const rel = (from, to) => toPosix(path.relative(from, to)) || '.';

// ---------- globs ----------

const GLOB_CHARS = /[*?{[]/;
// Limits on a pattern, so a careless or hostile one can't make matching slow: its length, its wildcards and
// its {a,b} groups (each adds alternatives every path is tried against)
export const GLOB_LIMITS = { length: 300, wildcards: 12, braces: 8 };

/** Why a glob can't be used, in plain words, or null when it's fine. */
export function globProblem(glob) {
  if (typeof glob !== 'string') return 'it is not text';
  if (glob.length > GLOB_LIMITS.length) return `it is longer than ${GLOB_LIMITS.length} characters`;
  const g = tidyGlob(glob);
  if ((g.match(/\*+|\?/g) || []).length > GLOB_LIMITS.wildcards) return `it has more than ${GLOB_LIMITS.wildcards} wildcards (* or ?)`;
  if ((g.match(/\{/g) || []).length > GLOB_LIMITS.braces) return `it has more than ${GLOB_LIMITS.braces} {…} groups`;
  try { globToRegExp(g); globToRegExp(g + '/**'); } catch (e) { return e.globProblem || 'it is not a pattern this map understands'; }
  return null;
}
/** The glob as matched: forward slashes, no leading ./ or trailing /, and repeated ** segments folded into one. */
const tidyGlob = (glob) => toPosix(glob).replace(/^\.\//, '').replace(/\/$/, '').replace(/(^|\/)\*\*(?:\/\*\*)+(?=\/|$)/g, '$1**').replace(/\*{3,}/g, '**');
const globError = (msg) => Object.assign(new Error(msg), { globProblem: msg });

export function globToRegExp(glob) {
  const g = tidyGlob(glob);
  let re = '';
  let braces = 0;
  for (let i = 0; i < g.length; ) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/';
        const atEnd = i + 2 === g.length || g[i + 2] === '/';
        if (atStart && atEnd) {
          if (i + 2 === g.length) { re += '.*'; i += 2; }
          else { re += '(?:.*/)?'; i += 3; }
          continue;
        }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '{') { braces++; re += '(?:'; i++; continue; }
    if (c === '}' && braces) { braces--; re += ')'; i++; continue; }
    if (c === ',' && braces) { re += '|'; i++; continue; }
    // a whole segment like [id], [...slug] or [[...slug]] is a folder name (Next.js, SvelteKit), not a character class
    if (c === '[' && (i === 0 || g[i - 1] === '/')) {
      const end = g.indexOf('/', i) < 0 ? g.length : g.indexOf('/', i);
      const seg = g.slice(i, end);
      if (/^\[\[?(\.\.\.)?[A-Za-z_$][\w$-]*\]\]?$/.test(seg)) { re += seg.replace(/[.[\]$\\]/g, '\\$&'); i = end; continue; }
    }
    if (c === '[') {
      const j = g.indexOf(']', i + 1);
      if (j < 0) throw globError('it has a "[" with no "]" to close it');
      const set = g.slice(i + 1, j).replace(/^!/, '^');
      if (!set || set === '^') throw globError('it has an empty [] set');
      for (const [, a, b] of set.matchAll(/(.)-(.)/g)) if (a > b) throw globError(`its range [${a}-${b}] runs backwards`);
      re += '[' + set.replace(/\\/g, '\\\\').replace(/\[/g, '\\[') + ']'; i = j + 1; continue;
    }
    re += c.replace(/[.+^$()|\\\][]/g, '\\$&');
    i++;
  }
  if (braces) throw globError('it has a "{" with no "}" to close it');
  try { return new RegExp('^' + re + '$'); } catch { throw globError('it is not a pattern this map understands'); }
}

/**
 * Compile a glob. A pattern with no wildcards also matches everything under it as a directory. Throws an error
 * whose message says what's wrong (globProblem) when the pattern can't be used.
 */
export function compileGlob(glob) {
  const problem = globProblem(glob);
  if (problem) throw globError(`"${String(glob).slice(0, 60)}" is not a valid pattern: ${problem}`);
  const g = tidyGlob(glob);
  const literalPrefix = g.split(GLOB_CHARS)[0];
  if (!GLOB_CHARS.test(g)) {
    return { glob, specificity: g.length, test: (p) => p === g || p.startsWith(g + '/') };
  }
  // A glob that names directories (src/components/{a,b}) also matches everything beneath them.
  const re = globToRegExp(g);
  const under = globToRegExp(g + '/**');
  return { glob, specificity: literalPrefix.length, test: (p) => re.test(p) || under.test(p) };
}

// ---------- file classification ----------

const LANG_BY_EXT = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.cs': 'csharp', '.fs': 'fsharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.dart': 'dart',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.m': 'objc', '.mm': 'objc',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.clj': 'clojure', '.lua': 'lua', '.r': 'r', '.jl': 'julia',
  '.zig': 'zig', '.elm': 'elm', '.hs': 'haskell', '.ml': 'ocaml', '.groovy': 'groovy',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'powershell', '.psm1': 'powershell',
  '.sql': 'sql', '.tf': 'terraform', '.proto': 'protobuf', '.graphql': 'graphql', '.gql': 'graphql',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
  '.html': 'html', '.htm': 'html', '.ejs': 'html', '.hbs': 'html', '.jinja': 'html', '.j2': 'html', '.njk': 'html',
};
const CONFIG_EXT = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.gradle', '.properties', '.env']);
const CONFIG_NAMES = /^(dockerfile.*|makefile|procfile|justfile|\.env\..*|\.?[\w-]*rc|gemfile|rakefile|cargo\.toml|go\.mod|pyproject\.toml|setup\.cfg|requirements.*\.txt)$/i;
const JSON_CONFIG = /^(package|tsconfig.*|jsconfig|composer|manifest|app|components|turbo|nx|lerna|angular|firebase|vercel|now|renovate|tslint|.?eslintrc|.?babelrc|.?prettierrc|.*.config|.*rc|settings|launch|tasks|deno|biome|project|workspace|devcontainer|cdk|serverless|appsettings.*|openapi|swagger).json$/i;
const DOC_EXT = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const DATA_EXT = new Set(['.csv', '.tsv', '.jsonl', '.ndjson', '.parquet', '.sqlite', '.db', '.xlsx', '.xls', '.avro']);
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.webm', '.mov', '.pdf', '.zip', '.gz', '.tar', '.tgz', '.7z', '.jar', '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin']);
const LOCK_NAMES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|poetry\.lock|pipfile\.lock|cargo\.lock|go\.sum|composer\.lock|gemfile\.lock|.*\.lock)$/i;
const GENERATED = /(\.min\.(js|css)$|\.map$|\.tsbuildinfo$|\.pyc$|\.pyo$|\.class$|\.o$|(^|\/)next-env\.d\.ts$)/i;

/** Directories never worth scanning, even if a repo tracks them. */
export const HARD_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.pnpm-store', '.yarn', '__pycache__', '.venv', 'venv', 'site-packages',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '.parcel-cache', '.gradle', '.idea',
]);

/** The folder the map lives in, at the codebase root. Maps made before the rename used show-code/. */
export const MAP_DIR = 'floorplan';
export const LEGACY_MAP_DIR = 'show-code';
/** True for a folder holding a map, so a project's own folder that happens to be called "floorplan" isn't taken for one. */
export const isMapDir = (d) => ['architecture.json', 'plan.json', 'graph.json', '.cache'].some((f) => fs.existsSync(path.join(d, f)));
/**
 * Keeps the map folder out of git: its own .gitignore ignores everything in it, itself included, so
 * nothing in the project's tracked files changes. Returns a warning when git already tracks files
 * there (ignoring doesn't untrack them), else null.
 */
export function keepOutOfGit(dir) {
  const gi = path.join(dir, '.gitignore');
  const want = '# Floorplan keeps its map out of git: this ignores everything in this folder, this file included.\n*\n';
  fs.mkdirSync(dir, { recursive: true });
  try { if (!fs.existsSync(gi) || fs.readFileSync(gi, 'utf8') !== want) fs.writeFileSync(gi, want); } catch {}
  const tracked = (git(dir, ['ls-files', '--', '.']) || '').split('\n').filter(Boolean);
  if (!tracked.length) return null;
  const rel = path.basename(dir);
  return `${tracked.length} file(s) in ${rel}/ were committed to git before; they stay tracked until you run: git rm -r --cached ${rel}  (this keeps the files on disk)`;
}

/**
 * The map folder for a codebase root. Moves an old show-code/ map into place unless migrate is false,
 * or in unattended mode, which never writes outside the map folder.
 */
export function mapDir(root, { migrate = !isUnattended() } = {}) {
  const dir = path.join(root, MAP_DIR);
  const old = path.join(root, LEGACY_MAP_DIR);
  if (migrate && !fs.existsSync(dir) && isMapDir(old)) {
    fs.renameSync(old, dir);
    console.error(`(moved the existing map from ${LEGACY_MAP_DIR}/ to ${MAP_DIR}/)`);
  }
  if (fs.existsSync(dir) && !isMapDir(dir) && fs.readdirSync(dir).length) {
    console.error(`✗ ${MAP_DIR}/ already exists here and isn't a map (it's part of the project). Pass --out <folder> to put the map somewhere else.`);
    process.exit(1);
  }
  return dir;
}
/** Extra directories skipped when walking outside of git (where .gitignore can't help). */
export const WALK_IGNORE_DIRS = new Set([...HARD_IGNORE_DIRS, 'dist', 'build', 'out', 'target', 'coverage', '.cache', 'vendor', 'bin', 'obj', 'env', '.vscode', '.claude']);

export function classify(relPath, bytes) {
  const base = path.posix.basename(relPath).toLowerCase();
  const ext = path.posix.extname(base);
  if (GENERATED.test(relPath)) return { category: 'generated', lang: null };
  if (LOCK_NAMES.test(base)) return { category: 'lock', lang: null };
  if (ext === '.log' || base.endsWith('.log')) return { category: 'log', lang: null };
  if (ASSET_EXT.has(ext)) return { category: 'asset', lang: null };
  if (DATA_EXT.has(ext)) return { category: 'data', lang: null };
  if (LANG_BY_EXT[ext]) {
    if (ext === '.svg') return { category: 'asset', lang: null };
    return { category: 'code', lang: LANG_BY_EXT[ext] };
  }
  if (ext === '.json' && (bytes > 100_000 || !JSON_CONFIG.test(base))) return { category: 'data', lang: null };
  if (CONFIG_EXT.has(ext) || CONFIG_NAMES.test(base)) return { category: 'config', lang: ext ? ext.slice(1) : base };
  if (DOC_EXT.has(ext)) return { category: 'docs', lang: null };
  return { category: 'other', lang: null };
}

// ---------- git ----------

/**
 * Runs git and returns { out, error }: its output, or null and a plain reason it failed. In unattended mode
 * git is asked not to take optional locks, so even `git status` leaves the repo's own files alone.
 */
export function gitRun(cwd, args) {
  const pre = isUnattended() ? ['--no-optional-locks'] : [];
  try {
    return { out: execFileSync('git', [...pre, '-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(), error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { out: null, error: 'git is not installed, or not on PATH' };
    const said = String(e.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    return { out: null, error: said.find((l) => /^(fatal|error):/.test(l)) || said[0] || String(e.message || e) };
  }
}

export function git(cwd, args) {
  return gitRun(cwd, args).out;
}

/** A likely cause and fix for a git failure, in plain words, for the scan's report. */
export function explainGitError(error, dir) {
  if (/not installed|not on PATH/.test(error)) return 'git is not installed here, or not on PATH. Install git, then scan again.';
  if (/dubious ownership|safe\.directory/.test(error)) return `git refuses this checkout because a different user owns the folder ("dubious ownership"), which is common in containers. Mark it safe, then scan again: git config --global --add safe.directory "${toPosix(dir)}"`;
  return `git could not read this repo (${error}).`;
}

export function gitInfo(dir) {
  const head = git(dir, ['rev-parse', 'HEAD']);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = git(dir, ['config', '--get', 'remote.origin.url']);
  return { head, branch, remote: remote ? remote.replace(/\/\/[^@/]+@/, '//') : null };
}

/** Files git considers part of the repo: tracked + untracked-but-not-ignored. */
export function gitFiles(dir) {
  return listGitFiles(dir).files;
}

/** Like gitFiles, but says why when git can't list them: { files, error }. */
export function listGitFiles(dir) {
  const { out, error } = gitRun(dir, ['ls-files', '-co', '--exclude-standard', '-z']);
  if (out == null) return { files: null, error };
  return { files: [...new Set(out.split('\0').filter(Boolean))].map(toPosix), error: null };
}

/** If dir/.git is a file pointing into another repo's worktrees/, return that repo's working dir. */
function worktreeMain(dir) {
  const dotgit = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(dotgit); } catch { return null; }
  if (!st.isFile()) return null;
  const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf8'));
  if (!m) return null;
  const gitdir = path.resolve(dir, m[1].trim());
  const idx = toPosix(gitdir).lastIndexOf('/.git/worktrees/');
  if (idx === -1) return null; // submodule or other indirection: treat as a normal repo
  return path.resolve(toPosix(gitdir).slice(0, idx));
}

// ---------- discovery ----------

/**
 * Walk the codebase root and find every git repo in it. Repos are not descended into
 * (git ls-files covers them). Loose files outside any repo are collected too.
 * Linked worktrees of a repo that is itself in the codebase are skipped as duplicates.
 */
export function discover(root, { includeWorktrees = false, maxLooseFiles = 5000 } = {}) {
  const repos = [];
  const loose = [];
  const skipped = [];

  const walk = (dir, depth) => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      repos.push({ abs: dir, path: rel(root, dir), worktreeOf: worktreeMain(dir) });
      return;
    }
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.filter((e) => e.isFile()).length > 500) { skipped.push({ path: rel(root, dir), reason: 'over 500 files outside git (data dump?)' }); return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (WALK_IGNORE_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) {
          if (!['.git', 'node_modules', '__pycache__'].includes(e.name)) skipped.push({ path: rel(root, abs), reason: 'ignored directory' });
          continue;
        }
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        if (loose.length < maxLooseFiles) loose.push(rel(root, abs));
      }
    }
  };
  walk(root, 0);

  // Drop worktree duplicates.
  const norm = (p) => toPosix(path.resolve(p)).toLowerCase();
  const primary = new Set(repos.filter((r) => !r.worktreeOf).map((r) => norm(r.abs)));
  const seenMains = new Set();
  const kept = [];
  for (const r of repos) {
    if (r.worktreeOf && !includeWorktrees && r.abs !== root) {
      const main = norm(r.worktreeOf);
      if (primary.has(main)) { skipped.push({ path: r.path, reason: `worktree of ${rel(root, r.worktreeOf)}` }); continue; }
      if (seenMains.has(main)) { skipped.push({ path: r.path, reason: `another worktree of ${r.worktreeOf}` }); continue; }
      seenMains.add(main);
    }
    kept.push(r);
  }
  return { repos: kept, loose, skipped };
}

// ---------- misc ----------

/**
 * JSON with comments and trailing commas (tsconfig.json, jsconfig.json…) as plain JSON text, in one pass over
 * the text: strings are kept as they are, comments and the commas before a closing } or ] are dropped. An
 * unclosed comment runs to the end, as it would for the tools that read these files.
 */
export function stripJsonComments(text) {
  const out = [];
  let i = 0, start = 0, lastComma = -1;
  const n = text.length;
  const flush = (to) => { if (to > start) out.push(text.slice(start, to)); };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) { // a string: copy through its closing quote
      i++;
      while (i < n) { const d = text.charCodeAt(i); if (d === 92) i += 2; else if (d === 34) { i++; break; } else i++; }
      lastComma = -1;
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) { // /* … */
      flush(i);
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      start = i;
    } else if (c === 47 && text.charCodeAt(i + 1) === 47) { // // …
      flush(i);
      const e = text.indexOf('\n', i + 2);
      i = e < 0 ? n : e;
      start = i;
    } else if (c === 44) { // a comma: remember where, in case a } or ] comes next
      flush(i); start = i; lastComma = out.length; out.push(','); i++; start = i;
    } else if (c === 125 || c === 93) { // } or ]: a comma just before it (past whitespace and comments) goes
      if (lastComma >= 0) out[lastComma] = '';
      lastComma = -1; i++;
    } else {
      if (!(c === 32 || c === 9 || c === 10 || c === 13)) lastComma = -1;
      i++;
    }
  }
  flush(n);
  return out.join('');
}

/**
 * [start, end] of every /* … *\/ comment, in one pass; an unclosed one runs to the end. (A lazy regex like
 * /\/\*[\s\S]*?\*\//g looks for the end again from every later "/*", which takes quadratic time.)
 */
export function blockComments(src) {
  const out = [];
  for (let i = src.indexOf('/*'); i >= 0;) {
    const e = src.indexOf('*/', i + 2);
    const end = e < 0 ? src.length : e + 2;
    out.push([i, end]);
    i = e < 0 ? -1 : src.indexOf('/*', end);
  }
  return out;
}
/** The text with every /* … *\/ comment blanked to spaces (line breaks kept, so offsets and lines stay put). */
export function blankBlockComments(src) {
  let out = '', from = 0;
  for (const [a, b] of blockComments(src)) { out += src.slice(from, a) + src.slice(a, b).replace(/[^\n]/g, ' '); from = b; }
  return out + src.slice(from);
}

/**
 * s.indexOf(ch, from) for searches that start further along the text each time, as a scan from top to bottom
 * does: an answer still ahead of the next start is the answer again, so all the searches together read the text
 * once. (Searching afresh from every start would read a file of a thousand "{" and no "}" a thousand times;
 * capping each search instead loses anything longer than the cap.) A start behind the last one searches afresh.
 */
export function forwardIndexOf(s, ch) {
  let from0 = Infinity, found = -1;
  return (from) => {
    if (from >= from0 && (found < 0 || found >= from)) return found;
    from0 = from;
    return (found = s.indexOf(ch, from));
  };
}

const SPACE = /\s/;
/**
 * `import … from '…'` statements, as [{ index, clause, spec, end }], in time linear in the text's length however
 * long their lists of names are. One starts where `head` (a global pattern) matches, and the word import must end
 * the match. Its clause runs from there to the first ' " or ; and must end in `from` right before a quote; the
 * quoted module name follows. `spaced`: `from` has whitespace on both sides and the name stays on one line, as in
 * /import\s+(clause)\s+from\s+["']([^"'\n]+)["']/; otherwise /import\s+(clause)\s*from\s*["']([^"']+)["']/.
 * A statement that starts inside the one before it is skipped, as a regular expression's matches would be.
 */
export function importStatements(code, head, { spaced = true } = {}) {
  const out = [];
  const next = ["'", '"', ';'].map((ch) => forwardIndexOf(code, ch));
  const n = code.length;
  // what follows the clause that ends at `stop` (statements that start further back but end at the same
  // place share it, so it's worked out once)
  const tail = (stop) => {
    if (code[stop] === ';') return null;
    let e = stop + 1;
    while (e < n && code[e] !== '"' && code[e] !== "'" && (!spaced || code[e] !== '\n')) e++;
    if (e === stop + 1 || e >= n || code[e] === '\n') return null;
    let s = stop;
    while (s > 0 && SPACE.test(code[s - 1])) s--;
    if ((spaced && s === stop) || s < 4 || code.slice(s - 4, s) !== 'from') return null;
    let t = s - 4;
    while (t > 0 && SPACE.test(code[t - 1])) t--;
    if (spaced && t === s - 4) return null;
    return { clauseEnd: t, spec: code.slice(stop + 1, e), end: e + 1 };
  };
  let end = 0, memoAt = -1, memo = null;
  for (const h of code.matchAll(head)) {
    if (h.index < end) continue;
    let p = h.index + h[0].length;
    if (!SPACE.test(code[p] ?? '')) continue;
    while (p < n && SPACE.test(code[p])) p++;
    if (code[p] === '(') continue; // a dynamic import, which loads a module when it runs
    let stop = -1;
    for (const f of next) { const i = f(p); if (i >= 0 && (stop < 0 || i < stop)) stop = i; }
    if (stop < 0) break;
    if (stop !== memoAt) { memoAt = stop; memo = tail(stop); }
    if (!memo || memo.clauseEnd <= p) continue;
    out.push({ index: h.index, clause: code.slice(p, memo.clauseEnd), spec: memo.spec, end: memo.end });
    end = memo.end;
  }
  return out;
}

/** Config files bigger than this aren't read: no real tsconfig.json or package.json comes close. */
export const MAX_CONFIG_BYTES = 1024 * 1024;
/** Config files readJsonLoose left unread because of their size, as { path, bytes } (the scan reports them). */
export const skippedConfigs = [];
export function readJsonLoose(file) {
  try {
    const bytes = fs.statSync(file).size;
    if (bytes > MAX_CONFIG_BYTES) { skippedConfigs.push({ path: file, bytes }); return null; }
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  } catch {
    return null;
  }
}

// flags that never take a value, so `--json <root>` still reads <root> as the codebase root
const SWITCHES = new Set(['json', 'unattended']);

export function parseArgs(argv, defaults = {}) {
  const out = { _: [], ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (!SWITCHES.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------- running without an agent session ----------

/**
 * Unattended mode: Floorplan run in CI, from a script or from your own tooling, with nobody there to ask.
 * FLOORPLAN_UNATTENDED=1 switches it on. It's an environment variable so it reaches the scripts another
 * script runs (refresh.mjs runs scan.mjs and build.mjs). In unattended mode nothing is written outside the
 * map folder, the map names no agent, and failures exit non-zero. See docs/unattended.md.
 */
export const isUnattended = (env = process.env) => /^(1|true|yes|on)$/i.test(String(env.FLOORPLAN_UNATTENDED || '').trim());

/** Reads --unattended (which sets FLOORPLAN_UNATTENDED for this script and the ones it runs); true when on. */
export function unattendedMode(args = {}, env = process.env) {
  if (args.unattended === true) env.FLOORPLAN_UNATTENDED = '1';
  return isUnattended(env);
}

/**
 * --json: prints one JSON object on stdout and nothing else there. With `code`, exits with it once the
 * output has been written (a pipe may still be taking it when process.exit would cut it short).
 */
export async function printJson(obj, code) {
  await new Promise((resolve) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n', resolve));
  if (code !== undefined) process.exit(code);
}

export const fmtNum = (n) => n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
