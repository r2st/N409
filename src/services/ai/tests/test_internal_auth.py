"""Internal shared-secret auth (audit B-1 P0).

When INTERNAL_SERVICE_TOKEN is set, every non-health route requires a matching
X-Internal-Token header; health/introspection routes stay open; and an unset
secret leaves the service open (dev/test) but logs a warning. In production
(APP_ENV=production) an unset secret is a failed boot instead.
"""

import logging

import pytest
from fastapi.testclient import TestClient

from app.internal_auth import (
    INTERNAL_TOKEN_ENV,
    MissingInternalTokenError,
    is_production,
    is_public_path,
    tokens_match,
    enforce_token_configured,
)
from app.main import app

TOKEN = "s3cret-internal-token"

# One route behind the gate, and a body its handler will accept far enough to
# prove the request cleared auth.
PROTECTED_PATH = "/ai/v1/pipelines/__no_such_pipeline__"
PROTECTED_BODY = {"valuation": {}}


@pytest.fixture
def client():
    return TestClient(app)


def test_public_paths_never_require_the_token(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    for path in ("/", "/health"):
        res = client.get(path)
        assert res.status_code == 200, f"{path} -> {res.status_code}"
    # /ready is public too, but its own status depends on the OpenRouter key —
    # what matters here is that the token gate let it through rather than 401ing.
    assert client.get("/ready").status_code in (200, 503)


def test_protected_route_rejects_missing_token(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    res = client.post("/ai/v1/pipelines/missing_data", json={"valuation": {}})
    assert res.status_code == 401
    assert "internal service token" in res.json()["detail"].lower()


def test_protected_route_rejects_wrong_token(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    res = client.post(
        "/ai/v1/pipelines/missing_data",
        json={"valuation": {}},
        headers={"X-Internal-Token": "wrong"},
    )
    assert res.status_code == 401


def test_correct_token_passes_the_gate(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    # 404 (unknown pipeline) proves we got *past* the auth gate into the handler.
    res = client.post(
        "/ai/v1/pipelines/__no_such_pipeline__",
        json={"valuation": {}},
        headers={"X-Internal-Token": TOKEN},
    )
    assert res.status_code == 404


def test_unset_secret_leaves_service_open(monkeypatch, client):
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    res = client.post("/ai/v1/pipelines/__no_such_pipeline__", json={"valuation": {}})
    # No 401 — the gate is a no-op without a configured secret.
    assert res.status_code == 404


def test_unset_secret_warns_outside_production(monkeypatch, caplog):
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    with caplog.at_level(logging.WARNING):
        enforce_token_configured()
    assert any(INTERNAL_TOKEN_ENV in r.message for r in caplog.records)


def test_is_public_path():
    assert is_public_path("/health")
    assert is_public_path("/")
    assert not is_public_path("/ai/v1/pipelines/missing_data")


# ── Non-ASCII header bytes ────────────────────────────────────────────────────
#
# HTTP header values are bytes, and Starlette decodes them as latin-1, so any
# byte above 0x7f reaches the middleware as a non-ASCII `str`. `compare_digest`
# refuses that pair with a TypeError, which is raised *inside* the gate: the
# request was never rejected, it fell through to the unhandled-error middleware
# and came back 500 with a traceback logged. These pin the 401.


@pytest.mark.parametrize(
    "raw",
    [
        b"caf\xe9",  # one latin-1 byte
        b"\xff" * len(TOKEN),  # right length, all high bytes
        TOKEN.encode() + b"\x80",  # the real token plus one
        "🔑".encode(),  # multi-byte UTF-8
    ],
    ids=["latin1", "high-bytes", "token-plus-one", "utf8-emoji"],
)
def test_non_ascii_token_is_rejected_not_crashed(monkeypatch, client, raw):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    res = client.post(
        "/ai/v1/pipelines/__no_such_pipeline__",
        json={"valuation": {}},
        headers={b"X-Internal-Token": raw},
    )
    assert res.status_code == 401, res.text


def test_non_ascii_secret_still_authenticates_its_own_caller(monkeypatch, client):
    """A secret is opaque bytes; nothing requires an operator to pick ASCII."""
    secret = "ünïcødé-token-🔑"
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, secret)
    res = client.post(
        "/ai/v1/pipelines/__no_such_pipeline__",
        json={"valuation": {}},
        headers={b"X-Internal-Token": secret.encode()},
    )
    assert res.status_code == 404  # past the gate, into the handler


def test_tokens_match_is_total_over_header_values():
    """No header value may raise; only a byte-for-byte match may return True."""
    assert tokens_match(None, TOKEN) is False
    assert tokens_match("café", TOKEN) is False
    assert tokens_match("", TOKEN) is False
    assert tokens_match("\U0001f511", TOKEN) is False  # above latin-1, no raise
    assert tokens_match(TOKEN, TOKEN) is True


def test_tokens_match_compares_wire_bytes_not_decoded_text():
    """`provided` is latin-1-decoded off the wire; `expected` is UTF-8 from env.

    So the two sides are re-encoded differently on purpose. For a non-ASCII
    secret that means the *latin-1 reading of its UTF-8 bytes* is what a
    correct caller presents — the same string is not a match, because the same
    string is not what would ever arrive.
    """
    secret = "ünïcødé-token"
    on_the_wire = secret.encode("utf-8").decode("latin-1")
    assert tokens_match(on_the_wire, secret) is True
    assert tokens_match(secret, secret) is False


# ── Fail-closed in production (R25 security audit) ────────────────────────────
#
# The gate was warn-only wherever the secret was missing, so a deploy that
# forgot INTERNAL_SERVICE_TOKEN logged one line and then served every non-health
# route unauthenticated — and that line reads exactly like the one a developer
# laptop prints, where it is correct. Under APP_ENV=production the same
# situation has to stop the service instead.


def test_production_without_a_secret_refuses_to_start(monkeypatch):
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(MissingInternalTokenError) as excinfo:
        enforce_token_configured()
    assert INTERNAL_TOKEN_ENV in str(excinfo.value)


@pytest.mark.parametrize("value", ["production", "PRODUCTION", "Production"])
def test_production_is_recognised_whatever_the_casing(monkeypatch, value):
    monkeypatch.setenv("APP_ENV", value)
    assert is_production() is True


@pytest.mark.parametrize("value", ["", "dev", "staging", "prod", "development"])
def test_only_production_fails_closed(monkeypatch, value):
    """`prod` is deliberately not production: the deploy sets the exact word.

    Guessing at near-misses would mean a laptop with APP_ENV=prod refusing to
    start, which trades one confusing failure for another. The unit files and
    DEPLOYMENT.md all set `production`.
    """
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    monkeypatch.setenv("APP_ENV", value)
    assert is_production() is False
    enforce_token_configured()  # warns, does not raise


def test_production_with_a_secret_starts(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    enforce_token_configured()


def test_production_rejects_requests_if_the_secret_is_unset_after_boot(monkeypatch, client):
    """The token is read per request so it can rotate without a restart.

    Rotating it to nothing must close the gate, not open it — otherwise the
    start-up check is the only thing holding the door and a bad rotation
    silently undoes it.
    """
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    res = client.post(PROTECTED_PATH, json=PROTECTED_BODY)
    assert res.status_code == 401
    assert "internal service token" in res.json()["detail"].lower()


def test_production_keeps_the_probes_open_with_no_secret(monkeypatch, client):
    """A supervisor must still be able to see that the service is up and wrong."""
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    assert client.get("/health").status_code == 200
    assert client.get("/ready").status_code in (200, 503)


# ── The API document is topology, not liveness ────────────────────────────────
#
# R157. `/docs`, `/redoc` and `/openapi.json` used to be in `_PUBLIC_PATHS`,
# which made the complete internal API surface — every pipeline endpoint with
# its full request and response schema — readable by anyone who could reach the
# port. This estate had already ruled on that question one level down: the
# reasons inside a `/ready` body are gated on `is_internal_caller` precisely
# because an installation with no secret configured is the one least able to
# afford publishing its topology. An OpenAPI document is more topology than a
# readiness reason, not less.
#
# The gate is the ordinary one, so nothing changes where no secret is set.


def test_doc_routes_require_the_token_when_one_is_configured(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    for path in ("/openapi.json", "/docs", "/redoc"):
        res = client.get(path)
        assert res.status_code == 401, f"{path} -> {res.status_code}"
        assert "internal service token" in res.json()["detail"].lower()


def test_doc_routes_answer_the_holder_of_the_token(monkeypatch, client):
    # The other half: gated, not removed. A caller that holds the secret still
    # gets the document, so this is a disclosure boundary and not a deletion.
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    for path in ("/openapi.json", "/docs", "/redoc"):
        res = client.get(path, headers={"X-Internal-Token": TOKEN})
        assert res.status_code == 200, f"{path} -> {res.status_code}"


def test_doc_routes_stay_open_where_no_secret_is_configured(monkeypatch, client):
    # Every developer machine and every test run. Gating the docs must not mean
    # the Swagger UI stops working locally, or the gate gets taken back out.
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    for path in ("/openapi.json", "/docs", "/redoc"):
        assert client.get(path).status_code == 200, path


def test_the_public_set_is_exactly_liveness_and_readiness():
    # Stated as an equality rather than as a handful of `assert is_public_path`
    # calls, because the failure this guards against is an *addition*: a path
    # added to the frozenset is unauthenticated on this service from that
    # commit, and a test that only checks the members it already knows about
    # cannot see one arrive.
    from app.internal_auth import _PUBLIC_PATHS

    assert _PUBLIC_PATHS == frozenset({"/", "/health", "/ready"})
