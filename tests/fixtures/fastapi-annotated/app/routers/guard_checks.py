"""Named guard dependencies should protect FastAPI routes."""
from fastapi import APIRouter, Depends

router = APIRouter()

def metrics_guard():
    return True

@router.get("/internal/metrics", dependencies=[Depends(metrics_guard)])
async def internal_metrics():
    return {"ok": True}
