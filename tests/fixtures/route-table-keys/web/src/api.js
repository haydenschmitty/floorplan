const API = import.meta.env.VITE_API_URL;

export const books = () => fetch(`${API}/api/books`).then((r) => r.json());
export const book = (id) => fetch(`${API}/api/books/${id}`).then((r) => r.json());
export const borrow = (id) => fetch(`${API}/api/books/${id}/loans`, { method: 'POST' });
export const orders = () => fetch('/api/orders').then((r) => r.json());
export const placeOrder = (body) => fetch('/api/orders', { method: 'POST', body: JSON.stringify(body) });
