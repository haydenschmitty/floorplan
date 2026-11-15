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

The Ask bar does not start Cursor, and a map made here does not send the question to the Claude Code CLI or Codex. The question stays on the map server, on this computer, until the Cursor chat picks it up.

After the map is open, leave this running in that chat (the `ASK` line prints the same command):

```bash
node <skill folder>/scripts/ask-poll.mjs <project>
```

When it prints `CURSOR ASK`, answer from the map and the code without editing files, write the answer JSON to a file, and send it back:

```bash
node <skill folder>/scripts/ask-poll.mjs <project> --reply <id> --file answer.json
```

Then start the poll again. The page shows the reply. **Fix with Cursor** and **Build this with Cursor** still copy a prompt for that same chat.

Generating the map does not depend on the bar. **Change** on a blueprint is not offered on this path. To use the Claude Code CLI or Codex instead, including **Change**, start the server with `--engine claude` or `--engine codex`. Those stay read-only in the way their own CLIs enforce. The Cursor chat is not locked that way: it is already your agent, and the map only displays what it sends back.

## A note for later chats

Cursor has no personal, uncommitted file like Claude Code's `CLAUDE.local.md`, and `AGENTS.md` is shared with your team, so Floorplan does not write either. After the first map it can offer a personal rule at `.cursor/rules/floorplan.mdc` that tells later chats to look the map up first. It is added only if you say yes, and the file is listed in `.git/info/exclude` so it is not committed. Delete the file, or put `<!-- floorplan:off -->` in it, to stop updates.

A blueprint (a map of an app that isn't built yet) adds no rule, because there is no code to look up yet.

## What's different from Claude Code and Codex

- **Ask** waits for the Cursor chat. Leave `ask-poll.mjs` running beside the map. `--engine claude` or `--engine codex` uses that program instead.
- **Changing a blueprint from the Ask bar** needs one of those engines. Otherwise edit `floorplan/plan.json` or ask in the chat, then update the floorplan.
- **No Claude app.** The map opens in your browser, served from your computer.
- **Permissions.** Cursor asks before running terminal commands, the way it does for any other command. Claude Code's `allowed-tools` list does not apply here. The scripts are the same ones.
