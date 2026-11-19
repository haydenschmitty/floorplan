"""#117 A and B: checks whose names don't say so, and look-alikes that check nothing."""
from fastapi import APIRouter, Depends

from app.auth import Clearance, current_page, current_vehicle, editor, order_or_404, picker, reader

router = APIRouter(prefix="/orders")


@router.post("/")
async def place_order(user=Depends(editor)):
    return {"ok": True}


@router.put("/{order_id}")
async def update_order(order_id: int, vehicle=Depends(current_vehicle)):
    return {"ok": True}


@router.delete("/{order_id}")
async def cancel_order(order_id: int, scopes=Depends(reader)):
    return {"ok": True}


@router.post("/{order_id}/close")
async def close_order(order_id: int, level=Depends(Clearance("manager"))):
    return {"ok": True}


# Really open: a page number, a lookup that answers 404 and a column picker check nobody.
@router.post("/{order_id}/notes")
async def add_note(order_id: int, page=Depends(current_page)):
    return {"ok": True}


@router.post("/{order_id}/copy")
async def copy_order(order_id=Depends(order_or_404)):
    return {"ok": True}


@router.post("/{order_id}/export")
async def export_order(order_id: int, fields=Depends(picker)):
    return {"ok": True}
