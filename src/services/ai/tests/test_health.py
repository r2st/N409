from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai"


def test_ready_reports_openrouter_key_state(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    res = client.get("/ready")
    assert res.status_code == 200
    assert res.json()["checks"]["openrouter_key"] == "missing"

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    res = client.get("/ready")
    assert res.json()["checks"]["openrouter_key"] == "configured"
