# Running Floorplan without an agent session

Floorplan is made to run inside Claude Code or Codex, with you there. It can also run on its own: in CI, in a script, or from your own tooling, with any model that can read files and return JSON. This guide covers the three things that make that work:

- **Unattended mode**, which keeps Floorplan to its own folder and makes failures fail;
- **`--json`**, which gives each script's result as data instead of a report;
- **the workflow file**, `skills/floorplan/workflow.json`, which describes every step as data so a small program can follow it.

The scripts never call a model, here or anywhere else. They do everything mechanical. A model only ever writes three kinds of JSON file: `floorplan/architecture.json`, `floorplan/descriptions/<key>.json` and `floorplan/recent-work.json`. In an agent session the agent does that; without one, your program asks a model and writes its answer.

## Unattended mode

Switch it on with an environment variable:

```bash
export FLOORPLAN_UNATTENDED=1
```

or pass `--unattended` to a script, which sets the same thing for it and for the scripts it runs (`refresh.mjs` runs `scan.mjs` and `build.mjs`). In unattended mode:

- **Nothing is written outside `floorplan/`.** No `CLAUDE.local.md`, no line in `.git/info/exclude`, no moving an old Floorplan section out of `CLAUDE.md`, and an old `show-code/` map is left where it is. Git is run with `--no-optional-locks`, so even `git status` leaves the repo's own files alone.
- **The map names no agent.** It records `"agent": "none"`, so its Health and blueprint buttons say "Fix with AI" and "paste it into your AI coding agent" instead of naming Claude or Codex. You can also set `FLOORPLAN_AGENT=none` on its own. Naming an agent (`--agent claude`, `FLOORPLAN_AGENT=codex`) still wins. If the map's server is running, it names the CLI it found, as it always has.
- **`open.mjs` starts nothing.** Nobody is there to look, so it starts no server and opens no browser.
- **Failures fail.** See [Exit codes](#exit-codes).

Everything else is the same: the scan, the map, Health, the descriptions. Without unattended mode, nothing about how Floorplan behaves changes.

### When git can't list a repo's files

The scan finds files with `git ls-files`. If git isn't installed, or refuses a checkout because a different user owns the folder ("dubious ownership", common in containers), that repo used to add nothing to the map without a word. Now the scan says so, for everyone:

```
! PROBLEMS (1): the map will be missing files until these are fixed
  ! shop-web adds no files to the map: git refuses this checkout because a different user owns the folder ("dubious ownership"), which is common in containers. Mark it safe, then scan again: git config --global --add safe.directory "/work/shop-web"
```

In unattended mode it's an error instead: the scan exits 1 without writing anything, naming the repo and the likely fix. Finding no files at all is an error there too.

## Results as JSON

`scan.mjs`, `build.mjs`, `describe.mjs`, `refresh.mjs`, `recent.mjs` and `status.mjs` take `--json`. With it, a script prints exactly one JSON object on stdout and nothing else there. Anything for a person goes to stderr.

Every object has:
- `schema`: what it is, e.g. `"floorplan/build-result@1"`;
- `ok`: whether it worked;
- `errors` (a list of messages) when it didn't.

Most also carry the human report as text (`report`, `summary` or `text`), which is what a model needs to see when it has something to fix. Paths are relative to the codebase root, with forward slashes. `--json` and `--unattended` never take a value, so `--json /path/to/project` works.

### scan.mjs: `floorplan/scan-result@1`

| Field | What it is |
|---|---|
| `repos[]` | `path`, `name`, `branch`, `head`, `files`, and `listed`: false when git couldn't list it |
| `counts` | `files`, `outsideRepos`, `byCategory` (code, config, docs…), `code` ({ files, loc }), `byLanguage`, `routes`, `httpMatches`, `importEdges`, `unresolvedImports`, `externalPackages`, `notRead` |
| `problems[]` | `{ code, message }`: `git_failed` (with `repo` and git's own `error`) or `no_files` |
| `warnings[]` | the problems' messages, when they aren't errors |
| `summary` | the summary a model maps from: the same text the scan prints |
| `scanFile` | where the scan was saved (`floorplan/.cache/scan.json`) |

### build.mjs: `floorplan/build-result@1`

| Field | What it is |
|---|---|
| `errors[]`, `warnings[]` | everything the build found wrong with architecture.json or the descriptions, in the words it prints |
| `files` | `total`, `unassigned`, `unassignedPercent` (one decimal), `include` |
| `unassignedByDirectory[]` | `{ dir, files }`, biggest first |
| `nodes[]` | the top-level parts: `id`, `kind`, `files`, `loc` |
| `links` | `total` and `byKind` (import, http, …) |
| `descriptions` | `files` and `routes` as `{ described, total }`, `modules` ({ withSummary, total, missing }), `review` (entries still flagged), and `complete`: every file and endpoint described and nothing left to review |
| `plainLanguage` | developer words in node labels and summaries on a map for everyone: `checked` (false when `audience` is `developers`), `count` (parts with any) and `items[]` ({ node, field: `label` or `summary`, term, say }). Each part also gets a `plain language:` line in `warnings[]`. Never an error |
| `partsToSplit[]` | parts with no children and more than 24 files that sit in several folders of their own: `{ id, files, folders: [{ dir, files }] }`, also in `warnings[]` |
| `secretsHidden[]` | `{ file, field }` for each piece of written text that looked like it held a secret and went into the map as «hidden», e.g. `{ "file": "descriptions/api.json", "field": "files[\"api/server.js\"].description" }`. Never the value. Each file also gets a `secret-looking text in …` line at the top of `warnings[]`. A warning, never an error; the files themselves are left as they are |
| `health` | `kind` (`health`, or `design-review` for a blueprint), `high`, `medium`, `low`, and `important[]` ({ severity, kind, title }); `null` when there's none |
| `screens` | how many screens were found |
| `recentWork` | `cards` and `tasks` highlighted, and whether `recent-work.json` exists |
| `agent`, `audience`, `blueprint`, `unattended`, `check` | how it was built |
| `notes` | `claudeLocalMd`: what happened to `CLAUDE.local.md`, if anything (never anything in unattended mode); `git`: a warning when git already tracks files in `floorplan/` |
| `wrote[]` | the files written in the map folder; empty when there were errors or with `--check` |
| `report` | the build's report |

If the build stops on something it didn't expect (a file it can't write, say), it still prints one object and exits 1: `ok` is false, and `errors` holds one line like `build stopped unexpectedly (EACCES); see stderr`, with `warnings` (empty) and `report` and none of the other fields. The details are on stderr only, because they can quote your files.

### describe.mjs: `floorplan/describe-result@1`

| Field | What it is |
|---|---|
| `nothingToDo` | true when every file and endpoint already has a description (still `ok`, exit 0) |
| `worksheets[]` | one per worksheet: `key`, `node` (its label), `nodeId`, `part` and `parts` when a big part was split, `files`, `routes`, `loc`, `worksheet` (the worksheet's path) and `descriptions` (the file to fill in) |
| `totals` | `worksheets`, `files`, `routes` |
| `audience`, `style` | who the descriptions are for, and the style line each worksheet starts with |

### refresh.mjs: `floorplan/refresh-result@1`

| Field | What it is |
|---|---|
| `map` | false when there's no map to refresh |
| `changes` | `files` ({ new, deleted, moved, edited, digestChanged }), `routes` ({ new, removed, repathed }), `descriptions` ({ carried, removed, flagged }), `large`, and `fingerprints` (false for a map too old to compare edits) |
| `newFilesByDirectory[]` | `{ dir, files }` |
| `build` | the build's own `--json` result, in full |
| `next[]` | what's left to do, in order, each `{ code, text }` plus details |
| `report` | the refresh's report |

The NEXT codes are stable, so a program can act on them:

| Code | Means | Details |
|---|---|---|
| `fix_build` | the build failed; fix architecture.json | `errors` |
| `assign_new_files` | files landed outside every part; add globs or a part | `directories` |
| `describe` | run describe.mjs and fill in what it lists | `missing` ({ files, routes }), `review` |
| `review_structure` | a large change; check the summaries and flows | |
| `recent_work` | always last: mark recent work | |
| `first_map` | there's no map yet; make one | |
| `fix_scan` | the scan stopped (unattended mode only); see `errors` | |
| `fix_plan`, `blueprint` | blueprints only (see [How it works](how-it-works.md#blueprints)) | |

### recent.mjs: `floorplan/recent-result@1`

`changedSinceMap` (new, edited, moved and deleted files and endpoints since the previous map, or `null`), `since`, `current` (the recent-work.json there now), and `repos[]` with `uncommitted[]` (`status`, `path`) and `commits[]` (`hash`, `date`, `subject`, `files[]`). Every path comes with the `card` it shows up as on the map (`name`, `node`, `nodeLabel`, `endpoints`), or `null` when it isn't on the map. `nothingRecent` is true when there's nothing at all, and `text` is the report a model reads.

### status.mjs: `floorplan/status-result@1`

`state` is `none`, `unbuilt` (architecture.json but no map), `map`, `blueprint`, `blueprint-started` or `unknown` (the map couldn't be read). For a map: `builtAt`, `files`, `nodes`, `agent`, and `repos[]` with `sameCommit`, `changedFiles` and `uncommitted` (or `compared: false` when there's no commit to compare). `status.mjs` never fails.

## Exit codes

`0` means the step worked, including when there was nothing to do (the JSON says so: `nothingToDo`, `nothingRecent`). Anything else means it failed.

| Script | Without unattended mode | In unattended mode |
|---|---|---|
| `scan.mjs` | 1 only on a crash; git problems are reported, not failed | also 1 when git can't list a repo, or no files are found |
| `build.mjs` | 1 on errors, or no scan or architecture.json | the same |
| `describe.mjs` | 1 without a map; 0 when there's nothing to describe | the same |
| `refresh.mjs` | 0, even with no map or a failed build (the NEXT list says what to do) | 1 when there's no map, the scan fails or the build fails |
| `recent.mjs` | 1 without a map | the same |
| `status.mjs` | always 0 | the same |

`--json` changes only what's printed, never the exit code.

## The workflow file

`skills/floorplan/workflow.json` (`"schema": "floorplan/workflow@1"`) is SKILL.md's process as data: everything a program needs to make a map, or bring one up to date, with any model. It has:

- **`conventions`**: how to run a script, what exit codes mean, how results are saved and read, how answers are checked and written, and the four tools a model gets: `read_file`, `list_files`, `grep` (all read-only, inside the codebase) and `submit` (its answer).
- **`format`**: what each kind of step means. A step runs a script, runs a model job (once, or once per item, possibly in parallel), writes a fixed file, repeats some steps until a check passes (at least `minAttempts` times when given), or follows refresh's NEXT list. A job or repeat step marked `optional: true` may fail without failing the run: the driver puts the files in its `restore` list back as they were, runs its `onFail` steps, records `{ step, reason }` in the run's notes and carries on. A job with `onlyChange: { file, fields }` may change only those fields of that file (`nodes[].label` means every node's label); any other difference is sent back to the model like a schema problem.
- **`start`**: run `status.mjs --json` and pick `first_map` or `refresh`.
- **`workflows`** and **`procedures`**: the steps.
- **`jobs`**: one per kind of model work: `architecture`, `plain_language`, `update_architecture`, `descriptions` and `recent_work`. Each lists the reference files to give the model, its instructions (written for a model with only those tools and nobody to ask), its inputs, the file its answer becomes, and the name of its answer's schema.
- **`schemas`**: a JSON Schema for each kind of answer.

The jobs point at the reference files in `skills/floorplan/references/` rather than repeating them, so the format and the style guide have one source, shared with SKILL.md.

### How a first map goes

1. `scan.mjs --json`. The model gets its `summary`.
2. The `architecture` job: the model reads `schema.md`, `choosing-boundaries.md` and `writing-descriptions.md`, looks around the code with its tools, and submits architecture.json. Then `build.mjs --json`. Until `build.ok` is true and `files.unassignedPercent` is under 10, the job runs again, now also given its last architecture.json and the build's `report`. Up to 4 attempts. Then, if `plainLanguage.count` is above 0, the `plain_language` job gets architecture.json and that report, to reword only the labels and summaries its `plain language:` warnings name; the driver rejects an answer that changes anything else (`onlyChange`), and the build checks it still passes. This step is `optional`: if the model gives no valid answer, or the reworded file doesn't build cleanly after 2 attempts, the driver puts back the architecture.json that built, rebuilds, notes it and carries on. Words left after that stay warnings: they never fail the run.
3. `describe.mjs --json`, then one `descriptions` job per worksheet, in parallel if you like: the model gets the worksheet (which quotes the code of each endpoint and of very short files) and the file to fill in, and submits it filled in. Then build. This repeats until `descriptions.complete` is true (describe.mjs lists only what's still missing). Up to 3 attempts.
4. `recent.mjs --json`. If `nothingRecent`, write `{ "tasks": [] }`; otherwise the `recent_work` job turns its `text` into recent-work.json. There's no conversation to go on, so the input is what changed since the last map, uncommitted changes and recent commits. Then build.

### How a refresh goes

`refresh.mjs --json`, then, for each item in `next`, the procedure for its code: `fix_build` and `assign_new_files` run the `update_architecture` job until the build passes its check, `describe` and `recent_work` run as in a first map, and so on. A code the file doesn't know fails the run, so a newer Floorplan can't be silently half-followed.

### A worked example

With a two-repo shop in `/work/shop`:

```bash
export FLOORPLAN_UNATTENDED=1
S=/path/to/floorplan/skills/floorplan

node $S/scripts/status.mjs /work/shop --json      # "state": "none", so first_map
node $S/scripts/scan.mjs /work/shop --json        # hand "summary" to the architecture job
# ... write the model's answer to /work/shop/floorplan/architecture.json ...
node $S/scripts/build.mjs /work/shop --json
```

The build answers, in part:

```json
{
  "schema": "floorplan/build-result@1",
  "ok": true,
  "files": { "total": 8, "unassigned": 2, "unassignedPercent": 25, "include": ["code"] },
  "unassignedByDirectory": [{ "dir": "shop-web/src", "files": 2 }],
  "descriptions": { "files": { "described": 0, "total": 8 }, "routes": { "described": 0, "total": 4 }, "complete": false },
  "report": "ASSIGNMENT  8 files (code), 2 unassigned (25.0%)\n  ..."
}
```

25% is over the limit, so the driver runs the architecture job again with that `report`, and builds again. Then:

```bash
node $S/scripts/describe.mjs /work/shop --json
```

```json
{
  "schema": "floorplan/describe-result@1",
  "ok": true,
  "nothingToDo": false,
  "worksheets": [
    { "key": "api", "node": "Main server", "files": 6, "routes": 4, "worksheet": "floorplan/.cache/worksheets/api.md", "descriptions": "floorplan/descriptions/api.json" },
    { "key": "web", "node": "Website", "files": 2, "routes": 0, "worksheet": "floorplan/.cache/worksheets/web.md", "descriptions": "floorplan/descriptions/web.json" }
  ]
}
```

Two `descriptions` jobs, one per worksheet, each writing its `descriptions` file. Build again until `descriptions.complete`, then recent work, and the map is `floorplan/index.html`.

[`tests/unattended.test.mjs`](../tests/unattended.test.mjs) has a complete driver in about a hundred lines, following the file with canned answers in place of a model. It's a good place to start your own.

### What a driver is responsible for

- Running each model job with only the tools the file lists, inside the codebase, read-only, and no network.
- Checking each answer against its schema (and its job's `onlyChange`), sending the problems back, and writing the accepted answer itself. The model never writes files.
- Honouring `optional` steps: a failed one puts its `restore` files back, runs `onFail`, and is noted, never fatal.
- Keeping secrets out of what it writes. The model reads the code, secrets included, so a fooled or careless one can copy a key into a description. The build masks such text before it reaches the map (see `secretsHidden` above), but the answer files keep what was written. To keep them clean too, run each answer's text through the same check before writing it:
  ```js
  import { maskSecrets } from '/path/to/floorplan/skills/floorplan/scripts/lib/health.mjs';
  const safe = maskSecrets(text);        // text written by a person or a model
  if (safe !== text) { /* it held something secret-looking: write `safe`, or send it back as a problem */ }
  ```
  `maskSecrets(text)` returns the text with every value that is or might be a secret replaced with `«hidden»`, and the same text when there's none. It's a stable export, checked by the tests. (With a second argument, `{ path, lang, category }`, it treats the text as that file's source code instead.)
- Patterns in architecture.json (`paths`, `exclude`, `ignore`, `packages`, `hosts`) that aren't valid, are over 300 characters, have more than 12 wildcards or 8 `{…}` groups, or number over 500 in one list, are build errors that name them (`nodes[3] ("web").paths[0] "[evil" is not a valid pattern: …`), so they go back to the model like any other.
- Limits: time, cost and how many tool calls a job may make (each job suggests a `toolCalls` budget).
- What happens to the map afterwards. `floorplan/.cache/` holds digests of the code (the scan, the worksheets, which quote short pieces of it with secrets masked), so don't publish it. `graph.json` includes this machine's folder path and the repos' remotes. To share a map, make an export, which leaves those out: `node floorplan/serve.mjs --export [file] [--include flows,notes,recent,health]`.

## What isn't covered

- **Blueprints**, maps planned from a PRD, need a person to answer questions, so the workflow file doesn't make them. A refresh of an existing blueprint still works.
- **Asking questions on the map**, requesting flows and changing a blueprint from the map need the map's server and Claude Code or Codex, as usual.

## Keeping it working

[`tests/unattended.test.mjs`](../tests/unattended.test.mjs) runs a whole first map and a refresh by following `workflow.json`, using only `--json` output and exit codes, and checks that unattended mode writes nothing outside `floorplan/`, that the map names no agent, and that git failures fail loudly. When you change how SKILL.md makes a map, change `workflow.json` to match. A new NEXT code in `refresh.mjs` needs a handler in `workflow.json` and a line in the table above; the test fails until it has one.
