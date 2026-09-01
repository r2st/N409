"""The service's discovery document has to match the service.

``GET /`` returns an ``endpoints`` list, and it is a contract rather than a
courtesy: individual endpoints assert their own presence in it (see
``test_comparables``, ``test_gift_estate``, ``test_ifrs2``, ``test_market_data``,
``test_fair_value_820``), which is exactly the shape that keeps a roster honest
one entry at a time and silent about the entries nobody thought to add.

Six were missing — the four fund routes and both debt routes, added to the app
and never to the list. A caller reading the document to find out what this
service answers was told the endpoints its own fund and debt packs depend on do
not exist.

So the roster is checked against the routes FastAPI actually registered, in
both directions: an endpoint added without a line here fails, and a line left
behind by a deleted endpoint fails too.
"""

from fastapi.routing import APIRoute

from app.main import app, root

# Registered but deliberately absent from the list. `/` is the document
# itself, and the FastAPI-provided docs pages are advertised under `/docs` —
# the one entry in the list that is not a route of ours.
NOT_ADVERTISED = {"/", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
ADVERTISED_WITHOUT_A_ROUTE = {"/docs"}


def registered_paths() -> set[str]:
    return {r.path for r in app.routes if isinstance(r, APIRoute)}


def test_every_registered_endpoint_is_advertised() -> None:
    listed = set(root()["endpoints"])
    missing = registered_paths() - NOT_ADVERTISED - listed
    assert not missing, f"registered but not in GET / endpoints: {sorted(missing)}"


def test_every_advertised_endpoint_is_registered() -> None:
    listed = set(root()["endpoints"]) - ADVERTISED_WITHOUT_A_ROUTE
    stale = listed - registered_paths()
    assert not stale, f"advertised by GET / but not registered: {sorted(stale)}"


def test_the_roster_is_not_empty() -> None:
    """A census reading nothing passes for the wrong reason."""
    assert len(registered_paths()) >= 25
    assert len(root()["endpoints"]) >= 25
