# Is it safe to install?

Plugins for Claude Code and Codex can run code on your computer, so it's worth asking. Some malicious plugins look harmless when you install them, then download and run something else later (a "stage two"). Floorplan is built so it can't do that, a test checks it on every change, and you can confirm all of it yourself.

## What Floorplan never does

- **No hooks.** Hooks run code automatically on events in every session, which makes them a common hiding place. Floorplan has none.
- **No MCP servers.** Floorplan has none, so it never starts a server that downloads its newest version with `npx`.
- **No dependencies, no install scripts.** Nothing comes from npm, at install time or ever. Its `package.json` exists only to run the tests.
- **Never downloads anything, and never runs code from the internet.** No `eval`, no encoded payloads. It loads two local files and nothing else: the map's lookup code from `floorplan/query.mjs` (which the build wrote) and, for Hermes Ask, the installed skill's own `health.mjs` from the folder the install's model-free probe names.
- **Never changes your code.** It writes only its own `floorplan/` folder and, in Claude Code and only if you say yes, a marked section of `CLAUDE.local.md`. See [What's in your project](project-files.md).
- **No analytics or tracking.**
- **Hermes adds a small native plugin, still nothing that runs on its own.** Three native files are executable surfaces: `plugin.yaml` (the manifest: `provides_hooks: []`, no MCP servers, no tools, no pip dependencies), `__init__.py` (registers one skill and one on-demand command), and `hermes/runner.py` (the model-free probe and the bounded Ask worker). They are fingerprinted in `CHECKSUMS.txt` like the rest of the release, and the same supply-chain test covers them.

## Everything it does

### The network

- **The map's server** (`floorplan/serve.mjs`) listens on `127.0.0.1` only, so other machines can't reach it. It answers only to `127.0.0.1` and `localhost` at its own port, and its API needs a token that only the map page receives.
- **One outbound request: the Floorplan Cloud waitlist,** sent only if you type your email into the card on the map and click to join. It goes to `floorplan-waitlist-690500262396.us-central1.run.app` and carries your email and "just me" or "with my team". Details in [Privacy and security](privacy-and-security.md#floorplan-cloud-waitlist).
- **The map page loads nothing from the internet.** Its layout engine and fonts are built into the file. It only links to documentation, which opens when you click.
- **Reporting a false alarm is yours to send.** If you tick the box under **Not a problem** in Health, the map opens a new GitHub issue in your browser with the text filled in, shown to you first. Nothing goes anywhere unless you submit it there.

Asking questions on the map runs Claude Code, Codex or Hermes, which talk to Anthropic, OpenAI or your Hermes model provider the way they always do, on your account. Floorplan itself sends nothing.

With Hermes, the answer is bounded on this computer: the map's server decides which files may be read, refuses `.git`, key and credential files, `.env*`, instruction files (`AGENTS.md`, `SOUL.md`, `CLAUDE*.md`) and symlinks, returns at most 200 lines and 32 KiB per read, and redacts known secrets or refuses the whole file. Both sides check a SHA-256 of the exact bytes before anything is returned, so a file swapped mid-read is refused rather than read.

### The programs it runs

| Program | When | Why |
|---|---|---|
| `git` | scan | Read-only: which files are tracked, the current branch and commit, what changed since the last map |
| `where` (Windows) or `which` | starting the map's server | Finding the Claude Code, Codex or Hermes CLI |
| `claude` or `codex` | when you ask a question on the map | Answering it, read-only: `claude -p` limited to reading files and Floorplan's lookup script, or `codex exec --sandbox read-only` |
| `hermes` | when you ask a question on the map with Hermes | `hermes floorplan probe` once at start (no model), then `hermes floorplan ask`, which answers through your Hermes profile and asks this server for every read |
| `node` | throughout | Running Floorplan's own scripts |
| `cmd /c start`, `open` or `xdg-open` | opening the map | Opening the map's local address in your browser |

Each is started directly with its arguments, never as a command line for a shell to interpret. The one shell is Windows' `cmd /c start`, given only the map's own local address.

### What runs without asking

In Claude Code, while the skill is in use, it pre-approves one kind of command: `node` running one of its own scripts, each named exactly (`scripts/build.mjs`, `describe.mjs`, `open.mjs`, `plan.mjs`, `recent.mjs`, `refresh.mjs`, `scan.mjs` and `status.mjs`). That list is fixed by the tests below. Anything else Claude does asks according to your permission settings, as usual. Codex asks according to your approval settings.

### Three things worth explaining

- **`skills/floorplan/assets/vendor/elk.bundled.js`** is a 1.6 MB minified file: the layout engine that arranges the map. It's [elkjs](https://github.com/kieler/elkjs) 0.9.3, byte for byte the same as the official package on npm. Its SHA-256 is `b0745abd7f23cd91690a1587e377edbe19fd7233c783300290936720546216d4`. To check it yourself:
  ```bash
  npm pack elkjs@0.9.3
  tar -xzf elkjs-0.9.3.tgz package/lib/elk.bundled.js
  ```
  Then compare `package/lib/elk.bundled.js` with Floorplan's copy, for example with `sha256sum` (macOS: `shasum -a 256`; Windows PowerShell: `Get-FileHash`).
- **One `new Function` and one dynamic `import()`** in `serve.mjs`, both local: the map's lookup code from `floorplan/query.mjs` (a file Floorplan's build wrote), and the installed skill's `health.mjs` from the folder the install's model-free probe names. Neither runs anything from the network.
- **Health reads the middle part of tokens it finds** (it decodes them from base64) to tell what kind of token each is, so it can skip ones that are public by design. It never stores or shows the token itself.

## Checked on every change

[`tests/supply-chain.test.mjs`](../tests/supply-chain.test.mjs) runs on every push and pull request, on Linux and Windows (and weekly on macOS). It fails if a change would:

- add a hook, an MCP server, a dependency or an install script, including one declared in the Hermes manifest;
- send a request anywhere other than the map's own server and the waitlist;
- import a network module or start a subprocess from the Python worker, or open a file without `O_NOFOLLOW`;
- start a program not in the table above, or start one through a shell;
- use `eval`, load code at run time, or hide a long encoded string in the code;
- add a script that would run without asking;
- change the bundled layout engine, or add a vendored file;
- let `CHECKSUMS.txt` miss a Python or YAML runtime file, or go stale when one changes (a changed, extra or missing file fails the check).

Each check was tested by planting exactly that kind of change and seeing it fail. A change to any of this has to change the test and this page together, in the open.

To run the same checks on your own copy:

```bash
node --test tests/supply-chain.test.mjs
```

## Check that your installed copy is a real release

Every release includes `CHECKSUMS.txt`: a SHA-256 fingerprint of every file the plugin runs from (the skill, the native Hermes runtime, the plugin manifests and the marketplace files). To compare your installed copy with the release on GitHub:

```bash
git clone --depth 1 --branch floorplan--v<version> https://github.com/haydenschmitty/floorplan floorplan-check
node floorplan-check/tools/checksums.mjs --check <installed folder>
```

`<version>` is the version you have (`claude plugin list` or `codex plugin list` shows it). The installed folder is:
- **Claude Code:** `~/.claude/plugins/cache/floorplan/floorplan/<version>`
- **Codex:** `~/.codex/plugins/cache/floorplan/floorplan/<version>`

It prints either that all files are identical, or which ones changed, are extra or are missing.

## The honest limits

- Claude Code and Codex install a plugin from its repository, and an update brings whatever the newest release contains, for this plugin as for any other. Releases are made only by the maintainer, and `main` is protected: its history can't be rewritten or deleted. Outside pull requests are reviewed before they're run or merged, and the checks above run on every one of them. Before you update, you can read the changes in the [changelog](../CHANGELOG.md) and verify the new version with its checksums.
- Floorplan works by having Claude or Codex read your code to describe it. That goes to Anthropic or OpenAI under your account, like any other task you give them. See [Privacy and security](privacy-and-security.md).

## Found something?

Please report it privately, as described in the [security policy](../SECURITY.md).
