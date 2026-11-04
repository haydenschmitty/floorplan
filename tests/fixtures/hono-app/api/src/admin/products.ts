// The product catalogue editor. The admin check sits where the server mounts it.
import { Hono } from 'hono';
import { db } from '../db.js';

export function createProductAdminRoutes(secret: string): Hono {
  const app = new Hono();
  app.get('/', async (c) => c.json(await db.products.list()));
  app.post('/', async (c) => c.json(await db.products.add(await c.req.json())));
  app.delete('/:id', async (c) => c.json(await db.products.remove(c.req.param('id'))));
  return app;
}
