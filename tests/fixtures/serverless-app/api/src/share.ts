import { verifyToken } from './token';

export const handler = async (event) => {
  const user = await verifyToken(event.headers.authorization);
  return { statusCode: 200, body: JSON.stringify({ sharedBy: user.id }) };
};
