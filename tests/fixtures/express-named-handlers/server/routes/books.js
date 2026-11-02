import express from 'express';
import { requireAuth } from '../auth.js';
import { listBooks, createBook, updateUser, createNote } from '../controllers.js';

const router = express.Router();

// a check before a handler defined elsewhere
router.post('/books', requireAuth, createBook);
// public, with a handler whose name only sounds like a check
router.get('/books', listBooks);
router.put('/users/:id', updateUser);
// open, even though the next route has a check
router.post('/notes', createNote);
router.delete('/notes/:id', requireAuth, async (req, res) => { res.json({ deleted: true }); });

export default router;
