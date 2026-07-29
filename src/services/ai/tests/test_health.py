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


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai"


def test_ready_503s_when_key_is_missing(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    res = client.get("/ready")
    assert res.status_code == 503
    body = res.json()
    assert body["status"] == "unavailable"
    assert body["checks"]["openrouter_key"] == "missing"


def test_ready_503s_on_a_wrong_provider_key(monkeypatch):
    """The old check passed anything non-empty; an OpenAI key must not."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-proj-not-an-openrouter-key")
    res = client.get("/ready")
    assert res.status_code == 503
    assert res.json()["checks"]["openrouter_key"] == "malformed"


def test_ready_503s_when_openrouter_rejects_the_key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-revoked")
    monkeypatch.setattr(
        openrouter,
        "_probe_key",
        lambda key, client=None: KeyStatus("invalid", "OpenRouter rejected it"),
    )
    res = client.get("/ready")
    assert res.status_code == 503
    body = res.json()
    assert body["checks"]["openrouter_key"] == "invalid"
    assert "rejected" in body["checks"]["openrouter_key_detail"]


def test_ready_200s_when_the_key_verifies(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-good")
    monkeypatch.setattr(
        openrouter,
        "_probe_key",
        lambda key, client=None: KeyStatus("valid", "OpenRouter accepted key 'ci'"),
    )
    res = client.get("/ready")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ready"
    assert body["checks"]["openrouter_key"] == "valid"
    assert body["checks"]["models"]
