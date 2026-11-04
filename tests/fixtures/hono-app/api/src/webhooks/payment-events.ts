// What each Stripe event does to an order, once the webhook has checked it is real.
import type Stripe from 'stripe';
import { db } from '../db.js';

export async function handlePaymentEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await db.orders.markPaid(event.data.object.id);
      break;
    case 'charge.refunded':
      await db.orders.markRefunded(event.data.object.id);
      break;
  }
}
