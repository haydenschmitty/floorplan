// The phone app's calls to the shop's API.
const BASE = process.env.EXPO_PUBLIC_API_URL;

export const listOrders = () => fetch(`${BASE}/api/v1/orders`).then((r) => r.json());
export const getOrder = (id: string) => fetch(`${BASE}/api/v1/orders/${id}`).then((r) => r.json());
export const me = () => fetch(`${BASE}/api/v1/me`).then((r) => r.json());
