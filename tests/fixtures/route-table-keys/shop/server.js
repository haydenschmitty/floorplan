// Plain Node server: a lookup keyed by method and path, no framework.
import http from 'node:http';
import { listOrders, createOrder, getOrder } from './orders.js';
import { requireAuth } from './auth.js';

const routes = {
  'GET /api/orders': listOrders,
  'POST /api/orders': requireAuth(createOrder),
  'GET /api/orders/:id': (req, res) => getOrder(req, res),
};

http.createServer((req, res) => {
  const handler = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  if (handler) handler(req, res); else res.writeHead(404).end();
}).listen(3000);
