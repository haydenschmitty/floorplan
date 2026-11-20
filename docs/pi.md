# Floorplan in Pi

Floorplan is an [Agent Skill](https://agentskills.io/specification) with a small Pi extension wrapper. The wrapper makes the bundled skill discoverable and supplies `/floorplan`, so Floorplan can be used in Pi without changing its Claude Code or Codex integrations.

## Install for one project

Floorplan is a Pi package. From the project you want to map, install this repository as a **project-local** package:

```bash
pi install --local git:github.com/haydenschmitty/floorplan
```

The command writes the package declaration to that project's `.pi/settings.json`. Review the source before trusting it: Floorplan's skill asks Pi to inspect code and run the bundled local Node scripts. Start Pi in that project and approve its project-trust prompt. Pi then loads the package's `.pi/extensions/floorplan.ts` and `skills/floorplan` resources.

For a checkout of this repository, Pi discovers `.pi/extensions/floorplan.ts` directly. Start Pi from the checkout, trust the project, and use `/reload` if Pi was already running when the extension was added.

Requirements:

- Pi with TypeScript extension and Agent Skill support.
- Node.js 18 or newer, which Floorplan's scripts require.
- A trusted project. Project-local extensions and packages deliberately do not run before trust is granted.

## Use it

In Pi, either ask normally:

> Make a floorplan of this app.

or invoke the wrapper explicitly:

```text
/floorplan
/floorplan ../projects/my-app
/floorplan . --refresh
```

`/floorplan` forwards its arguments to `/skill:floorplan`. The skill guides Pi through scanning, describing, building, and opening the map; it remains responsible for deciding the architecture and the plain-language descriptions. Generated map files still go in the mapped project's ignored `floorplan/` directory.

## Integration design and boundaries

| Surface | Pi behavior | Compatibility |
| --- | --- | --- |
| `.pi/extensions/floorplan.ts` | Auto-discovered project extension; registers `/floorplan`. | Additive; Claude Code and Codex do not load it. |
| `resources_discover` | Exposes the existing `skills/floorplan` directory to Pi. | The source skill remains portable Agent Skill Markdown. |
| `/floorplan [args]` | Dispatches Pi's `/skill:floorplan [args]` command. | Reuses the existing scripts and workflow; it does not duplicate them. |
| `skills/floorplan/scripts/*.mjs` | Pi executes them as instructed by the skill. | Existing scripts, JSON workflow, Claude Code plugin, and Codex plugin are unchanged. |

Floorplan does not register a Pi MCP server, provider, file watcher, or background process. The extension itself does not mutate a mapped codebase; the existing Floorplan scripts retain their documented behavior.

The map's browser **Ask** bar currently executes its questions through the Claude Code CLI or Codex. Pi is the agent that creates and updates the map, but it is not yet a browser Ask-bar engine. Ask follow-up questions in the Pi conversation when neither of those CLIs is available.

## Updating or removing

After updating a package installation, restart Pi or run `/reload` to rediscover its resources. Remove the project-local package with the matching source:

```bash
pi remove git:github.com/haydenschmitty/floorplan
```

This removes the Pi package configuration; it does not delete Floorplan maps already created in your projects.
