# Floorplan in Kilo Code

Floorplan works in [Kilo Code](https://kilo.ai) — the `kilo` CLI or the Kilo Code extension for VS Code — the same way it works in Claude Code and Codex: the same skill, scripts and map, on your own sign-in. There are no API keys to set up.

## What you need

- Kilo Code: the [CLI](https://kilo.ai/docs) (`kilo` on your PATH) or the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=kilocode.kilo-code). The map's Ask bar finds either: it looks for `kilo` on your PATH and inside the extension (`~/.vscode/extensions/kilocode.kilo-code-*/bin/kilo`), on macOS, Windows and Linux, including Cursor, VSCodium and Windsurf extension folders.
- [Node.js](https://nodejs.org) 18 or newer.

## Install

From a checkout of this repo (or your fork):

```bash
node tools/install-kilo.mjs            # ~/.config/kilo, for every project
node tools/install-kilo.mjs --project  # .kilo/ inside one project
```

That copies the skill to `<target>/skills/floorplan` and adds a `/floorplan` command. Add `--symlink` to link the checkout instead of copying it, so edits apply in the next session, and `--uninstall` to take it back out. Then start a new Kilo Code session — skills load at startup — and ask for a floorplan, or type `/floorplan`.

## Make your first map

Open your project in Kilo Code (for a frontend and backend in separate repos, open the folder that holds both) and ask in plain words:

> Draw a floorplan of this codebase

Everything after that is the same as in Claude Code ([Getting started](getting-started.md#make-your-first-map)): Kilo Code scans the code, describes every part, file and web request, builds the map and opens it. Later, "update the floorplan" re-reads only what changed. Inside VS Code, the map can appear beside the conversation (Kilo Code opens it in its own browser view when it has one); otherwise it opens in your browser, served from your computer.

## Asking questions on the map

The map's Ask bar runs Kilo Code on your machine, read-only. Each question starts `kilo run` in the codebase root under a read-only agent defined for that run: files can be read and searched, the map's own lookup script can run, and nothing can be changed. A few details worth knowing:

- **No daemon.** Questions never attach to a shared Kilo daemon, because the daemon wouldn't see the read-only agent; each run carries its own configuration.
- **Fail closed.** If Kilo ever reports falling back to its default agent (a broken config, an unfamiliar version), the question is stopped rather than answered with wider permissions.
- **Sessions are saved.** Kilo keeps every run in your session list; map questions run under a "Floorplan" title so they're easy to find and reuse (there's no ephemeral mode yet). Follow-ups resume the same session.
- **Your MCP servers.** The read-only agent denies every MCP tool, but MCP servers declared in your own Kilo config may still start while a question runs, the way they do in any Kilo session. Floorplan starts none itself.
- **Picking the model.** `--engine kilo` forces Kilo Code for questions; `--kilo <path>` points at an unusual install; `--model` is passed through only in `provider/model` form (as Kilo expects).

```bash
node floorplan/serve.mjs --engine kilo
```

## What's different from Claude Code and Codex

- **No notes file.** Like Codex, Kilo Code has no personal, uncommitted project notes (`AGENTS.md` is shared with your team), so a map built by Kilo Code leaves your project's notes alone.
- **No in-map blueprint changes.** On a [blueprint](getting-started.md#plan-something-you-havent-built-yet), the Ask bar's Change switch needs a CLI that holds answers to a schema; Kilo's CLI doesn't yet, so under Kilo Code you change the plan in chat ("also plan out refunds") and ask for a refresh. Asking questions and requesting flows works as everywhere else.
- **"Fix with Kilo Code".** The Health panel's ready-made fix prompts and a blueprint's **Build this with Kilo Code** name Kilo Code when the map was built with it.

## Update or remove it

Pull the repo and re-run the installer (or re-`--symlink` it), then start a new session:

```bash
node tools/install-kilo.mjs            # refreshes the skill and the command
node tools/install-kilo.mjs --uninstall
```

Your maps stay in each project's `floorplan/` folder until you delete them.
