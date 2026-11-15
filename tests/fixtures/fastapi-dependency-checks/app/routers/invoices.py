"""#117 C: a factory's result added to the whole router."""
from fastapi import APIRouter, Depends

from app.auth import require_role

invoice_writer = require_role("sales")
router = APIRouter(prefix="/invoices", dependencies=[Depends(invoice_writer)])


@router.post("/")
async def create_invoice():
    return {"ok": True}
