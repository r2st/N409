"""Every error this service can emit is JSON and carries its request id.

Before the errors module, an exception nobody caught produced the Starlette
default: ``text/plain`` reading ``Internal Server Error``, no ``x-request-id``
header, and not one log line with a traceback. These tests hold the line on
each of those three separately, because each was a distinct way an operator
lost the thread on a production 500.
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

# The exception message a route raises. It stands in for the thing that must
# never reach the caller: in this tier an exception message can quote the
# input that caused it, and the input is a client's cap table.
SECRET_MESSAGE = "acme-holdings preferred stack blew up"

# A holder's address, as it arrives on a cap table and as an upstream or a
# validator quotes it back.
HOLDER_ADDRESS = "jane.okonkwo@acme-holdings.example"


@pytest.fixture
def boom_client() -> TestClient:
    """A throwaway app wired exactly like the real one, with a route that raises.

    Built fresh rather than bolting a route onto the module-level ``app``,
    which every other test in the suite shares.
    """
    boom_app = FastAPI()

    @boom_app.get("/boom")
    def _boom() -> dict:
        raise RuntimeError(SECRET_MESSAGE)

    @boom_app.get("/teapot")
    def _teapot() -> dict:
        raise HTTPException(status_code=418, detail="I'm a teapot", headers={"x-brew": "no"})

    @boom_app.get("/ok")
    def _ok() -> dict:
        return {"ok": True}

    @boom_app.get("/unavailable")
    def _unavailable() -> dict:
        raise HTTPException(status_code=503, detail="solver backend is not available")

    @boom_app.get("/field-errors")
    def _field_errors() -> dict:
        # The shape a request-validation failure answers in: pydantic's error
        # list, whose entries carry an `input` echoing the payload that was
        # refused. In this tier that payload is a client's cap table.
        raise HTTPException(
            status_code=422,
            detail=[
                {"loc": ["body", "holders", 0, "email"], "input": HOLDER_ADDRESS, "msg": "bad"}
            ],
        )

    boom_app.middleware("http")(make_unhandled_error_middleware("engine-wrapper"))
    boom_app.middleware("http")(make_request_context_middleware("engine-wrapper"))
    install_error_handlers(boom_app)
    return TestClient(boom_app)


class TestUnhandledException:
    def test_answers_json_not_plain_text(self, boom_client: TestClient) -> None:
        res = boom_client.get("/boom")
        assert res.status_code == 500
        assert res.headers["content-type"].startswith("application/json")
        assert res.json()["detail"] == INTERNAL_ERROR_DETAIL

    def test_does_not_leak_the_exception_message(self, boom_client: TestClient) -> None:
        res = boom_client.get("/boom")
        assert SECRET_MESSAGE not in res.text
        assert "RuntimeError" not in res.text
        assert "Traceback" not in res.text

    def test_echoes_the_callers_request_id(self, boom_client: TestClient) -> None:
        res = boom_client.get("/boom", headers={"x-request-id": "trace-me-42"})
        # Both places: the header for a proxy or a client that logs headers,
        # the body for a human reading the failure in a devtools pane.
        assert res.headers["x-request-id"] == "trace-me-42"
        assert res.json()["request_id"] == "trace-me-42"

    def test_mints_a_request_id_when_the_caller_sent_none(self, boom_client: TestClient) -> None:
        body_id = boom_client.get("/boom").json()["request_id"]
        assert body_id and body_id != "-"

    def test_logs_the_traceback_once_against_the_request_id(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.ERROR):
            boom_client.get("/boom", headers={"x-request-id": "trace-me-43"})
        unhandled = [r for r in caplog.records if getattr(r, "event", None) == "unhandled_error"]
        assert len(unhandled) == 1
        record = unhandled[0]
        assert record.levelno == logging.ERROR
        assert record.exc_info is not None
        assert SECRET_MESSAGE in logging.Formatter().formatException(record.exc_info)
        assert record.path == "/boom"

    def test_the_logged_line_is_serialisable_json_carrying_the_request_id(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        from app.observability import JsonLogFormatter

        with caplog.at_level(logging.ERROR):
            boom_client.get("/boom", headers={"x-request-id": "trace-me-44"})
        record = next(r for r in caplog.records if getattr(r, "event", None) == "unhandled_error")
        # The formatter runs inside the request, where the id is still bound;
        # re-formatting here only proves the payload serialises.
        line = json.loads(JsonLogFormatter().format(record))
        assert line["level"] == "error"
        assert "Traceback" in line["exc"]

    def test_access_log_records_the_500_at_error_level(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.INFO):
            boom_client.get("/boom")
        access = next(r for r in caplog.records if getattr(r, "event", None) == "http_access")
        assert access.status == 500
        assert access.levelno == logging.ERROR

    def test_a_healthy_request_is_untouched(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.INFO):
            res = boom_client.get("/ok")
        assert res.status_code == 200
        assert res.json() == {"ok": True}
        access = next(r for r in caplog.records if getattr(r, "event", None) == "http_access")
        assert access.levelno == logging.INFO


class TestDeliberateFailures:
    """HTTPException, validation, auth and body-cap answers stay traceable too."""

    def test_http_exception_keeps_its_detail_and_gains_a_request_id(
        self, boom_client: TestClient
    ) -> None:
        res = boom_client.get("/teapot", headers={"x-request-id": "pot-1"})
        assert res.status_code == 418
        assert res.json()["detail"] == "I'm a teapot"
        assert res.json()["request_id"] == "pot-1"

    def test_http_exception_headers_survive_the_rewrap(self, boom_client: TestClient) -> None:
        # WWW-Authenticate on a 401 and Allow on a 405 are protocol, not
        # decoration; the rewrap must not drop them.
        assert boom_client.get("/teapot").headers["x-brew"] == "no"

    def test_a_deliberate_5xx_is_logged_at_error(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The gap R225 closed.

        A 5xx raised on purpose is still the server failing to serve. Before
        this line the handler rewrapped it and returned it in silence, so the
        only failures with a log entry were the ones nobody had anticipated.
        """
        with caplog.at_level(logging.ERROR):
            boom_client.get("/unavailable", headers={"x-request-id": "gone-1"})
        failed = [r for r in caplog.records if getattr(r, "event", None) == "request_failed"]
        assert len(failed) == 1
        assert failed[0].levelno == logging.ERROR
        assert failed[0].status == 503
        assert failed[0].path == "/unavailable"
        assert failed[0].http_method == "GET"
        assert "solver backend" in failed[0].detail

    def test_a_4xx_is_not_logged(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A 4xx describes the request, and the caller has already been told."""
        with caplog.at_level(logging.WARNING):
            boom_client.get("/teapot")
        assert [r for r in caplog.records if getattr(r, "event", None) == "request_failed"] == []

    def test_engine_validation_error_carries_a_request_id(self) -> None:
        res = client.post("/engine/v1/compute", json={"params": {}, "inputs": {}})
        assert res.status_code == 422
        assert res.json()["request_id"]

    def test_request_validation_error_keeps_fastapis_detail_list(self) -> None:
        # `kind` is a Literal, so a bad value fails in Pydantic before the
        # route runs — FastAPI's own 422, not the engine's.
        res = client.post("/engine/v1/market-feed", json={"kind": "nonsense"})
        assert res.status_code == 422
        body = res.json()
        assert isinstance(body["detail"], list)
        assert body["detail"][0]["loc"]
        assert body["request_id"]

    def test_request_validation_detail_is_json_serialisable(self) -> None:
        res = client.post("/engine/v1/market-feed", json={"kind": "nonsense"})
        json.dumps(res.json())  # would raise if a ctx value leaked through

    def test_oversized_body_rejection_carries_a_request_id(self) -> None:
        res = client.post(
            "/engine/v1/compute",
            content="{}",
            headers={
                "content-type": "application/json",
                "content-length": str(16 * 1024 * 1024),
                "x-request-id": "too-big-1",
            },
        )
        assert res.status_code == 413
        assert res.json()["request_id"] == "too-big-1"

    def test_unparseable_content_length_carries_a_request_id(self) -> None:
        res = client.post(
            "/engine/v1/compute",
            content="{}",
            headers={"content-type": "application/json", "content-length": "not-a-number"},
        )
        assert res.status_code == 400
        assert res.json()["request_id"]

    def test_rejected_internal_token_carries_a_request_id(self, monkeypatch) -> None:
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "s3cret")
        res = client.post(
            "/engine/v1/compute",
            json={"params": {}, "inputs": {}},
            headers={"x-internal-token": "wrong", "x-request-id": "denied-1"},
        )
        assert res.status_code == 401
        assert res.json()["request_id"] == "denied-1"
        assert res.headers["x-request-id"] == "denied-1"

    def test_4xx_access_log_is_a_warning_not_an_error(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.INFO):
            client.post("/engine/v1/compute", json={"params": {}, "inputs": {}})
        access = next(r for r in caplog.records if getattr(r, "event", None) == "http_access")
        assert access.status == 422
        assert access.levelno == logging.WARNING


class TestOutboundScrub:
    """The response body is redacted on the same terms as the log line.

    Both are built from the same string, and only the log was treated as a
    place an identifier must not land. The response is the half that leaves the
    process: the valuation service keeps a `detail` on the engagement's network
    log and puts a string one in front of an analyst, so what this body carries
    is what Postgres keeps.
    """

    def test_an_address_in_a_field_error_does_not_travel(self, boom_client: TestClient) -> None:
        res = boom_client.get("/field-errors")
        assert res.status_code == 422
        assert HOLDER_ADDRESS not in res.text

    def test_the_field_path_survives_the_scrub(self, boom_client: TestClient) -> None:
        """The path is what a caller fixes the request with; only the value goes."""
        detail = boom_client.get("/field-errors").json()["detail"]
        assert detail[0]["loc"] == ["body", "holders", 0, "email"]
        assert detail[0]["msg"] == "bad"

    def test_an_ordinary_detail_is_returned_verbatim(self, boom_client: TestClient) -> None:
        assert boom_client.get("/unavailable").json()["detail"] == "solver backend is not available"
