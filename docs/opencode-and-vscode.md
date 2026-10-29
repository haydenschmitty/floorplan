# Floorplan in OpenCode and VS Code

Floorplan's skill follows the open [Agent Skills](https://agentskills.io/) format, so it also runs in [OpenCode](https://opencode.ai) and in GitHub Copilot Chat in [VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills). Neither has a Floorplan plugin to install, so you copy the skill folder into place yourself. Making and using a map is then the same as in Claude Code.

## What you need

- OpenCode, or VS Code with GitHub Copilot Chat.
- [Node.js](https://nodejs.org) 18 or newer.
- **For the Ask bar:** the [Claude Code CLI](https://code.claude.com/docs/en/overview) or the [Codex CLI](https://developers.openai.com/codex/cli). The map itself works without them. See [Asking questions on the map](#asking-questions-on-the-map).

## Install

Copy the `skills/floorplan` folder from this repository into a skills folder that your agent reads. Keep the folder name `floorplan`.

| Agent | For all your projects | For one project |
|---|---|---|
| OpenCode | `~/.config/opencode/skills/floorplan` | `.opencode/skills/floorplan` |
| VS Code (Copilot) | `~/.copilot/skills/floorplan` | `.github/skills/floorplan` |
| Both | `~/.agents/skills/floorplan` | `.agents/skills/floorplan` |

For example, on macOS or Linux:

```bash
git clone https://github.com/haydenschmitty/floorplan
mkdir -p ~/.agents/skills
cp -r floorplan/skills/floorplan ~/.agents/skills/
```

On Windows (PowerShell):

```powershell
git clone https://github.com/haydenschmitty/floorplan
New-Item -ItemType Directory -Force "$HOME\.agents\skills" | Out-Null
Copy-Item -Recurse floorplan\skills\floorplan "$HOME\.agents\skills\"
```

If you install it per project, the skill folder is part of that project, so add it to `.gitignore` unless your team wants to share it.

Restart OpenCode, or start a new chat in VS Code, so the skill is picked up.

## Make your first map

Open your project and ask in plain words:

> Make me a floorplan of this app.

In VS Code you can also type `/floorplan` in the chat. Everything after that is the same as in Claude Code ([Getting started](getting-started.md#make-your-first-map)): the agent scans the code, describes every part, file and web request, builds the map and opens it. Later, "update the floorplan" re-reads only what changed.

The agent will ask to run Floorplan's scripts (`node …`); allow them. Copilot runs them in VS Code's terminal.

## Which agent built the map

The map records which agent made it, so the Health panel's fix prompts say **Fix with OpenCode** or **Fix with Copilot**.

- **OpenCode** is recognised on its own.
- **Copilot** sets nothing the scripts can see. The skill tells it to pass `--agent copilot` to the build. If a map made in VS Code says "Fix with Claude", rebuild it with `node <skill folder>/scripts/build.mjs . --agent copilot`.

You can also set `FLOORPLAN_AGENT=opencode` or `FLOORPLAN_AGENT=copilot` in your environment.

## Asking questions on the map

The map's Ask bar answers through a command-line agent on your computer that can read your code: the Claude Code CLI (`claude -p`) or Codex (`codex exec`), each on your own sign-in and read-only. OpenCode and Copilot Chat don't have a mode the map can use for this yet, so for a map made in either, the server uses whichever of the two CLIs is installed:

```bash
node floorplan/serve.mjs --engine claude
```

Without either one, everything else on the map works: browsing, screens, flows, Health and Recent work. The Ask bar says which CLI it needs.

## What's different from Claude Code

- **No notes file.** In Claude Code, Floorplan keeps a short note in `CLAUDE.local.md` that points future sessions at the map. OpenCode and VS Code have no personal, uncommitted equivalent (`AGENTS.md` and `.github/copilot-instructions.md` are shared with your team), so Floorplan leaves your project's notes alone.
- **No plugin updates.** To update, pull the repository again and copy the `skills/floorplan` folder over the old one.

## Remove it

Delete the `floorplan` skill folder you copied, then delete the `floorplan/` folder from any project you used it in.
