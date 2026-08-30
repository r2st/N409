import json
import logging
import re
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.observability import _EXTRA_KEYS, JsonLogFormatter, current_request_id

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


def _extra_dicts(source: str) -> list[tuple[int, str]]:
    """Every ``extra={...}`` literal in a source file, with its line number."""
    out: list[tuple[int, str]] = []
    for match in re.finditer(r"extra=\{", source):
        start = match.end() - 1
        depth = 0
        for i in range(start, len(source)):
            if source[i] == "{":
                depth += 1
            elif source[i] == "}":
                depth -= 1
                if depth == 0:
                    out.append((source[: match.start()].count("\n") + 1, source[start + 1 : i]))
                    break
    return out


def test_no_call_site_logs_a_key_the_formatter_will_drop():
    """A field the allowlist does not name is discarded in silence.

    ``_EXTRA_KEYS`` is an allowlist on purpose — a caller must not be able to
    widen what reaches disk by adding a key to ``extra``. The cost of that is
    that a call site passing an unlisted key looks, from where it is written,
    exactly like one that works: no error, no warning, and a log line missing
    the one field it was written for. Four sites did precisely this with
    ``detail``, including the line that reports which finish reason truncated a
    completion and the one that reports the malformed value an operator typed
    into a limit — the whole diagnostic content of both, dropped.

    Both services share this formatter, so both trees are walked.
    """
    offenders: list[str] = []
    for service in ("ai", "engine-wrapper"):
        app_dir = Path(__file__).resolve().parents[3] / "services" / service / "app"
        for path in sorted(app_dir.glob("*.py")):
            source = path.read_text(encoding="utf-8")
            for line, body in _extra_dicts(source):
                for key in re.findall(r'"([a-z_]+)"\s*:', body):
                    if key not in _EXTRA_KEYS:
                        offenders.append(f"{service}/app/{path.name}:{line} {key}")
    assert offenders == []


def test_the_allowlist_is_still_an_allowlist():
    """Widening it with named dimensions must not have made it a passthrough."""
    record = logging.LogRecord("ai", logging.INFO, __file__, 1, "hello", None, None)
    record.prompt = "the entire document we just sent a model"
    parsed = json.loads(JsonLogFormatter().format(record))
    assert "prompt" not in parsed


def test_named_dimensions_reach_the_line():
    """The fields that were being smuggled through ``path`` and ``status``."""
    record = logging.LogRecord("ai", logging.WARNING, __file__, 1, "llm 5xx, retrying", None, None)
    record.event = "llm_retry"
    record.model = "openai/gpt-4o-mini"
    record.attempt = 2
    record.status = 503
    parsed = json.loads(JsonLogFormatter().format(record))
    # The model is its own field, so "group the failures by model" is a query
    # rather than a substring match against a field named for URL paths.
    assert parsed["model"] == "openai/gpt-4o-mini"
    assert parsed["attempt"] == 2
    # And `status` means what an access log means by it.
    assert parsed["status"] == 503


def test_a_string_dimension_is_redacted_like_the_message():
    """`detail` carries free text, which in this tier can quote an input."""
    record = logging.LogRecord(
        "ai", logging.WARNING, __file__, 1, "limit misconfigured", None, None
    )
    record.detail = "contact analyst@example.com"
    parsed = json.loads(JsonLogFormatter().format(record))
    assert parsed["detail"] == "contact [EMAIL]"


def test_an_absurd_inbound_request_id_is_not_adopted():
    """The rule `packages/shared` states for the three Fastify services.

    Those validate the header before adopting it; these two took it verbatim,
    so a caller could name itself with 8 KB that then rode every line of a
    five-service trace. The request is still served and still correlated —
    under the id this hop would have minted anyway.
    """
    res = client.get("/health", headers={"x-request-id": "x" * 200})
    assert res.status_code == 200
    assert res.headers["x-request-id"] != "x" * 200
    assert len(res.headers["x-request-id"]) <= 128


def test_an_inbound_request_id_that_would_not_survive_a_grep_is_not_adopted():
    # An id is a value things are joined on. The formatter escapes a newline
    # rather than letting it forge a second log line, but neither a space nor a
    # control character survives the journal query a join is made of.
    for hostile in ["has space", "semi;colon", "quote\"mark"]:
        res = client.get("/health", headers={"x-request-id": hostile})
        assert res.status_code == 200
        assert res.headers["x-request-id"] != hostile


def test_an_ordinary_traced_id_is_still_adopted():
    # The whole point of adopting one at all: the caller's id, not a fresh one
    # per hop. A UUID, a ULID and a W3C trace id all pass.
    for ok in [
        "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "4bf92f3577b34da6a3ce929d0e0e4736",
        "req-abc-123",
    ]:
        res = client.get("/health", headers={"x-request-id": ok})
        assert res.headers["x-request-id"] == ok
