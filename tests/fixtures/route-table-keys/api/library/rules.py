"""Who may call what. Keyed like the route table, but these values are access levels, not handlers."""
PUBLIC, SIGNED_IN = "public", "signed-in"

LEVELS = {
    "GET /api/books": PUBLIC,
    "GET /api/books/{book_id}": PUBLIC,
    "POST /api/books/{book_id}/loans": SIGNED_IN,
}

NOTES = {
    "GET /api/books": "cached for a minute",
    "POST /api/login": "rate limited",
}
