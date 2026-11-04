// Compares two strings in constant time, so a wrong token can't be guessed one letter at a time.
import { timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
