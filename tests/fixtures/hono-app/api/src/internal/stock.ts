// Stock changes from the warehouse service, which sends the shared stock token.
import { Hono } from 'hono';
import { db } from '../db.js';
import { privateCaller } from './private-caller.js';

export function createStockRoutes(token: string): Hono {
  const app = new Hono();
  app.use('*', privateCaller(token));
  app.post('/reserve', async (c) => c.json(await db.stock.reserve(await c.req.json())));
  app.post('/release', async (c) => c.json(await db.stock.release(await c.req.json())));
  return app;
}
