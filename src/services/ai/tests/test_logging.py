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


def test_a_perplexity_key_never_reaches_the_log(monkeypatch) -> None:
    """The provider R241 did not count.

    R241 read "a second completion provider" as the whole of what had arrived
    since this net was written. There were two: Bedrock, and the research
    provider restored three weeks earlier, whose key this service holds, sends
    on every `/ai/v1/research` call and verifies at boot — and which was named
    in neither half of `redact`.
    """
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-abcdef0123456789abcdef")
    out = redact("perplexity rejected pplx-abcdef0123456789abcdef")
    assert "abcdef0123456789abcdef" not in out
    # The diagnosis survives.
    assert "perplexity rejected" in out


def test_a_perplexity_key_that_is_not_this_process_is_struck_by_shape(monkeypatch) -> None:
    """The literal net knows *this* deployment's current key and nothing else.

    A key rotated while a call was in flight is not that value, and neither is
    one a caller pasted into a request body — which R241 named as a live path:
    a 422 detail is pydantic's error list and its entries quote the payload
    they refused.
    """
    monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
    assert "pplx-9911abcdef0123456789" not in redact("refused: pplx-9911abcdef0123456789")


# What AWS answers a signature it will not accept with: the string-to-sign,
# quoted back. `_error_message` keeps 200 characters of a body like this and
# puts them in the exception the give-up raises.
_SIGNATURE_MISMATCH = (
    "The request signature we calculated does not match the signature you provided. "
    "Credential=AKIAIOSFODNN7EXAMPLE/20260830/us-east-1/bedrock/aws4_request, "
    "SignedHeaders=content-type;host;x-amz-date, "
    "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
)


def test_a_bedrock_signature_and_key_id_never_reach_the_log() -> None:
    """The second completion provider signs its own requests.

    `Bearer …` and `sk-…` were the shapes this estate produced when those rules
    were written; SigV4 matches neither, and the failure that quotes it back —
    a skewed clock, a region that does not match the one signed for — is a
    misconfiguration rather than an attack.
    """
    out = redact(_SIGNATURE_MISMATCH)
    assert "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7" not in out
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    # The diagnosis is the whole reason the line is kept.
    assert "does not match the signature you provided" in out
    assert "us-east-1" in out


def test_an_aws_secret_of_no_particular_shape_is_still_struck(monkeypatch) -> None:
    """The same argument the OpenRouter case above makes, for the provider
    added after it. An AWS secret access key is forty characters of base64 with
    no prefix to recognise, so only the literal value can catch it."""
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "FwoGZXIvYXdzEBYaDNOT-A-REAL-TOKEN-9911")
    struck = redact(
        "signing failed with wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY "
        "and FwoGZXIvYXdzEBYaDNOT-A-REAL-TOKEN-9911"
    )
    assert "wJalrXUtnFEMI" not in struck
    assert "NOT-A-REAL-TOKEN-9911" not in struck


def test_the_signing_credentials_do_not_print_themselves() -> None:
    """A dataclass writes a repr over every field, and this object is an
    argument to the signing and the retry loop — which is where a TypeError
    quotes its arguments."""
    from app.bedrock import Credentials

    creds = Credentials("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG", "sess-9911", "us-east-1")
    shown = repr(creds)
    assert "wJalrXUtnFEMI" not in shown
    assert "sess-9911" not in shown
    # Still says which configuration it is.
    assert "us-east-1" in shown


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
