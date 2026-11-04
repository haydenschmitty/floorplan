// Order refunds for the support team. The admin check sits where the server mounts it.
import { Hono } from 'hono';
import { db } from '../db.js';

export function createOrderAdminRoutes(secret: string, options: { pageSize: number }): Hono {
  const app = new Hono();
  app.get('/', async (c) => c.json(await db.orders.list(options.pageSize)));
  app.put('/:id/refund', async (c) => c.json(await db.orders.refund(c.req.param('id'))));
  return app;
}
