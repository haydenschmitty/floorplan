// The phone app's calls to the shop.
const BASE = process.env.EXPO_PUBLIC_API_URL;

export const listProducts = () => fetch(`${BASE}/api/products`).then((r) => r.json());
export const getProduct = (slug: string) => fetch(`${BASE}/api/products/${slug}`).then((r) => r.json());
export const getOrder = (id: number) => fetch(`${BASE}/orders/${id}`).then((r) => r.json());
