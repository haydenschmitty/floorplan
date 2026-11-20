---
name: floorplan
description: "Draw a floorplan of an app's codebase (one repo or several side by side), an interactive node-graph map where every subsystem, module, file and HTTP route has a human-readable name and a one-line description, connected by the imports and HTTP calls between them, at several zoom levels. It is saved as a self-contained floorplan/index.html in the codebase. Use whenever the user wants to visualize, map, diagram, document or get an architectural overview of a codebase, repo or monorepo, understand how their app works or is connected under the hood, onboard onto unfamiliar code, see how the frontend talks to the backend, or update an existing floorplan, even if they don't say \"visualize\". Also use it before any code exists: when the user shares a PRD, a spec or a description of something they want to build and asks what pieces it needs or how they'd fit together, it draws a blueprint, the same map planned from the document."
argument-hint: "[path-to-codebase-root] [--refresh]"
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/build.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/describe.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/open.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/plan.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/recent.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/refresh.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/status.mjs *)
---

# Floorplan

You produce `floorplan/` at the codebase root: a floorplan of the app that someone new can read like a system diagram. Every card shows a human name and a one-line description, with the real path in small type underneath.

- **You write:** `architecture.json` (subsystems, modules, flows) and `descriptions/*.json` (a name and description for every file and route).
- **Generated:** `graph.json` and `index.html`.

The scripts do the mechanical work: finding repos, parsing imports and routes, matching HTTP calls to endpoints, layout and rendering. Your job is the part only a reader of the code can do: deciding what things *are* and saying so plainly.

Existing map: !`node ${CLAUDE_SKILL_DIR}/scripts/status.mjs || true`
Arguments: $ARGUMENTS

**In Antigravity or Codex** (or any agent that left the two lines above unfilled): `${CLAUDE_SKILL_DIR}` in every command here means this skill's folder, the one holding this SKILL.md, so use its path. Run `node <that folder>/scripts/status.mjs` from the codebase root yourself to see whether a map exists, and take the path and `--refresh` from the user's request. The scripts detect Antigravity (`ANTIGRAVITY_AGENT`) or Codex automatically, so the Ask bar, "Fix with Antigravity", and "Build this with Antigravity" use the right agent.

## Nothing built yet? Draw a blueprint

If the user wants to plan something they haven't built ("here's my PRD", "I want to build an app that…", a long description of a system), make a **blueprint**: the same map, planned from their document instead of scanned from code. Use this path when there's no code for the system yet, even if the folder holds other things. If the code exists, make a normal map.

