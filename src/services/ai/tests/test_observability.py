import json
import logging

from fastapi.testclient import TestClient

from app.main import app
from app.observability import JsonLogFormatter, current_request_id

client = TestClient(app)


def test_json_formatter_emits_one_object_with_request_id():
    record = logging.LogRecord("ai", logging.INFO, __file__, 1, "hello", None, None)
    record.http_method = "GET"
    record.status = 200
    line = JsonLogFormatter().format(record)
    parsed = json.loads(line)
    assert parsed["msg"] == "hello"
    assert parsed["level"] == "info"
    assert parsed["http_method"] == "GET"
    assert parsed["status"] == 200
    assert "request_id" in parsed


def test_response_echoes_request_id():
    res = client.get("/health", headers={"x-request-id": "req-abc-123"})
    assert res.status_code == 200
    assert res.headers["x-request-id"] == "req-abc-123"


def test_request_id_is_minted_when_absent():
    res = client.get("/health")
    assert res.headers.get("x-request-id")
    # A fresh id per request.
    other = client.get("/health")
    assert res.headers["x-request-id"] != other.headers["x-request-id"]


def test_request_id_context_defaults_outside_a_request():
    assert current_request_id() == "-"
