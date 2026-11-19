"""#102 and #117 D: a Depends() kept in a variable, and a list of dependencies kept in a constant."""
from fastapi import APIRouter, Depends

from app.auth import PAGED, WRITE, pages, require_key

router = APIRouter(prefix="/notes")
api = Depends(require_key)


@router.post("/inline", dependencies=[Depends(require_key)])
def add_inline():
    return {"ok": True}


@router.post("/aliased", dependencies=[api])
def add_aliased():
    return {"ok": True}


@router.post("/default")
def add_default(_: None = api):
    return {"ok": True}


@router.post("/shared", dependencies=WRITE)
def add_shared():
    return {"ok": True}


# Really open: what they depend on is a page number.
@router.post("/paged", dependencies=PAGED)
def add_paged():
    return {"ok": True}


@router.post("/paged-default")
def add_paged_default(page: int = pages):
    return {"ok": True}
