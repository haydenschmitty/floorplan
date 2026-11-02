export function requireAuth(req, res, next) {
  if (!req.headers.authorization) return res.status(401).end();
  next();
}
