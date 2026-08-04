"""Internal shared-secret auth (audit B-1 P0).

When INTERNAL_SERVICE_TOKEN is set, every non-health route requires a matching
X-Internal-Token header; health/introspection routes stay open; and an unset
secret leaves the service open (dev/test) but logs a warning.
"""

import logging

import pytest
from fastapi.testclient import TestClient

from app.internal_auth import (
    INTERNAL_TOKEN_ENV,
    is_public_path,
    tokens_match,
    warn_if_unset,
)
from app.main import app

TOKEN = "s3cret-internal-token"


@pytest.fixture
def client():
    return TestClient(app)


def test_public_paths_never_require_the_token(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    for path in ("/", "/health", "/ready", "/engine/v1/health", "/openapi.json"):
        res = client.get(path)
        assert res.status_code == 200, f"{path} -> {res.status_code}"


def test_compute_rejects_missing_token(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    res = client.post("/engine/v1/compute", json={"params": {}, "inputs": {}})
    assert res.status_code == 401
    assert "internal service token" in res.json()["detail"].lower()


def test_compute_rejects_wrong_token(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    res = client.post(
        "/engine/v1/compute",
        json={"params": {}, "inputs": {}},
        headers={"X-Internal-Token": "wrong"},
    )
    assert res.status_code == 401


def test_correct_token_passes_the_gate(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    res = client.post(
        "/engine/v1/compute",
        json={"params": {}, "inputs": {}},
        headers={"X-Internal-Token": TOKEN},
    )
    # Anything but 401 proves we cleared the auth gate (200 or a 4xx/5xx from
    # the compute handler itself — never the auth layer's 401).
    assert res.status_code != 401


def test_unset_secret_leaves_service_open(monkeypatch, client):
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    res = client.post("/engine/v1/compute", json={"params": {}, "inputs": {}})
    assert res.status_code != 401


def test_warn_if_unset_logs(monkeypatch, caplog):
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    with caplog.at_level(logging.WARNING):
        warn_if_unset()
    assert any(INTERNAL_TOKEN_ENV in r.message for r in caplog.records)


def test_is_public_path():
    assert is_public_path("/engine/v1/health")
    assert not is_public_path("/engine/v1/compute")


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
        "/engine/v1/compute",
        json={"params": {}, "inputs": {}},
        headers={b"X-Internal-Token": raw},
    )
    assert res.status_code == 401, res.text


def test_non_ascii_secret_still_authenticates_its_own_caller(monkeypatch, client):
    """A secret is opaque bytes; nothing requires an operator to pick ASCII."""
    secret = "ünïcødé-token-🔑"
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, secret)
    res = client.post(
        "/engine/v1/compute",
        json={"params": {}, "inputs": {}},
        headers={b"X-Internal-Token": secret.encode()},
    )
    assert res.status_code != 401  # cleared the gate


def test_tokens_match_is_total_over_header_values():
    """No header value may raise; only a byte-for-byte match may return True."""
    assert tokens_match(None, TOKEN) is False
    assert tokens_match("café", TOKEN) is False
    assert tokens_match("", TOKEN) is False
    assert tokens_match("\U0001f511", TOKEN) is False  # above latin-1, no raise
    assert tokens_match(TOKEN, TOKEN) is True


def test_tokens_match_compares_wire_bytes_not_decoded_text():
    """`provided` is latin-1-decoded off the wire; `expected` is UTF-8 from env."""
    secret = "ünïcødé-token"
    on_the_wire = secret.encode("utf-8").decode("latin-1")
    assert tokens_match(on_the_wire, secret) is True
    assert tokens_match(secret, secret) is False
