import type { FastifyInstance } from 'fastify';

export default async function noteRoutes(app: FastifyInstance) {
  app.get('/:buildingId/notes', async () => []);
}
