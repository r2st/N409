"""Outbound HTTP clients whose response body has a ceiling — in bytes and in seconds.

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

## Why there is a second ceiling, in seconds

A size cap does not bound a *slow* answer, and the thing being protected is the
same one either way: a threadpool slot that no client disconnect reclaims (see
`limits.py`). `llm_http.Deadline` was written to bound it — "each attempt is
given whatever is left" — and hands that figure to httpx as `timeout=`. But an
httpx read timeout is a bound on one socket read, not on the exchange: a far
end that sends a byte every ten seconds resets it forever. Ninety seconds of
budget, three attempts and three candidates then buy an unbounded number of
hours on one thread, with a `content-length` of 40 and no cap ever crossed.

So the transport measures the whole attempt — headers and body — against the
`read` timeout the caller asked for, which is the number that caller already
meant by it. Nothing legitimate here is affected: these clients do not stream,
so a completion's whole latency is its time-to-first-byte, and that was bounded
by the same figure already.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Iterator

import httpx

_log = logging.getLogger("http_client")

# Far above every real body these clients read: an LLM completion is bounded by
# its token cap, a search page is a few hundred kilobytes, a Bedrock model list
# is smaller still. Chosen to be comfortably out of the way of a legitimate
# answer rather than to be tight, because the failure it guards is unbounded
# rather than merely large.
MAX_RESPONSE_BYTES = 16 * 1024 * 1024

#: Named through the `_VAR` convention rather than inline, because that is the
#: spelling `envExample.test.ts` can see — a variable it cannot see is one it
#: will report as read by nothing, and the advice that follows is to delete it
#: from the deployment contract.
MAX_RESPONSE_BYTES_VAR = "MAX_RESPONSE_BYTES"


#: Configuration lines this process has already written, keyed by the reading
#: they were about.
#:
#: `new_client` is called once per outbound request, so an unconditional line in
#: the reader below would be a line per LLM call. Keyed on the value rather than
#: a bare flag so a ceiling that changes at runtime — which is what the suite
#: does — is still announced, and so a redeploy that fixes a typo says so
#: instead of staying quiet because the wrong value was already reported.
_announced: set[str] = set()


def _announce_once(key: str, level: int, message: str, **fields: object) -> None:
    if key in _announced:
        return
    _announced.add(key)
    _log.log(level, message, extra={"event": "http_client_config", **fields})


def max_response_bytes(default: int = MAX_RESPONSE_BYTES) -> int:
    """Configured ceiling (MAX_RESPONSE_BYTES); 0 disables it.

    ## Why the two lines (round 341, methodology M11)

    Both fallbacks were silent, and this service already has the convention for
    them twice over: ``limits._misconfigured`` says in as many words that
    "falling back *without saying so* is its own failure — the operator who
    raised the body cap has a service running on the old one and nothing
    anywhere disagrees with them", and ``ratelimit.install_rate_limit`` warns
    whenever the ceiling it ends up with is nothing. This reader did neither.

    An unparseable value — ``MAX_RESPONSE_BYTES=16MB`` in a unit file — took the
    default with nothing said, which is exactly the sentence above.

    And a *negative* one resolves to 0, which this function documents as off, so
    a mistyped ``-1`` turns the ceiling off rather than tightening it. That is
    not a smaller cap being applied quietly; it is the guard whose module header
    says "the failure it guards is unbounded rather than merely large" being
    removed by a typo, with the socket then free to deliver into a buffer nobody
    is draining for as long as the far end keeps sending. ``0`` remains a
    supported way to turn it off — it is in the docstring and ``new_client``
    relies on it — so this is a line, not a refusal.
    """
    raw = os.environ.get(MAX_RESPONSE_BYTES_VAR)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        _announce_once(
            f"unparseable:{raw}",
            logging.WARNING,
            "MAX_RESPONSE_BYTES is not an integer — falling back to the default",
            detail=raw,
            limit=default,
        )
        return default
    # Negative is a typo for "off", not a licence to buffer everything — and
    # "off" is what it resolves to, which is why the line below exists.
    ceiling = max(value, 0)
    if ceiling == 0:
        _announce_once(
            f"off:{raw}",
            logging.WARNING,
            "response size ceiling disabled — a far end that never stops sending will be buffered without limit",
            detail=raw,
            limit=0,
        )
    elif ceiling != default:
        # The other half, for the same reason `install_rate_limit` logs the
        # ceiling it enabled: an operator who raised or lowered this has no
        # other way to confirm the value reached the process.
        _announce_once(
            f"set:{ceiling}",
            logging.INFO,
            "response size ceiling configured",
            limit=ceiling,
        )
    return ceiling


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


class ResponseTooSlow(httpx.ReadTimeout):
    """An answer still arriving after its whole attempt budget, abandoned.

    A `TimeoutException` and therefore a `TransportError`, which is the
    opposite choice to `ResponseTooLarge` and for the opposite reason: an
    oversized answer will be oversized again, but a far end having a slow
    minute may well answer the next attempt. The retry ladders treat it as they
    treat any other timeout, and `llm_http.Deadline` — which is shrinking all
    the while — is what ends the call rather than letting it retry forever.
    """

    def __init__(self, budget_s: float) -> None:
        super().__init__(f"response was still arriving after {budget_s:g}s and was abandoned")
        self.budget_s = budget_s


class _CappedStream(httpx.SyncByteStream):
    """Passes chunks through until they total more than `limit`, or take too long.

    `started` is the moment the *request* went out rather than the moment the
    body began, so the two halves of an attempt — waiting for the first byte and
    reading the rest — share one budget instead of each getting the whole one.
    """

    def __init__(
        self,
        inner: httpx.SyncByteStream,
        limit: int,
        *,
        budget_s: float | None = None,
        started: float | None = None,
    ) -> None:
        self._inner = inner
        self._limit = limit
        self._budget_s = budget_s
        self._started = time.monotonic() if started is None else started

    def _out_of_time(self) -> bool:
        return self._budget_s is not None and time.monotonic() - self._started > self._budget_s

    def __iter__(self) -> Iterator[bytes]:
        total = 0
        for chunk in self._inner:
            total += len(chunk)
            if self._limit > 0 and total > self._limit:
                # Closing is what makes the bound real — without it the socket
                # keeps delivering into a buffer nobody is draining.
                self.close()
                raise ResponseTooLarge(self._limit)
            if self._out_of_time():
                self.close()
                raise ResponseTooSlow(self._budget_s)  # type: ignore[arg-type]
            yield chunk

    def close(self) -> None:
        closer = getattr(self._inner, "close", None)
        if closer is not None:
            closer()


def _attempt_budget_s(request: httpx.Request) -> float | None:
    """The whole-attempt budget: the `read` timeout the caller asked for.

    httpx records the resolved timeouts on the request, so this needs nothing
    from the call sites — which is the point, since the call site that gets it
    wrong is always the one added later.
    """
    timeout = request.extensions.get("timeout")
    if not isinstance(timeout, dict):
        return None
    read = timeout.get("read")
    if not isinstance(read, (int, float)) or isinstance(read, bool) or read <= 0:
        return None
    return float(read)


class CappedTransport(httpx.BaseTransport):
    """Wraps a transport so a response stops at `limit` bytes and at its budget.

    A `limit` of 0 or less turns the size ceiling off (MAX_RESPONSE_BYTES=0);
    the time ceiling is not configurable and does not turn off, because it is
    not a size opinion — it is the caller's own `timeout=` finally meaning what
    every one of them already reads it as.
    """

    def __init__(self, inner: httpx.BaseTransport, limit: int) -> None:
        self._inner = inner
        self._limit = limit

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        started = time.monotonic()
        budget_s = _attempt_budget_s(request)
        response = self._inner.handle_request(request)
        declared = response.headers.get("content-length")
        if (
            self._limit > 0
            and declared is not None
            and declared.isdigit()
            and int(declared) > self._limit
        ):
            response.close()
            raise ResponseTooLarge(self._limit)
        stream = response.stream
        if not isinstance(stream, httpx.SyncByteStream):  # pragma: no cover - async transport
            return response
        return httpx.Response(
            status_code=response.status_code,
            headers=response.headers,
            stream=_CappedStream(stream, self._limit, budget_s=budget_s, started=started),
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

    Wrapped unconditionally: `MAX_RESPONSE_BYTES=0` is an operator turning off
    the *size* ceiling, and reading it as "no transport at all" would silently
    take the time ceiling with it.
    """
    return httpx.Client(  # type: ignore[arg-type]
        transport=CappedTransport(
            transport if transport is not None else httpx.HTTPTransport(),
            max_response_bytes(),
        ),
        **kwargs,
    )
