"""Response security headers on the engine service (round 74).

Same module and same reasoning as the AI service (app/security_headers.py).
The engine's own reason to want them is its 422s: `validate_payload` and the
`EngineInputError` handlers put the caller's field names and values straight
into `detail`, so every malformed compute is a JSON response echoing caller
text — the shape a content-sniffing browser turns into script.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_carries_the_full_set():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert res.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "max-age=15552000" in res.headers["strict-transport-security"]
    csp = res.headers["content-security-policy"]
    assert "default-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert res.headers["cross-origin-resource-policy"] == "same-site"
    policy = res.headers["permissions-policy"]
    assert "geolocation=()" in policy
    assert "idle-detection=()" in policy
    assert "serial=()" in policy
    assert "clipboard-read=()" in policy


def test_ready_and_the_versioned_health_carry_them():
    for path in ("/ready", "/engine/v1/health"):
        res = client.get(path)
        assert res.status_code == 200, path
        assert res.headers["x-content-type-options"] == "nosniff", path


def test_a_422_that_echoes_the_caller_is_not_bare(monkeypatch):
    """The engine's validation errors quote the caller's own field values."""
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    res = client.post("/engine/v1/compute", json={"nonsense": True})
    assert res.status_code == 422
    assert res.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'none'" in res.headers["content-security-policy"]


def test_the_token_gate_401_is_not_bare(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "s3cret")
    res = client.post("/engine/v1/compute", json={})
    assert res.status_code == 401
    assert res.headers["x-content-type-options"] == "nosniff"


def test_the_body_cap_413_is_not_bare(monkeypatch):
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    res = client.post(
        "/engine/v1/compute",
        content=b"x" * 16,
        headers={"content-length": str(64 * 1024 * 1024), "content-type": "application/json"},
    )
    assert res.status_code == 413
    assert res.headers["x-content-type-options"] == "nosniff"


def test_a_404_is_not_bare():
    res = client.get("/no-such-route")
    assert res.status_code == 404
    assert res.headers["x-content-type-options"] == "nosniff"


def test_the_doc_ui_gets_a_policy_it_can_load_under():
    res = client.get("/docs")
    assert res.status_code == 200
    csp = res.headers["content-security-policy"]
    assert "https://cdn.jsdelivr.net" in csp
    assert "frame-ancestors 'none'" in csp


def test_no_cors_grant_is_ever_issued():
    """The valuation service is the only caller and it is not a browser."""
    res = client.get("/health", headers={"origin": "https://attacker.example"})
    assert res.status_code == 200
    assert "access-control-allow-origin" not in res.headers
    assert "access-control-allow-credentials" not in res.headers


def test_a_preflight_for_compute_is_not_answered():
    res = client.options(
        "/engine/v1/compute",
        headers={
            "origin": "https://attacker.example",
            "access-control-request-method": "POST",
        },
    )
    assert "access-control-allow-origin" not in res.headers
    assert "access-control-allow-methods" not in res.headers
