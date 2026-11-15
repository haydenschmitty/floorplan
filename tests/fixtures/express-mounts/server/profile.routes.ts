import { Router } from 'express';
export const profileRoutes = Router();
profileRoutes.get('/me', (req, res) => res.json({}));
