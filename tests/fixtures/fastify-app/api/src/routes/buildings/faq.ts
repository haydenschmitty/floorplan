import type { FastifyInstance } from 'fastify';

export default async function faqRoutes(app: FastifyInstance) {
  app.get('/', async () => []);
}
