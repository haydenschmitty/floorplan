const app = Fastify();
app.post('/api/plain-guarded', { preHandler: requireAuth }, handler);
app.route({ method: 'POST', url: '/api/object-prehandler', preHandler: requireAuth, handler });
app.route({ method: 'POST', url: '/api/object-onrequest', onRequest: [logAccess, app.authenticate], handler });
app.route({
  method: 'POST',
  url: '/api/object-prevalidation',
  preValidation: [logAccess, requireUser],
  handler,
});
app.route({ method: 'POST', url: '/api/object-open', handler });
app.route({ method: 'POST', url: '/api/neighbor-open', handler });
app.route({
  method: 'POST',
  url: '/api/object-schema-only',
  schema: { response: { 200: { preHandler: requireAuth } } },
  handler,
});
