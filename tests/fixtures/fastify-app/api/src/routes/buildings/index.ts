import type { FastifyInstance } from 'fastify';
import faqRoutes from './faq.js';

export default async function buildingRoutes(app: FastifyInstance) {
  app.get('/', async () => []);
  // a plugin registered inside a plugin: its routes sit under both prefixes
  await app.register(faqRoutes, { prefix: '/:buildingId/faq' });
}
