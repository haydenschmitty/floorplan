# Floorplan in Hermes

Floorplan is a native Hermes plugin: one shared skill, one on-demand `hermes floorplan` command, and the same map, Blueprint and Health features as in Claude Code and Codex. Nothing runs on its own.

## What gets installed

The plugin is the whole repository. Its runtime is three native files plus the shared skill:

| Path | What it is |
|---|---|
| `plugin.yaml` | the Hermes manifest: name, version, `provides_hooks: []`, no MCP servers, no tools, no pip dependencies |
| `__init__.py` | registration: one skill (`floorplan:floorplan`) and one CLI command (`hermes floorplan`) |
| `hermes/runner.py` | the model-free `probe`, and the bounded `ask` worker |
| `skills/floorplan/` | the shared skill, its scripts and assets (the same files Claude Code and Codex use) |

`tools/checksums.mjs` lists all of them, so each release's `CHECKSUMS.txt` fingerprints them. `tests/supply-chain.test.mjs` fails if the plugin grows a hook, an MCP server, a tool, a pip dependency, a network import, a subprocess, or a file read that follows a symlink.

## Install one profile from an immutable SHA

Use the 40-character commit SHA of a release (its `floorplan--v<version>` tag), never a branch:

```bash
hermes --profile <profile> plugins install haydenschmitty/floorplan --ref <40-character-sha> --no-enable
node tools/checksums.mjs --check <installed plugin folder>     # every file identical
hermes --profile <profile> plugins doctor <installed plugin folder> --ci
hermes --profile <profile> plugins enable floorplan
```

`--no-enable` installs without turning the plugin on, so checksums and `plugins doctor` run before anything loads. Restart that profile's owning process the way you normally do (Desktop, TUI or gateway), and only that profile. Do not mass-roll out every profile.

Hermes scans every plugin from outside its catalog as it installs it, and blocks a community plugin whose verdict is CAUTION. Floorplan's verdict is CAUTION: the findings are the vendored layout engine (`skills/floorplan/assets/vendor/elk.bundled.js`, minified code that reads as obfuscated), the skill's `!`-prefixed status line (it reads as a command to run), the plugin icon's size, and words in the docs and tests. So in a terminal the first install asks `Install anyway? Only continue if you trust the source. [y/N]`, and without one it stops with `BLOCKED … Use --force to override`. Read the findings, then answer `y`, or run the same install command again with `--force`. Nothing in the plugin runs at install: it has no hooks and no dependencies.

Run the checksum check from a clone of that same release: its `CHECKSUMS.txt` and `tools/checksums.mjs` are the reference. Between releases `CHECKSUMS.txt` still describes the last release, so a commit that isn't a release (a pull request's, say) fails the check. The installed folder is `<HERMES_HOME>/plugins/floorplan`; each profile has its own `HERMES_HOME`, its own enabled list and its own installed bytes. Installing or enabling in one profile does not change another.

`plugins doctor --ci` is necessary, not sufficient: it parses the manifest, imports the plugin, runs its registration and reports its hook/tool/MCP counts (none here). It does not prove a provider route, a source read or an inference.

## Use it

In a Hermes session in the project folder:

```
/floorplan:floorplan
```

The registered skill is the shared `skills/floorplan/SKILL.md`; it reads and writes only map-owned files, as in the other engines. For repeatable one-shot generation:

```bash
hermes --profile <profile> chat --skills floorplan:floorplan --query-file <request-file> --oneshot
```

At the map's server, the profile and model are explicit:

```bash
node floorplan/serve.mjs --engine hermes --profile <profile> --model <model> [--hermes /path/to/hermes]
```

`hermes --profile <profile> floorplan probe` prints what the install registered (plugin version, protocol, profile, skill folder, Python and OS, `ask: ready` or `unsupported_runtime`) without a model call or a credential.

## What the browser Ask can read

Ask runs in a Hermes worker with no tools. The worker asks the map's server for one lookup at a time, and the server does the reading.

- **Normal source reads:** only a file that belongs to the map's own scan/code graph is eligible. A path that was never scanned is denied, even if it is under the project root.
- **Always denied:** `.git`, `.hermes`, `.env*`, key and credential files, instruction files (`AGENTS.md`, `SOUL.md`, `CLAUDE*.md`), symlinks, FIFOs, absolute paths and any `..`.
- **A blueprint is the only exception, and it is exactly three files:** `floorplan/plan.json`, `floorplan/architecture.json`, and the one PRD path named in `plan.json`'s `source`. Nothing else outside the scanned code is readable, and the PRD is pinned from the plan bytes this request classified, never from a lookup.

Every blueprint input is classified with a fresh full `findIssues` scan of the actual bytes. The worker then receives the classified bytes and their SHA-256, and issues a single-use ticket naming that hash, the root digest and the mode. The server opens the file again through a confined descriptor (`O_NOFOLLOW` on every component) and refuses the read if the SHA-256 changed. A file swapped between classification and reading is refused; no new bytes reach the model.

A read returns at most 32 KiB and at most 200 lines: a 200-line window passes, 201 fails. Known secrets are redacted inside the same verified buffer, and a whole file that looks private is refused rather than sliced.

## What is sent to the model

The question, the map overview, and the permitted, redacted source text are sent to the provider configured for the selected Hermes profile. That is the same account and route the rest of your Hermes work uses.

The host may route a request to a fallback model. The answer records the provider and model the host actually returned, and the map shows that attribution; it is not a promise that the requested model answered. Floorplan adds no provider, auth or analytics layer, and nothing is sent when you do not ask.

