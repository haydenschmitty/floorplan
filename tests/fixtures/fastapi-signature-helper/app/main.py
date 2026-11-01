from fastapi import FastAPI, Request
from app.auth import validated_sender, unverified_sender

app = FastAPI()

@app.post("/webhook/verified")
async def receive_verified(request: Request):
    sender = await validated_sender(request)
    return {"sender": sender}

@app.post("/webhook/unverified")
async def receive_unverified(request: Request):
    sender = await unverified_sender(request)
    return {"sender": sender}
