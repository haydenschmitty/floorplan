from fastapi import APIRouter, FastAPI

from app.graphql import make_graphql_router
from app.routers import items

app = FastAPI()

# A router made in this file.
router = APIRouter(prefix="/api/v1/status")


@router.get("/ping")
async def ping():
    return {"ok": True}


# A router a factory returns: this file neither makes nor imports the name graphql_router.
graphql_router = make_graphql_router()

app.include_router(router)
app.include_router(graphql_router, prefix="/api/v1/graphql")
app.include_router(items.router, prefix="/api/v1/items")
