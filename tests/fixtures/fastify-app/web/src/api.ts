const API = '/api/v1';

export const listTickets = () => fetch(`${API}/tickets`).then((r) => r.json());
export const acceptTicket = (id: string) => fetch(`${API}/tickets/${id}/accept`, { method: 'POST' });
export const acceptInvite = () => fetch('/api/v1/invites/accept', { method: 'POST' });
export const buildingFaq = (id: string) => fetch(`/api/v1/buildings/${id}/faq`).then((r) => r.json());
