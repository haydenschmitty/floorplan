"""Library server: one function behind a cloud HTTP gateway, routed by a lookup table."""
import json

import auth
import books


def list_books(event):
    """The whole catalogue, newest first."""
    return 200, books.newest()


def get_book(event, book_id):
    """One book with its loan history."""
    return 200, books.one(book_id)


def health(event):
    return 200, {"ok": True}


ROUTES = {
    "GET /api/books": list_books,
    "GET /api/books/{book_id}": get_book,
    "POST /api/books/{book_id}/loans": books.lend,
    "POST /api/login": auth.login,
    "GET /api/status": lambda e: health(e),
}


def handler(event, context):
    route = f'{event["method"]} {event["path"]}'
    fn = ROUTES.get(route)
    return fn(event) if fn else (404, {})
