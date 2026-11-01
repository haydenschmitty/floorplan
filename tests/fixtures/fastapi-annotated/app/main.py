from fastapi import FastAPI

from app.routers import comments, feedback, notes, offices, public_health, reports, things

app = FastAPI()
app.include_router(public_health.router)
app.include_router(things.router)
app.include_router(notes.router)
app.include_router(offices.router)
app.include_router(feedback.router)
app.include_router(reports.router)
app.include_router(comments.router)