## Stopping a request

**Stop** is local and bounded: the map's server kills that request's worker process group, including descendants, within five seconds. Late output is ignored and cannot mutate the map. It does not cancel or refund provider-side compute that has already run.

## Stale prose after body-only edits

A refresh re-reads structure and changed files. A change that only edits prose inside a function body does not necessarily refresh the description of that file. The refresh report says so; edit `architecture.json` or `descriptions/` yourself if you want different wording.

## Changing a blueprint from the map

Change is offered only for a blueprint, not for a map of real code. The worker stays read-only: it returns the whole updated plan and architecture, and the map's server validates them with the skill's own `plan.mjs` and `build.mjs`.

Publication writes **only map-owned files**: `plan.json`, `architecture.json`, `recent-work.json`, and the generated map files (`graph.json`, `index.html`, `serve.mjs`, `query.mjs`, `page-safety.mjs`, `hermes-boundary.mjs`, `.cache/skill.json`, `.cache/scan.json`, `.gitignore`). It never writes application code, never writes outside `floorplan/`, and never overwrites an occupied live path.

The protocol is staged and preserve-first:

1. Validate and build the candidate in `floorplan/.cache/change-<request-id>/`.
2. Move each actual live entry into its own slot under `.cache/history/<id>/held/`, verify it, then `link` the staged file into the now-empty live path.
3. On success, write `.cache/history/<id>/manifest.json` and send one reload. On failure, restore exclusively where possible and retain every displaced inode under `displaced/` with an explicit conflict path in the manifest.

Sites that already hold an open descriptor keep reading the old inode. Publication is a sequence of moves and links, not a transaction: there is **no atomic compare-and-swap**, no global multi-file atomicity, and a concurrent writer can observe the intermediate sequence. A Change, including its one validation retry, gets 300 seconds.

Preservation entries (a history folder with a `manifest.json`) are recovery and Undo sources and are **never pruned** automatically. Older pre-manifest snapshots keep the last 20. The retained inodes and staged copies cost disk space; delete old history folders yourself, only after every writer has stopped.

## Upgrade and rollback

Before upgrading: record the installed SHA and checksums, stop that map's workers and server, and back up the user-owned `plan.json`, `architecture.json`, `descriptions/`, `custom-flows.json`, `recent-work.json` and `health-dismissed.json`.

Then install the new release's SHA with the same install command plus `--force`, which replaces the installed copy and leaves the plugin enabled or disabled as it was. Run `plugins doctor --ci` and `checksums.mjs --check` again, rebuild the map with an explicit `--agent hermes` (which regenerates `serve.mjs` and `hermes-boundary.mjs`), reopen it and repeat the smoke.

An older generated server that meets a newer installed plugin protocol reports **`protocol_mismatch`** and refuses to run Ask; rebuild the map. A generated map never embeds a path to the Python runtime, so a map can be reopened after a plugin upgrade.

Rollback installs the recorded previous SHA, regenerates matching helpers and repeats the checksums and smoke. Map content is restored from the backup only if needed; no git source in the mapped application changes.

## Disable and uninstall

Stop the map's workers and server first, then:

```bash
hermes --profile <profile> plugins disable floorplan
hermes --profile <profile> plugins remove floorplan
```

Neither command deletes `floorplan/`, your notes, `descriptions/`, saved flows, dismissals, `.cache/history/` conflict records, or `~/.floorplan/settings.json`. A map that only needs to be read still opens as `floorplan/index.html`, offline, with no Ask bar. Another profile's enabled list and installed bytes are untouched.

## Remote viewing: a same-port tunnel, never a reverse proxy

The server listens on `127.0.0.1` only and accepts only the `Host` `127.0.0.1:<port>` or `localhost:<port>`; a request that carries an `Origin` must match that host, and one without an `Origin` is accepted. That is deliberate; a preview domain is refused even with a valid token.

From the laptop, tunnel the same port:

```bash
ssh -N -L 127.0.0.1:<P>:127.0.0.1:<P> <host>
```

Then open `http://127.0.0.1:<P>`. Host and Origin stay equal to the server's own port, so the guards keep working. If `<P>` is busy on the laptop, restart the server on another free port and tunnel that same port. A failing check:

```bash
curl -s -o /dev/null -w '%{http_code}' -H 'Host: preview.invalid:<P>' http://127.0.0.1:<P>/
# 403
```

## Support matrix

| Surface | Support contract |
|---|---|
| Linux and macOS, Hermes on POSIX Python | documented and tested; a real install, doctor, source read and model route still have to pass on the host before you rely on it |
| Windows native Hermes Ask | **not supported**: the worker returns `unsupported_runtime`; the map still works offline |
| WSL | only when Hermes, the plugin and the map all run inside WSL; a Windows test says nothing about it |
| Shared Node scanner/build/viewer, Claude Code and Codex | unchanged: Node 18, 20 and 22 on Linux and Windows, Node 22 on macOS, plus Linux Node 24 |
| Other Hermes builds and providers | the capability probe detects a missing API; install plus `plugins doctor` does not prove a provider route or structured output |

## Troubleshooting

- **`unsupported_runtime`**: the worker is on a runtime without POSIX confined reads (native Windows). Use the map offline, or run inside WSL/macOS/Linux.
- **`protocol_mismatch`**: rebuild the map with the installed plugin.
- **`profile_mismatch`**: the running server and the plugin disagree about the profile; restart `serve.mjs` with the same `--profile`.
- **Ask is unavailable after an upgrade**: `plugins doctor --ci`, then rebuild the map so its generated helper matches the installed protocol.
