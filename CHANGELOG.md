# Changelog

## Unreleased

- **Ask through any ACP agent:** the map's server can answer questions and build flows through any agent that speaks the Agent Client Protocol — `node floorplan/serve.mjs --engine acp --acp 'gemini --acp'`, on that agent's own sign-in. `--acp <name>` picks a known agent (`gemini`, `opencode`, `devin`, `claude-code-acp`, `codex-acp`); with none given it auto-detects one on PATH. The server confines it to reading the codebase and running `floorplan/query.mjs` commands (best-effort; some agents use their own tools instead). The engine pill in the Ask bar opens a picker to switch agent or model live; the choice is remembered across restarts. See [ACP agents](docs/acp.md).

## 0.2.1 (2026-10-28)

- **Firebase Cloud Functions:** callable (`onCall`) and `onRequest` functions now show up as endpoints, named the way your functions entry file exports them, and the website's `httpsCallable` calls and requests reach them, including through a helper of your own that wraps `httpsCallable`. So a React + Firebase app's website and server are connected on the map, Screens shows the server code behind each page, and Ask can follow the links. Callables are shown as `CALL /name`. Reported by @omardlr-aviv in #8.
- **Health on Firebase:** callable and `onRequest` functions with no sign-in check (`request.auth`, `context.auth`, App Check or a verified ID token) are flagged like any other endpoint anyone can call.
- **Background functions:** scheduled functions and Firestore, Storage, Pub/Sub and Auth triggers are listed for the AI, which places them in the map's background-job parts.

## 0.2.0 (2026-10-28)

- **Works in Codex:** Floorplan is now a Codex plugin too, with the same skill, map and Health check, on your ChatGPT sign-in and with no API keys. Install it from the Codex app with no terminal: **Plugins → Add a marketplace →** `haydenschmitty/floorplan`, then install Floorplan. See [Floorplan in Codex](docs/codex.md).
- **Ask through Codex:** in a map made with Codex, the Ask bar runs your own Codex on your computer, in its read-only sandbox, and these runs stay out of your Codex history. Follow-up questions keep the conversation. The map's server uses whichever agent made the map, and falls back to the other one if only that one is installed (`--engine claude|codex` picks one).
- **Says who it's working with:** the Ask bar, the Health panel's "Fix with Claude" or "Fix with Codex" prompts, and request-a-flow all name the agent that made the map. In Codex, Floorplan leaves your project's notes alone (there's no Codex equivalent of the personal `CLAUDE.local.md`).
- **Docs** cover both apps throughout, with a new [Floorplan in Codex](docs/codex.md) guide.

## 0.1.5 (2026-10-28)

- **Fewer false Health alarms on FastAPI:** a dependency shortcut whose own name says it checks the caller, like `AdminAccess = Annotated[dict, Depends(check)]`, now counts as a login check even when its function has a plain name.
- **More accurate Health on FastAPI:** more database session helpers (`get_sql_session`, `SessionLocal`, engine, connection and unit-of-work helpers) are recognised, so an endpoint that only has one of them is flagged instead of passing as protected. Both by @PaulMagos in #6.
- **Map server hardening:** the map's local server no longer serves files from a neighbouring folder whose name starts with "floorplan" (like `floorplan-old/`), and a malformed web address now gets an error instead of stopping the server. Both were found by the new tests.
- **Tests:** a test suite now covers how code is read, Health, a whole map of a sample two-repo app, the privacy promises (offline map, no secret values written anywhere) and the map server's security checks. It runs on every push and pull request on Linux and Windows, and weekly on macOS. Run it with `npm test`.

## 0.1.4 (2026-10-28)

- **Safari fix:** cards now show up in Safari (and every browser on iPhone/iPad). Before, only the connection lines were drawn and card text appeared in the top-left corner. Reported by @fpv001 in #1, fixed by @PaulMagos in #3.
- **Fewer false Health alarms on FastAPI:** endpoints protected through a shared dependency shortcut, like `user: AdminUser` where `AdminUser = Annotated[..., Depends(...)]`, are no longer reported as open to anyone. That includes shortcuts defined in another file, and shortcuts built on other shortcuts. A database session dependency (`SessionDep`, `get_db`) no longer counts as a login check, so endpoints that only have one are flagged as they should be. Reported by @PaulMagos in #4.

## 0.1.3 (2026-10-28)

- **Works offline, no outside requests:** the map's layout engine (elkjs) and fonts are now bundled into it instead of loaded from jsDelivr and Google Fonts. Maps get this on their next update.
- The waitlist service's code is no longer part of the plugin download. It stays readable in the repo's history, linked from [Privacy and security](docs/privacy-and-security.md#floorplan-cloud-waitlist).

## 0.1.2 (2026-10-27)

- **Floorplan Cloud waitlist:** once a map has been open for two minutes, a corner card asks, once, whether you'd like an email when Floorplan Cloud (shared, synced team maps) launches. Nothing is sent unless you click **Notify me**, and then only your email and "just me" or "with my team". **Use my Claude email** fills in your Claude account's address, and you see it before anything is sent. **Don't ask again**, or `FLOORPLAN_NO_PROMPTS=1`, turns it off. See [Privacy and security](docs/privacy-and-security.md#floorplan-cloud-waitlist).
- The waitlist service's code is in `services/waitlist/`: rate-limited per IP address and overall, write-only, and capped.

## 0.1.1 (2026-10-27)

- **More connections found:** requests made through small helpers imported from an API client, like `post("/orders", …)` in a Python job, are now matched to the endpoints they reach.
- **Fewer false Health alarms:**
  - Express routers protected where they're mounted (`app.use('/admin', requireStaff, adminRouter)`), including routers nested inside them, are no longer reported as open to anyone.
  - Newsletter, contact and waitlist sign-ups are treated as public on purpose.
- **Flows:** the page heading fades out while a flow plays, so the flow bar no longer overlaps it.
- **Screens:** a screen's board is labelled "Screen" instead of "Answer".
- **README:** screenshots, from a demo app mapped end to end.

## 0.1.0 (2026-10-27)

First release.

- **The map:** an interactive node graph of a codebase, from the whole app down to single files and endpoints. Every part has a plain-English name and description. It works across several repos side by side.
- **Connections:** imports, and web requests matched to the server endpoints they reach, including URLs built in variables, nested template strings and small request helpers. Flask blueprint and Express router prefixes are resolved, nested mounts included.
- **Screens:** detects an app's pages (Next.js, React Router, Vue, SvelteKit, Remix, Nuxt, Astro, Expo, Angular, TanStack) and shows everything behind each one.
- **Health check:** passwords and keys in code, endpoints anyone can use without signing in, unused files and very large files, each with a ready-made fix prompt. Secret values are never stored.
- **Ask:** questions answered as a mini-map with a walkthrough, through the Claude Code CLI or the Claude app.
- **Flows:** guided walkthroughs, plus "Request a new flow".
- **Start here** tour, plain-language glossary and a "Show technical detail" switch.
- **Recent work:** the cards Claude just changed are highlighted, each with a note tying the change to what was asked.
- **Updates:** refreshes re-read only what changed, and an open map reloads itself.
- **Git:** nothing Floorplan creates is committed. The map folder ignores itself, and Claude's notes go in `CLAUDE.local.md`.
