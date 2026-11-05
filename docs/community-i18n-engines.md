# Community additions: i18n, engine/model picker, Devin support, MCP

This document describes the enhancements layered on top of upstream Floorplan,
intended as a contribution. Everything is optional, backward compatible, and
keeps English as the default.

## What changed vs upstream

| Area | Upstream | This version |
|---|---|---|
| Language | English only | EN default + FR (optional), ~535-entry dictionary + regex templates for dynamic strings |
| Language choice | none | Flag button in header (SVG flags, scales to N languages) + first-visit picker; persists in `~/.floorplan/settings.json` |
| Engines | Claude Code, Codex | + Devin CLI (`devin -p`), + Devin Cloud API (REST), + "My own agent (MCP)" mode |
| Models | none | Per-engine model picker (local free / cloud paid), badge `· free`, persisted per engine |
| Engine labels | hardcoded | Local/cloud badges in the picker |
| First run | none | Welcome popup (language + engine + model + API key), ⚙ gear reopens it, never re-shows after `configured` |
| Sign-in failure | error banner only | Auto-test on load → guided popup: exact commands, "Start sign-in" (server runs `devin auth logout` + opens `devin auth login`), "I did it — check" re-tests; MCP fallback revealed automatically after a failed check |
| Auth commands | generic `devin auth login` | Real detected CLI path injected (`cliPath`) so commands are copy-paste ready |
| MCP | none | `scripts/floorplan-mcp.mjs` stdio server, 6 tools, key-free (CLI auth or `DEVIN_API_KEY` env) |
| Theme | auto → light → dark (3 states) | light ↔ dark (2 states) |
| API keys | none | `DEVIN_API_KEY` field in setup → written to project `.env`, `.env.example` template, never re-displayed |

## Settings (per user, not per project)

`~/.floorplan/settings.json`:

```json
{
  "lang": "fr",
  "engine": "devincloud",
  "configured": true,
  "useMcp": false,
  "models": { "devin": "swe-2-medium" }
}
```

`want` = requested engine; `engine` = actual running engine (honest fallback
when the requested CLI is missing). `useMcp` dims the Ask bar: the user's own
agent answers through `floorplan_ask`.

## Engines and models

`serve.mjs` `ENGINES` registry: each engine has `scope` (`local`/`cloud`),
`models[]` (with `free` flag and `defaultModel`), `find()`, `run()`,
and optionally `authCheck`/`authStart`/`authOpen` for the sign-in guide.

- `claude` — `claude -p`, models sonnet/opus/haiku
- `codex` — `codex exec`, GPT-5.2 Codex / mini
- `devin` — `devin -p`, free local models (SWE-2 family)
- `devincloud` — `assets/devin-api.mjs` → `api.devin.ai` sessions; model sent
  in the session payload
- `mcp` — pseudo-engine: keeps the UI but hands answering to the MCP server

### Cloud context digest

`devincloud` can't read local files. serve.mjs injects a bounded digest of the
map (project, every node/file summary, connections, up to 200 routes, ~60 KB
cap) into the prompt so cloud answers stay grounded.

## Endpoints

- `GET/POST /api/settings` — `{ lang, engine, configured, useMcp, devinKey,
  engines, engineNames, engineScope, engineModels, savedModels, model }`;
  POST accepts `lang`, `engine`, `useMcp`, `devinKey` (written to `.env`),
  `models`, `configured`.
- `POST /api/engine` — engine-only switch (kept).
- `POST /api/auth-check` — runs the engine's `authCheck` (e.g.
  `devin auth status`) or checks `DEVIN_API_KEY` presence; parses output text
  (exit code alone lies — `devin auth status` returns 0 while logged out).
- `POST /api/auth-start` — runs the engine's `authStart` then spawns `authOpen`
  detached so the CLI opens the user's browser itself.
- `cliPath` injected so the guide prints the real executable path.

## MCP server — `scripts/floorplan-mcp.mjs`

Dependency-free stdio server. Tools:

`floorplan_engines`, `floorplan_ask`, `floorplan_set_engine`,
`floorplan_set_model`, `floorplan_auth_check`, `floorplan_auth_start`.

Register in `.devin/mcp_config.json`:

```json
"floorplan": { "command": "node", "args": ["<repo>/skills/floorplan/scripts/floorplan-mcp.mjs"] }
```

No keys handled by the server itself: CLIs use their own auth, `devincloud`
reads `DEVIN_API_KEY` from env → project `.env` (searched upward) →
`~/.floorplan/.env`.

## i18n details

- `I18N.fr` dictionary + `TPL` regex templates (`{n}`, `{agent}` interpolation).
- `t()` exact/template lookup; `window.T(s, vars)` for `ui/*.js` helpers
  (exposed globally because `ui/*.js` scripts run outside the main IIFE —
  a plain `const T` was invisible to them).
- `translateDom()` + `MutationObserver` cover text nodes, `title`,
  `placeholder`, `aria-label`, `value` for everything rendered later.
- Inject is recomputed per request (`inject()` function, not a cached string),
  so changing language/engine/model reloads correctly; settings POSTs broadcast
  `reload` to open tabs.

## Honest limits

- `devin -p` needs `can_use_cli` on the account (paid tier); the guide detects
  it and offers the MCP fallback.
- Devin Cloud answers consume plan credits (real sessions).
- Some glossary descriptions remain English; health-check titles are data
  strings covered by dictionary entries as they're encountered.
- Repo test suite requires `git`; it wasn't runnable in the dev environment.
