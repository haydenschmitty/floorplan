# Privacy and security

For what the plugin itself can and can't do on your computer (no hooks, MCP servers, dependencies or downloads, and how to verify your copy), see [Is it safe to install?](is-it-safe.md).

## What runs where

| Part | Where it runs | What it sends |
|---|---|---|
| Scan, build, updates | your computer (Node.js) | nothing |
| Writing names and descriptions | Claude or Codex, through your session | the files it reads, the same as any other task you give it |
| The map | your browser | nothing. Its layout engine and fonts are bundled into the file, so it works offline |
| The map's server (`serve.mjs`) | your computer, listening on `127.0.0.1` only | nothing on its own |
| Asking questions (Claude Code CLI) | a `claude -p` session on your computer, with your account | your question, and the files Claude chooses to read |
| Asking questions (Codex) | a `codex exec` run on your computer, with your ChatGPT sign-in, not saved to your Codex history | your question, and the files Codex chooses to read |
| Asking questions (Hermes) | a `hermes floorplan ask` worker on your computer, with your Hermes profile; it reads source only through the map's own boundary | your question, and the bounded, redacted files the boundary lets through |
| Changing a blueprint from the map | the same as asking questions, with Claude Code, Codex or Hermes; the map's server then writes only the plan's files in `floorplan/` | your request, and the files the AI chooses to read |
| Asking questions (Claude app) | your claude.ai account | the map (names, descriptions, structure), never your source code. Claude asks before publishing it there |
| Exporting a copy | your computer: the map's server writes one HTML file | nothing. You decide who gets the file. It holds the map, plus Health or recent work only if you tick them, and never your folder path, git remotes or source code |
| Floorplan Cloud waitlist (only if you sign up) | the map's server, to Floorplan's waitlist service | the email you typed or chose, and "just me" or "with my team". See [below](#floorplan-cloud-waitlist) |

Floorplan has no analytics or telemetry, no dependencies to install, and no install scripts. Its only outside connection is the opt-in waitlist below, and nothing reaches it unless you sign up. The map's few links to documentation open only when you click them.

The layout engine ([elkjs](https://github.com/kieler/elkjs) 0.9.3, EPL-2.0) and fonts (Inter and JetBrains Mono, SIL Open Font License) are bundled in `skills/floorplan/assets/vendor/` with their licenses, and every build copies them into the map.

## The local server

- It listens on `127.0.0.1` only, so other machines on your network can't reach it.
- Every start creates a random token, which only the map page it serves receives. Asking questions and saving flows require that token, and those requests are refused when they come from another website.
- It answers only to `127.0.0.1` and `localhost` at its own port, so a website that points its own domain at your computer (DNS rebinding) can't load the map or its token.
- Questions run Claude with **read-only** tools: reading files, searching, and the map's own lookup script. It can't edit files or run other commands.
- With Codex, questions run in Codex's **read-only** sandbox: it can read and search, but not write files.
- With Hermes, the worker has no tools at all: it asks the map's server for a lookup, and the server does the reading. Only files the map already scanned are eligible; `.git`, `.hermes`, key and credential files, `.env*`, `AGENTS.md`, `SOUL.md`, `CLAUDE*.md` and symlinks are refused, at most 200 lines and 32 KiB come back per read, and known secrets are redacted (or the whole file refused). It cannot write, run a command, or reach another tool or MCP server.
- On a blueprint, the only files outside the scanned code that Hermes may read are **exactly three files**: `floorplan/plan.json`, `floorplan/architecture.json`, and the one PRD path named in `plan.json`'s `source`. Each is classified with a fresh full `findIssues` scan of the exact bytes. The worker receives those bytes and their SHA-256 and issues a single-use ticket naming that hash, the root and the mode; the server reopens the file through a confined descriptor and refuses the read if the SHA-256 changed. A read returns at most 32 KiB and at most 200 lines: a 200-line window passes, 201 fails. The redaction and extraction use the same verified buffer; nothing is reopened to extract.
- **Change writes only map-owned files**, never application code: `plan.json`, `architecture.json`, `recent-work.json` and the generated map files. It validates a candidate in `floorplan/.cache/change-<request-id>/` first, then moves each actual live entry under `.cache/history/<id>/held/` and `displaced/`, writes a `manifest.json` naming every moved file, and installs a staged file only into an empty path. Those preservation entries are recovery and Undo sources and are never pruned automatically; older pre-manifest snapshots keep the last 20. There is **no atomic compare-and-swap** and no multi-file transaction: publication is sequential, and a reader that already holds an open descriptor keeps reading the old inode. Retained inodes cost disk space; delete old history folders in `floorplan/.cache/history/` yourself, only after every writer has stopped.
- On a blueprint (a map planned from a PRD), **Change** requests run the same read-only way. The agent replies with the updated plan, and the server itself writes only `floorplan/plan.json`, `floorplan/architecture.json` and `floorplan/recent-work.json`, after checking them, keeping the old copies for Undo.
- It stops by itself two hours after the last tab closes, and `node floorplan/serve.mjs --stop` stops it immediately.

## Floorplan Cloud waitlist

Once a map has been open for two minutes, a card in its bottom-left corner asks whether you'd like an email when **Floorplan Cloud** launches. It's a hosted version with one shared map per team, kept in sync with GitHub. It asks once:
- **Not now** asks again in two weeks.
- **Don't ask again** and signing up both stop it for good, in every project.

Nothing is sent unless you click **Notify me**.

**What's sent:** only the email address in the box, and whether you'd use Floorplan Cloud just yourself or with a team. Nothing about you, your project or your code goes with it.

**Use my Claude email:** this button fills the box with the email of the Claude account your Claude Code is signed in with. Claude Code is asked only at that moment, and you see the address before anything is sent. Nothing is read when you don't click it.

**Where it goes:**
- The map's local server sends it to a small service on Google Cloud Run. You can read its code [here](https://github.com/haydenschmitty/floorplan/blob/4cb4ff9337b2d021abbd52148e25a1e0016f099d/services/waitlist/server.mjs). It's kept in this repo's history rather than in the plugin, so it isn't downloaded when you install Floorplan.
- That service adds a row to a private Google Sheet that only Floorplan's maker, [Hayden Smith](https://github.com/haydenschmitty), can see. The row holds the date, the email and your answer.

**What it's used for:** only to email you when Floorplan Cloud launches, and to gauge whether it's worth building. The list is never sold or shared. Every email on it will include a way to unsubscribe, and you can ask to be removed at any time by emailing [hismith142@gmail.com](mailto:hismith142@gmail.com).

**Your IP address** is used briefly to rate-limit sign-ups and is never written to the sheet. Google Cloud keeps its standard request logs, which include IP addresses, for 30 days.

**Turning it off:**
- Click **Don't ask again**, or
- set the environment variable `FLOORPLAN_NO_PROMPTS=1`.

Your answer is kept in `~/.floorplan/settings.json`.

**How the service is protected:** its address is in Floorplan's public code, so it's built to be harmless if abused.
- It only accepts new sign-ups, and never returns anything from the list.
- A repeat sign-up looks the same as a new one, so nobody can check whether an address is on the list.
- Input is checked strictly and saved as plain text.
- Sign-ups are limited per IP address and overall, and the list has a size cap.
- It runs as a single small instance, so a flood of requests can't run up costs.

## Secrets

The Health check looks for passwords, API keys and private keys in your code, and for `.env` files that would be committed. When it finds one, it records only the file, the line, the kind of secret, and a masked hint like "starts AKIA…, 20 characters". **Secret values are never stored in the map, printed, or sent anywhere**, and Claude is instructed never to repeat them.

The check is a helpful first pass, not a security audit.

## Git

Nothing Floorplan creates is committed. See [What's in your project](project-files.md#staying-out-of-git).

## Reporting a vulnerability

Please report security problems privately, as described in [SECURITY.md](../SECURITY.md), rather than in a public issue.
