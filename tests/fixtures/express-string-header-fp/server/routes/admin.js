import { Router } from 'express';

const router = Router();

export async function deleteUser(req, res) { res.status(204).end(); }
router.delete('/users/:id', deleteUser);

export default router;