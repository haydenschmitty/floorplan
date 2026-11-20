# Floorplan in OpenCode

Floorplan works in [OpenCode](https://opencode.ai) the same way it works in Claude Code: the same skill, scripts and map, on whichever models and providers you've connected in OpenCode. There are no API keys to set up.

## What you need

- OpenCode 2 (the terminal app or the desktop app), with a provider connected (`/connect` in the app, or `opencode auth login` in a terminal).
- [Node.js](https://nodejs.org) 18 or newer.

## Install

OpenCode loads skills from a catalog or a folder on your machine. Add Floorplan's catalog to your global config (`~/.config/opencode/opencode.json`), so it works in every project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "skills": [
    "https://raw.githubusercontent.com/haydenschmitty/floorplan/main/skills/"
  ]
}
```

OpenCode downloads the skill from that address and keeps a local copy, refreshing it when the catalog's version changes (each Floorplan release bumps it). If the download is blocked, or you want a specific copy, clone the repo and point at it instead:

```bash
git clone https://github.com/haydenschmitty/floorplan ~/tools/floorplan
```

```json
{
  "skills": ["~/tools/floorplan/skills"]
}
```

Put either line in a project's `.opencode/opencode.json` instead, to use Floorplan in that project only.

## Make your first map

Open your project in OpenCode and ask in plain words:

> Draw a floorplan of this codebase

Or load the skill by name: mention `@floorplan` in your message. Everything after that is the same as in Claude Code ([Getting started](getting-started.md#make-your-first-map)): OpenCode scans the code, describes every part, file and web request, builds the map and opens it. Later, "update the floorplan" re-reads only what changed.

When OpenCode opens the map, it starts the map's server in the background. If it can't keep it running, run the server yourself from the project folder:

```bash
node floorplan/serve.mjs
```

## Asking questions on the map

The map's Ask bar runs your own OpenCode on your computer: `opencode run` against a private server whose configuration denies every write, so the run reads your code and the map but changes nothing. The runs are archived, so they stay out of your session list, and a follow-up question brings the last few questions and answers along.

The server uses whichever agent built the map, and falls back to the others if that one isn't installed. To choose:

```bash
node floorplan/serve.mjs --engine opencode
```

It finds `opencode` on your PATH, and the curl install at `~/.opencode/bin`. If yours is somewhere else, pass `--opencode /path/to/opencode`. `--model provider/model` picks the model; otherwise your OpenCode settings decide.

## What's different from Claude Code

- **No notes file.** In Claude Code, Floorplan can keep a short note in `CLAUDE.local.md` (personal and never committed, and only if you say yes) that points future sessions at the map. OpenCode has no personal, uncommitted equivalent (`AGENTS.md` is shared with your team), so in OpenCode Floorplan leaves your project's notes alone.
- **No Claude app.** Publishing the map to the Claude app is a Claude feature. In OpenCode the map opens in your browser, served from your computer.
- **"Fix with OpenCode".** The Health panel's ready-made fix prompts are for pasting into OpenCode. On a [blueprint](getting-started.md#plan-something-you-havent-built-yet), the same goes for **Build this with OpenCode**.
- **No Change on a blueprint.** OpenCode's CLI holds no answer schema, so with OpenCode a blueprint's Ask bar has no Change switch: ask for changes to the plan in your OpenCode session instead.
- **MCP servers load.** OpenCode has no switch that turns off only its MCP servers for one run, so their tool descriptions load into each question, as in Codex.

## Update or remove it

A catalog install refreshes itself when a release changes the catalog's version; a folder install is read as it is, so pulling the repo updates it. To remove Floorplan, delete the `skills` line from your config.

Your maps stay in each project's `floorplan/` folder until you delete them.

## Trying a working copy

Point the `skills` config at your clone's `skills/` folder (above). A local folder is read as it is, so edits apply in the next session with no update step. `--agent claude|codex|opencode|none` on build.mjs (or `FLOORPLAN_AGENT`) and `--engine claude|codex|opencode` on serve.mjs let you try any agent's map from anywhere.
