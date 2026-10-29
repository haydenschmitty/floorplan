# Changelog

## Unreleased

- **PHP and BigTree:** static PHP includes now connect to their files. BigTree maps also show office pages, website request handlers and scripts in the site folder, with their shared headers and footers.

## 0.4.2 (2026-10-30)

- **Is it safe to install?** A new page lists everything Floorplan does on your computer: no hooks, MCP servers, dependencies or downloads, its one outbound request, and every program it runs. A test enforces it on every change, and each release now includes `CHECKSUMS.txt`, so you can confirm your installed copy matches it (`node tools/checksums.mjs --check <folder>`).
- **Checked by GitHub's code scanner:** CodeQL now scans every change. Its first scan found six spots to tighten, all fixed: complete escaping in three places, the "Made with Floorplan" link built without reusing page text as HTML, and plain error messages on the map when Undo or Export fails, with the details in the map server's output.

## 0.4.1 (2026-10-30)

- **Exported copies say where they came from:** a small "Made with Floorplan" link at the bottom of an exported map leads to the project, so whoever receives one can make their own.

## 0.4.0 (2026-10-30)

- **Export a copy to share:** the map's new **Export** button saves one HTML file anyone can open in a browser, with nothing to install. It has the whole map without the Ask bar, your folder path or git remotes. Flows and notes go in by default; recent work and the health check (or a blueprint's design review) only if you tick them. Ask Claude or Codex to "export the floorplan", or run `node floorplan/serve.mjs --export`.

## 0.3.2 (2026-10-30)

- **The map's server answers only to this computer's own addresses:** it refuses requests under any other host name, so a website that points its domain at 127.0.0.1 (DNS rebinding) can't load the map, read its token and ask questions about your code.

## 0.3.1 (2026-10-30)

- **Asking on a map works again on Windows with the current Claude Code install:** the map's server found only the shell shim of an npm install and failed with `spawn ...\claude ENOENT`; it now finds the real `claude.exe` inside the package. Reported and fixed by @menachem-kurkus in #20 and #21.
- **Fewer false Health alarms on FastAPI:** a check added where a router is included, like `app.include_router(admin.router, dependencies=[Depends(require_admin)])`, now protects every endpoint of that router, as `app.use('/admin', requireStaff, adminRouter)` already did on Express. A database session added there still doesn't count as a sign-in check. Fixed by @stevensiht in #15.
- **FastAPI routers found by the name they're imported under:** a router imported under another name (`from app.routes import campaigns as campaign_routes`) gets its prefix and its checks, and a package that shares a router's name (`from app.platform import pricing` beside a `platform` router) is no longer mistaken for it. Fixed by @stevensiht in #15.
- **No more false alarm for analytics and map tokens:** Health no longer calls Cloudflare Web Analytics' beacon token or a Mapbox public token (`pk.…`) a leaked secret. Both are public by design: the page has to send them for analytics or maps to work. Reported by @CplSyx in #23.
- **Big files no longer vanish from the map:** files up to 2 MB are now read in full (up from 512 KB). A file over the limit still appears with its line count, the scan lists it, Health includes it among the very large files, and its card says its connections and secrets weren't checked. Reported by @Rasherb69 in #16.

## 0.3.0 (2026-10-29)

- **Blueprints: plan it before you build it.** Floorplan still maps the code you have; now it can also start from no code at all. Share a PRD, a spec or a description of something you want to build, and Floorplan draws the map of what it would take: every part, file, endpoint and screen, how they connect, and the outside services they rely on. It's marked as planned (dashed cards and a **Blueprint** label), Health becomes a design review of the plan (endpoints anyone could use, decisions the PRD leaves open, loose ends), and each part has **Build this with Claude** (or Codex), a ready request to build it as planned. Switch the Ask bar to **Change** to shape the plan from the map ("also plan out refunds"): the map redraws with the new and changed pieces highlighted, and **Undo** puts it back. Design review items can be settled the same way with **Resolve on the map**: an open question just needs your answer. Once the code exists, the map can switch to the real code.
- **Bracketed folder names** like Next.js' `[id]` and `[...slug]` can be written as they are in `architecture.json` path patterns; they match that folder exactly.

## 0.2.2 (2026-10-28)

- **Light mode:** a new **Theme** button in the top bar cycles **Auto → Light → Dark**. Auto follows your device's light or dark setting and changes with it. Your choice is remembered on this device, and the map shows the right colours from the first moment, with no flash. The button is a 44 px target, works from the keyboard with a visible focus ring, and the change is instant (nothing animates, so Reduce Motion is respected). Dark looks exactly as before. Requested in #9 and built by @menachem-kurkus in #10.

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
