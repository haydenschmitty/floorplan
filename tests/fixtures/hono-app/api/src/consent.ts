// The marketing consent a signed-in shopper gives or takes back.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth } from './auth.js';
import { db } from './db.js';

const consentBodyLimit = bodyLimit({ maxSize: 1024 });

export function createConsentRoutes(deps: { pageSize: number }): Hono {
  const app = new Hono();
  app.post('/', consentBodyLimit, (c) => postConsent(c, deps));
  return app;
}

/** Saves the shopper's choice, once their session checks out. */
async function postConsent(c: Context, deps: { pageSize: number }): Promise<Response> {
  const session = await auth.getSession(c.req.raw.headers);
  if (!session) return c.json({ error: 'Sign in first.' }, 401);
  await db.consent.save(session.userId, await c.req.json());
  return c.json({ ok: true });
}
