"""The JSON log line: shape, and what must never appear in it.

The TS services redact through pino's field paths, which works because pino
logs structured objects. The two free-text fields here — the message a caller
formatted, and the traceback of an exception nobody caught — have no field
names to key off, so they are matched by shape. These tests pin both halves:
what gets struck, and what must survive, because a valuation log is full of
bare numbers that a careless pattern would mangle.
"""

from __future__ import annotations

import json
import logging

import pytest

from app.observability import (
    MAX_REQUEST_ID_CHARS,
    JsonLogFormatter,
    acceptable_request_id,
    redact,
)


def line(record: logging.LogRecord, service: str | None = "engine-wrapper") -> dict:
    return json.loads(JsonLogFormatter(service).format(record))


def make_record(msg: str, *args: object, **extra: object) -> logging.LogRecord:
    record = logging.LogRecord("engine", logging.INFO, __file__, 1, msg, args, None)
    for key, value in extra.items():
        setattr(record, key, value)
    return record


class TestShape:
    def test_one_json_object_per_line(self) -> None:
        out = JsonLogFormatter("engine-wrapper").format(make_record("hello"))
        assert "\n" not in out
        assert json.loads(out)["msg"] == "hello"

    def test_carries_the_standard_fields(self) -> None:
        out = line(make_record("hello"))
        assert out["level"] == "info"
        assert out["logger"] == "engine"
        assert out["request_id"] == "-"  # nothing bound outside a request
        assert out["ts"].endswith("Z")

    def test_names_the_service_like_the_pino_logger_does(self) -> None:
        # `logger` is the module and is not a substitute: both Python services
        # log under "limits" and "ratelimit".
        assert line(make_record("hello"))["service"] == "engine-wrapper"

    def test_promotes_only_the_allowlisted_extras(self) -> None:
        out = line(make_record("hello", event="http_access", status=200, cap_table={"x": 1}))
        assert out["event"] == "http_access"
        assert out["status"] == 200
        # A caller cannot widen what gets logged by adding a key to `extra`.
        assert "cap_table" not in out

    def test_interpolates_message_args(self) -> None:
        assert line(make_record("computed %s in %d ms", "opm", 12))["msg"] == "computed opm in 12 ms"


class TestRedaction:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("mail founder@acme.com now", "mail [EMAIL] now"),
            ("ssn 123-45-6789 seen", "ssn [SSN] seen"),
            ("ein 12-3456789 seen", "ein [EIN] seen"),
            ("call (415) 555-0123 now", "call [PHONE] now"),
            ("call 415-555-0123 now", "call [PHONE] now"),
        ],
    )
    def test_strikes_identifiers_by_shape(self, raw: str, expected: str) -> None:
        assert redact(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        [
            "Authorization: Bearer abc123def456ghi",
            "key sk-or-v1-0123456789abcdef0123",
            "GET https://api.example.com/v1?api_key=hunter2secret",
            "connect postgres://u:p@h/db?password=hunter2secret",
        ],
    )
    def test_strikes_credentials(self, raw: str) -> None:
        out = redact(raw)
        for secret in ("abc123def456ghi", "0123456789abcdef0123", "hunter2secret"):
            assert secret not in out

    @pytest.mark.parametrize(
        "survivor",
        [
            "fully diluted shares 12345678",
            "equity value 1234567.89",
            "concluded FMV $2.4500 per share",
            "volatility 0.6512 over 3.5 years",
            "computed 452 scenarios in 1204 ms",
            "valuation 01JQ8Z3K7M4N5P6Q7R8S9T0V1W",
        ],
    )
    def test_leaves_the_numbers_a_valuation_log_is_made_of_alone(self, survivor: str) -> None:
        # A pattern aggressive enough to catch every possible phone number
        # would mangle every line in this service. It does not.
        assert redact(survivor) == survivor

    def test_strikes_the_configured_secret_whatever_shape_it_has(self, monkeypatch) -> None:
        # The shape patterns cannot know what a rotated token looks like, so
        # the literal value is struck too.
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "zzz-not-key-shaped-zzz")
        assert "zzz-not-key-shaped-zzz" not in redact("token was zzz-not-key-shaped-zzz")

    def test_reads_the_secret_per_line_so_a_rotation_takes_effect(self, monkeypatch) -> None:
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "first-secret-value")
        assert "[REDACTED]" in redact("saw first-secret-value")
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "second-secret-value")
        assert "[REDACTED]" in redact("saw second-secret-value")

    def test_ignores_a_secret_too_short_to_match_safely(self, monkeypatch) -> None:
        # An empty or one-character token would otherwise redact everything.
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "ab")
        assert redact("a fine message about abacus shares") == "a fine message about abacus shares"

    def test_ignores_an_unset_secret(self, monkeypatch) -> None:
        monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
        assert redact("a fine message") == "a fine message"

    def test_applies_to_the_formatted_message(self) -> None:
        assert line(make_record("contact %s", "founder@acme.com"))["msg"] == "contact [EMAIL]"

    def test_applies_to_promoted_string_extras(self) -> None:
        out = line(make_record("shape drift", event="output_schema", status="founder@acme.com"))
        assert out["status"] == "[EMAIL]"

    def test_leaves_non_string_extras_as_they_are(self) -> None:
        out = line(make_record("request", status=422, duration_ms=1.5))
        assert out["status"] == 422 and out["duration_ms"] == 1.5

    def test_applies_to_the_traceback_of_an_escaped_exception(self) -> None:
        # The path that made this matter: the unhandled-exception handler logs
        # exc_info, and an exception message here can quote its input.
        try:
            raise ValueError("cap table for founder@acme.com is malformed")
        except ValueError:
            import sys

            record = logging.LogRecord(
                "engine", logging.ERROR, __file__, 1, "unhandled exception", (), sys.exc_info()
            )
        out = line(record)
        assert "founder@acme.com" not in out["exc"]
        assert "[EMAIL]" in out["exc"]
        assert "ValueError" in out["exc"]  # still diagnosable


class TestInboundRequestId:
    """An `x-request-id` is adopted only if it is one.

    The rule `packages/shared/src/requestContext.ts` states for the three
    Fastify services, whose doc counts *five*: the valuation service forwards
    its id here and to the AI gateway, and every line of all five carries it.
    These two took the header verbatim, which is exactly what that rule exists
    to replace — an 8 KB header becomes 8 KB on every line of the trace, and a
    whitespace- or control-bearing id does not survive the journal query a join
    is made of.
    """

    def test_refuses_one_past_the_ceiling(self) -> None:
        assert acceptable_request_id("x" * (MAX_REQUEST_ID_CHARS + 1)) is None

    def test_refuses_one_that_would_not_survive_a_grep(self) -> None:
        for hostile in ["has space", "new\nline", "semi;colon", "quote\"mark", "brace{}"]:
            assert acceptable_request_id(hostile) is None, hostile

    def test_refuses_an_absent_or_empty_header(self) -> None:
        assert acceptable_request_id(None) is None
        assert acceptable_request_id("") is None

    def test_adopts_the_shapes_tracing_actually_emits(self) -> None:
        for ok in [
            "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "req-abc-123",
            "x" * MAX_REQUEST_ID_CHARS,
        ]:
            assert acceptable_request_id(ok) == ok, ok
