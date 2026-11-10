# architecture.json schema

`floorplan/architecture.json` describes the structure: subsystems, modules, external services, flows. Names and descriptions for individual files and routes go in `floorplan/descriptions/*.json` instead (see [writing-descriptions.md](writing-descriptions.md)). They're kept separate so parallel agents can write them without conflicts. `build.mjs` checks both against the scan and reports problems by field.

Contents: [Top level](#top-level) · [nodes](#nodes) · [Assignment rules](#how-files-get-assigned) · [edges](#edges) · [annotations](#annotations) · [flows](#flows) · [Recent work](#recent-work) · [Full example](#full-example)

## Top level

| field | type | required | meaning |
|---|---|---|---|
| `$schema` | `"floorplan/architecture@1"` | no | marker |
| `project` | object | yes | `name` (string, required), `summary` (1–3 sentences), `entrypoints` (file paths) |
| `nodes` | array | yes | subsystems and modules. See below |
| `edges` | array | no | connections the scanner can't see |
| `annotations` | array | no | notes pinned to specific files |
| `flows` | array | no | guided walkthroughs through the board |
| `tour` | array | no | the "Start here" tour shown on first open: 3–8 stops `{ "node": "<node id or file path>", "title": "…", "note": "…" }`, in plain language, in the order a newcomer should see them. The first flow is appended automatically |
| `audience` | `"everyone"` \| `"developers"` | no | who names and descriptions are written for. Default `"everyone"`: plain language a non-technical owner understands (what it does for the business, in everyday words). `"developers"`: technical style for engineers |
| `include` | string[] | no | file categories to map. Default `["code"]`. Others: `config`, `docs` |
| `ignore` | string[] | no | globs for files to leave off the board entirely (generated code, vendored libs, fixtures) |

## nodes

Each node is a chip on the board. Hierarchy comes from `parent`. A node with no parent sits on the top-level board.

| field | type | meaning |
|---|---|---|
| `id` | string | unique; letters, digits, `_ - .`. Convention: dotted by parent (`api.orders`) |
| `label` | string | short display name ("Orders API") |
| `kind` | enum | `ui` `service` `worker` `library` `feature` `data` `config` `test` `script` `infra` `external` |
| `parent` | string | id of the enclosing node |
| `summary` | string | one sentence: what it's responsible for |
| `details` | string | optional longer notes; blank lines separate paragraphs |
| `paths` | string[] | globs claiming files (see below) |
| `exclude` | string[] | globs to carve files back out of `paths`. **Inherited by all descendants**, e.g. `"exclude": ["**/*.test.tsx"]` on a frontend node keeps co-located tests out of every child, so a separate Tests node can claim them |
| `packages` | string[] | **external nodes:** package names this node stands for, e.g. `"stripe"`, `"npm:@stripe/*"`, `"pypi:sqlalchemy"`. Imports of them become edges to this node |
| `hosts` | string[] | **external nodes:** hostnames called from code, e.g. `"api.stripe.com"`, `"*.squareup.com"`. Calls become `http` edges |
| `tags` | string[] | free-form, shown in the panel |

Kinds, briefly:
- `ui`: frontends and apps
- `service`: a deployable server
- `worker`: background jobs and queues
- `library`: shared code
- `feature`: a vertical slice inside a service or UI
- `data`: models, migrations, the DB layer
- `config`
- `test`
- `script`: one-off and ops scripts
- `infra`: deploy, CI, IaC
- `external`: databases and third-party APIs. These own no files.

### Glob syntax
- `**` matches any number of directories, `*` stays within one path segment, `?` matches one character, `{a,b}` is alternation.
- A whole folder name in brackets, like `[id]`, `[...slug]` or `[[...slug]]` (Next.js, SvelteKit), matches that folder literally: `app/orders/[id]/**`. Elsewhere, `[abc]` matches one of those characters.
- A pattern with no wildcard also matches as a directory: `backend/app` equals `backend/app/**`.
- Paths are relative to the codebase root. In a multi-repo root they start with the repo folder.
- A pattern must be valid (every `[` and `{` closed, ranges like `[a-z]` in order) and modest: at most 300 characters, 12 wildcards and 8 `{…}` groups, and at most 500 patterns in one list. Anything else is a build error naming the field, e.g. `nodes[3] ("web").paths[0] "[evil" is not a valid pattern: it has a "[" with no "]" to close it`.

### How files get assigned
Every included file goes to exactly one node:
1. Collect the nodes whose `paths` match the file and whose `exclude` doesn't.
2. The **deepest** node wins, so a child beats its parent. You can give a parent a broad glob (`web/**`) and children narrower ones; files no child claims stay on the parent.
3. Between nodes at the same depth, the glob with the longer literal prefix wins. Real ties are warned about.
4. Files no node claims go to an automatic **Unassigned** chip. Keep it under ~10%.

In the viewer, a node with more than ~24 files of its own groups them into folder chips automatically, so you don't need a node for every directory. Make a node when it means something.

## edges

Only add what static analysis can't find. Imports (`import`) and HTTP calls matched to routes (`http`) are already in the scan.

| field | type | meaning |
|---|---|---|
| `from`, `to` | string | node id **or** file path |
| `kind` | enum | `import` `call` `http` `rpc` `event` `queue` `data` `config` |
| `label` | string | short, e.g. `"POST /orders"`, `"order.paid"`, `"reads/writes"` |
| `description` | string | optional sentence shown when the trace is clicked |

Good candidates:
- service → database (`data`)
- publisher → queue → consumer (`queue` / `event`)
- webhooks coming in from third parties (`http`, from the external node to the handler)
- cron/scheduler → job (`call`)
- Firebase background functions (schedules, Firestore/Storage/Pub/Sub triggers, from the scan's FIREBASE FUNCTIONS list) → a `worker` node; link the collection or topic that triggers them (`event`)
- calls through env-configured base URLs that the matcher missed (`http`)

## annotations

`{ "path": "<file>", "note": "…", "tags": ["hotspot"] }` pins a note to a file. The file's chip gets an accent outline. Use these sparingly, for god-files, tricky invariants, or deprecated code still in use.

## flows

```json
{ "id": "checkout", "title": "Checkout", "description": "optional",
  "steps": [ { "node": "web.cart", "note": "User clicks Pay" }, { "node": "api.orders", "note": "Creates the order" } ] }
```
- Each step's `node` is a node id or a file path. There must be at least 2 steps.
- The viewer moves to the board where each pair of consecutive steps is visible and animates a signal between them.
- Write the notes as a narration a new engineer would want.

## recent work

`floorplan/recent-work.json` is a separate file, rewritten on every make and update. It holds what was just worked on, framed against what the user asked for. The viewer gives those cards a green "Changed"/"New" tag, shows "N changed" on the parts containing them, adds each `note` to the card's hover, and lists the tasks under a **Recent work** button and in the overview panel.

```json
{
  "updatedAt": "2026-10-27T10:30:00Z",
  "tasks": [
    {
      "title": "Refunds from the order page",
      "request": "Let staff refund an order straight from its order page",
      "summary": "Staff can now refund all or part of an order from its page. The money goes back to the customer's card through Stripe, and they get an email. Refunds over $500 need a manager.",
      "items": [
        { "ref": "shop-api/app/services/refunds.py", "change": "new", "note": "New: works out how much to refund, sends it back through Stripe and records it on the order. This is the heart of what was asked." },
        { "ref": "POST /api/orders/<int:order_id>/refund", "change": "new", "note": "The request the Refund button sends; it checks the manager limit before anything is refunded." }
      ]
    }
  ]
}
```

| field | meaning |
|---|---|
| `tasks[].title` | 2–5 words, shown on hover and as the board title |
| `tasks[].request` | what the user asked for, in their words (shortened). Shown as "You asked: …" |
| `tasks[].summary` | 1–2 sentences: what was done toward it, and where it stands. Mention deletions here; deleted files aren't on the map |
| `items[].ref` | a file path, a node id, or `"METHOD /path"` exactly as on the map. Refs that aren't on the map are left out with a warning |
| `items[].change` | `"new"` or `"changed"` (default) |
| `items[].note` | 1–2 plain sentences: what changed on this card, and how it serves the request |

`{ "tasks": [] }` clears all highlights.

## Full example

A frontend repo and a backend repo side by side:

```json
{
  "$schema": "floorplan/architecture@1",
  "project": {
    "name": "Acme Shop",
    "summary": "Next.js storefront talking to a Flask API over REST; Postgres for storage; Stripe for payments.",
    "entrypoints": ["shop-api/app.py", "shop-web/src/app/page.tsx"]
  },
  "ignore": ["shop-api/migrations/versions/**"],
  "nodes": [
    { "id": "web", "label": "Storefront", "kind": "ui", "summary": "Next.js app router UI.", "paths": ["shop-web/src"] },
    { "id": "web.pages", "parent": "web", "label": "Pages", "kind": "feature", "paths": ["shop-web/src/app"] },
    { "id": "web.api", "parent": "web", "label": "API client", "kind": "library", "summary": "Typed fetch wrapper for every backend call.", "paths": ["shop-web/src/lib/api*"] },
    { "id": "api", "label": "Shop API", "kind": "service", "summary": "Flask REST API.", "paths": ["shop-api/app.py", "shop-api/app"] },
    { "id": "api.routes", "parent": "api", "label": "Routes", "kind": "feature", "paths": ["shop-api/app/routes"] },
    { "id": "api.models", "parent": "api", "label": "Models", "kind": "data", "paths": ["shop-api/app/models"] },
    { "id": "tests", "label": "Tests", "kind": "test", "paths": ["shop-api/tests", "shop-web/**/*.test.{ts,tsx}"] },
    { "id": "pg", "label": "Postgres", "kind": "external", "packages": ["pypi:sqlalchemy", "pypi:psycopg2"] },
    { "id": "stripe", "label": "Stripe", "kind": "external", "packages": ["stripe"], "hosts": ["api.stripe.com"] }
  ],
  "edges": [
    { "from": "stripe", "to": "api.routes", "kind": "http", "label": "webhooks", "description": "payment_intent.succeeded marks orders paid." }
  ],
  "annotations": [
    { "path": "shop-api/app/routes/orders.py", "note": "All order state transitions live here.", "tags": ["hotspot"] }
  ],
  "flows": [
    { "id": "checkout", "title": "Checkout", "steps": [
      { "node": "web.pages", "note": "Cart page submits the order" },
      { "node": "web.api", "note": "POST /api/orders" },
      { "node": "api.routes", "note": "Validates and creates the order" },
      { "node": "stripe", "note": "Creates a PaymentIntent" }
    ]}
  ]
}
```
