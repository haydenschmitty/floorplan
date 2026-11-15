"""Really open: the whole router depends on a page number, kept in a variable and in a list."""
from fastapi import APIRouter

from app.auth import PAGED, pages

router = APIRouter(prefix="/catalog", dependencies=[pages])
drafts = APIRouter(prefix="/drafts", dependencies=PAGED)


@router.post("/")
async def add_product():
    return {"ok": True}


@drafts.post("/")
async def add_draft():
    return {"ok": True}
