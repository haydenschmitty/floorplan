---
name: floorplan
description: Draw a floorplan of an app's codebase (one repo or several side by side), an interactive node-graph map where every subsystem, module, file and HTTP route has a human-readable name and a one-line description, connected by the imports and HTTP calls between them, at several zoom levels. It is saved as a self-contained floorplan/index.html in the codebase. Use whenever the user wants to visualize, map, diagram, document or get an architectural overview of a codebase, repo or monorepo, understand how their app works or is connected under the hood, onboard onto unfamiliar code, see how the frontend talks to the backend, or update an existing floorplan, even if they don't say "visualize". Also use it before any code exists: when the user shares a PRD, a spec or a description of something they want to build and asks what pieces it needs or how they'd fit together, it draws a blueprint, the same map planned from the document.
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

**In Codex or Cursor** (or any agent that left the two lines above unfilled): `${CLAUDE_SKILL_DIR}` in every command here means this skill's folder, the one holding this SKILL.md, so use its path. Run `node <that folder>/scripts/status.mjs` from the codebase root yourself to see whether a map exists, and take the path and `--refresh` from the user's request. The scripts notice they're running under Codex or Cursor, so the map's Ask bar and "Fix with" prompts use that agent.

## Nothing built yet? Draw a blueprint

If the user wants to plan something they haven't built ("here's my PRD", "I want to build an app that…", a long description of a system), make a **blueprint**: the same map, planned from their document instead of scanned from code. Use this path when there's no code for the system yet, even if the folder holds other things. If the code exists, make a normal map.

