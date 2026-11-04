// Stock level updates from the supplier, signed with a shared secret.
import { Hono } from 'hono';
import { db } from '../db.js';
import { safeEqual } from '../safe-equal.js';

export function createInventoryWebhookRoutes(secret: string): Hono {
  const app = new Hono();
  app.post('/', async (c) => {
    if (!safeEqual(c.req.header('authorization') ?? '', secret)) return c.text('no', 401);
    await db.stock.update(await c.req.json());
    return c.text('ok');
  });
  return app;
}
