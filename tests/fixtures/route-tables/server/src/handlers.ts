const json = (data: unknown) => Response.json(data);

export const listProducts = () => json([]);
export const getProduct = (id: string) => json({ id });
export const readProductContent = (id: string) => json({ id, content: "" });
export const createReview = (_req: Request, id: string) => json({ id });
export const updateProduct = () => json({});
export const deleteProduct = () => json({});
export const validateCoupon = () => json({ valid: true });
export const getCoupon = (code: string) => json({ code });
export const sendDownload = (name: string) => json({ name });
export const getCart = () => json({ items: [] });
export const addToCart = (_req: Request) => json({ ok: true });
export const serveAsset = (_req: Request) => json({});
