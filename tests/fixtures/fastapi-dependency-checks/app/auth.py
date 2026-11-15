"""Dependencies the routers use. Only some of them check who is calling, and few say so in their name."""
import hmac
import os

from fastapi import Depends, Header, HTTPException, status


# Named "validate_", but what they validate is a credential (#112).
async def validate_api_key(x_api_key: str = Header(None)):
    if not x_api_key or not hmac.compare_digest(x_api_key, os.environ["API_KEY"]):
        raise HTTPException(status_code=401)
    return {"user_id": "u1"}


async def validate_jwt(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return {"user_id": "u1"}


# Validates the body's shape only: not a check on the caller.
async def validate_payload(body: dict):
    if "title" not in body:
        raise HTTPException(status_code=422, detail="title is required")
    return body


async def require_login(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401)
    return {"user": "u1"}


def require_key(x_key: str = Header(None)) -> None:
    if not x_key or not hmac.compare_digest(x_key, os.environ["KEY"]):
        raise HTTPException(status_code=401)


# Factories: what they return checks the caller.
def require_role(*roles):
    async def check(authorization: str = Header(None)):
        if not authorization:
            raise HTTPException(status_code=401)
        return {"roles": roles}
    return check


def needs(*scopes):
    async def check(authorization: str = Header(None)):
        if not authorization:
            raise HTTPException(status_code=403, detail="Forbidden")
        return scopes
    return check


class Clearance:
    def __init__(self, level):
        self.level = level

    def __call__(self, authorization: str = Header(None)):
        if not authorization:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
        return self.level


# Neutral names whose code checks the caller (#117 B).
async def current_vehicle(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401)
    return {"vehicle": "v1"}


# Neutral names that check nothing about the caller.
async def current_page(page: int = 1):
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be 1 or more")
    return page


async def order_or_404(order_id: int):
    if order_id > 100:
        raise HTTPException(status_code=404)
    return order_id


def columns(*names):
    def pick(fields: str = ""):
        return [n for n in names if n in fields]
    return pick


editor = require_role("editor", "admin")
reader = needs("orders:read")
picker = columns("id", "total")
WRITE = [Depends(require_login)]
PAGED = [Depends(current_page)]
pages = Depends(current_page)
