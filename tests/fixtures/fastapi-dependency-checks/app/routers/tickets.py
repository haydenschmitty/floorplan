"""#112: dependencies named validate_<credential> are checks; a schema validator is not."""
from fastapi import APIRouter, Depends
from flask_pydantic import validate

from app.auth import validate_api_key, validate_jwt, validate_payload

router = APIRouter(prefix="/tickets")


@router.post("/")
async def create_ticket(user=Depends(validate_api_key)):
    return {"ok": True}


@router.get("/")
async def list_tickets(user=Depends(validate_jwt)):
    return []


# Really open: the body's shape is checked, the caller isn't.
@router.put("/{ticket_id}")
async def update_ticket(ticket_id: int, body=Depends(validate_payload)):
    return {"ok": True}


@router.patch("/{ticket_id}")
@validate
async def patch_ticket(ticket_id: int):
    return {"ok": True}
