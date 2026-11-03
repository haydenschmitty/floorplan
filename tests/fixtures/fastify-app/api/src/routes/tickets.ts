import type { FastifyInstance } from 'fastify';

/** Tickets residents raise about their building. */
export default async function ticketRoutes(app: FastifyInstance) {
  app.get('/', async () => []);
  app.get('/:id', async () => ({}));
  app.post('/:id/accept', async () => ({ ok: true }));
}
