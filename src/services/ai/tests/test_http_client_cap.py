"""The ceiling on an outbound response body, and the census that holds it.

`httpx` reads a whole body into memory before the call returns and has no
opinion on how big it may be, so without this the size of the buffer is the far
end's choice — an LLM gateway's, a keyless web index's, or a SearXNG at
whatever URL the operator set. The valuation service made this decision for its
own provider clients (`clients/deadline.ts:MAX_INTEGRATION_JSON_BYTES`); these
tests hold the same one for the Python tier.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from app.http_client import (
    MAX_RESPONSE_BYTES,
    ResponseTooLarge,
    max_response_bytes,
    new_client,
)

APP = Path(__file__).resolve().parents[1] / "app"


def _client(handler) -> httpx.Client:
    return new_client(transport=httpx.MockTransport(handler))


def test_body_under_the_cap_is_read_whole() -> None:
    body = b"x" * 1024
    with _client(lambda _req: httpx.Response(200, content=body)) as http:
        assert http.get("https://example.test/").content == body


def test_oversized_body_is_refused_mid_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "1024")

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 4096)

    with _client(handler) as http:
        with pytest.raises(ResponseTooLarge) as excinfo:
            http.get("https://example.test/")
    assert excinfo.value.limit_bytes == 1024


def test_a_lying_content_length_does_not_defeat_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stream is the guard; the declared length is only a courtesy."""
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "1024")

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-length": "10"},
            stream=httpx.ByteStream(b"x" * 4096),
        )

    with _client(handler) as http:
        with pytest.raises(ResponseTooLarge):
            http.get("https://example.test/")


def test_an_honest_oversized_length_is_refused_before_a_byte_is_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "1024")

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-length": "999999"}, content=b"")

    with _client(handler) as http:
        with pytest.raises(ResponseTooLarge):
            http.get("https://example.test/")


def test_refusal_is_not_a_transport_error() -> None:
    """So the retry ladders move on rather than re-buying the same answer.

    `openrouter._RETRYABLE_HTTP_EXC` and its Bedrock twin are
    `(httpx.TransportError,)`. A response that was too big will be too big
    again, so it must not land in that set — but it must still be caught by the
    `except httpx.HTTPError` arms that classify a candidate as failed.
    """
    err = ResponseTooLarge(16)
    assert isinstance(err, httpx.HTTPError)
    assert not isinstance(err, httpx.TransportError)


def test_zero_disables_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "0")
    assert max_response_bytes() == 0
    with _client(lambda _req: httpx.Response(200, content=b"x" * 4096)) as http:
        assert len(http.get("https://example.test/").content) == 4096


def test_a_non_integer_setting_falls_back_to_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "sixteen megabytes")
    assert max_response_bytes() == MAX_RESPONSE_BYTES


def test_negative_is_off_not_unlimited(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "-1")
    assert max_response_bytes() == 0


def test_no_outbound_client_is_built_outside_the_factory() -> None:
    """The census. A guard at a call site is a guard where somebody remembered.

    Every outbound client in this service is built by `new_client`, so the
    ceiling reaches a provider added later without its author knowing this file
    exists — which is exactly how Bedrock escaped three OpenRouter-shaped
    guards (`n409-second-provider-blind-spots`).
    """
    offenders = []
    for path in sorted(APP.rglob("*.py")):
        if path.name == "http_client.py":
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\bhttpx\.(Async)?Client\(", line):
                offenders.append(f"{path.relative_to(APP)}:{number}: {line.strip()}")
    assert offenders == [], (
        "build outbound clients with http_client.new_client so the response-size "
        "ceiling applies:\n" + "\n".join(offenders)
    )
