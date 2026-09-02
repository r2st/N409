"""Per-caller request ceiling on the AI service.

The counter itself is covered in the engine's test_ratelimit.py — the module is
the same one. What differs here is the tuning and what it protects: every
pipeline blocks on an LLM for up to 90 seconds and spends tokens, so a caller
that loops costs real money and is slower to notice than a runaway compute.
"""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors import install_error_handlers, make_unhandled_error_middleware
from app.main import app
from app.observability import make_request_context_middleware
from app.ratelimit import DEFAULT_LIMIT_PER_MINUTE, limit_per_minute, make_rate_limit_middleware

# What app/main.py passes. Lower than the engine's, deliberately.
AI_LIMIT_PER_MINUTE = 240


@pytest.fixture
def limited_client() -> TestClient:
    limited = FastAPI()

    @limited.post("/ai/v1/pipelines/thing")
    def _thing() -> dict:
        return {"ok": True}

    @limited.get("/ready")
    def _ready() -> dict:
        return {"status": "ready"}

    limited.add_middleware(make_rate_limit_middleware(2, window_s=60))
    limited.add_middleware(make_unhandled_error_middleware("ai"))
    limited.add_middleware(make_request_context_middleware("ai"))
    install_error_handlers(limited)
    return TestClient(limited)


class TestTuning:
    def test_the_ai_ceiling_is_lower_than_the_engines(self, monkeypatch) -> None:
        # An LLM pipeline is orders of magnitude more expensive than a compute,
        # so it does not get the same allowance.
        monkeypatch.delenv("RATE_LIMIT_RPM", raising=False)
        assert limit_per_minute(AI_LIMIT_PER_MINUTE) == AI_LIMIT_PER_MINUTE
        assert AI_LIMIT_PER_MINUTE < DEFAULT_LIMIT_PER_MINUTE

    def test_an_explicit_setting_still_wins(self, monkeypatch) -> None:
        monkeypatch.setenv("RATE_LIMIT_RPM", "12")
        assert limit_per_minute(AI_LIMIT_PER_MINUTE) == 12


class TestMiddleware:
    def test_a_looping_caller_is_cut_off(self, limited_client: TestClient) -> None:
        assert limited_client.post("/ai/v1/pipelines/thing").status_code == 200
        assert limited_client.post("/ai/v1/pipelines/thing").status_code == 200
        assert limited_client.post("/ai/v1/pipelines/thing").status_code == 429

    def test_the_refusal_is_json_and_traceable(self, limited_client: TestClient) -> None:
        headers = {"x-request-id": "ai-flood-1"}
        res = [limited_client.post("/ai/v1/pipelines/thing", headers=headers) for _ in range(3)][-1]
        assert res.status_code == 429
        assert res.json()["request_id"] == "ai-flood-1"
        assert int(res.headers["retry-after"]) >= 1

    def test_readiness_probes_are_exempt(self, limited_client: TestClient) -> None:
        for _ in range(20):
            assert limited_client.get("/ready").status_code == 200
        assert limited_client.post("/ai/v1/pipelines/thing").status_code == 200

    def test_refusals_are_logged_as_warnings(
        self, limited_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.WARNING):
            for _ in range(3):
                limited_client.post("/ai/v1/pipelines/thing")
        exceeded = [r for r in caplog.records if getattr(r, "event", None) == "ratelimit_exceeded"]
        assert len(exceeded) == 1


class TestRealApp:
    def test_the_shipped_app_advertises_the_ai_ceiling(self) -> None:
        res = TestClient(app).post("/ai/v1/test", json={})
        # 422 for an empty body — the point is the limiter ran and annotated it.
        assert res.headers["x-ratelimit-limit"] == str(AI_LIMIT_PER_MINUTE)

    def test_normal_traffic_is_not_throttled(self) -> None:
        client = TestClient(app)
        assert all(client.get("/ai/v1/models").status_code == 200 for _ in range(30))
