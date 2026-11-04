const API = '/api';

export const listOrders = () => fetch(`${API}/orders`).then((r) => r.json());
export const getOrder = (id: string) => fetch(`${API}/orders/${id}`).then((r) => r.json());
export const createOrder = (items: string[]) => fetch(`${API}/orders`, { method: 'POST', body: JSON.stringify({ items }) });
export const shipOrder = (id: string) => fetch(`${API}/orders/${id}/ship`, { method: 'PATCH' });
export const salesReport = () => fetch('/api/admin/reports/sales').then((r) => r.json());
export const clearStatsCache = () => fetch('/api/admin/stats/cache', { method: 'DELETE' });
