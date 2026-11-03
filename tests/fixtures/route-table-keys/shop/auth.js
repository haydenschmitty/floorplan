export const requireAuth = (fn) => (req, res) => (req.headers.authorization ? fn(req, res) : res.writeHead(401).end());
