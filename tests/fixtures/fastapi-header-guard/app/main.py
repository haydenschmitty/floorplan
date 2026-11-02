from fastapi import FastAPI, Header, HTTPException

app = FastAPI()


@app.post("/invites/checked")
async def checked_invite(x_invite_token: str = Header(alias="X-Invite-Token")):
    if x_invite_token != "server-side-expected":
        raise HTTPException(status_code=403)
    return {"ok": True}


@app.post("/invites/unchecked")
async def unchecked_invite(x_invite_token: str = Header(alias="X-Invite-Token")):
    return {"received": bool(x_invite_token)}
