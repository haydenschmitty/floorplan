# Troubleshooting

### The Ask bar says it needs the Claude Code CLI
The map is open without a way to ask questions. Either:
- install the [Claude Code CLI](https://code.claude.com/docs/en/overview), sign in, then ask Claude to update the floorplan or run `node floorplan/serve.mjs`;
- or open the map in the Claude app: ask Claude to "publish my floorplan to the Claude app". Answers there come from the map only.

### The CLI is installed but isn't found
`serve.mjs` looks for `claude` on your PATH and in `~/.local/bin`. If it lives somewhere else:

```bash
node floorplan/serve.mjs --claude /path/to/claude
```

### Codex: the Ask bar says it needs Codex
The map's server looks for `codex` on your PATH and, on Windows, for the CLI that comes with the Codex desktop app. Install the [Codex CLI](https://developers.openai.com/codex/cli), or point the server at yours:

```bash
node floorplan/serve.mjs --codex /path/to/codex
```

If it says Codex isn't signed in, open the Codex app (or run `codex login`) and sign in with ChatGPT. More in [Floorplan in Codex](codex.md).

### Codex: the map didn't open, or Ask stopped working after Codex opened it
Codex runs commands in a sandbox, and the map's server needs to keep running and reach the network. Allow the server to run outside the sandbox when Codex asks, or run `node floorplan/serve.mjs` yourself from the project folder.

### `node` isn't recognized
Install [Node.js](https://nodejs.org) 18 or newer, then start a new session so Claude Code or Codex picks it up.

### Claude or Codex keeps asking to run `node` scripts
In Claude Code, Floorplan pre-approves its own scripts while it's running, but it may still ask in some setups. Choose the option to always allow them for this project. Codex asks according to your approval settings; allowing Floorplan's `node` scripts for the project stops the prompts.

### The skill doesn't show up
Plugins load when a session starts, so start a new one after installing. Check that it's installed and enabled:

```bash
claude plugin list
```

Plain requests like "make me a floorplan" work without the slash command. If you do want it, it's `/floorplan:floorplan`.

In Codex, check **Plugins** in the app, or run `codex plugin list`, and start a new chat after installing. To call it by name, type `$floorplan`.

### The map looks out of date
Ask Claude or Codex to "update the floorplan". If a tab was already open, it reloads itself once the update finishes.

### The map is blank, or stuck on "Laying out"
Maps made before version 0.1.3 load their layout engine from the internet, so check your connection or any content blocker, or ask Claude to "update the floorplan". Newer maps have everything built in and work offline.

### The Ask bar has no Change switch
**Change** appears only on a [blueprint](getting-started.md#plan-something-you-havent-built-yet), opened through its server (`node floorplan/serve.mjs`) with the Claude Code CLI, Codex or Hermes available. A map of real code doesn't have it: ask Claude Code or Codex to change the code, then update the floorplan.

### A change to a blueprint failed, or I don't like it
If the updated plan doesn't pass Floorplan's checks after a second try, nothing is saved and the map stays as it was; try asking more specifically. If a change went through but isn't what you wanted, press **Undo** in its summary, or ask for another change. With Hermes, the held and displaced versions, named by a `manifest.json`, stay in `floorplan/.cache/history/<id>/` and are never pruned automatically; delete old folders yourself after every writer has stopped. With Claude Code and Codex the previous plan versions are kept in `floorplan/.cache/history/`.

### Hermes: the Ask bar says `unsupported_runtime`
Source-aware Ask needs a POSIX runtime (Linux or macOS, or Hermes running entirely inside WSL). Native Windows Hermes is not supported: the map works offline, but asking is unavailable. See [Floorplan in Hermes](hermes.md).

### Hermes: the Ask bar says `protocol_mismatch`
The generated `floorplan/serve.mjs` speaks an older protocol than the installed plugin. Rebuild the map with the current plugin (`--agent hermes`), then reload. Your map content and history are untouched.

### Hermes: the Ask bar says `profile_mismatch`
The running server and the worker disagree about the profile. Restart `serve.mjs` with the same `--profile`, or rebuild and reopen the map with that profile.

### Hermes: view the map from another computer
Use a same-port SSH tunnel, never a reverse proxy: `ssh -N -L 127.0.0.1:<P>:127.0.0.1:<P> <host>`, then open `http://127.0.0.1:<P>`. A preview domain gets 403 even with a valid token, by design.

### A connection is missing
Floorplan finds most web requests and imports by reading the code, but not all of them, for example requests to an address that only exists in settings. Ask Claude to add the missing connection to the floorplan; it records it in `architecture.json` and it stays on every update.

### A file is in the wrong part, or under "Unassigned"
Ask Claude to move it, or edit the `paths` patterns in `floorplan/architecture.json` and ask for an update.

### "floorplan/ already exists here and isn't a map"
Your project has its own folder called `floorplan`, which Floorplan won't write into. Rename your folder, or ask Claude to build the map somewhere else; the scan and build scripts accept `--out <folder>`.

### `git status` shows files under `floorplan/`
They were committed before Floorplan started ignoring the folder. Untrack them, keeping the files on disk:

```bash
git rm -r --cached floorplan
```

### Port 4378 is in use
Nothing to do. The server moves to the next free port, and the URL it prints, or that Claude gives you, is the right one.

### Stopping the background server

```bash
node floorplan/serve.mjs --stop
```

It also stops by itself two hours after the last tab closes.

### Still stuck?
[Open an issue](https://github.com/haydenschmitty/floorplan/issues/new/choose) with what you asked, what happened, whether you used Claude Code, Codex or Hermes, and the output it showed. Please leave out anything private from your code.
