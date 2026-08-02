"""Log redaction on the service that actually handles the sensitive data.

The pattern set itself is pinned in the engine's test_logging.py — the module
is the same one. What is specific here is the exposure: this service receives
uploaded documents and cap tables, so a message or traceback that quotes its
input is a disclosure rather than noise.

app/anonymize.py redacts document text on the way *out* to an external LLM.
This is the other direction — the way to disk — and the two are independent:
a request that skipped anonymization (or failed before reaching it) still must
not write a founder's email into the log.
"""

from __future__ import annotations

import json
import logging
import sys

from app.observability import JsonLogFormatter, redact


def line(record: logging.LogRecord) -> dict:
    return json.loads(JsonLogFormatter("ai").format(record))


def test_names_this_service() -> None:
    record = logging.LogRecord("ai", logging.INFO, __file__, 1, "hello", (), None)
    assert line(record)["service"] == "ai"


def test_a_failed_pipeline_does_not_write_document_content_to_the_log() -> None:
    # An agent raising on malformed extracted text is the realistic path: the
    # message quotes what it choked on, and the unhandled-exception handler
    # logs exc_info.
    try:
        raise ValueError("could not parse holder row: Ada Lovelace <ada@acme.com> (415) 555-0123")
    except ValueError:
        record = logging.LogRecord(
            "ai", logging.ERROR, __file__, 1, "unhandled exception", (), sys.exc_info()
        )
    exc = line(record)["exc"]
    assert "ada@acme.com" not in exc
    assert "555-0123" not in exc
    assert "[EMAIL]" in exc and "[PHONE]" in exc
    # Still enough left to debug with.
    assert "ValueError" in exc and "could not parse holder row" in exc


def test_an_openrouter_key_never_reaches_the_log(monkeypatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-abcdef0123456789abcdef")
    out = redact("all models failed for key sk-or-v1-abcdef0123456789abcdef")
    assert "abcdef0123456789abcdef" not in out


def test_a_rotated_key_of_an_unexpected_shape_is_still_struck(monkeypatch) -> None:
    # The `sk-` pattern cannot know what a future key looks like; the literal
    # value from the environment covers the gap.
    monkeypatch.setenv("OPENROUTER_API_KEY", "totally-different-shape-9911")
    assert "totally-different-shape-9911" not in redact("key totally-different-shape-9911 rejected")


def test_token_usage_counts_survive_redaction() -> None:
    # The llm_usage line is how spend is tracked; mangling its numbers would
    # trade one problem for another.
    record = logging.LogRecord("ai", logging.INFO, __file__, 1, "llm usage", (), None)
    record.event = "llm_usage"
    record.status = 18432
    record.duration_ms = 204915
    out = line(record)
    assert out["status"] == 18432
    assert out["duration_ms"] == 204915