1. **Read the input.** A PRD file, a pasted message, or a document they point you at. Ask 2–3 questions only if something fundamental is open (who uses it, web or mobile, does anyone sign in, does money change hands); otherwise decide and record it as an assumption.
2. **Read [references/blueprint.md](references/blueprint.md)**, then [references/schema.md](references/schema.md) for architecture.json.
3. **Write `floorplan/plan.json`**: every planned file and endpoint, what each screen calls, which outside services and data each part uses, who may use each endpoint, your assumptions and the open questions. If the PRD is only in the chat, save it as `docs/prd.md` and use that as `source`, so the map and later questions can refer back to it.
4. **Write `floorplan/architecture.json`** as for a code map (parts, external nodes for the services and data plan.json names, 1–3 flows for the PRD's main user stories, a tour), with globs covering the planned paths. Plain language for everyone, as in step 4 below.
5. **Run `node ${CLAUDE_SKILL_DIR}/scripts/plan.mjs <root>`, then build.mjs** (step 5 below). Fix what they report until both are clean. Skip describe.mjs and recent.mjs: names and descriptions come from plan.json. A blueprint adds no notes to CLAUDE.local.md, since there's no code to look up yet.
6. **Show it** with open.mjs (step 8).
7. **Report** (instead of step 8's report): the URL; the shape of the system in 3–5 lines; the stack you chose; your main assumptions; and the design review's questions and warnings. Tell them each part has **Build this with Claude** (or Codex) for a ready request to build just that part; that they can switch the map's Ask bar to **Change** and ask for additions or changes ("also plan out refunds"), and the map redraws with what changed highlighted (the design review's **Resolve on the map** fills in such a request, so open questions just need their answer); that plan.json and architecture.json are theirs to edit or to ask you to change; and that the map stays out of git.

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

   **Audience.** The people opening this map are usually the app's owners, often non-technical builders who made it with AI. Unless the user asks for a developer-facing map, leave `"audience"` unset or set it to `"everyone"`, and write every `project.summary`, node `label`/`summary`, and file/route description in plain language (see "Plain language" in references/writing-descriptions.md). Use short labels like "Main server" rather than "Shop API (Flask)". Paths and method/URL stay visible on the cards, so descriptions only need to say what the thing is for.

   **Tour.** Add `"tour": [{ "node": "<node id or file path>", "title": "…", "note": "…" }]`, with stops in the order a newcomer should see them: what the app is, the apps people use, the main server, outside services, and ending on an important screen's file. Write titles and notes in plain words for someone who has never read the code. The first guided flow is added at the end automatically as "watch a real request". Without a tour, one is built from node summaries and the first flow, so good summaries and at least one flow matter.

5. **Build and fix.**
   `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <root>`
   It validates everything and names each problem ("did you mean …", files unassigned by directory, ambiguous globs). Fix and rebuild until it's clean and unassigned is under ~10%.

   **Nothing Floorplan makes is committed.** `floorplan/` holds its own `.gitignore` that ignores the whole folder, so the project's tracked files aren't touched. If git already tracks files there, the build prints the `git rm -r --cached` command to untrack them; pass it on to the user rather than running it.

   **A note for future sessions, only if the user wants one.** In Claude Code, the build can keep a short marked block in the project's `CLAUDE.local.md`, Claude Code's personal, uncommitted project notes, which load at session start like CLAUDE.md. The block tells future Claude Code sessions here that the map exists and how to look things up in it with `floorplan/query.mjs`, so they start from the map instead of searching the code from scratch. Because it changes how later sessions work, the build never adds it on its own: it reports `CLAUDE.LOCAL.MD  not added`, and you offer it in your report (step 8). Only when the user says yes, run `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <root> --claude-md`. Once the block exists, every build keeps it current. The build adds `CLAUDE.local.md` to the repo's local ignore list (`.git/info/exclude`, not `.gitignore`), rewrites only its own block, and moves the block out of `CLAUDE.md` if an older version put it there. To remove it, the user deletes the block, or puts `<!-- floorplan:off -->` in CLAUDE.local.md to keep it from coming back. Under Codex and Cursor the build skips this: neither has a personal, uncommitted notes file (AGENTS.md is shared with the team), so don't add one there either.

6. **Describe every file and route.**
   `node ${CLAUDE_SKILL_DIR}/scripts/describe.mjs <root>`
   This writes one worksheet per module (`floorplan/.cache/worksheets/<key>.md`) and a skeleton to fill in (`floorplan/descriptions/<key>.json`). Each worksheet holds a digest of every file (docstrings, definitions, what it uses and what uses it) and every route (handler, docstring), which is enough to describe most files without opening them.
   - Read [references/writing-descriptions.md](references/writing-descriptions.md) first.
   - **More than ~150 files:** split the worksheets across parallel subagents if you have them, ~100–150 files each, grouped by area (backend routes, services, scripts, tests, UI). Give each one its worksheet keys, the codebase root and the writing guide, and tell it to edit only its own `descriptions/<key>.json` files and keep the keys unchanged.
   - **Smaller codebases:** do it yourself.

   Then rebuild. The build reports `DESCRIPTIONS files X/Y · routes X/Y`. Get both to 100%: re-run describe.mjs and it lists only what's still missing.

7. **Mark recent work.** The map highlights what was just worked on: those cards get a green "Changed"/"New" tag, the parts containing them show "N changed", hovering shows your note, and a **Recent work** button lays them out on one board. Do this on every make and every update, because it replaces the previous highlights.
   `node ${CLAUDE_SKILL_DIR}/scripts/recent.mjs <root>`
   It lists what changed since the previous map, uncommitted changes and recent commits, each matched to the card it appears as. The *why* comes from you:
   - **What counts.** Work done in this conversation, by you or your subagents, is the main source. Lean on what you know about it. If you did nothing here (a fresh session), use what recent.mjs shows that is clearly in flight: uncommitted changes and the latest commits. If there's nothing, write `{ "tasks": [] }` so old highlights clear.
   - **Write `floorplan/recent-work.json`.** Use one task per thing the user asked for: `title` (2–5 words), `request` (what they asked, in their words, shortened), `summary` (1–2 sentences on what was done toward it and where it stands, including anything deleted, since deleted files can't be highlighted). Then add `items`: the cards that changed, as a file path, node id or `"METHOD /path"`, with `change` (`"new"` or `"changed"`) and a `note`.
   - **Every note answers "how does this relate to what they asked for?"** In one or two plain sentences, say what changed on this card and why the request needed it. For example, write "Now catches web requests whose address is built up in a variable first, which is why the orders and inventory screens were showing no server calls." Not "Added flattenTemplates and variableUse helpers".
   - **Highlight what mattered.** Pick the files and endpoints whose behaviour changed for this request, usually 3–15. Skip tests and drive-by edits unless they're the point. A file with a changed endpoint can list both the file and the endpoint.
   - **Keep the code's words out unless the audience is developers.** Never put secrets in notes.

   Format: [references/schema.md#recent-work](references/schema.md#recent-work). Then run build.mjs. It reports `RECENT WORK  N card(s) highlighted` and warns about refs that aren't on the map.

8. **Show it, then report.** Whenever you make or update a floorplan, finish by putting it in front of the user:
   `node ${CLAUDE_SKILL_DIR}/scripts/open.mjs <root>`
   - It starts the map's server in the background (or reuses the one already running for this map) and opens it in their browser. Tabs that are already open reload in place instead of a new one opening.
   - It prints the URL, whether Ask works (the Claude Code CLI, Codex or the Cursor CLI was found), and how to stop the server. The server also stops on its own a couple of hours after the last tab closes.
   - **In Codex**, run open.mjs outside the sandbox (ask for escalated permissions): the server has to keep running after the command ends, and Ask needs the network to reach Codex. If that isn't allowed, give the user `node floorplan/serve.mjs` to run in their own terminal from the codebase root.
   - If you have an in-app browser or preview tool, pass `--no-open` and open the printed URL there instead, so the map appears right beside the conversation.
   - If this is a remote or headless machine where the user can't reach 127.0.0.1, skip open.mjs and tell them to run `node floorplan/serve.mjs` on their own machine, or offer the Claude app route (step 9).

   Then **report.** Give the URL, then describe the architecture you mapped in 3–5 lines, in the user's language, including anything surprising: cycles, god-files, dead areas, coupled subsystems. Always mention the **high-severity Health items** (`graph.health`; the build output and graph.json list them). Hard-coded passwords/keys and endpoints anyone can change data through are things the owner needs to hear about. Never repeat a secret's value. Say that `architecture.json` and `descriptions/` are theirs to edit, and that after more work they can just ask to "update the floorplan", which re-reads only what changed. Give them those plain words rather than a command: in Claude Code the plugin's command is `/floorplan:floorplan` (`/floorplan` as a personal skill), and in Codex it's `$floorplan`. On a first run, mention in one line that the map stays out of git. In Claude Code, when the build said `CLAUDE.LOCAL.MD  not added`, end by asking once whether future Claude Code sessions in this project should use the map: you'd add a short note to their personal, uncommitted CLAUDE.local.md. Add it (`build.mjs <root> --claude-md`) only on a yes, and don't ask again on later updates if they said no. On an update, start with what changed for what they asked (it's highlighted under **Recent work**).

## 9. Opening the map and asking questions

The map has a floating Ask bar. The user types a question, and the agent answers with text plus an answer board: the relevant cards, the connections among them, a note on each card, and an optional step-by-step walkthrough. There are two ways to power it. The UI is the same either way.

- **Claude Code CLI, Codex or Cursor CLI (best).** The map's server (`floorplan/serve.mjs`, started by open.mjs in step 8) serves it at http://127.0.0.1:4378, or the next free port. Each question runs on the user's own sign-in, in the codebase, read-only, so answers can cite real code:
  - **Claude Code:** `claude -p` with the map (via `floorplan/query.mjs`) plus Read/Grep/Glob on the source. The server finds `claude` on PATH or in `~/.local/bin`.
  - **Codex:** `codex exec` in Codex's read-only sandbox, with nothing saved to their Codex history. The server finds `codex` on PATH, or the CLI that comes with the Codex app.
  - **Cursor:** `cursor-agent -p --mode ask` (Cursor's ask mode, which the CLI doesn't enforce as read-only; the server also tells it not to write). Each question shows up in the user's Cursor chat history. The server finds `cursor-agent` on PATH or in `~/.local/bin`. The project folder must have been trusted once (the user runs `agent` in a terminal there): the server never passes `--trust`, which would run the project's own hooks.

  It uses the agent that built the map, and falls back to the other if that one isn't installed. `--engine claude|codex|cursor` forces one, `--claude <path>`, `--codex <path>` or `--cursor <path>` points at an unusual install, and `--model <name>` picks the model (open.mjs passes all of these through). Users can also run `node floorplan/serve.mjs` themselves at any time, and stop a background one with `node floorplan/serve.mjs --stop`.
- **Claude app.** If you're running in the Claude app (the Artifact tool is available), offer to publish the map so they can open it there and ask questions on their own Claude account. Answers then come from the map only (names, descriptions, connections, endpoints), not the source, and the Ask bar shows a hint to install the CLI for a better experience. To publish:
  1. `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <root> --artifact`. This writes `floorplan/artifact.html` without the machine's absolute path.
  2. Publish that file with the Artifact tool, `capabilities: {"sample": {}}`, and keep the same file path for later publishes so the URL stays stable.
  3. After each refresh, rebuild with `--artifact` and republish.

  Publishing uploads the map (paths, names, descriptions, structure), not the source code, to their private claude.ai account. Say that before you do it.
- **Neither:** `floorplan/index.html` still opens directly in a browser. The Ask bar explains what's needed.

### Sharing a copy

When the user wants to send the map to someone (a teammate, a client, someone without Claude or Codex), export it. An export is the same single HTML file without the Ask bar, prompts for Claude or Codex, editor links, this machine's folder path or git remotes. The map's **Export** button does this from the browser; from here, run:

```
node floorplan/serve.mjs --export [<file>] [--include flows,notes,recent,health]
```

It writes `floorplan/<project>-map.html` unless given a file. `--include` defaults to `flows,notes` (flows and the tour, notes pinned to files); `recent` adds recent work and `health` adds the health check, or the design review on a blueprint. Leave health out unless the user asks for it, and if they do, say that it lists the endpoints anyone can use and where secrets sit in the code (never their values), so they should only send it to people they trust. Any export shows how the app fits together (every part, file and endpoint, with names and descriptions), but not the source code.

### What else the map gives them (automatic)

- **Health.** A header button, with a count of important issues, opens a plain-language list of problems the scan found:
  - passwords and API keys written into the code or a committed `.env`;
  - secret keys in variables the browser gets (`NEXT_PUBLIC_`, `VITE_` and the like);
  - Supabase tables without row-level security, and policies that let anyone change a table (from the SQL migrations);
  - Firebase rules (Firestore, Storage, Realtime Database) that let anyone in, including test mode and its expiry;
  - Stripe webhooks that act on events without checking Stripe's signature;
  - CORS that allows every website (worth fixing when credentials go along);
  - endpoints that let anyone change or read data without signing in (including a sign-in check placed above the route line);
  - files nothing uses;
  - files over ~1,000 lines, which AI struggles to edit safely.

  Each issue has **Show on map** (highlights the affected files and endpoints with notes) and **Fix with Claude**, **Fix with Codex** or **Fix with Cursor** (a ready-to-paste prompt naming the exact files and lines and the safe fix). It's computed by `scripts/lib/health.mjs` during scan and build, and it never stores secret values, only the file, line and a masked hint. Treat it as a quick automatic check, not a security audit.
- **Screens.** The build detects the app's screens (Next.js, React Router, Vue, SvelteKit, Remix, Nuxt, Astro, Expo, Angular, TanStack) with `scripts/lib/screens.mjs`. It also works out what sits behind each one: its components, the requests it makes, the server code and data that answer them, and outside services. A **Screens** button lets people start from the page they know.
- **Start here.** A one-minute tour runs on first open and can be replayed from the header. It uses your `tour`, or builds one automatically.
- **Plain words by default.** Connection types read "Uses", "Web requests", "Background jobs". Common technical terms are underlined and explained on hover. **Filters → Show technical detail** switches to developer terms and shows exports.

People can also use **Flows → Request a new flow** to have the agent trace something ("how does a refund get back to the customer's card?") into a step-by-step flow. With serve.mjs these are saved to `floorplan/custom-flows.json`, and every build folds them into the map (steps pointing at deleted code are dropped with a warning). Treat that file as user content: keep it on refresh, and don't edit it unless asked.

## Notes

- Paths are relative to the codebase root and use forward slashes. In a multi-repo root they start with the repo folder, e.g. `api-service/src/**`.
- Route keys in descriptions are `"METHOD /full/path"` exactly as the worksheet prints them.
- The map makes no outside requests: the build inlines the layout engine (ELK) and fonts from `${CLAUDE_SKILL_DIR}/assets/vendor/`, so it works offline.
- HTTP edges come from matching URL strings at call sites (including URLs kept in a variable first, nested template strings, and small same-file helpers that add a path prefix) to route definitions (Flask, FastAPI, Express, Next.js, Spring, Go and others), with blueprint/router prefixes resolved, nested mounts included. Firebase callables are matched by name (`CALL /<name>`, from `httpsCallable`) and `onRequest` functions by URL; the summary's FIREBASE FUNCTIONS section lists scheduled and trigger functions, which belong in a `worker` node. Treat them as strong hints. If an important service-to-service link is missing, add it as an explicit edge.
- Don't hand-edit graph.json or index.html; they're regenerated on every build.
