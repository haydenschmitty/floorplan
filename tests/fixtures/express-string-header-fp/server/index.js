import express from 'express';
import cors from 'cors';
import admin from './routes/admin.js';

const app = express();
// A token-refresh setup names its headers: nothing here checks who is calling.
app.use(cors({ origin: true, exposedHeaders: ['X-Refreshed-Token'] }));
app.use('/api/admin', admin);
app.listen(3000);