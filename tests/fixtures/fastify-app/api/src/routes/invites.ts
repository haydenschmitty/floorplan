import type { FastifyInstance } from 'fastify';

/** Invitations to join a building. */
export async function inviteRoutes(fastify: FastifyInstance) {
  fastify.get('/', async () => []);
  fastify.post('/accept', async () => ({ ok: true }));
}
