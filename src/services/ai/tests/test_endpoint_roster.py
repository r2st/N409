"""The service's discovery document has to match the service.

``GET /`` returns an ``endpoints`` list. ``/ai/v1/anonymize`` was registered and
never listed, so a caller reading the document to find out what this service
answers was told the redaction endpoint does not exist.

Checked against the routes FastAPI actually registered, in both directions —
the engine wrapper carries the same guard for the same reason.
"""

from fastapi.routing import APIRoute

from app.main import app, root

# `/` is the document itself; the FastAPI docs pages are advertised under the
# single `/docs` entry, which is the one line here that is not a route of ours.
# `/metrics` is registered and deliberately not listed: `GET /` is public on
# this service, and the discovery document is not the place to tell whoever
# found the port that there is a scrape endpoint behind a secret.
NOT_ADVERTISED = {"/", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc", "/metrics"}
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
    assert len(registered_paths()) >= 6
    assert len(root()["endpoints"]) >= 6
