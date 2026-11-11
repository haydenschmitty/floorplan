# Changelog

## 0.7.3 (2026-11-10)

- **A long description no longer covers the map in a short window:** when the map opened in a window that isn’t very tall (a laptop screen, or the map inside a frame), the heading’s description could run over the top row of boxes, because only part of the heading was kept clear when the map was fitted. The whole heading is now kept clear (up to just under half the window), and in a window under 760 pixels tall a long description folds to three lines with a More / Less toggle, as it already did on phones.

## 0.7.2 (2026-11-10)

- **A second build no longer fails when Floorplan is installed read-only:** the build puts two of its own files next to the map (`serve.mjs` and `page-safety.mjs`), and it copied them, permissions included. Where the plugin's files are read-only (some package managers, system-wide installs and locked-down machines install them that way), the copies were read-only too, so the next build stopped with a permission error (`EACCES` or `EPERM`) when it tried to replace them. They're now written fresh, so they can always be replaced, and a read-only copy left by an earlier version is replaced too.
- **`build.mjs --json` always prints its JSON object:** when the build stopped on something it didn't expect, it exited 1 with nothing on stdout, so a program reading the result couldn't tell what had happened. It now prints the usual object with `ok: false` and one error, like `build stopped unexpectedly (EACCES); see stderr`. The details still go to stderr, and never into the object, because they can quote your files.
- **A description file that isn't an object is reported, not a crash:** a file in `floorplan/descriptions/` holding `null` stopped the build, a refresh and `describe.mjs` with a stack trace. Now a file that holds `null`, a list or plain text, or whose `files` or `routes` holds a list, a number or text, is a build error that names it, like `descriptions/api.json must be an object like { "files": { … }, "routes": { … } }, not null`. `describe.mjs` treats such a file as empty and writes a fresh one to fill in, and a refresh leaves it for the build to name.
- **A tsconfig that extends itself no longer crashes the scan:** a `tsconfig.json` or `jsconfig.json` whose `extends` led back to itself, directly or through other configs, sent the scan round in circles until it ran out of stack. The loop now simply ends there.

## 0.7.1 (2026-11-10)

