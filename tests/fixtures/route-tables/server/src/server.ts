import { CATALOG_ROUTES } from "./routes/catalog";
import { getCart, addToCart, serveAsset } from "./handlers";

function dispatch(req: Request): Response | Promise<Response> {
  const { pathname } = new URL(req.url);
  for (const route of CATALOG_ROUTES) {
    const match = typeof route.path === "string" ? pathname === route.path : route.path.exec(pathname);
    if (match && route.method === req.method) return route.handle({ req, params: Array.isArray(match) ? match.slice(1) : [] });
  }
  return new Response("Not found", { status: 404 });
}

Bun.serve({
  port: 3000,
  routes: {
    "/api/health": new Response("ok"),
    "/api/carts/:cartId": {
      GET: getCart,
      POST: (req) => addToCart(req),
    },
    "/assets/*": (req) => serveAsset(req),
  },
  fetch: dispatch,
});
