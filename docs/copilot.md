# Floorplan in GitHub Copilot

Floorplan works in GitHub Copilot CLI and the GitHub Copilot app with the same skill, scripts and map used by Claude Code and Codex. It runs on your Copilot sign-in and needs no API key.

## What you need

- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), signed in, or the GitHub Copilot app.
- [Node.js](https://nodejs.org) 18 or newer.

## Install

**In the GitHub Copilot app:**

1. Open **Customize**.
2. Add `haydenschmitty/floorplan` as a plugin marketplace.
3. Find **Floorplan** and install it.
4. Start a new project session.

**From a terminal:**

```bash
copilot plugin marketplace add haydenschmitty/floorplan
copilot plugin install floorplan@floorplan
```

The Copilot app and CLI share installed plugins and skills.

## Make your first map

Open your project and ask:

> Draw a floorplan of this codebase

To name the skill explicitly, say:

> Use /floorplan to draw a floorplan of this codebase

Copilot scans the code, describes every part, file and web request, builds the map and opens it. Later, "update the floorplan" re-reads only what changed.

## Asking questions on the map

The Ask bar runs GitHub Copilot CLI on your computer in the project folder. Floorplan exposes only Copilot's file-reading and search tools; shell commands, file writes, URLs and memory are unavailable. Copilot starts with `floorplan/graph.json`, then reads source files when the map does not have enough detail.

Follow-up questions resume the same local Copilot CLI session. Account-history synchronization is disabled for these runs, but the session remains in Copilot CLI's local session data.

The map uses whichever supported agent built it and falls back to another installed one. To force Copilot:

```bash
node floorplan/serve.mjs --engine copilot
```

It finds `copilot` on your PATH. If yours is somewhere else, pass `--copilot /path/to/copilot`. `--model <name>` chooses a model; otherwise Copilot's settings decide.

## What's different

- **No notes file.** Claude Code can add a personal `CLAUDE.local.md` note pointing future sessions at the map. Copilot's repository instructions are shared files, so Floorplan leaves them alone.
- **Blueprint Change is unavailable in the map.** Copilot CLI does not currently expose the schema-enforced response contract Floorplan requires before it will replace a blueprint's planning files. Ask Copilot in the project session to change the blueprint instead, then update the floorplan.
- **The Claude app publishing option is Claude-specific.** In Copilot, the map opens locally in your browser.

## Update or remove it

```bash
copilot plugin update floorplan
copilot plugin uninstall floorplan
copilot plugin marketplace remove floorplan
```

Your maps stay in each project's `floorplan/` folder until you delete them.

## Trying a working copy

Add your local clone as a marketplace:

```bash
copilot plugin marketplace add /path/to/floorplan
copilot plugin install floorplan@floorplan
```

A plugin from a local marketplace is loaded live, so edits apply in the next session. Copilot may ask you to approve access when the plugin lives outside the project folder.
