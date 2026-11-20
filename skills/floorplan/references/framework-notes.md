# Framework-Specific Matching Notes

Details on how `scripts/scan.mjs` extracts endpoints, calls, and relationships for specific stacks and how to represent them in `floorplan/architecture.json`.

## HTTP, RPC, and Serverless Endpoints

- **HTTP call-to-route matching:** HTTP edges come from matching URL strings at call sites (including URLs kept in a variable first, nested template strings, and small same-file helpers that add a path prefix) to route definitions (Flask, FastAPI, Express, Fastify, Next.js, Spring, ASP.NET Core, Go and others), with blueprint/router/plugin prefixes resolved, nested mounts included.
- **Firebase Cloud Functions:** Firebase callables are matched by name (`CALL /<name>`, from `httpsCallable`) and `onRequest` functions by URL. The scan summary's `FIREBASE FUNCTIONS` section lists scheduled and trigger functions, which belong in a `worker` node.
- **Supabase Edge Functions:** Supabase Edge Functions are endpoints at `/functions/v1/<name>` reached by `supabase.functions.invoke('<name>')`. The scan summary's `SUPABASE EDGE FUNCTIONS` line counts them.
- **Laravel (PHP / Wayfinder / Inertia):** Laravel routes (`Route::get`, `resource`, groups, and route files loaded inside groups or by `withRouting`) are placed in the controller method that answers them, and Laravel Wayfinder calls and Inertia pages are linked by route name, controller method and the page each method renders. The scan summary's `LARAVEL` section counts them and names route files nothing loads (their addresses may be missing a prefix: mention it in your report).
- **Serverless Framework:** Endpoints come from the `http` and `httpApi` events in `serverless*.yml` (and the files they include with `${file(...)}`), placed in the handler's file, or in the function a handler only passes the request on to. The scan summary's `SERVERLESS` section counts them, names functions whose handler file wasn't found, and lists scheduled, queue, stream and other background functions, which belong in a `worker` node.

Treat scan matches as strong hints. If an important service-to-service link is missing, add it as an explicit edge in `architecture.json`.

## Shopify Themes

- A folder with `layout/theme.liquid` is scanned as a Shopify theme: templates use sections, which render snippets and load assets, all linked by name.
- Apps added as app blocks or embeds appear in `EXTERNAL PACKAGES` as `shopify-app:<app>`, so give each app that matters an `external` node with that package.
- Requests made through Shopify's `routes` object (the cart and search APIs) aren't seen statically; add an explicit edge to a Shopify `external` node where they matter.
