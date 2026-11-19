/** Runs a handler with shared options: parses the body, adds CORS headers, turns errors into responses. */
export const withEvent = async (event, options, check, handler) => {
  const body = JSON.parse(event.body || '{}');
  check(body);
  return { statusCode: 200, headers: options.cors ? { 'Access-Control-Allow-Origin': '*' } : {}, body: JSON.stringify(await handler(body)) };
};

export const checkInput = (body) => {
  if (!body || typeof body !== 'object') throw new Error('Bad input');
};

export const requireUser = (event) => {
  if (!event.headers?.authorization) throw new Error('Not signed in');
};
