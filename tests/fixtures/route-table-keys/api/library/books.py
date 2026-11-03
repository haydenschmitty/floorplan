def newest():
    return []


def one(book_id):
    return {"id": book_id}


def lend(event, book_id):
    """Lends a book to the signed-in reader."""
    return 201, {}
