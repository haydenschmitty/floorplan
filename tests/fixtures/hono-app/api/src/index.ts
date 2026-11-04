// The shop's server: mounts each router under its address, with the admin check in front of /api/admin.
import { Hono } from 'hono';
import { adminGate } from './admin/gate.js';
import { createProductAdminRoutes } from './admin/products.js';
import { createOrderAdminRoutes } from './admin/orders.js';
import { createStockRoutes } from './internal/stock.js';
import { createInventoryWebhookRoutes } from './webhooks/inventory.js';
import { createPaymentWebhookRoutes } from './webhooks/payments.js';
import { createConsentRoutes } from './consent.js';
import { createReviewRoutes } from './reviews.js';

const app = new Hono();
const adminSecret = process.env.ADMIN_SECRET ?? '';
const stockToken = process.env.STOCK_TOKEN ?? '';

app.get('/health', (c) => c.text('ok'));
// a check on one address, not a router: it moves neither this app's routes nor what it mounts
const docsAuth = adminGate(adminSecret);
app.use('/docs', docsAuth);
app.use('/api/admin/*', adminGate(adminSecret));
app.route('/api/admin/products', createProductAdminRoutes(adminSecret));
app.route(
  '/api/admin/orders',
  createOrderAdminRoutes(adminSecret, { pageSize: 50 }),
);
app.route('/internal/stock', createStockRoutes(stockToken));
app.route('/webhooks/inventory', createInventoryWebhookRoutes(adminSecret));
app.route('/webhooks/payments', createPaymentWebhookRoutes());
app.route('/api/consent', createConsentRoutes({ pageSize: 10 }));
app.route('/api/reviews', createReviewRoutes());

export default app;
