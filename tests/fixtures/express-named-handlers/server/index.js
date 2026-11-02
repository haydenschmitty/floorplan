import express from 'express';
import books from './routes/books.js';

const app = express();
app.use('/api', books);
app.listen(3000);