1. **Read the input.** A PRD file, a pasted message, or a document they point you at. Ask 2–3 questions only if something fundamental is open (who uses it, web or mobile, does anyone sign in, does money change hands); otherwise decide and record it as an assumption.
2. **Read [references/blueprint.md](references/blueprint.md)**, then [references/schema.md](references/schema.md) for architecture.json.
3. **Write `floorplan/plan.json`**: every planned file and endpoint, what each screen calls, which outside services and data each part uses, who may use each endpoint, your assumptions and the open questions. If the PRD is only in the chat, save it as `docs/prd.md` and use that as `source`, so the map and later questions can refer back to it.
4. **Write `floorplan/architecture.json`** as for a code map (parts, external nodes for the services and data plan.json names, 1–3 flows for the PRD's main user stories, a tour), with globs covering the planned paths. Plain language for everyone, as in step 4 below.
5. **Run `node ${CLAUDE_SKILL_DIR}/scripts/plan.mjs <root>`, then build.mjs** (step 5 below). Fix what they report until both are clean. Skip describe.mjs and recent.mjs: names and descriptions come from plan.json. A blueprint adds no notes to CLAUDE.local.md, since there's no code to look up yet.
6. **Show it** with open.mjs (step 8).
7. **Report** (instead of step 8's report): the URL; the shape of the system in 3–5 lines; the stack you chose; your main assumptions; and the design review's questions and warnings. Tell them each part has **Build this with Claude** (or **Build this with Antigravity** / **Codex**) for a ready request to build just that part; that they can switch the map's Ask bar to **Change** and ask for additions or changes ("also plan out refunds"), and the map redraws with what changed highlighted (the design review's **Resolve on the map** fills in such a request, so open questions just need their answer); that plan.json and architecture.json are theirs to edit or to ask you to change; and that the map stays out of git.

To change a blueprint, edit plan.json and architecture.json and run `refresh.mjs`, which redraws it from plan.json. Once the code exists and the user wants a map of it, run `refresh.mjs <root> --from-code`, then carry on as for a refresh. plan.json stays where it is.

## A map already exists? Refresh it instead

If the status above shows an existing map, don't start over. Run:

`node ${CLAUDE_SKILL_DIR}/scripts/refresh.mjs <root>`

It re-scans, compares content fingerprints against the last build, and does the bookkeeping without spending tokens:
- carries descriptions over to moved or renamed files and endpoints;
- drops entries for deleted files;
- flags entries whose exports or routes changed with a `review` note (edits inside function bodies don't count);
- rebuilds;
- prints what changed and a short NEXT list.

Do only what NEXT asks:
- add globs for new directories that landed in "unassigned";
- run describe.mjs (step 6), which now only produces worksheets for the new and flagged items;
- check module summaries and flows if the change was large.

A typical refresh after a few hours of work is a handful of worksheet entries. Then mark recent work (step 7), and show it and report (step 8). Always show it, even when nothing changed: the user asked to see their floorplan.

## Workflow (first run)

The codebase root is the argument if one was given, otherwise the current directory. It may be a single repo, or a plain folder holding several repos (frontend + backend + infra, and so on). The scanner finds every git repo under it and skips duplicate worktrees.

1. **Scan.**
   `node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs <root>`
   It writes `floorplan/.cache/scan.json` and prints a summary: repos, a code tree with LOC, entrypoints, the heaviest directory→directory import edges, HTTP call→route matches across repos, external packages and hosts. Work from the summary. Don't read scan.json, which is large.

2. **Read the contract.** Read [references/schema.md](references/schema.md) (the architecture.json format) and [references/choosing-boundaries.md](references/choosing-boundaries.md) (how to carve a codebase into a good map).

3. **Explore just enough.** Read READMEs, manifests (package.json, pyproject, go.mod, docker-compose, deploy configs) and entrypoints, then skim 1–2 files per candidate subsystem until you can write a one-sentence summary for each. You're after the shape of the system, not a code review.

4. **Write `floorplan/architecture.json`.** Aim for:
   - 3–9 top-level nodes;
   - 3–12 children under each big one;
   - globs covering more than 90% of code files;
   - external nodes for the databases and third-party services the code really talks to;
   - edges only for what the scan can't see (queues, cron, webhooks, cross-service calls through env-configured URLs);
   - 1–3 flows that explain the system's main jobs;
   - a `tour`: 3–8 narrated stops for the "Start here" tour (see below).

   Every node needs a `summary`.

   **Audience.** The people opening this map are usually the app's owners, often non-technical builders who made it with AI. Unless the user asks for a developer-facing map, leave `"audience"` unset or set it to `"everyone"`, and write every `project.summary`, node `label`/`summary`, and file/route description in plain language (see "Plain language" in references/writing-descriptions.md). Use short labels like "Main server" rather than "Shop API (Flask)". Paths and method/URL stay visible on the cards, so descriptions only need to say what the thing is for. And say what the code does today, not what its names suggest: when a part is mostly placeholders, its summary says so ("Say what it does today" in references/writing-descriptions.md).

   **Tour.** Add `"tour": [{ "node": "<node id or file path>", "title": "…", "note": "…" }]`, with stops in the order a newcomer should see them: what the app is, the apps people use, the main server, outside services, and ending on an important screen's file. Write titles and notes in plain words for someone who has never read the code. The first guided flow is added at the end automatically as "watch a real request". Without a tour, one is built from node summaries and the first flow, so good summaries and at least one flow matter.

5. **Build and fix.**
   `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <root>`
   It validates everything and names each problem ("did you mean …", files unassigned by directory, ambiguous globs). Fix and rebuild until it's clean and unassigned is under ~10%. Two warnings are worth one more pass: `plain language:` names a part whose label or summary uses developer words (reword it as suggested), and a part that "holds N files and no smaller parts" lists the folders it could be split along.

   **Nothing Floorplan makes is committed.** `floorplan/` holds its own `.gitignore` that ignores the whole folder, so the project's tracked files aren't touched. If git already tracks files there, the build prints the `git rm -r --cached` command to untrack them; pass it on to the user rather than running it.

   **A note for future sessions, only if the user wants one.** In Claude Code, the build can keep a short marked block in the project's `CLAUDE.local.md`, Claude Code's personal, uncommitted project notes, which load at session start like CLAUDE.md. The block tells future Claude Code sessions here that the map exists and how to look things up in it with `floorplan/query.mjs`, so they start from the map instead of searching the code from scratch. Because it changes how later sessions work, the build never adds it on its own: it reports `CLAUDE.LOCAL.MD  not added`, and you offer it in your report (step 8). Only when the user says yes, run `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <root> --claude-md`. Once the block exists, every build keeps it current. The build adds `CLAUDE.local.md` to the repo's local ignore list (`.git/info/exclude`, not `.gitignore`), rewrites only its own block, and moves the block out of `CLAUDE.md` if an older version put it there. To remove it, the user deletes the block, or puts `<!-- floorplan:off -->` in CLAUDE.local.md to keep it from coming back. Under Antigravity and Codex the build skips this: neither has a personal, uncommitted notes file (AGENTS.md is shared with the team), so don't add one there either.

6. **Describe every file and route.**
   `node ${CLAUDE_SKILL_DIR}/scripts/describe.mjs <root>`
   This writes one worksheet per module (`floorplan/.cache/worksheets/<key>.md`) and a skeleton to fill in (`floorplan/descriptions/<key>.json`). Each worksheet holds a digest of every file (docstrings, definitions, what it uses, and the files that import it, send it web requests or name it) and every route (handler, docstring), and quotes the code of each route it lists and the whole of very short files (secrets masked). That's enough to describe most files without opening them.
   - Read [references/writing-descriptions.md](references/writing-descriptions.md) first, especially "Say what it does today": describe what the quoted code does, say so plainly when it's a placeholder, and don't claim who runs or uses something unless the worksheet or the code shows it.
   - **More than ~150 files:** split the worksheets across parallel subagents if you have them (such as `invoke_subagent` in Antigravity), ~100–150 files each, grouped by area (backend routes, services, scripts, tests, UI). Give each one its worksheet keys, the codebase root and the writing guide, and tell it to edit only its own `descriptions/<key>.json` files and keep the keys unchanged.
   - **Smaller codebases:** do it yourself.

   Then rebuild. The build reports `DESCRIPTIONS files X/Y · routes X/Y`. Get both to 100%: re-run describe.mjs and it lists only what's still missing.

7. **Mark recent work.** The map highlights what was just worked on: those cards get a green "Changed"/"New" tag, the parts containing them show "N changed", hovering shows your note, and a **Recent work** button lays them out on one board. Do this on every make and every update, because it replaces the previous highlights.
   `node ${CLAUDE_SKILL_DIR}/scripts/recent.mjs <root>`
   It lists what changed since the previous map, uncommitted changes and recent commits, each matched to the card it appears as. The *why* comes from you:
   - **What counts.** Work done in this conversation, by you or your subagents, is the main source. Lean on what you know about it. If you did nothing here (a fresh session), use what recent.mjs shows that is clearly in flight: uncommitted changes and the latest commits. If there's nothing, write `{ "tasks": [] }` so old highlights clear.
   - **Write `floorplan/recent-work.json`.** Use one task per thing the user asked for: `title` (2–5 words), `request` (what they asked, in their words, shortened; leave it `""` when nobody asked here, as when working from commits, because the map shows it as "You asked: …"), `summary` (1–2 sentences on what was done toward it and where it stands, including anything deleted, since deleted files can't be highlighted). Then add `items`: the cards that changed, as a file path, node id or `"METHOD /path"`, with `change` (`"new"` or `"changed"`) and a `note`.
   - **Every note answers "how does this relate to what they asked for?"** In one or two plain sentences, say what changed on this card and why the request needed it. For example, write "Now catches web requests whose address is built up in a variable first, which is why the orders and inventory screens were showing no server calls." Not "Added flattenTemplates and variableUse helpers".
   - **Highlight what mattered.** Pick the files and endpoints whose behaviour changed for this request, usually 3–15. Skip tests and drive-by edits unless they're the point. A file with a changed endpoint can list both the file and the endpoint.
   - **Keep the code's words out unless the audience is developers.** Never put secrets in notes, and never invent example values: say only what the code shows.

   Format: [references/schema.md#recent-work](references/schema.md#recent-work). Then run build.mjs. It reports `RECENT WORK  N card(s) highlighted` and warns about refs that aren't on the map.

8. **Show it, then report.** Whenever you make or update a floorplan, finish by putting it in front of the user:
   `node ${CLAUDE_SKILL_DIR}/scripts/open.mjs <root>`
   - It starts the map's server in the background (or reuses the one already running for this map) and opens it in their browser. Tabs that are already open reload in place instead of a new one opening.
   - It prints the URL, whether Ask works (the Claude Code CLI, Codex, or Antigravity CLI was found), and how to stop the server. The server also stops on its own a couple of hours after the last tab closes.
   - **In Codex** (or sandboxed runners), run open.mjs outside the sandbox (ask for escalated permissions): the server has to keep running after the command ends, and Ask needs the network to reach the CLI. If that isn't allowed, give the user `node floorplan/serve.mjs` to run in their own terminal from the codebase root.
   - If you have an in-app browser or preview tool (such as Antigravity's `browser` subagent), pass `--no-open` and open the printed URL there instead, so the map appears right beside the conversation (otherwise `open.mjs` opens the default system browser).
   - If this is a remote or headless machine where the user can't reach 127.0.0.1, skip open.mjs and tell them to run `node floorplan/serve.mjs` on their own machine, or offer the Claude app route (step 9).

   Then **report.** Give the URL, then describe the architecture you mapped in 3–5 lines, in the user's language, including anything surprising: cycles, god-files, dead areas, coupled subsystems. Always mention the **high-severity Health items** (`graph.health`; the build output and graph.json list them). Hard-coded passwords/keys and endpoints anyone can change data through are things the owner needs to hear about. Also pass on any check the build marks with `!` under `what was checked` (like no endpoints found in code that runs a server): that check had nothing to look at, so a short Health list there isn't a clean bill of health. Never repeat a secret's value. When the build's `NOT MAPPED` line shows many docs or config files, say in one line that the map shows only the kinds of file it names (code, unless `include` says otherwise), so a small map isn't taken for a scan that missed things, and that you can add them. Say that `architecture.json` and `descriptions/` are theirs to edit, and that after more work they can just ask to "update the floorplan", which re-reads only what changed. Give them those plain words rather than a command: in Claude Code the plugin's command is `/floorplan:floorplan` (`/floorplan` as a personal skill), in Codex it's `$floorplan`, and in Antigravity ask in plain words ("Draw a floorplan of this codebase"). On a first run, mention in one line that the map stays out of git. In Claude Code, when the build said `CLAUDE.LOCAL.MD  not added`, end by asking once whether future Claude Code sessions in this project should use the map: you'd add a short note to their personal, uncommitted CLAUDE.local.md. Add it (`build.mjs <root> --claude-md`) only on a yes, and don't ask again on later updates if they said no. On an update, start with what changed for what they asked (it's highlighted under **Recent work**).

## 9. Opening the map and asking questions

The Ask bar lets users ask questions and get text + an interactive mini-map board + optional walkthrough:

- **Local CLI (best):** `floorplan/serve.mjs` (started by `open.mjs`) serves `http://127.0.0.1:4378` (or next free port) and answers read-only on the user's own account:
  - **Claude Code:** `claude -p` using `floorplan/query.mjs` + Read/Grep/Glob (CLI-enforced read-only; finds `claude` on PATH or `~/.local/bin`).
  - **Codex:** `codex exec` in its read-only sandbox (ephemeral; finds `codex` on PATH or in the Codex app).
  - **Antigravity:** `agy --sandbox --disable-slash-commands --output-format stream-json --json-schema <file> --print=…` (resumes via `--conversation`; finds `agy` on PATH or `%LOCALAPPDATA%\agy\bin\agy.exe` / `~/.local/bin/agy`). Uses `--sandbox` + prompt-level read-only instructions rather than CLI tool whitelisting; pass `--engine claude` or `--engine codex` for stricter read-only enforcement.

  Defaults to the agent that built the map, falling back across the others. Flags (passed through by `open.mjs`): `--engine claude|codex|antigravity`, `--claude|--codex|--antigravity <path>`, `--model <name>`, `--editor <name|link>` (including `antigravity`, `antigravity-ide`). Users can run `node floorplan/serve.mjs` directly or stop it with `--stop`.
- **Claude app:** When the Artifact tool is available, run `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <root> --artifact` to write `floorplan/artifact.html` (no machine paths) and publish with `capabilities: {"sample": {}}` at the same path on updates. Inform the user first that publishing uploads the map structure/descriptions (not source code) to their claude.ai account.
- **Standalone:** `floorplan/index.html` opens directly in any browser without Ask.

### Sharing a copy

Export a single shareable HTML file (no Ask bar, agent prompts, editor links, local paths, or git remotes) via the browser **Export** button or:

```
node floorplan/serve.mjs --export [<file>] [--include flows,notes,recent,health]
```

Writes `floorplan/<project>-map.html` by default (`--include` defaults to `flows,notes`; omit `health` unless asked, and warn the user that `health` lists open endpoints and secret locations—never values).

### Built-in map features

- **Health (`scripts/lib/health.mjs`):** Flags hardcoded keys/passwords, public client env vars, open Supabase/Firebase rules, unverified Stripe webhooks, open CORS, unprotected endpoints, unused files, and >1,000-line files (never stores secret values), each with **Show on map** and **Fix with Claude / Codex / Antigravity** prompts. Not a full security audit.
- **Screens (`scripts/lib/screens.mjs`):** Auto-detects UI routes (Next.js, React Router, Vue, SvelteKit, Remix, Nuxt, Astro, Expo, Angular, TanStack, Shopify) and everything behind them.
- **Start here, plain words, & custom flows:** Built-in guided tour (`tour` or auto-generated), hover definitions (**Filters → Show technical detail** toggles dev terms), and **Flows → Request a new flow** (saved to `floorplan/custom-flows.json` by `serve.mjs`; keep as user content on refresh).

## Notes

- Paths are relative to the codebase root and use forward slashes. In a multi-repo root they start with the repo folder, e.g. `api-service/src/**`.
- Route keys in descriptions are `"METHOD /full/path"` exactly as the worksheet prints them.
- The map makes no outside requests: the build inlines the layout engine (ELK) and fonts from `${CLAUDE_SKILL_DIR}/assets/vendor/`, so it works offline.
- Framework-specific matching notes (Firebase, Supabase Edge Functions, Laravel/Wayfinder/Inertia, Serverless Framework, Shopify themes): read [references/framework-notes.md](references/framework-notes.md) when mapping one of those stacks.
- Don't hand-edit graph.json or index.html; they're regenerated on every build.
