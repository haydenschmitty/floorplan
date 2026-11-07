import { Hono } from 'hono';

// #98 — a module router under an arbitrary variable name.
export const frentes = new Hono();

frentes.get('/lista', () => new Response('ok'));
frentes.post('/nueva', () => new Response('ok'));
frentes.delete('/vieja', () => new Response('ok'));

export const croquis = new Hono();
croquis.get('/mapa', () => new Response('ok'));

const api = new Hono();
api.route('/frentes', frentes);
api.route('/croquis', croquis);

export default api;
