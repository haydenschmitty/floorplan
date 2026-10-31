# What's in your project

Floorplan writes to exactly two places in your project: the `floorplan/` folder, and (in Claude Code, only if you say yes) a short section in `CLAUDE.local.md`. Neither is committed to git, and nothing else in your project is touched.

## The `floorplan/` folder

| File | What it is | Edit it? |
|---|---|---|
| `index.html` | The map: one self-contained page | No. Rebuilt every time |
| `graph.json` | Everything the map shows, as data | No. Rebuilt every time |
| `architecture.json` | The parts of your app, outside services, extra connections, flows and the tour | **Yes** |
| `descriptions/*.json` | The name and description of every file and endpoint, one file per part | **Yes** |
| `plan.json` | Blueprints only: the planned files, endpoints and screens, who may use each endpoint, the stack, assumptions and open questions. Names and descriptions live here instead of `descriptions/` | **Yes** |
| `recent-work.json` | What was just worked on, and why. Replaced on every update | Rarely. The AI writes it |
| `custom-flows.json` | Flows requested from the map | Only to delete one |
| `serve.mjs` | Serves the map locally and answers questions through the Claude Code CLI, Codex or the Cursor CLI | No |
| `query.mjs` | Looks things up in the map from the command line; Claude, Codex and Cursor use it too | No |
| `artifact.html` | A copy for opening in the Claude app, only if you asked for one | No |
| `<project>-map.html` | An exported copy to share, only if you exported one from Claude or Codex (the map's Export button downloads it instead) | No |
| `.cache/` | The scan, the description worksheets, the last update's changes, the running server's address, and, for a blueprint, the last 20 versions of the plan that **Undo** goes back to | No. Safe to delete, though Undo then has nothing to go back to |
| `.gitignore` | Keeps this whole folder out of git | No |

### Editing names and structure

Your edits to `architecture.json` and `descriptions/` are kept on every update. You can:
- rename a part, or reword a description;
- move files between parts by changing the `paths` patterns;
- add a connection the scan missed;
- pin a note to a file;
- add or change flows and the tour.

Or just ask Claude or Codex ("rename 'Main server' to 'Shop API' on the floorplan").

A blueprint is edited the same way, through `plan.json` and `architecture.json`, or from the map with the Ask bar's **Change** switch. The plan's format is in [`blueprint.md`](../skills/floorplan/references/blueprint.md).

The full format is in [`skills/floorplan/references/schema.md`](../skills/floorplan/references/schema.md), and the style guide for names and descriptions is in [`writing-descriptions.md`](../skills/floorplan/references/writing-descriptions.md).

## `CLAUDE.local.md`

In Claude Code, after the first map, Claude asks whether future sessions in your project should use it. Only if you say yes, Floorplan adds a short marked section here, telling future Claude Code sessions that the map exists and how to look things up in it. `CLAUDE.local.md` is Claude Code's file for personal project notes, loaded at the start of every session like `CLAUDE.md`. Floorplan:
- creates the file if you don't have one;
- only ever rewrites its own section, between `<!-- floorplan:start -->` and `<!-- floorplan:end -->`, and keeps it current on each update;
- adds the file to your clone's private ignore list, `.git/info/exclude`.

To remove it, delete the section. To keep it from coming back, put `<!-- floorplan:off -->` anywhere in `CLAUDE.local.md`. (Before 0.4.4, Floorplan added the section without asking; if you have it from then, it stays until you remove it.)

A blueprint adds no section, since there's no code to look up yet. Claude offers it once the map switches to the real code.

In Codex and Cursor this file isn't touched. Neither has a personal, uncommitted notes file (`AGENTS.md` is shared with your team), so Floorplan doesn't add a note there.

## Staying out of git

- **`floorplan/`** contains its own `.gitignore` that ignores everything in the folder, including itself. Your `.gitignore` isn't changed, and the folder never appears in `git status`.
- **`CLAUDE.local.md`** is listed in `.git/info/exclude`, the per-clone ignore list that is never committed. If your project already ignores it, nothing is added.

The map is personal to each clone. Teammates who install Floorplan make their own.

If you committed a `floorplan/` folder before, ignoring it doesn't untrack those files. The build tells you the command that does, which keeps the files on disk:

```bash
git rm -r --cached floorplan
```
