import { Router } from 'express';
export function createBillingRoutes() {
  const router = Router();
  router.post('/refund', (req, res) => res.json({}));
  return router;
}
