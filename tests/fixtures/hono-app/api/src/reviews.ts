// Product reviews. Posting one checks nothing about the caller.
import { Hono } from 'hono';
import { db } from './db.js';

export function createReviewRoutes(): Hono {
  const app = new Hono();
  app.post('/', async (c) => c.json(await db.reviews.add(await c.req.json())));
  return app;
}
