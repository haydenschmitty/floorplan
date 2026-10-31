# Is it safe to install?

Plugins for Claude Code and Codex can run code on your computer, so it's worth asking. Some malicious plugins look harmless when you install them, then download and run something else later (a "stage two"). Floorplan is built so it can't do that, a test checks it on every change, and you can confirm all of it yourself.

## What Floorplan never does

- **No hooks.** Hooks run code automatically on events in every session, which makes them a common hiding place. Floorplan has none.
- **No MCP servers.** Floorplan has none, so it never starts a server that downloads its newest version with `npx`.
- **No dependencies, no install scripts.** Nothing comes from npm, at install time or ever. Its `package.json` exists only to run the tests.
- **Never downloads anything, and never runs code from the internet.** No `eval`, no loading code at run time, no encoded payloads.
- **Never changes your code.** It writes only its own `floorplan/` folder and, in Claude Code and only if you say yes, a marked section of `CLAUDE.local.md`. See [What's in your project](project-files.md).
- **No analytics or tracking.**

## Everything it does

### The network

- **The map's server** (`floorplan/serve.mjs`) listens on `127.0.0.1` only, so other machines can't reach it. It answers only to `127.0.0.1` and `localhost` at its own port, and its API needs a token that only the map page receives.
- **One outbound request: the Floorplan Cloud waitlist,** sent only if you type your email into the card on the map and click to join. It goes to `floorplan-waitlist-690500262396.us-central1.run.app` and carries your email and "just me" or "with my team". Details in [Privacy and security](privacy-and-security.md#floorplan-cloud-waitlist).
- **The map page loads nothing from the internet.** Its layout engine and fonts are built into the file. It only links to documentation, which opens when you click.

Asking questions on the map runs Claude Code, Codex or the Cursor CLI, which talk to Anthropic, OpenAI or Cursor the way they always do, on your account. Floorplan itself sends nothing.

### The programs it runs

| Program | When | Why |
|---|---|---|
| `git` | scan | Read-only: which files are tracked, the current branch and commit, what changed since the last map |
| `where` (Windows) or `which` | starting the map's server | Finding the Claude Code, Codex or Cursor CLI (only `cursor-agent` is looked for, never a program just called `agent`) |
| `claude`, `codex` or `cursor-agent` | when you ask a question on the map | Answering it: `claude -p` limited to reading files and Floorplan's lookup script, `codex exec --sandbox read-only`, or `cursor-agent -p --mode ask` (Cursor's CLI can't enforce read-only, so Floorplan also tells it not to write, and never passes `--trust`; see [Floorplan in Cursor](cursor.md#read-only-what-is-and-isnt-guaranteed)) |
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
- **One `new Function`** in `serve.mjs` loads the map's lookup code from `floorplan/query.mjs`, a file Floorplan's build wrote into your project. It never runs anything from the network.
- **Health reads the middle part of tokens it finds** (it decodes them from base64) to tell what kind of token each is, so it can skip ones that are public by design. It never stores or shows the token itself.

## Checked on every change

[`tests/supply-chain.test.mjs`](../tests/supply-chain.test.mjs) runs on every push and pull request, on Linux and Windows (and weekly on macOS). It fails if a change would:

- add a hook, an MCP server, a dependency or an install script;
- send a request anywhere other than the map's own server and the waitlist;
- start a program not in the table above, or start one through a shell;
- use `eval`, load code at run time, or hide a long encoded string in the code;
- add a script that would run without asking;
- change the bundled layout engine, or add a vendored file.

Each check was tested by planting exactly that kind of change and seeing it fail. A change to any of this has to change the test and this page together, in the open.

To run the same checks on your own copy:

```bash
node --test tests/supply-chain.test.mjs
```

## Check that your installed copy is a real release

Every release includes `CHECKSUMS.txt`: a SHA-256 fingerprint of every file the plugin runs from (the skill, the plugin manifests and the marketplace files). To compare your installed copy with the release on GitHub:

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
- Floorplan works by having Claude, Codex or Cursor read your code to describe it. That goes to Anthropic, OpenAI or Cursor under your account, like any other task you give them. See [Privacy and security](privacy-and-security.md).

## Found something?

Please report it privately, as described in the [security policy](../SECURITY.md).
