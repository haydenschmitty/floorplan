from fastapi import HTTPException
from twilio.request_validator import RequestValidator

def validated_sender(request):
    validator = RequestValidator("server-secret")
    if not validator.validate(request.url, request.form(), request.headers.get("X-Twilio-Signature")):
        raise HTTPException(status_code=403)
    return "sender"

def unverified_sender(request):
    return "sender"
