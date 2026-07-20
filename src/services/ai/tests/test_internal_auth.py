"""Internal shared-secret auth (audit B-1 P0).

When INTERNAL_SERVICE_TOKEN is set, every non-health route requires a matching
X-Internal-Token header; health/introspection routes stay open; and an unset
secret leaves the service open (dev/test) but logs a warning.
"""

import logging

import pytest
from fastapi.testclient import TestClient

from app.internal_auth import INTERNAL_TOKEN_ENV, is_public_path, warn_if_unset
from app.main import app

TOKEN = "s3cret-internal-token"


@pytest.fixture
def client():
    return TestClient(app)


def test_public_paths_never_require_the_token(monkeypatch, client):
    monkeypatch.setenv(INTERNAL_TOKEN_ENV, TOKEN)
    for path in ("/", "/health", "/ready", "/openapi.json"):
        res = client.get(path)
        assert res.status_code == 200, f"{path} -> {res.status_code}"


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


def test_warn_if_unset_logs(monkeypatch, caplog):
    monkeypatch.delenv(INTERNAL_TOKEN_ENV, raising=False)
    with caplog.at_level(logging.WARNING):
        warn_if_unset()
    assert any(INTERNAL_TOKEN_ENV in r.message for r in caplog.records)


def test_is_public_path():
    assert is_public_path("/health")
    assert is_public_path("/")
    assert not is_public_path("/ai/v1/pipelines/missing_data")
