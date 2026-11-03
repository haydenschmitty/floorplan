import type { FastifyInstance } from 'fastify';
import faqRoutes from './faq.js';
import noteRoutes from './notes.js';

export default async function buildingRoutes(app: FastifyInstance) {
  app.get('/', async () => []);
  // a plugin registered inside a plugin: its routes sit under both prefixes
  await app.register(faqRoutes, { prefix: '/:buildingId/faq' });
  // registered with no prefix of its own: its routes sit under this plugin's
  await app.register(noteRoutes);
}
