from fastapi import APIRouter

router = APIRouter()


@router.get("/list")
async def list_items():
    return []


@router.delete("/{item_id}")
async def delete_item(item_id: int):
    return {"deleted": item_id}
