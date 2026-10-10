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

# An address the upstream quoted back at us, in the body of its refusal.
FOUNDER_ADDRESS = "jane.okonkwo@acme-holdings.example"

# A deliberate 5xx `detail` the way one is actually built: an upstream's own
# words, joined by `_classify`. Two things in it must not travel — the address
# the provider echoed, and the key it was called with.
UPSTREAM_QUOTE = (
    "All models failed: some/model: HTTP 400 "
    f'{{"error":{{"message":"contact {FOUNDER_ADDRESS} refused"}}}} '
    "| other/model: Authorization: Bearer sk-or-v1-0123456789abcdef0123456789abcdef"
)


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

    @boom_app.get("/unavailable")
    def _unavailable() -> dict:
        # The shape every OpenRouter give-up reaches the caller in.
        raise HTTPException(status_code=503, detail="openrouter: retries exhausted")

    @boom_app.get("/quoted")
    def _quoted() -> dict:
        # The same shape, carrying what an upstream body actually puts in it.
        # `_classify` joins 200 characters of each candidate's raw response into
        # one message, and this is a provider quoting the request it refused.
        raise HTTPException(status_code=503, detail=UPSTREAM_QUOTE)

    @boom_app.get("/field-errors")
    def _field_errors() -> dict:
        # A 422 detail is a list, which is the shape a scrub keyed on `str`
        # would walk straight past.
        raise HTTPException(
            status_code=422,
            detail=[{"loc": ["body", "owner"], "input": FOUNDER_ADDRESS, "msg": "bad"}],
        )

    boom_app.add_middleware(make_unhandled_error_middleware("ai"))
    boom_app.add_middleware(make_request_context_middleware("ai"))
    install_error_handlers(boom_app)
    return TestClient(boom_app)


