// Lets a request through only when it carries the token it is given.
import type { Context, Next } from 'hono';
import { safeEqual } from '../safe-equal.js';

export function privateCaller(expected: string) {
  return async (c: Context, next: Next) => {
    if (!safeEqual(c.req.header('x-stock-token') ?? '', expected)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  };
}
