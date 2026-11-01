import { listProducts, getProduct, readProductContent, createReview, updateProduct, deleteProduct, validateCoupon, getCoupon, sendDownload } from "../handlers";

export interface Route {
  method: string;
  path: string | RegExp;
  handle: (ctx: { req: Request; params: string[] }) => Response | Promise<Response>;
}

const LEGACY_PATH = "/api/legacy";

export const CATALOG_ROUTES: readonly Route[] = [
  { method: "GET", path: "/api/products", handle: listProducts },
  {
    method: "GET",
    path: /^\/api\/products\/([^/]+)$/,
    handle: ({ params }) => getProduct(params[0]),
  },
  {
    path: /^\/api\/products\/([^/]+)\/content$/,
    limits: { burst: 5 },
    method: "GET",
    handle: ({ params }) => readProductContent(params[0]),
  },
  {
    method: "POST",
    path: /^\/api\/(?:products|items)\/([^/]+)\/reviews$/,
    handle: ({ req, params }) => createReview(req, params[0]),
  },
  { path: "/api/products/:id", handler: updateProduct, method: "PUT" },
  { method: 'DELETE', path: '/api/products/:id', action: deleteProduct },
  { method: "POST", path: "/api/coupons/validate", handle: validateCoupon },
  { method: "GET", path: /^\/api\/coupons\/(?!validate$)([^/]+)$/, handle: ({ params }) => getCoupon(params[0]) },
  { method: "GET", path: /^\/downloads\/(.+)$/, handle: ({ params }) => sendDownload(params[0]) },
  { method: "GET", path: LEGACY_PATH, handle: listProducts },
  { method: "GET", path: new RegExp("^/api/old-products$"), handle: listProducts },
];
