# Floorplan in Cursor

Floorplan works in [Cursor](https://cursor.com) too: the same skill, the same scripts and the same map. Cursor makes the map. The map's Ask bar doesn't run through Cursor, so it needs the Claude Code CLI or Codex (see below).

## What you need

- Cursor, signed in.
- [Node.js](https://nodejs.org) 18 or newer.
- Optional, for the map's Ask bar: the Claude Code CLI or Codex. Without one the map still opens and works; only asking questions needs it.

## Install

Cursor loads skills from `~/.agents/skills/` (all your projects) or `.agents/skills/` inside a project. Put the skill's folder there:

```bash
git clone https://github.com/haydenschmitty/floorplan ~/floorplan
mkdir -p ~/.agents/skills
ln -s ~/floorplan/skills/floorplan ~/.agents/skills/floorplan
```

(Use `cp -R` instead of `ln -s` if you'd rather not keep the clone.) Start a new chat; the skill appears when you type `/floorplan`, and Cursor also picks it up when you ask for a map of your codebase.

## Make your first map

Open your project in Cursor and ask in plain words:

> Draw a floorplan of this codebase

Everything after that is the same as in Claude Code ([Getting started](getting-started.md#make-your-first-map)). Cursor doesn't fill in the two lines at the top of the skill that point at its scripts, so the agent uses the skill's own folder instead and runs `status.mjs` itself, as it does in Codex. Floorplan notices it is running under Cursor and records that in the map.

## The Ask bar

The Ask bar answers through the Claude Code CLI or Codex, whichever is installed (Claude Code first), on your own sign-in there. The map's header shows which one is answering. If neither is installed, the map still works, and the Ask bar says what it needs. See [Floorplan in Codex](codex.md) and [Troubleshooting](troubleshooting.md) for setting them up.

The Cursor CLI isn't used here. The Ask bar tells people their questions can read the code but never change it, and the Cursor CLI has no way to hold an agent to that from the command line, so Floorplan doesn't offer it for now.

## What's different from Claude Code

- **No notes file.** Claude Code gets a personal `CLAUDE.local.md` pointing future sessions at the map. Cursor doesn't read it, and `AGENTS.md` is shared with your team, so in Cursor Floorplan leaves your project's notes alone.
- **No Claude app.** Publishing the map to the Claude app is a Claude feature. In Cursor the map opens in your browser, served from your computer.
- **"Fix with Cursor".** On a map Cursor made, the Health panel's ready-made fix prompts, and a blueprint's "Build this with Cursor", are for pasting into a Cursor chat.
