"""The ceiling on an outbound response body, and the census that holds it.

`httpx` reads a whole body into memory before the call returns and has no
opinion on how big it may be, so without this the size of the buffer is the far
end's choice — an LLM gateway's, a keyless web index's, or a SearXNG at
whatever URL the operator set. The valuation service made this decision for its
own provider clients (`clients/deadline.ts:MAX_INTEGRATION_JSON_BYTES`); these
tests hold the same one for the Python tier.
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path

import httpx
import pytest

from app import http_client
from app.http_client import (
    MAX_RESPONSE_BYTES,
    ResponseTooLarge,
    ResponseTooSlow,
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


def _config_lines(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if getattr(r, "event", None) == "http_client_config"]


def test_an_unparseable_ceiling_says_it_took_the_default(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """R341, M11. Falling back is right; falling back in silence is not.

    ``limits._misconfigured`` already argues this for the request-body cap, in
    as many words: the operator who set the value "has a service running on the
    old one and nothing anywhere disagrees with them". This reader made the same
    fallback and said nothing.
    """
    http_client._announced.clear()
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "16MB")
    with caplog.at_level(logging.WARNING):
        assert max_response_bytes() == MAX_RESPONSE_BYTES
    line = _config_lines(caplog)[0]
    assert line.levelno == logging.WARNING
    # The value the operator actually typed, which is the whole diagnostic.
    assert line.detail == "16MB"
    assert line.limit == MAX_RESPONSE_BYTES


def test_a_ceiling_of_nothing_says_the_guard_is_off(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The louder half: a mistyped `-1` removes the ceiling rather than tightening it.

    ``max(value, 0)`` resolves every negative to 0, and 0 is documented as off —
    ``_CappedStream`` tests ``self._limit > 0``. So the guard whose module header
    says "the failure it guards is unbounded rather than merely large" is
    removed by a typo, and the socket is then free to deliver into a buffer
    nobody is draining. ``ratelimit.install_rate_limit`` has warned on its own
    version of this since it was written.
    """
    http_client._announced.clear()
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "-1")
    with caplog.at_level(logging.WARNING):
        assert max_response_bytes() == 0
    line = _config_lines(caplog)[0]
    assert line.levelno == logging.WARNING
    assert line.detail == "-1"
    assert line.limit == 0


def test_a_configured_ceiling_is_announced_once_rather_than_per_request(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # `new_client` is called once per outbound request, so an unconditional line
    # would be one per LLM call. Announced on the value, not on a bare flag, so
    # a redeploy that fixes a typo still says so.
    http_client._announced.clear()
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "1024")
    with caplog.at_level(logging.INFO):
        for _ in range(5):
            assert max_response_bytes() == 1024
    assert len(_config_lines(caplog)) == 1
    assert _config_lines(caplog)[0].levelno == logging.INFO


def test_the_default_ceiling_is_not_worth_a_line(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # A deployment that set nothing, and one that set the default explicitly,
    # are both the ordinary case. A line for either is the noise that makes the
    # two above easy to miss.
    http_client._announced.clear()
    monkeypatch.delenv("MAX_RESPONSE_BYTES", raising=False)
    with caplog.at_level(logging.INFO):
        assert max_response_bytes() == MAX_RESPONSE_BYTES
        monkeypatch.setenv("MAX_RESPONSE_BYTES", str(MAX_RESPONSE_BYTES))
        assert max_response_bytes() == MAX_RESPONSE_BYTES
    assert _config_lines(caplog) == []


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


# ── The other ceiling: a body that is small and never ends ───────────────────
#
# `llm_http.Deadline` says each attempt gets "whatever is left" and hands that
# to httpx as `timeout=`. An httpx read timeout bounds one socket read, not the
# exchange, so a far end that drips a byte at a time resets it forever: the
# thread is held, no cap is crossed, and no client disconnect reclaims the
# threadpool slot (`limits.py`). These hold the second ceiling.


class _DrippingStream(httpx.SyncByteStream):
    """A body that arrives one small chunk at a time, forever if allowed."""

    def __init__(self, chunks: int, gap_s: float) -> None:
        self.chunks = chunks
        self.gap_s = gap_s
        self.delivered = 0
        self.closed = False

    def __iter__(self):
        for _ in range(self.chunks):
            time.sleep(self.gap_s)
            self.delivered += 1
            yield b"x"

    def close(self) -> None:
        self.closed = True


class _DripTransport(httpx.BaseTransport):
    def __init__(self, stream: _DrippingStream, *, headers: dict | None = None) -> None:
        self.stream = stream
        self.headers = headers or {}

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=self.headers, stream=self.stream, request=request)


def test_a_slow_drip_is_abandoned_at_the_attempt_budget() -> None:
    """The failure this closes: 40 bytes, a content-length that is honest, and
    a thread held until the far end feels like finishing."""
    stream = _DrippingStream(chunks=200, gap_s=0.01)
    with new_client(transport=_DripTransport(stream)) as http:
        with pytest.raises(ResponseTooSlow) as excinfo:
            http.get("https://example.test/", timeout=0.05)
    assert excinfo.value.budget_s == 0.05
    # Abandoned rather than merely reported: the socket is closed and the rest
    # of the body was never read.
    assert stream.closed
    assert stream.delivered < 200


def test_the_time_ceiling_is_a_transport_error_so_the_ladder_may_retry() -> None:
    """Opposite of `ResponseTooLarge`, and for the opposite reason: a slow
    minute may pass, and `Deadline` is what stops the retrying."""
    err = ResponseTooSlow(1.0)
    assert isinstance(err, httpx.TransportError)
    assert isinstance(err, httpx.TimeoutException)


def test_the_budget_covers_waiting_for_the_first_byte_too() -> None:
    """Both halves of an attempt share one budget rather than each getting it.

    Otherwise a far end that stalls just under the read timeout and *then*
    drips gets twice the ceiling the caller asked for.
    """

    class _Stalling(httpx.BaseTransport):
        def handle_request(self, request: httpx.Request) -> httpx.Response:
            time.sleep(0.06)
            return httpx.Response(200, stream=_DrippingStream(4, 0.01), request=request)

    with new_client(transport=_Stalling()) as http:
        with pytest.raises(ResponseTooSlow):
            http.get("https://example.test/", timeout=0.05)


def test_a_prompt_answer_is_not_affected() -> None:
    stream = _DrippingStream(chunks=3, gap_s=0.001)
    with new_client(transport=_DripTransport(stream)) as http:
        assert http.get("https://example.test/", timeout=5.0).content == b"xxx"


def test_a_caller_that_turned_its_own_budget_off_is_left_alone() -> None:
    """`timeout=None` is an operator running a deliberately slow local model —
    the same `0 disables` escape hatch `Deadline` documents."""
    stream = _DrippingStream(chunks=5, gap_s=0.01)
    with new_client(transport=_DripTransport(stream), timeout=None) as http:
        assert len(http.get("https://example.test/").content) == 5


def test_turning_the_size_cap_off_does_not_take_the_time_cap_with_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """MAX_RESPONSE_BYTES=0 is an opinion about bytes and nothing else."""
    monkeypatch.setenv("MAX_RESPONSE_BYTES", "0")
    stream = _DrippingStream(chunks=200, gap_s=0.01)
    with new_client(transport=_DripTransport(stream)) as http:
        with pytest.raises(ResponseTooSlow):
            http.get("https://example.test/", timeout=0.05)
