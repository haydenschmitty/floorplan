import { Hono } from 'hono';
import api from './routes.js';

const app = new Hono();

app.get('/health', () => new Response('ok'));
app.route('/api', api);

export default app;
