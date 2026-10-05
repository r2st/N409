"""Response security headers on the AI service (round 74).

The Fastify pair have carried helmet since the B-1 audit; this service carried
nothing. See app/security_headers.py for why loopback binding does not make
that harmless.
"""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import openrouter
from app.main import app
from app.openrouter import KeyStatus

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_key_cache():
    openrouter.reset_key_cache()
    yield
    openrouter.reset_key_cache()


def _healthy(monkeypatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-good")
    monkeypatch.setattr(
        openrouter, "_probe_key", lambda key, client=None: KeyStatus("valid", "ok")
    )
    monkeypatch.setattr(
        "app.main.verify_search_provider", lambda: SimpleNamespace(state="valid", detail="ok")
    )


def test_health_carries_the_full_set():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert res.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "max-age=15552000" in res.headers["strict-transport-security"]
    assert "includeSubDomains" in res.headers["strict-transport-security"]
    csp = res.headers["content-security-policy"]
    assert "default-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert res.headers["cross-origin-resource-policy"] == "same-site"
    # Explicitly requested this round and not something helmet sets either:
    # every powerful feature denied outright on an API response.
    policy = res.headers["permissions-policy"]
    assert "geolocation=()" in policy
    assert "camera=()" in policy
    assert "microphone=()" in policy
    assert "idle-detection=()" in policy
    assert "serial=()" in policy
    assert "clipboard-read=()" in policy


def test_ready_carries_them_on_both_verdicts(monkeypatch):
    _healthy(monkeypatch)
    assert client.get("/ready").headers["x-content-type-options"] == "nosniff"
    monkeypatch.setattr(
        openrouter, "_probe_key", lambda key, client=None: KeyStatus("invalid", "no")
    )
    openrouter.reset_key_cache()
    res = client.get("/ready")
    assert res.status_code == 503
    assert res.headers["x-content-type-options"] == "nosniff"


class TestResponsesThatNeverReachARoute:
    """The middleware is outermost precisely so these are covered.

    Each of these is produced by a layer *above* the router and returns a body
    holding a caller-influenced string, so each is a response that must not go
    out bare — and each would have, had the headers been added as a route
    dependency or an `after_request` on the handlers.
    """

    def test_the_token_gate_401(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "s3cret")
        res = client.post("/ai/v1/pipelines/missing_data", json={})
        assert res.status_code == 401
        assert res.headers["x-content-type-options"] == "nosniff"
        assert "default-src 'none'" in res.headers["content-security-policy"]

    def test_the_body_cap_413(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
        res = client.post(
            "/ai/v1/pipelines/missing_data",
            content=b"x" * 16,
            headers={"content-length": str(64 * 1024 * 1024), "content-type": "application/json"},
        )
        assert res.status_code == 413
        assert res.headers["x-content-type-options"] == "nosniff"

    def test_a_404(self):
        res = client.get("/no-such-route")
        assert res.status_code == 404
        assert res.headers["x-content-type-options"] == "nosniff"

    def test_a_422_that_echoes_the_caller(self, monkeypatch):
        """A validation error puts the caller's own input in the body. That is
        the exact shape a sniffing browser turns into script."""
        monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
        res = client.post("/ai/v1/research", json={"query": ""})
        assert res.status_code == 422
        assert res.headers["x-content-type-options"] == "nosniff"


def test_the_doc_ui_gets_a_policy_it_can_actually_load_under():
    """`default-src 'none'` would leave /docs blank, and a blank page is how a
    header gets turned off. Pinned to the hosts Swagger UI really fetches."""
    res = client.get("/docs")
    assert res.status_code == 200
    csp = res.headers["content-security-policy"]
    assert "https://cdn.jsdelivr.net" in csp
    # Still no framing and still no default: only what the page needs.
    assert "frame-ancestors 'none'" in csp
    assert "default-src 'none'" in csp
    assert res.headers["x-content-type-options"] == "nosniff"


def test_no_cors_grant_is_ever_issued():
    """The AI service has exactly one legitimate caller and it is not a browser.
    Registering CORSMiddleware with the `allow_origins=['*']` convention default
    would make every pipeline readable from any page — asserted with an Origin
    present, because CORS headers only appear when one is."""
    res = client.get("/health", headers={"origin": "https://attacker.example"})
    assert res.status_code == 200
    assert "access-control-allow-origin" not in res.headers
    assert "access-control-allow-credentials" not in res.headers


def test_a_preflight_for_a_pipeline_is_not_answered():
    res = client.options(
        "/ai/v1/pipelines/missing_data",
        headers={
            "origin": "https://attacker.example",
            "access-control-request-method": "POST",
        },
    )
    assert "access-control-allow-origin" not in res.headers
    assert "access-control-allow-methods" not in res.headers
