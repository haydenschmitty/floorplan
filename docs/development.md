# Developing Floorplan

## Repo layout

```
.claude-plugin/
  plugin.json          the plugin: name, version, author
  marketplace.json     this repo as its own one-plugin marketplace
  icon.png
.codex-plugin/
  plugin.json          the same plugin for Codex (same skill, same version)
  icon.png
.agents/plugins/
  marketplace.json     this repo as a Codex marketplace
skills/floorplan/
  SKILL.md             the workflow Claude and Codex follow
  agents/openai.yaml   how Codex lists the skill
  references/          formats and style guides Claude reads while working
    schema.md                architecture.json and recent-work.json
    choosing-boundaries.md   how to carve a codebase into a good map
    writing-descriptions.md  plain-language names and descriptions
    blueprint.md             plan.json, for a map planned from a PRD
  scripts/             Node.js, no dependencies; Claude runs these
    status.mjs     is there a map, and how stale is it (runs when the skill loads)
    scan.mjs       repos, files, imports, endpoints, requests → .cache/scan.json
    plan.mjs       a blueprint's plan.json → the same .cache/scan.json
    build.mjs      validate, assign files, connect, Health, screens → graph.json + index.html
    describe.mjs   worksheets for Claude to name and describe files and endpoints
    refresh.mjs    incremental update: re-scan, carry over, flag changes, rebuild
    recent.mjs     facts for marking recent work
    open.mjs       start or reuse the map's server, and open the browser
    lib/           extraction, import resolution, route matching, Health, screens, which agent is running, helpers
  assets/
    viewer.html    the map (template the build fills in)
    ui/            viewer extensions: Theme button, blueprints, glossary, Health, recent work, screens, tour, waitlist card
    graph-query.js shared map lookups (viewer, query.mjs, Ask instructions)
    serve.mjs      copied into each project's floorplan/ folder; answers through Claude Code, Codex or the Cursor CLI
    query-cli.mjs  becomes floorplan/query.mjs
    logo.png, favicon.png
    vendor/        bundled layout engine (elkjs) and fonts, with their licenses
tests/                 regression tests and the sample projects they map
tools/checksums.mjs    writes CHECKSUMS.txt for a release, and checks an installed copy against it
CHECKSUMS.txt          SHA-256 of every file the plugin runs from, as of the last release
docs/                  these guides
```

## Try your working copy

Install from your local folder instead of GitHub:

```bash
claude plugin marketplace add /path/to/floorplan
claude plugin install floorplan@floorplan
```

A plugin installed from a local folder runs straight from it, so edits apply in the next session with no update step.

