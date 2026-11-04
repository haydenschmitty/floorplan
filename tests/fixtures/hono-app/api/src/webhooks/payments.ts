// Payment events from Stripe: checks Stripe's signature, then hands the event on.
import { Hono } from 'hono';
import Stripe from 'stripe';
import { handlePaymentEvent } from './payment-events.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');

export function createPaymentWebhookRoutes(): Hono {
  const app = new Hono();
  app.post('/', async (c) => {
    const signature = c.req.header('stripe-signature') ?? '';
    const event = await stripe.webhooks.constructEventAsync(await c.req.text(), signature, process.env.STRIPE_WEBHOOK_SECRET ?? '');
    await handlePaymentEvent(event);
    return c.text('ok');
  });
  return app;
}
