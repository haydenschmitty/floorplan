import express from 'express';
import orderRoutes from './orders.routes.js';
import { authRoutes } from './auth/index.js';
import { createBillingRoutes } from './billing.routes.js';
import { profileRoutes } from './profile.routes.js';

const app = express();
const billingRoutes = createBillingRoutes();

app.use('/api/orders', orderRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/profile', profileRoutes);
app.get('/health', (req, res) => res.json({ ok: true }));
