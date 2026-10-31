# Floorplan in Cursor

Floorplan works in [Cursor](https://cursor.com) too: the same skill, scripts and map. Cursor reads the skill from a skills folder, and the map's Ask bar runs the [Cursor CLI](https://cursor.com/docs/cli/overview) on your own Cursor sign-in.

## What you need

- Cursor, signed in.
- [Node.js](https://nodejs.org) 18 or newer.
- For the map's Ask bar: the Cursor CLI (`cursor-agent`), signed in with `cursor-agent login`, and your project folder trusted once (see below). Without it the map still opens and works, only asking questions needs it.

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

Everything after that is the same as in Claude Code ([Getting started](getting-started.md#make-your-first-map)). Cursor doesn't fill in the two lines at the top of the skill that point at its scripts, so the agent uses the skill's own folder instead and runs `status.mjs` itself, as it does in Codex.

## Asking questions on the map

The Ask bar runs `cursor-agent -p --mode ask` in your project folder. It uses your Cursor sign-in and plan, so questions count towards your usage like any other request. Unlike Codex, the Cursor CLI has no "don't save this" switch, so each question also shows up in your Cursor chat history, and a follow-up carries the last few questions and answers along.

### Read-only: what is and isn't guaranteed

Claude Code and Codex are read-only because their CLIs enforce it. The Cursor CLI doesn't give Floorplan an equivalent switch:

- Ask mode is Cursor's read-only mode for questions, and it turns down requests to edit files. But the CLI's own help says print mode "has access to all tools, including write and shell", so ask mode is not a lock.
- The CLI does have permission rules (`deny` entries such as `Write(...)` and `Shell(...)`), but they can only be set in your own Cursor CLI config (`~/.cursor/cli-config.json`, or `.cursor/cli.json` in the project). Floorplan doesn't edit those, so it doesn't use them.
- So Floorplan also tells the agent in the prompt never to create, edit or delete a file. That is an instruction, not a guarantee. If you need a hard guarantee, ask through Claude Code or Codex (`--engine claude` or `--engine codex`).

### Trusting the folder

The first time the Cursor CLI runs in a folder, it asks whether you trust it, and stops with "Workspace Trust Required" until you decide. Floorplan doesn't answer for you: it never passes `--trust`. That flag saves the trust for good and makes the CLI run the project's own `.cursor/hooks.json`, which could be any command. So, once per project, open a terminal in the project folder, run `agent`, and choose to trust it. After that the Ask bar works. The map says the same thing if it hits this.

The server uses whichever agent built the map and falls back to the others if that one isn't installed. To choose:

```bash
node floorplan/serve.mjs --engine cursor
```

It finds `cursor-agent` on your PATH and in `~/.local/bin`; it never runs a program just called `agent`. If yours is somewhere else, or installed only as `agent`, pass `--cursor /path/to/cursor-agent`. `--model <name>` picks the model; otherwise your Cursor settings decide.

## What's different from Claude Code

- **No notes file.** Claude Code gets a personal `CLAUDE.local.md` pointing future sessions at the map. Cursor doesn't read it, and `AGENTS.md` is shared with your team, so in Cursor Floorplan leaves your project's notes alone.
- **No Claude app.** Publishing the map to the Claude app is a Claude feature. In Cursor the map opens in your browser, served from your computer.
- **No Change on a blueprint.** Changing a blueprint from the map needs the agent to return an updated plan in a fixed format, which the Cursor CLI can't hold it to (the format goes in the prompt only). The map doesn't offer Change with Cursor; Claude Code and Codex do.
- **"Fix with Cursor".** The Health panel's ready-made fix prompts are for pasting into a Cursor chat.