class TestUnhandledException:
    def test_answers_json_not_plain_text(self, boom_client: TestClient) -> None:
        res = boom_client.post("/boom")
        assert res.status_code == 500
        assert "json" in res.headers["content-type"]
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

    def test_a_deliberate_5xx_is_logged_at_error(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The gap R225 closed.

        A 503 raised because the provider never answered is as much a server
        failure as an exception nobody caught — it was merely one somebody had
        thought about, which is not the same as one somebody was told about.
        The attempt-level warnings in ``openrouter.py`` stop before the give-up,
        so this line is the only record that the condition reached a caller.
        """
        with caplog.at_level(logging.ERROR):
            boom_client.get("/unavailable", headers={"x-request-id": "gone-1"})
        failed = [r for r in caplog.records if getattr(r, "event", None) == "request_failed"]
        assert len(failed) == 1
        assert failed[0].levelno == logging.ERROR
        assert failed[0].status == 503
        assert failed[0].path == "/unavailable"
        assert failed[0].http_method == "GET"
        assert "retries exhausted" in failed[0].detail

    def test_a_4xx_is_not_logged(
        self, boom_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A 4xx describes the request. Its rate is set by whoever is wrong."""
        with caplog.at_level(logging.WARNING):
            boom_client.get("/teapot")
        assert [r for r in caplog.records if getattr(r, "event", None) == "request_failed"] == []

    def test_unknown_pipeline_404_carries_a_request_id(self) -> None:
        res = client.post(
            "/ai/v1/pipelines/no-such-pipeline",
            json={"valuation": {}},
            headers={"x-request-id": "missing-1"},
        )
        assert res.status_code == 404
        assert res.json()["detail"] == "No pipeline named 'no-such-pipeline'. Check the pipeline name in the request path."
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


class TestOutboundScrub:
    """The response body is redacted on the same terms as the log line.

    Both are built from one `str(exc)`. The 5xx handler's own note says an
    upstream's words can quote the URL it was called with, key and all, and it
    logs through the redacting formatter for exactly that reason — then handed
    the identical string to the caller untouched. Downstream that string is not
    discarded: the valuation service treats a string `detail` as the upstream's
    own sentence, stores it on the engagement's network log and renders it to an
    analyst, so what this body carries is what Postgres keeps.
    """

    def test_an_address_quoted_by_an_upstream_does_not_travel(
        self, boom_client: TestClient
    ) -> None:
        res = boom_client.get("/quoted")
        assert res.status_code == 503
        assert FOUNDER_ADDRESS not in res.text
        assert "[EMAIL]" in res.json()["detail"]

    def test_a_credential_quoted_by_an_upstream_does_not_travel(
        self, boom_client: TestClient
    ) -> None:
        res = boom_client.get("/quoted")
        assert "sk-or-v1-0123456789abcdef0123456789abcdef" not in res.text
        assert "Bearer sk-" not in res.text

    def test_the_diagnosis_survives_the_scrub(self, boom_client: TestClient) -> None:
        """Only the identifiers go. What names the failure is what makes the
        body worth returning at all."""
        detail = boom_client.get("/quoted").json()["detail"]
        assert "All models failed" in detail
        assert "some/model" in detail and "other/model" in detail
        assert "HTTP 400" in detail

    def test_reaches_a_string_nested_in_a_field_error_list(
        self, boom_client: TestClient
    ) -> None:
        res = boom_client.get("/field-errors")
        assert res.status_code == 422
        assert FOUNDER_ADDRESS not in res.text
        # The field path is the whole point of the list and is untouched.
        assert res.json()["detail"][0]["loc"] == ["body", "owner"]

    def test_an_ordinary_detail_is_returned_verbatim(self, boom_client: TestClient) -> None:
        """A scrub that mangled the ordinary case would be paid for on every
        error in the tier."""
        assert boom_client.get("/unavailable").json()["detail"] == "openrouter: retries exhausted"


class TestARefusalCanAlwaysBeSerialised:
    """A body pydantic refused is answered with the refusal, not with a 500.

    The twin of the sweep in the engine's ``test_errors.py``; the bug was in
    ``_scrubbed``, which both services carry a copy of. ``1e999`` and ``NaN``
    are ordinary JSON tokens that every parser in use here accepts and that
    become a Python float ``json.dumps`` will not encode. Pydantic refused them
    correctly and named the field; the 422 handler then echoed the value back
    under ``input`` and died inside ``JSONResponse``, so the caller got
    ``Internal Server Error`` with no field name and the log got a traceback
    for a request that was merely wrong.
    """

    @staticmethod
    def _models() -> list[tuple[str, type]]:
        from pydantic import BaseModel

        found: list[tuple[str, type]] = []
        for route in app.routes:
            if "POST" not in getattr(route, "methods", set()):
                continue
            for name, annotation in getattr(getattr(route, "endpoint", None), "__annotations__", {}).items():
                if name == "return":
                    continue
                if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                    found.append((route.path.replace("{pipeline}", "draft_section"), annotation))
        return found

    def test_the_sweep_reaches_the_endpoints_it_is_about(self) -> None:
        paths = {path for path, _ in self._models()}
        assert "/ai/v1/research" in paths
        assert "/ai/v1/anonymize" in paths
        assert len(paths) >= 4

    @pytest.mark.parametrize("token", ["1e999", "-1e999", "NaN"])
    def test_no_field_of_any_request_model_answers_5xx(self, token: str) -> None:
        offenders: list[str] = []
        for path, model in self._models():
            for field in model.model_fields:
                res = client.post(
                    path,
                    content=f'{{"{field}": {token}}}',
                    headers={"content-type": "application/json"},
                )
                if res.status_code >= 500:
                    offenders.append(f"{path} {field}={token} -> {res.status_code}")
        assert offenders == []

    def test_the_refusal_still_names_the_field_and_renders_the_value(self) -> None:
        res = client.post(
            "/ai/v1/anonymize",
            content='{"text": 1e999}',
            headers={"content-type": "application/json"},
        )
        assert res.status_code == 422
        issue = next(i for i in res.json()["detail"] if i["loc"] == ["body", "text"])
        assert issue["input"] == "inf"


class TestRfc9457Envelope:
    """Error responses carry ``type``, ``title`` and ``status`` alongside
    ``detail`` so cross-service error handling is consistent with the Fastify
    tier's RFC 9457 bodies (M16 audit).
    """

    def test_4xx_carries_problem_fields(self, boom_client: TestClient) -> None:
        res = boom_client.get("/teapot")
        body = res.json()
        assert body["status"] == 418
        assert body["title"] == "Error"
        assert body["type"] == "about:blank"
        assert body["detail"] == "I'm a teapot"

    def test_5xx_carries_problem_fields(self, boom_client: TestClient) -> None:
        res = boom_client.get("/unavailable")
        body = res.json()
        assert body["status"] == 503
        assert body["title"] == "Service Unavailable"
        assert body["type"] == "urn:n409:problem:unavailable"

    def test_422_carries_validation_type(self) -> None:
        res = client.post("/ai/v1/test", json={})
        body = res.json()
        assert body["status"] == 422
        assert body["type"] == "urn:n409:problem:validation"
        assert body["title"] == "Unprocessable Content"

    def test_500_carries_internal_type(self, boom_client: TestClient) -> None:
        res = boom_client.post("/boom")
        body = res.json()
        assert body["status"] == 500
        assert body["type"] == "urn:n409:problem:internal"
        assert body["title"] == "Internal Server Error"

    def test_content_type_is_problem_json(self, boom_client: TestClient) -> None:
        res = boom_client.get("/teapot")
        assert "application/problem+json" in res.headers["content-type"]


class TestApiVersionHeader:
    """Every response carries an ``X-API-Version`` header (M16 audit)."""

    def test_success_response_carries_version(self) -> None:
        res = client.get("/health")
        assert res.headers.get("x-api-version") == "0.2.0"

    def test_error_response_carries_version(self) -> None:
        res = client.post("/ai/v1/test", json={})
        assert res.headers.get("x-api-version") == "0.2.0"
