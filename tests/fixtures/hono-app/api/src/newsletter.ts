// The newsletter choice a signed-in shopper makes or takes back.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth } from './auth.js';
import { db } from './db.js';

const newsletterBodyLimit = bodyLimit({ maxSize: 1024 });

export function createNewsletterRoutes(deps: { pageSize: number }): Hono {
  const app = new Hono();
  app.post('/', newsletterBodyLimit, (c) => postNewsletter(c, deps));
  return app;
}

/** Saves the shopper's choice, once their session checks out. */
async function postNewsletter(c: Context, deps: { pageSize: number }): Promise<Response> {
  const session = await auth.getSession(c.req.raw.headers);
  if (!session) return c.json({ error: 'Sign in first.' }, 401);
  await db.newsletter.save(session.userId, await c.req.json());
  return c.json({ ok: true });
}