- **The map works when the browser blocks storage, copying or new windows:** embedded in a sandboxed iframe, in a private window, or with strict settings. Settings now hold while the page is open instead of resetting, the "Start here" tour no longer starts on every load (the button still starts it, and `#tour=0` in the address keeps it from starting on its own anywhere), copy buttons say "Copied" only when the text really was copied and otherwise select it for you, and links that would open a new window show their address instead of doing nothing. Links to a place on the map (`#v=…&s=…`) and embedding are now described in [Using the map](docs/using-the-map.md#links-to-a-place-on-the-map). Nothing changes where the browser allows these.
- **Truer descriptions:** maps now say what the code does today, not what its names suggest, so a half-built feature reads as "replies that a note was saved, without keeping it anywhere yet" instead of "saves notes". The writing guide has a new "Say what it does today" section, the description worksheets quote the code of each endpoint and of very short files (secrets masked, `.env` files never quoted, a few lines each), and they list which files import, request or name each file, so nobody has to guess who runs a script. The build also warns, never fails, when a part's name or summary on a map for everyone uses developer words ("API client", "UI kit", a framework's name), and when a part holds many files that sit in folders of their own.
- **Safer maps of code you didn't write, and safer copies to share.** A repository, or a description an AI or a person wrote about it, can no longer break, leak from or stall the map:
  - **One odd string can't blank the map:** text such as `<!--<script>` in an endpoint path, a file name or a description made the browser swallow the rest of the page, so the map drew nothing. The map's data now goes into the page with `<`, `>` and `&` written as escapes (the same data, nothing the browser can mistake for markup), through one helper used by the build, the map's server and its exports.
  - **Secrets written into descriptions are hidden:** if a description, label, summary, note or recent-work entry (or a comment the scan picked up) holds something that looks like a key or password, the map shows «hidden» and the build warns, naming the file and the field but never the value. Your files are left as they are. Ordinary words, file paths, commit hashes and IDs are left alone. Drivers can call the same check (`maskSecrets`) on text before writing it.
  - **Maps carry a Content-Security-Policy:** only the page's own scripts run (each allowed by its hash), and an exported copy can't contact anything at all, so even a script that somehow got in couldn't send the map anywhere. The map in `floorplan/` and the page the map's server serves may talk only to that local server. Everything works as before: Ask, flows, live reload, Export, the waitlist card and a blueprint's Change and Undo.
  - **A bad pattern is an error you can fix, not a crash:** a glob in `architecture.json` that isn't valid (an unclosed `[` or `{`, a backwards range), or is absurdly long or wild, used to stop the build with a stack trace. Now it's a build error that says where it is, like `nodes[3] ("web").paths[0] "[evil" is not a valid pattern`.
  - **No more stalled scans:** a large `tsconfig.json` full of `/*` kept the scan busy for minutes. Comments are now stripped in one pass, config files over 1 MB are skipped with a note, and the patterns that read code (imports, endpoints, requests, comments, Health's checks, screens) no longer slow down sharply on large or unusual files.
  - **Names can't pretend to be something else:** invisible characters and ones that reverse the text around them (which can make one file name read as another) are shown on the map as a visible marker like `[U+202E]`. The files keep their real names underneath.
- **Fewer wrong plain-language warnings:** "hook" is flagged only where it means a React-style hook ("custom hooks", "the useCart hook"), not a template's set-up hooks or git hooks; "component" and "primitives" only on parts that are screens (or when said outright, "UI components"); and "shell" only as "app shell", not a shell script.
- **Rewording never fails the map:** in the workflow file, the step that rewords labels and summaries the build flags is now optional and may change only their wording. If the model gives no valid answer, changes anything else, or the reworded file doesn't build, the earlier architecture.json is put back and the map carries on. The workflow format gains `optional`, `restore`, `onFail`, `minAttempts` and a job's `onlyChange` ([Running without an agent session](docs/unattended.md#the-workflow-file)).

## 0.7.0 (2026-11-09)

- **Run Floorplan without an agent session:** in CI, in a script, or from your own tooling, with any model that can read files and return JSON. See [Running without an agent session](docs/unattended.md).
  - **Unattended mode** (`FLOORPLAN_UNATTENDED=1`, or `--unattended`): nothing is written outside `floorplan/` (no `CLAUDE.local.md`, no `.git/info/exclude`, no moving an old section out of `CLAUDE.md`), the map names no agent, `open.mjs` starts nothing, and a refresh whose build fails, or that finds no map, exits with an error.
  - **Results as JSON:** `--json` on `scan.mjs`, `build.mjs`, `describe.mjs`, `refresh.mjs`, `recent.mjs` and `status.mjs` prints one JSON object instead of the report. A refresh's NEXT list comes with stable codes (`fix_build`, `assign_new_files`, `describe`, `review_structure`, `recent_work`) a program can act on.
  - **The workflow as data:** `skills/floorplan/workflow.json` describes the steps SKILL.md takes, which script to run, which jobs need a model, what each is given, the schema of its answer and when it's done, so a small program can follow it. A new test follows it through a first map and a refresh, so it keeps working.
  - **Maps that name no agent:** `FLOORPLAN_AGENT=none` (which unattended mode implies) makes the map's buttons say "Fix with AI" rather than naming Claude or Codex.
- **A repo git can't read no longer disappears quietly:** if git isn't installed, or refuses a checkout because a different user owns it ("dubious ownership", common in containers), the scan now names the repo and the fix instead of leaving it off the map without a word. In unattended mode, that and finding no files at all are errors.
- Nothing changes for people using Floorplan in Claude Code or Codex.

## 0.6.3 (2026-11-02)

- **Endpoints in route tables** (#54, from @Yahhi): servers without a framework often keep their endpoints in a lookup a dispatcher reads, keyed by method and path, like `{ "GET /api/orders": listOrders }` in JavaScript or a Python dict of handlers behind a cloud function. Floorplan found no endpoints in these apps, so the website's requests weren't linked to the server. Now each key is an endpoint, named after its handler (a function, an inline function that calls one, or a wrapped one like `requireAuth(createOrder)`). Tables of other things keyed the same way, like access levels or notes, are left alone. Health doesn't judge sign-in on these endpoints, because the dispatcher or the handler checks it where Floorplan can't see.
- **Fastify endpoints get their full address** (#30, from @secatech): a plugin mounted with `app.register(plugin, { prefix: '/api/tickets' })` now puts its endpoints under that prefix, including plugins registered inside other plugins and ones loaded with `import()` or `require()`. Before, every plugin's endpoints sat at the root (`GET /`, `GET /:id`), so the website's requests were often matched to the wrong part of the server.
- **Django endpoints get their full address:** an app's `urls.py` included by the project (`path("api/orders/", include("orders.urls"))`) now puts its endpoints under that prefix, as `/api/orders/<int:pk>` rather than `/<int:pk>`, so the website's requests link to them. The include line itself is no longer listed as an endpoint, and the project's `urls.py` links to the app's. Fixed by @rudycelekli (#64).
- **Code after a `/*` inside a string is read again:** a string such as `'/api/*'` (as in Hono's `app.use('/api/*', cors())`) was taken for the start of a comment, so every endpoint, import and web request from there to the next comment's end was missing from the map. Fixed by @rudycelekli (#61).
- **Skill installation:** quote the YAML description so `npx skills add` can read it. Fixed by @Bl0ck154 (#25), and @Mason-Little sent the same fix.
- **Blueprints in Codex:** the build report now says a blueprint is "planned, not built yet" in Codex too. Fixed by @owlahikit.

## 0.6.2 (2026-11-02)

- **Far fewer false alarms in Health** (thanks to @samuelpullen15-droid, who reported 13 of them from one site with the new **Not a problem** button):
  - **Feeds and files meant for everyone:** reading `rss.xml`, `atom.xml`, `llms.txt`, `ads.txt` and similar no longer counts as an open endpoint.
  - **Addresses you publish yourself:** an endpoint listed in your `llms.txt`, or allowed in your `robots.txt`, is public on purpose. A catch-all route counts when something under it is listed, and a blocked or merely nearby address doesn't.
  - **Responses marked for everyone:** a `Cache-Control: public` response is public on purpose, including when a helper it imports sets the header. So is a Next.js route with `force-static` or `revalidate`.
  - **Nothing private to give:** a Next.js `GET` that reads no database, session, cookie or server secret, directly or through what it imports, is no longer reported. A rate limiter's Redis doesn't count, an import Floorplan can't follow does, and so does reading files on a route whose address the caller chooses.
  - **Payload CMS:** the API routes Payload generates apply its own access rules, so they no longer read as "anyone could change data".
  - **A "POST only" reply:** a handler that only answers 405 isn't an open endpoint or a way to send fake events.
  - **Webhooks locked with a shared secret:** comparing against a secret from the environment, `timingSafeEqual`, and helpers like `isAuthorized()` or `verifyWebhookSecret()` now count as checks on Next.js routes.
  - **A browser tracker's site token:** a token handed to a tracker's `<script>` tag is one every visitor already has. Names like `ACCESS_TOKEN` or `AUTH_TOKEN`, and real key formats, are still reported.
  - **Files a tool opens by name:** a file whose comment says a tool reads it, or that it's generated, no longer looks unused.
  - Endpoints that change data are still always checked, and "Not a problem" is still there for anything Health can't work out.
- **FastAPI checks Health missed** (#7), fixed by @Bl0ck154: dependencies named like `metrics_guard`, a token in a `Header` parameter when the handler rejects a bad one, a Twilio-style signature check inside a helper, and `/readyz` and `/livez` as public health checks.
- **Health reads each Express route's own checks:** a sign-in check in front of a handler defined elsewhere (`router.post('/books', requireAuth, createBook)`) was missed, so the endpoint was reported as open to anyone. The other way round, a route could borrow the check of the route below it, and a handler whose name sounds like a check (`updateUser`) was taken for one, so some open endpoints weren't reported. Fixed by @rudycelekli.

## 0.6.1 (2026-11-01)

- **Fewer false alarms in Health** (thanks to the user who reported these):
  - **A password hash isn't the password:** bcrypt, argon2 and similar hashes are no longer reported as passwords, and neither is anything under a name like `ADMIN_PASSWORD_HASH`, including browser variables such as `VITE_ADMIN_PASSWORD_HASH`. The secret that makes a hash (`HASH_SECRET`) is still flagged, and so is a real key format under any name.
  - **An encrypted backup isn't an exposed one:** encrypted values in a `.env` file are left alone (dotenvx, sops, Ansible Vault, AWS KMS, HashiCorp Vault, age, PGP, OpenSSL and Fernet), and so are passphrase-protected private keys. A value left unencrypted next to them is still flagged.
- **Mark an issue "Not a problem":** a new button on each Health issue, with an optional reason. The issue moves to the bottom of the list and out of the count, and stays there when the map is rebuilt. It shows again if the same check finds something new in that file or the issue changes severity, and **Show again** undoes it. Your choices are saved in `floorplan/health-dismissed.json`. Exported copies keep the issue set apart but leave your reason out.
- **Report a false alarm if you like:** a box in the same dialog opens a GitHub issue for you to read, edit and send yourself, with a preview of exactly what it says. It never includes your code or any values, and nothing is sent unless you send it.

## 0.6.0 (2026-10-31)

- **Health catches the classic mistakes in AI-built apps.** Five new checks, each in plain words with a fix to paste:
  - **Secret keys sent to the browser:** an OpenAI, Stripe or Supabase service-role key (and others) in a `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` or similar variable, which every visitor can read. Keys that are public by design, like Supabase's anon key or Stripe's publishable key, are left alone.
  - **Supabase tables anyone can read and change:** tables whose row-level security is never switched on (or is switched off), worked out by replaying the migrations in order, so a table locked later or dropped doesn't count. Policies that let anyone add, change or delete rows are flagged too, as worth a look.
  - **Firebase rules that let anyone in:** Firestore, Storage and Realtime Database rules open to anyone, including "test mode" rules, with the date they stop working (or stopped).
  - **Stripe webhooks anyone could fake:** code that acts on events like `checkout.session.completed` without checking Stripe's signature, so anyone could send a fake "payment succeeded".
  - **Servers that let any website call them (CORS):** a small note on its own, and worth fixing when login cookies are allowed along with it.
- **No more false alarm on Supabase's `config.toml`:** values like `"env(S3_SECRET_KEY)"` read a setting from the environment, so they're no longer reported as a key written into the code.

## 0.5.0 (2026-10-31)

- **Fits phones and tablets:** the top bar wraps instead of running off the screen, the details open as a sheet at the bottom of a phone (tap a box to see them), the long description under the title folds to a line with More / Less, and every control is at least 44 px to tap. Nothing changes with a mouse at 1000 px and wider. Requested in #18 and built by @menachem-kurkus in #19.
- **Touch gestures on the map:** dragging or pinching on a phone or tablet made the map jump to unexpected places. A drag now follows only the finger that started it and ends when the browser takes over the touch (before, the drag stayed switched on and followed any later movement); a second finger starts a pinch instead of restarting the drag, and a third finger is ignored; two fingers zoom around the point between them and moving both pans; the first tap after a drag is no longer swallowed; and the browser no longer zooms or bounces the page under the map, or re-fits the map when a phone's address bar slides in and out. A mouse, a trackpad and the wheel work exactly as before. Built by @menachem-kurkus in #24.
- **No hover tooltip after a tap:** a tap also sends the browser's hover event, so a card's tooltip popped up over the details sheet. Tooltips now show only for a mouse, and a tooltip stays inside a narrow window.

## 0.4.4 (2026-10-31)

- **The note for future sessions is now your choice:** in Claude Code, Floorplan no longer adds its section to `CLAUDE.local.md` on its own. After your first map, Claude asks whether future sessions in the project should use it, and adds the note only if you say yes. A note you already have is kept up to date; delete it to remove it.
- **Pre-approved commands named one by one:** the skill now lists each of its eight scripts by name, instead of approving anything in its scripts folder.

## 0.4.3 (2026-10-31)

- **Links for the Claude plugin directory:** the Claude Code manifest now points to the documentation, the privacy and security page, and GitHub issues for support, so a directory listing shows the right links. Nothing else changed.

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
