import Fastify from 'fastify';
import cors from '@fastify/cors';
import ticketRoutes from './routes/tickets.js';
import { inviteRoutes } from './routes/invites.js';
import buildingRoutes from './routes/buildings/index.js';

export async function buildApp() {
  const app = Fastify();
  await app.register(cors, { origin: ['https://example.com'] });
  await app.register(ticketRoutes, { prefix: '/api/v1/tickets' });
  await app.register(inviteRoutes, {
    prefix: '/api/v1/invites',
    logLevel: 'warn',
  });
  await app.register(buildingRoutes, { prefix: '/api/v1/buildings' });
  await app.register(import('./routes/health.js'), { prefix: '/health' });
  return app;
}
