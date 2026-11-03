import type { FastifyInstance } from 'fastify';

export default async function health(app: FastifyInstance) {
  app.get('/', async () => ({ ok: true }));
}
