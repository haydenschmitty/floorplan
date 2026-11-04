// The check in front of every admin route: the caller must send the admin secret.
import type { Context, Next } from 'hono';
import { safeEqual } from '../safe-equal.js';

export function adminGate(secret: string) {
  return async (c: Context, next: Next) => {
    if (!safeEqual(c.req.header('authorization') ?? '', `Bearer ${secret}`)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  };
}
