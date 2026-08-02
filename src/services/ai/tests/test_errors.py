"""Every error this service can emit is JSON and carries its request id.

Before the errors module, an exception nobody caught produced the Starlette
default: ``text/plain`` reading ``Internal Server Error``, no ``x-request-id``
header, and not one log line with a traceback. Each of those is held separately
below, because each was a distinct way an operator lost the thread on a
production 500.

The stakes are higher here than in the engine: this service handles uploaded
documents and cap tables, so an exception message that reaches the caller — or
an unredacted one that reaches the log — is a disclosure, not just noise.
"""

from __future__ import annotations

import json
import logging

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.errors import INTERNAL_ERROR_DETAIL, install_error_handlers, make_unhandled_error_middleware
from app.main import app
from app.observability import make_request_context_middleware

client = TestClient(app)

# Stands in for the thing that must never reach the caller: an exception
# message in this service can quote the document that caused it.
SECRET_MESSAGE = "acme-holdings founder grant schedule"


@pytest.fixture
def boom_client() -> TestClient:
    """A throwaway app wired exactly like the real one, with a route that raises."""
    boom_app = FastAPI()

    @boom_app.post("/boom")
    def _boom() -> dict:
        raise RuntimeError(SECRET_MESSAGE)

    @boom_app.get("/teapot")
    def _teapot() -> dict:
        raise HTTPException(status_code=418, detail="I'm a teapot", headers={"x-brew": "no"})

    boom_app.middleware("http")(make_unhandled_error_middleware("ai"))
    boom_app.middleware("http")(make_request_context_middleware("ai"))
    install_error_handlers(boom_app)
    return TestClient(boom_app)


class TestUnhandledException:
    def test_answers_json_not_plain_text(self, boom_client: TestClient) -> None:
        res = boom_client.post("/boom")
        assert res.status_code == 500
        assert res.headers["content-type"].startswith("application/json")
        assert res.json()["detail"] == INTERNAL_ERROR_DETAIL

    def test_does_not_leak_the_exception_message(self, boom_client: TestClient) -> None:
        res = boom_client.post("/boom")
        assert SECRET_MESSAGE not in res.text
        assert "Traceback" not in res.text

    def test_echoes_the_callers_request_id(self, boom_client: TestClient) -> None:
        res = boom_client.post("/boom", headers={"x-request-id": "ai-trace-7"})
        assert res.headers["x-request-id"] == "ai-trace-7"
        assert res.json()["request_id"] == "ai-trace-7"

    def test_logs_the_traceback_once_at_error_level(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.ERROR):
            boom_client.post("/boom", headers={"x-request-id": "ai-trace-8"})
        unhandled = [r for r in caplog.records if getattr(r, "event", None) == "unhandled_error"]
        assert len(unhandled) == 1
        assert unhandled[0].exc_info is not None
        assert SECRET_MESSAGE in logging.Formatter().formatException(unhandled[0].exc_info)

    def test_access_log_records_the_500_at_error_level(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.INFO):
            boom_client.post("/boom")
        access = next(r for r in caplog.records if getattr(r, "event", None) == "http_access")
        assert access.status == 500
        assert access.levelno == logging.ERROR


class TestDeliberateFailures:
    def test_http_exception_keeps_its_detail_and_gains_a_request_id(
        self, boom_client: TestClient
    ) -> None:
        res = boom_client.get("/teapot", headers={"x-request-id": "pot-2"})
        assert res.status_code == 418
        assert res.json()["detail"] == "I'm a teapot"
        assert res.json()["request_id"] == "pot-2"
        assert res.headers["x-brew"] == "no"

    def test_unknown_pipeline_404_carries_a_request_id(self) -> None:
        res = client.post(
            "/ai/v1/pipelines/no-such-pipeline",
            json={"valuation": {}},
            headers={"x-request-id": "missing-1"},
        )
        assert res.status_code == 404
        assert res.json()["detail"] == "Unknown pipeline 'no-such-pipeline'"
        assert res.json()["request_id"] == "missing-1"

    def test_request_validation_error_keeps_fastapis_detail_list(self) -> None:
        # /ai/v1/test requires `system` and `user`; omitting both fails in
        # Pydantic before the route runs.
        res = client.post("/ai/v1/test", json={})
        assert res.status_code == 422
        body = res.json()
        assert isinstance(body["detail"], list)
        assert body["detail"][0]["loc"]
        assert body["request_id"]
        json.dumps(body)  # would raise if a non-serialisable ctx value leaked

    def test_oversized_body_rejection_carries_a_request_id(self) -> None:
        res = client.post(
            "/ai/v1/pipelines/data_extraction",
            content="{}",
            headers={
                "content-type": "application/json",
                "content-length": str(64 * 1024 * 1024),
                "x-request-id": "too-big-2",
            },
        )
        assert res.status_code == 413
        assert res.json()["request_id"] == "too-big-2"

    def test_rejected_internal_token_carries_a_request_id(self, monkeypatch) -> None:
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "s3cret")
        res = client.post(
            "/ai/v1/pipelines/data_extraction",
            json={"valuation": {}},
            headers={"x-internal-token": "wrong", "x-request-id": "denied-2"},
        )
        assert res.status_code == 401
        assert res.json()["request_id"] == "denied-2"
        assert res.headers["x-request-id"] == "denied-2"

    def test_4xx_access_log_is_a_warning_not_an_error(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.INFO):
            client.post("/ai/v1/test", json={})
        access = next(r for r in caplog.records if getattr(r, "event", None) == "http_access")
        assert access.status == 422
        assert access.levelno == logging.WARNING
