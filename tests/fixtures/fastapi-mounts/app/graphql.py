"""Builds the router for the GraphQL endpoint. A library serves it, so no route is written out here."""
from graphql_kit import router_for


def make_graphql_router():
    return router_for("schema.graphql")
