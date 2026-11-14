# Choosing boundaries

The board is useful when each chip is something a person would name in a whiteboard conversation. It's useless when it just mirrors the folder tree. Use these heuristics to get there.

## The top-level board (3–9 chips)

Ask: *what are the deployable or ownable things, and what do they talk to?*

- **Multi-repo codebase.** Usually one chip per deployable (frontend, API, worker, a second app like an admin panel or a mobile app), plus shared libraries, plus externals. The repo is not always the unit: a backend repo might hold an API *and* a worker *and* an MCP connector, so give each its own chip.
- **Monorepo** (`apps/*`, `packages/*`, `services/*`). Apps and services become top-level chips. Group packages as one `Shared libraries` chip with children, unless a package is big and central.
- **Single monolith.** Use layers or domains as the top level (`Web layer`, `Domain services`, `Data`, `Jobs`), or the 4–8 biggest domains if the code is organized by feature. Choose the one the code actually follows.
- **Externals.** Add the database(s) and each third-party API the code meaningfully depends on. Use the scan's EXTERNAL PACKAGES and EXTERNAL HOSTS lists; `packages` and `hosts` on external nodes connect them automatically. Skip utility libraries (react, lodash, pytest). They're dependencies, not architecture.
- **Tests, scripts, migrations.** Give them their own top-level chips (`kind: test`, `script`, `data`) rather than mixing them into the service. Otherwise they bury the real dependency structure: tests import everything.

## Second level (3–12 per chip)

- Prefer **responsibility** over **file type**. "Orders", "Inventory" and "Auth" beat "routes", "services" and "models" when the code is organized that way. But if the code really is layered (routes/ → services/ → models/), mirror the layers. A layered board that shows routes → services → models is honest and readable.
- A child is worth making when it has a clear one-sentence purpose and enough files (roughly 3+) or importance (a central API client) to matter.
- Large UI component trees: group by feature area (`products`, `orders`, `checkout`), and keep one chip for the shared building blocks (`components/ui`: buttons, tables, dialogs). That chip will have many incoming traces. That's correct and useful to see.
- **Don't make one bucket for every component.** If `components/` holds `products/`, `orders/`, `account/` and `nav/`, a single "Screen parts" chip with 30 files tells the reader nothing. Give each feature folder its own child ("Products", "Orders", "Account settings", "Menu and frame"), and keep only the shared kit together. The same goes for any part where most files sit in a few folders of their own.
- A part with no children and more than ~24 files is too coarse. The build warns about one whose files fall into several folders of 3 or more ("Consider children by feature area"), and lists the folders. Split it along them, or along whatever the code really follows.
- Don't go deeper than three levels of nodes. The viewer already gives you folder, file and symbol levels below your nodes.

## Covering the files

- Write broad globs on parents (`backend/app/**`), then narrower ones on children. The deepest match wins, so you never need `exclude` just to stop a parent stealing a child's files.
- After building, look at `unassigned, by directory`, and give each sizeable directory a home or an `ignore` entry.
- `ignore` is for things that aren't the system: generated clients, vendored copies, snapshot fixtures, one-off data dumps. It's not for tests or scripts, which belong on their own chips.

## Summaries

One sentence, about responsibility, in the codebase's own vocabulary. "Syncs product catalog and inventory with Shopify" beats "Contains Shopify-related services". Mention the framework only at the top level: in `project.summary`, or in top-level node summaries when the map's audience is developers. For everyone, node summaries say what a part does, not what it's built with ("Plain language" in writing-descriptions.md). Say what it does today: if a part is mostly placeholders, the summary says so ("Say what it does today" in writing-descriptions.md).

## Flows

Pick the 1–3 things the system exists to do (take an order, sync inventory, run a nightly job). Trace them across the board in 3–7 steps from the user or trigger to the final side effect. Check that consecutive steps are actually connected by an import, HTTP or explicit edge; if not, add the missing edge. The flow should make the system's main path obvious to someone seeing it for the first time.

## Sanity checks before you finish

- Does the top-level board, read left to right, tell the system's story (UI → API → services → data/externals)?
- Is any chip connected to almost everything? That's either a shared kit (fine, label it) or a sign the boundary is wrong.
- Are there traces you didn't expect, like the frontend importing backend code, or tests that are imported by production code? Mention them to the user; they're often the most valuable finding.
