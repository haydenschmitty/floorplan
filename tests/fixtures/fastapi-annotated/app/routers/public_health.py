"""Public Kubernetes-style health endpoints have no authentication."""
from fastapi import APIRouter

router = APIRouter()

@router.get("/readyz")
async def readyz():
    return {"ready": True}

@router.get("/livez")
async def livez():
    return {"live": True}
