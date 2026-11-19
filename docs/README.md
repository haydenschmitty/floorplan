# Floorplan documentation

| Guide | What's in it |
|---|---|
| [Getting started](getting-started.md) | Installing, making your first map, keeping it updated, planning an app before it exists, updating and removing the plugin |
| [Floorplan in Codex](codex.md) | Installing and using Floorplan in Codex, and what's different from Claude Code |
| [Using the map](using-the-map.md) | Every button, view, panel, shortcut and right-click menu, and what a blueprint adds |
| [How it works](how-it-works.md) | The pipeline from scan to map, how connections are found, how updates stay cheap, how blueprints are drawn and changed |
| [What's in your project](project-files.md) | Every file Floorplan creates, which ones you can edit, and how it stays out of git |
| [Privacy and security](privacy-and-security.md) | What runs where, what leaves your machine, and how secrets are handled |
| [Is it safe to install?](is-it-safe.md) | Everything Floorplan does on your computer, how a test enforces it, and how to verify your installed copy |
| [Troubleshooting](troubleshooting.md) | Common problems and how to fix them |
| [Running without an agent session](unattended.md) | Running Floorplan in CI, in scripts or from your own tooling: unattended mode, results as JSON, exit codes and the workflow file |
| [Developing Floorplan](development.md) | Repo layout, testing a local copy, releasing a new version |

New here? Start with [Getting started](getting-started.md).

The commands in these guides are written for a POSIX shell (macOS and Linux terminals, Git Bash or WSL on Windows). Most are plain `node …` or `claude …` commands that work the same in Windows PowerShell, with paths in quotes. Where they differ: set a variable for the session with `$env:FLOORPLAN_UNATTENDED = "1"` instead of `export FLOORPLAN_UNATTENDED=1`, use it as `$S` after `$S = "C:\path\to\floorplan\skills\floorplan"` instead of `S=…`, and run two commands one after the other with `;` (or `a; if ($?) { b }` to stop when the first fails) instead of `&&`.

Floorplan is mainly for mapping code you already have, and every guide is written for that. It can also draw a **blueprint**, a map planned from a PRD or spec before the code exists: see [Plan something you haven't built yet](getting-started.md#plan-something-you-havent-built-yet), [Blueprints on the map](using-the-map.md#blueprints) and [how blueprints work](how-it-works.md#blueprints).
