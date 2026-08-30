"""Outbound HTTP clients whose response body has a ceiling.

Every outbound call this service makes goes to something outside the trust
boundary: an LLM gateway, a keyless web index, a self-hosted SearXNG at a URL
the operator set. `httpx.Client.post` reads the whole body into memory before
it returns, and httpx has no opinion on how big that body may be — so the size
of the buffer is the far end's choice, not ours. A gateway that answers with an
endless body, or an ingress that streams a multi-gigabyte error page, takes
this unit's heap with it. No status code is involved and nothing in the log
says "too big": the process is simply killed, and on this box that is one of
five units sharing 3.8 GB.

The valuation service settled this for its own provider clients — see
`clients/deadline.ts:MAX_INTEGRATION_JSON_BYTES`, whose docstring is the same
argument — and the Python tier had no counterpart. This module is it, and the
cap is deliberately the same 16 MB so the two tiers do not have to be reasoned
about separately.

## Why a transport rather than a helper at each call site

There are eight places a client is built and rather more places a response is
read, and a helper is only a guard where somebody remembered to call it. The
lesson `n409-second-provider-blind-spots` records is the same one: Bedrock
escaped three guards written to OpenRouter's spelling because each guard lived
at a call site. A transport wraps the *stream*, so the ceiling applies to every
request any client makes — including one added by whoever wires up the next
provider, who does not have to know this file exists.

The cut is at the first chunk that crosses the budget, so the peak held is one
chunk over the cap rather than whatever the far end felt like sending; the
`content-length` check ahead of it is a courtesy for the honest oversized
answer, not the guard, because a chunked response has no length and a lying one
is exactly the case that matters.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import httpx

# Far above every real body these clients read: an LLM completion is bounded by
# its token cap, a search page is a few hundred kilobytes, a Bedrock model list
# is smaller still. Chosen to be comfortably out of the way of a legitimate
# answer rather than to be tight, because the failure it guards is unbounded
# rather than merely large.
MAX_RESPONSE_BYTES = 16 * 1024 * 1024

_LIMIT_VAR = "MAX_RESPONSE_BYTES"


def max_response_bytes(default: int = MAX_RESPONSE_BYTES) -> int:
    """Configured ceiling (MAX_RESPONSE_BYTES); 0 disables it."""
    raw = os.environ.get(_LIMIT_VAR)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    # Negative is a typo for "off", not a licence to buffer everything.
    return max(value, 0)


class ResponseTooLarge(httpx.HTTPError):
    """An answer that ran past the ceiling, refused mid-stream.

    Subclasses `httpx.HTTPError` and *not* `httpx.TransportError`: the callers
    that classify failures treat a transport error as retryable, and re-sending
    a request whose answer was too big buys the identical answer at twice the
    cost. This is a failure of that response, so the retry ladders move on to
    the next candidate or give up, which is what they do for any other
    non-transport HTTP failure.
    """

    def __init__(self, limit_bytes: int) -> None:
        super().__init__(f"response body exceeded {limit_bytes // (1024 * 1024)} MB and was abandoned")
        self.limit_bytes = limit_bytes


class _CappedStream(httpx.SyncByteStream):
    """Passes chunks through until they total more than `limit`."""

    def __init__(self, inner: httpx.SyncByteStream, limit: int) -> None:
        self._inner = inner
        self._limit = limit

    def __iter__(self) -> Iterator[bytes]:
        total = 0
        for chunk in self._inner:
            total += len(chunk)
            if total > self._limit:
                # Closing is what makes the bound real — without it the socket
                # keeps delivering into a buffer nobody is draining.
                self.close()
                raise ResponseTooLarge(self._limit)
            yield chunk

    def close(self) -> None:
        closer = getattr(self._inner, "close", None)
        if closer is not None:
            closer()


class CappedTransport(httpx.BaseTransport):
    """Wraps a transport so every response body stops at `limit` bytes."""

    def __init__(self, inner: httpx.BaseTransport, limit: int) -> None:
        self._inner = inner
        self._limit = limit

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        response = self._inner.handle_request(request)
        declared = response.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > self._limit:
            response.close()
            raise ResponseTooLarge(self._limit)
        stream = response.stream
        if not isinstance(stream, httpx.SyncByteStream):  # pragma: no cover - async transport
            return response
        return httpx.Response(
            status_code=response.status_code,
            headers=response.headers,
            stream=_CappedStream(stream, self._limit),
            extensions=response.extensions,
            request=request,
        )

    def close(self) -> None:
        self._inner.close()


def new_client(*, transport: httpx.BaseTransport | None = None, **kwargs: object) -> httpx.Client:
    """An `httpx.Client` that refuses a response body past the ceiling.

    Every outbound client in this service is built here. `transport` is for the
    tests, which hand a `MockTransport` in and get the cap wrapped around it —
    the same object shape production gets, so what the suite exercises is the
    code that ships.
    """
    limit = max_response_bytes()
    inner = transport if transport is not None else httpx.HTTPTransport()
    wrapped = CappedTransport(inner, limit) if limit > 0 else inner
    return httpx.Client(transport=wrapped, **kwargs)  # type: ignore[arg-type]
