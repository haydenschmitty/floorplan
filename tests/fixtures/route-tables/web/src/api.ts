const BASE = import.meta.env.VITE_API_BASE ?? "";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const listProducts = () => request("/api/products");
export const loadProduct = (id: string) => request(`/api/products/${id}`);
export const loadContent = (id: string) => request(`/api/products/${id}/content`);
export const postReview = (id: string, text: string) => request(`/api/items/${id}/reviews`, { method: "POST", body: JSON.stringify({ text }) });
export const checkCoupon = (code: string) => request("/api/coupons/validate", { method: "POST", body: JSON.stringify({ code }) });
export const loadCart = (cartId: string) => fetch(`/api/carts/${cartId}`);
export const addItem = (cartId: string, sku: string) => fetch(`/api/carts/${cartId}`, { method: "POST", body: JSON.stringify({ sku }) });

// A request descriptor handed to a queue: it names a method and a path but serves nothing.
export const retryDescriptor = { method: "POST", path: "/api/products/sync" };
