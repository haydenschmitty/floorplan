from fastapi import FastAPI

from app.routers import catalog, invoices, notes, orders, tickets

app = FastAPI()
app.include_router(tickets.router)
app.include_router(orders.router)
app.include_router(invoices.router)
app.include_router(catalog.router)
app.include_router(catalog.drafts)
app.include_router(notes.router)
