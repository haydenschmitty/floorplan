# Floorplan in Antigravity

Floorplan works in Antigravity with a native `.antigravity-plugin/plugin.json` manifest, `ANTIGRAVITY_AGENT` auto-detection, `antigravity://` / `antigravity-ide://` editor links, and Ask bar support powered by the Antigravity CLI (`agy`).

## What you need

- Antigravity (desktop app or `agy` CLI, signed in).
- [Node.js](https://nodejs.org) 18 or newer.

## Install

From a terminal, install and validate the local plugin folder:

```bash
agy plugin validate /path/to/floorplan --strict
agy plugin install /path/to/floorplan
```

Verify it is active:

```bash
agy plugin list --json
```

Installed plugins live under `~/.gemini/config/plugins/floorplan` (`%USERPROFILE%\.gemini\config\plugins\floorplan` on Windows).

## Make your first map

Open your project in Antigravity (or a parent folder holding separate frontend and backend repos) and ask in plain words:

> Draw a floorplan of this codebase

Antigravity runs the Floorplan scanner, writes `floorplan/architecture.json` and `floorplan/descriptions/*.json`, builds `floorplan/index.html`, and opens the map. Later, ask:

> Update the floorplan

Only changed files are re-read, and changes light up under **Recent work**.

> **Windows tip:** If you start the map from inside an agent shell that terminates detached child processes when a command finishes, run `node floorplan/serve.mjs --no-open --editor antigravity` as a background/daemon process (or run `open.mjs` from a regular terminal).

## Opening files in Antigravity

Pass `--editor antigravity` (or `--editor antigravity-ide`) to `open.mjs` or `serve.mjs`, or set `"editor": "antigravity"` in `floorplan/architecture.json`, so **Open in editor** links open directly in Antigravity instead of VS Code:

```bash
node floorplan/serve.mjs --editor antigravity
```

## Asking questions on the map

The map's Ask bar runs the Antigravity CLI (`agy`) on your machine:

```text
agy --sandbox --disable-slash-commands --output-format stream-json --json-schema <file> --print=...
```

Follow-up questions resume the same conversation with `--conversation <id>`.

- **Read-only caveat:** Unlike `claude -p` (tool whitelist) or `codex exec --sandbox read-only` (OS-level read-only sandbox), `agy` executes with `--sandbox` plus prompt-level read-only instructions rather than CLI-enforced tool whitelisting. If you have Claude Code or Codex installed and prefer strict CLI-enforced read-only mode for Ask, pass `--engine claude` or `--engine codex`:

```bash
node floorplan/serve.mjs --engine claude
```

If `agy` is installed somewhere unusual, pass `--antigravity /path/to/agy` (or set `FLOORPLAN_ANTIGRAVITY`). `--model <name>` selects the model.

## What's different from Claude Code

- **No notes file.** In Claude Code, Floorplan can keep a short note in `CLAUDE.local.md` (personal and never committed, only if you say yes). Antigravity leaves project notes files untouched.
- **No Claude app artifact upload.** Publishing to claude.ai is a Claude-specific feature. In Antigravity the map runs locally in your browser or Antigravity's built-in browser preview (`open.mjs --no-open`).
- **"Fix with Antigravity".** Health fix prompts, blueprint **Build this with Antigravity** prompts, and **Export** hints all reference Antigravity.