To try it in Codex, see [Trying a working copy](codex.md#trying-a-working-copy). Codex copies a local plugin when you add it, so run `codex plugin add floorplan@floorplan` again after each change. `--agent claude|codex` on build.mjs (or `FLOORPLAN_AGENT`) and `--engine claude|codex` on serve.mjs let you try either agent's map from anywhere.

The scripts also run on their own, which is the fastest way to work on them:

```bash
node skills/floorplan/scripts/scan.mjs /path/to/project
node skills/floorplan/scripts/build.mjs /path/to/project
node skills/floorplan/scripts/open.mjs /path/to/project
```

`build.mjs` needs a `floorplan/architecture.json` in the project, so run the skill once first, or write a small one by hand ([schema](../skills/floorplan/references/schema.md)).

## Tests

```bash
npm test
```

The tests use Node's built-in test runner, so there's nothing to install (`npm test` is the same as `node --test`). GitHub runs them on every push and pull request on Linux and Windows with Node 18, 20 and 22, and on macOS weekly and on demand (Actions → macOS → Run workflow), since its macOS machines are often all busy.

| File | What it checks |
|---|---|
| `parsing.test.mjs` | imports, endpoints, web requests and doc comments, per language and framework |
| `helpers-lib.test.mjs` | globs, file types, command-line flags, fallback names |
| `secrets.test.mjs` | Health finds secrets, masks them, and ignores placeholders |
| `health.test.mjs` | which endpoints Health calls open to anyone (FastAPI sample in `fixtures/`) |
| `stack-health.test.mjs` | Health's checks for Supabase row-level security, Firebase rules, Stripe webhook signatures, secret keys in public variables and CORS, with look-alikes each must leave alone, and a whole sample app done wrong and done right |
| `firebase.test.mjs` | Firebase Cloud Functions: callables and onRequest functions as endpoints, the website's calls to them, Screens, Health, background functions (React + Firebase sample in `fixtures/`) |
| `blueprint.test.mjs` | a map planned from a PRD before any code exists: plan.json errors, endpoints and calls, Screens, the design review, refreshing and switching to the real code (sample PRD in `fixtures/`) |
| `blueprint-change.test.mjs` | changing a blueprint from the map: the agent's updated plan is checked, saved and highlighted, retried once when it fails the checks, and undone (stand-in CLI in `fixtures/fake-cli/`) |
| `large-files.test.mjs` | files over the scan's size limit stay on the map with their line count, and the scan, Health and the map say they weren't read |
| `sample-app.test.mjs` | a whole map of a two-repo shop: endpoints, cross-repo requests, Health, offline map, no secret values written, updates |
| `serve.test.mjs` | the map's server: 127.0.0.1 only, its own host names only, token and same-origin checks, nothing served from outside its folder |
| `export.test.mjs` | exporting a copy to share: what's left out by default, the extras when asked, the Export button's endpoint |
| `phone.test.mjs` | phone and tablet layout: the top bar wraps instead of overflowing, icon-only buttons keep a name, 44 px touch targets, the details sheet that opens when a box is tapped, the zoom buttons in the top row, the folding description and the AI-tool note shown only while asking (checks on the built page, not a real screen) |
| `ask.test.mjs` | asking through Claude Code, Codex or the Cursor CLI: which one is used, read-only, follow-ups, sign-in errors (stand-in CLIs in `fixtures/fake-cli/`) |
| `agents.test.mjs` | telling Claude Code from Codex, and what a map built by each records and writes |
| `release.test.mjs` | the version agrees across both plugins' `plugin.json`, the README badge, the changelog and `CHECKSUMS.txt` |
| `supply-chain.test.mjs` | what the plugin can do stays what [Is it safe to install?](is-it-safe.md) says: no hooks, MCP servers or dependencies, one outbound request, a fixed list of programs and pre-approved scripts, no code loaded at run time, the vendored layout engine unchanged |
| `touch.test.mjs` | touch gestures: a drag follows one finger and ends on a cancelled touch, two-finger pinch and pan, nothing re-fits the map mid-gesture (checks on the built page, not a real screen) |

Sample projects are written to a temp folder by `helpers.mjs` (`shopApp()`) or copied from `tests/fixtures/`. Anything secret-looking is assembled at runtime, so no real-looking key is ever committed.

When you fix a bug in what Floorplan detects, add a sample that shows it, and check the test fails without your fix.

## Extending the viewer

Files in `skills/floorplan/assets/ui/` are inlined into every map, in name order. They talk to the viewer only through `window.Floorplan`, which offers:
- the graph and lookups;
- navigation (`go`, `open`, `reveal`, `showBoard`, `playFlow`);
- `addHeaderButton` and `addPanelSection('overview' | 'item', fn)`;
- `modal`, `toast`, `store`;
- events (`on('ready' | 'render' | 'panel' | 'technical')`);
- `exported`, set in an exported copy: leave out anything there that needs Claude, Codex or the map's server.

`20-health.js` and `25-recent.js` are good examples.

## Adding an agent

There are two lists, and an agent can be on one or both:
- **The agent that built the map**, in `scripts/lib/agent.mjs`: an entry in `DETECT` that recognises it from the variables it sets for every command it runs. The map records it, so its prompts name the right agent.
- **The agent that answers questions**, in `assets/serve.mjs`: an entry in `ENGINES` with its name, where to get it, `find` (where its CLI lives, plus a `--<name> <path>` override) and `run` (the arguments and how to read its output into progress and an answer).

An engine must be read-only in a way its CLI enforces, not only because the prompt asks; if it can't be, say so plainly in the docs. Set `structured: true` only when the CLI holds answers to the schema, because changing a blueprint from the map relies on it; without it, the map doesn't offer Change. Never take the command to run from the page or from saved settings. Add a stand-in CLI to `tests/fixtures/fake-cli/` and tests like `ask.test.mjs`.

## Guidelines

- **No dependencies.** The scripts must run anywhere Node 18+ does, with nothing to install.
- **Plain language first.** Anything the map shows people should make sense to an app's owner, not just its engineers.
- **Never store or print secret values.** Health findings record where a secret is and a masked hint, never the value.
- **Keep examples generic.** Code comments, docs and prompts must not describe any real private project.

## Maintaining

### Branches and commits

- `main` is always releasable. Every change reaches it through its own branch, merged with a merge commit (`git merge --no-ff`), so each change reads as one unit in the history.
- Name branches by what they are, with the issue number when there is one:
  - `fix/4-fastapi-annotated-guards`
  - `feat/codex-support`
  - `docs/…`, `chore/…`

  A branch made with GitHub's **Create a branch** button on an issue (`2-reaching-outside-repo`) is fine too.
- Commit messages start with a short summary in the imperative ("Bundle the layout engine"), and the body says why.
  - `Fixes #N` in a commit or merge message closes the issue when it reaches `main`.
  - `Refs #N` links it without closing.
- **Contributors' pull requests keep their commits and authorship.** Merge them with a merge commit ("Merge pull request #N from user/branch"), and resolve `CHANGELOG.md` conflicts by keeping both entries.
- Delete branches once merged.

### Versions and the changelog

- Versions follow [semantic versioning](https://semver.org). Before 1.0:
  - a patch (0.1.x) for fixes and small improvements;
  - a minor version (0.x.0) for new features, or anything that changes what people install or run.
- **Users only receive an update when the version changes**, so release fixes promptly rather than leaving them on `main`.
- Every change people will notice adds a line under `## Unreleased` at the top of `CHANGELOG.md`:
  - in plain language;
  - crediting whoever reported or fixed it, e.g. "Reported by @name in #1, fixed by @name in #3".

### Releasing

1. On an up-to-date `main`, run the tests and check the manifests, including the official plugin directory's requirements:
   ```bash
   npm test
   claude plugin validate . --profile directory
   ```
2. Bump `version` in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, and the version badge in `README.md`.
3. Rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z (YYYY-MM-DD)`.
4. Write the release's fingerprints, after the version bump:
   ```bash
   node tools/checksums.mjs
   ```
5. Commit as `Floorplan X.Y.Z: <one-line headline>` and push `main`.
6. Tag and push the tag. This also checks that `plugin.json` and the marketplace entry agree:
   ```bash
   claude plugin tag . -m "Floorplan %s" --push
   ```
7. On GitHub, publish a release from the tag (`floorplan--vX.Y.Z`), titled `Floorplan X.Y.Z`, with that version's changelog section as its notes.
8. Reply on every issue and pull request the release fixes: what changed, the version, and how to get it (`claude plugin update floorplan@floorplan`).

### Issues and pull requests

- Reply to new issues within a few days, even if only to say you've seen them.
  - Label each one (`bug`, `enhancement`, `question`).
  - Assign yourself when you pick it up.
- Ask for the shape of a problem, never for private code, secrets or screenshots of a private map.
- Thank contributors, and credit them in the changelog and release notes.
- Close an issue with a comment that names the release containing the fix.
- Security reports go through [SECURITY.md](../SECURITY.md), privately. Don't discuss them in public issues until a fix is released.
