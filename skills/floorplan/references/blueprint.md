# Blueprints: a floorplan of a system that isn't built yet

A blueprint is the same map, drawn from a plan instead of code. Someone has a PRD, a spec or just a long description of what they want to build, and the map shows every piece they'd need, how the pieces connect, what each screen relies on, and what still has to be decided.

You write two files in `floorplan/`:
- `plan.json`: the files, endpoints and connections the system would have (this file).
- `architecture.json`: the parts, outside services, flows and tour, exactly as for a code map ([schema.md](schema.md)).

`plan.mjs` turns `plan.json` into the scan `build.mjs` expects, so everything after that works as for real code. Cards are drawn with dashed outlines and a **Blueprint** label, Health becomes a **design review** of the plan, and every part has a **Build this with Claude** (or Codex) button with a ready request to build it.

Contents: [Planning well](#planning-well) · [plan.json](#planjson) · [Checks](#what-the-design-review-checks)

## Planning well

- **Plan to the level of files and endpoints**, not just boxes. Screens, the design review and the build prompts all depend on it. A small product is typically 15–60 files and 10–40 endpoints. Don't plan every helper: one file per page, per group of endpoints, per outside service and per kind of saved data is about right. Where the stack puts one handler per URL (Next.js `route.ts`, SvelteKit `+server.ts`), plan it that way; more files are fine.
- **Pick a sensible, common stack** unless the PRD names one, and list it in `stack`. Prefer what a solo builder working with AI would choose: a Next.js or React website, a Node or Python server, Postgres, Stripe, a hosted email service. Use real, conventional paths for that stack (`web/app/checkout/page.tsx`, `api/src/routes/orders.ts`).
- **Every screen the PRD describes is a file with a `screen` URL.** Give each screen `calls` for the endpoints it uses and `uses` for the parts it's built from.
- **Every endpoint gets `access`**, and `who` when only some signed-in people may use it ("managers of that location", "the account owner"). Decide it from the PRD. If the PRD is silent and it matters, leave it out (the review will flag it) or add a question. An endpoint that must be open to anyone and changes data (sign-in codes, sign-up, guest checkout) gets `publicBecause`: why, and what stops abuse.
- **Don't invent requirements.** Where the PRD doesn't say and you had to choose, write the choice in `assumptions`. Where the answer changes what gets built and you can't reasonably choose, add it to `questions` with the parts it affects. Carry every open question the PRD lists into `questions` unless the PRD settles it elsewhere; if you planned around the likely answer, say so in `assumptions` too. Ask the user 2–3 questions up front only if the PRD leaves something fundamental open (who uses it, web or mobile, does anyone sign in, does money change hands).
- **Outside services and data stores are `external` nodes** in architecture.json (Stripe, the database, an email service). Files reach them through `services` and `data` in plan.json. Put `data` on the files that talk to the database directly (a database helper, or each data-access file), not on every file that uses them: Screens follow `uses` down to them.
- **Background work** (scheduled emails, nightly jobs, queue workers) gets its own files and a `worker` node.

## plan.json

```json
{
  "$schema": "floorplan/plan@1",
  "source": "docs/prd.md",
  "stack": ["Next.js website", "Node.js + Express server", "Postgres", "Stripe"],
  "assumptions": ["Staff and customers share one sign-in, with staff marked as such."],
  "questions": [{ "question": "Can customers cancel for free?", "about": ["POST /api/orders/:id/cancel"] }],
  "files": [ { "path": "web/app/checkout/page.tsx", "name": "Checkout page", "description": "…", "screen": "/checkout", "uses": ["web/lib/api.ts"], "calls": ["POST /api/orders"] } ],
  "endpoints": [ { "method": "POST", "path": "/api/orders", "file": "api/src/routes/orders.ts", "name": "Place an order", "description": "…", "access": "signed-in" } ]
}
```

| field | meaning |
|---|---|
| `source` | what it was planned from: the PRD's path in the project, or a few words such as "a description in chat" |
| `stack` | the technology choices, in plain words |
| `assumptions` | choices you made where the PRD didn't say. Shown on the map's overview |
| `questions` | `{ question, about }`: decisions the PRD leaves open. `about` lists node ids, file paths or `"METHOD /path"`. Each one shows in the design review until it's answered and removed |
| `files` | every planned file (see below) |
| `endpoints` | every planned endpoint (see below) |

**files[]**

| field | meaning |
|---|---|
| `path` | where it would live, relative to the project folder. Required, unique |
| `name`, `description` | a human name and one plain sentence, written like a description of real code ([writing-descriptions.md](writing-descriptions.md)) |
| `screen` | for a page people open: its URL (`/checkout`, `/orders/:id`). Makes it a screen in **Screens** |
| `uses` | other planned files it is built from or calls directly (becomes "uses" connections) |
| `calls` | endpoints it calls, as `"METHOD /path"`, exactly as in `endpoints` |
| `services` | ids of `external` nodes it talks to (Stripe, an email service) |
| `data` | ids of nodes for the data stores it reads or writes (usually the database) |

**endpoints[]**

| field | meaning |
|---|---|
| `method` | GET, POST, PUT, PATCH, DELETE, or CALL for a callable function (for example Firebase `onCall`) |
| `path` | the URL, starting with `/`. Use `:name` for parts that change (`/api/orders/:id`) |
| `file` | the planned file that handles it. Required |
| `name`, `description` | as for files |
| `access` | who may use it: `public` (anyone), `signed-in`, `team` (only the people who run the service, for its own admin pages, not the app's users), `webhook` (another company's service, which must prove it's them) or `internal` (only your own services) |
| `who` | with `signed-in`: which signed-in people, in a few words ("managers of that location", "the account owner"). Leave it out when any signed-in user may |
| `publicBecause` | with `public`: why it has to be open, and what limits abuse ("sign-in has to work before anyone is signed in; 5 codes per number per hour"). The design review stops flagging an open endpoint that has one |

Node `paths` globs in architecture.json assign planned files to parts, the same as for code. Aim for no unassigned files. Folder names in brackets (`app/orders/[id]/**`) match literally.

plan.mjs's "calls to planned endpoints" counts each call; the build's "http" links count each caller-to-file connection plus links to outside services, so the two numbers differ.

## Changes from the map

When the map is open through its server (open.mjs), the Ask bar has an **Ask / Change** switch. A change request ("also plan out refunds", "drop the admin page") goes to the same agent, read-only. It replies with the complete updated plan.json and architecture.json, and the server checks them with plan.mjs and build.mjs. If the checks fail, or new files fall under no part, it sends the problems back once. Then it saves the files, redraws the map (open tabs reload), and highlights the new and changed cards as recent work, with **Undo**. The replaced files are kept in `floorplan/.cache/history/`. Each design review item has **Resolve on the map**, which puts a ready request in Change mode: an open question's request ends with "My answer:" for the person to finish, and the agent then removes the question and builds the answer into the plan. Changes you make by hand or through this skill work the same way: edit the files and run refresh.mjs.

## What the design review checks

- endpoints that change data and are open to anyone, unless `publicBecause` explains why;
- endpoints with no `access` decided;
- every open question, pointing at the parts it affects;
- endpoints no planned screen or service calls;
- planned files connected to nothing.

Each has **Resolve on the map** when the map is served (see above), and otherwise **Resolve with Claude/Codex**, a request to paste into the agent.
