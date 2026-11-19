export async function verifyToken(header) {
  if (!header) throw new Error('Not signed in');
  return { id: 'someone' };
}
