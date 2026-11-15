# Floorplan in Cursor

Floorplan works in Cursor the same way it works in Claude Code and Codex: the same skill and the same scripts. Cursor's agent reads the code, names the parts, and builds a self-contained map at `floorplan/index.html`. There are no API keys to set up, and no new dependencies.

## What you need

- Cursor, with this skill loaded (see below).
- [Node.js](https://nodejs.org) 18 or newer. Check with `node --version`.

## Install

Any one of these is enough. Start a new chat afterwards so Cursor picks the skill up.

**Drop the skill in the project** (or in your user skills). Copy the `skills/floorplan` folder to one of:

- `.cursor/skills/floorplan/`
- `.agents/skills/floorplan/`
- `.claude/skills/floorplan/` or `.codex/skills/floorplan/` (Cursor loads these too)

**From the skills registry**, in the project folder:

```bash
npx skills add haydenschmitty/floorplan --skill floorplan -a cursor
```

On a local clone of this repo, the same command with `.` instead of `haydenschmitty/floorplan` installs from the checkout. This repository also has a `.cursor-plugin/plugin.json`, so Cursor can list it as a plugin whose only content is that skill.

## Make your first map

Open the project in Cursor and ask:

> Make me a floorplan of this app.

You can also type `/floorplan`. For a frontend and a backend in separate repos, open the folder that holds both.

Cursor runs the skill's Node scripts (`scan.mjs`, `build.mjs`, and the rest). It does not expand Claude Code's `${CLAUDE_SKILL_DIR}`: the skill tells the agent to use the folder that contains `SKILL.md`. The scripts then find their own files from that path.

The map opens in your browser. If the agent can't keep the map's server running after the command ends, run this yourself from the project folder:

```bash
node floorplan/serve.mjs
```

Stop it with `node floorplan/serve.mjs --stop`. Later, "update the floorplan" re-reads only what changed.

In `architecture.json`, `"editor": "cursor"` makes **Open in editor** open Cursor. The agent sets that when it draws the map here.

## Asking questions

The map's Ask bar does not run Cursor. Ask in the Cursor chat ("how does a refund reach the customer?"), with the map open beside you. **Fix with Cursor** and **Build this with Cursor** copy a prompt for that same chat.

If the Claude Code CLI or Codex is installed, the map's server uses it as a fallback and the Ask bar answers on its own, read-only, the way it does in those apps. Without either CLI the bar says to ask in Cursor, and the map itself still works. Generating the map does not depend on the bar.

## A note for later chats

Cursor has no personal, uncommitted file like Claude Code's `CLAUDE.local.md`, and `AGENTS.md` is shared with your team, so Floorplan does not write either. After the first map it can offer a personal rule at `.cursor/rules/floorplan.mdc` that tells later chats to look the map up first. It is added only if you say yes, and the file is listed in `.git/info/exclude` so it is not committed. Delete the file, or put `<!-- floorplan:off -->` in it, to stop updates.

A blueprint (a map of an app that isn't built yet) adds no rule, because there is no code to look up yet.

## What's different from Claude Code and Codex

- **Ask** lives in the Cursor chat unless the Claude Code CLI or Codex is installed.
- **Changing a blueprint from the Ask bar** needs that same fallback. Otherwise edit `floorplan/plan.json` or ask in the chat, then update the floorplan.
- **No Claude app.** The map opens in your browser, served from your computer.
- **Permissions.** Cursor asks before running terminal commands, the way it does for any other command. Claude Code's `allowed-tools` list does not apply here. The scripts are the same ones.
