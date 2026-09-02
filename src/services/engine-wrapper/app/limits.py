"""Request-body cap + threadpool sizing (audit B-2 P2).

Two DoS mitigations shared by the FastAPI services:

* **Body-size cap** — FastAPI has no default body limit, so a large base64
  ``documents`` array is buffered fully in memory (OOM/DoS). Reject over-size
  requests up front from ``Content-Length``, and — when the caller does not
  declare one — count the body as it streams and cut it off at the same
  ceiling.
* **Threadpool sizing** — FastAPI runs sync ``def`` handlers in a bounded
  threadpool; LLM calls block up to 90s and CPU-bound engine work holds a
  thread for its duration. Make the size a deliberate, tunable number instead
  of an implicit default.
"""

from __future__ import annotations

import logging
import os

import anyio
from starlette.datastructures import Headers

from .asgi import ASGIApp, Receive, Scope, Send
from .errors import error_response

_log = logging.getLogger("limits")


def _misconfigured(name: str, raw: str, default: int) -> int:
    """Log a rejected value and hand back the default.

    Falling back rather than raising is deliberate — both readers below run
    during start-up, and an unhandled ValueError here is a service that will not
    boot because somebody wrote "8MB" in a unit file. But falling back *without
    saying so* is its own failure: the operator who raised the body cap has a
    service running on the old one and nothing anywhere disagrees with them.
    ``ratelimit.limit_per_minute`` has warned on exactly this since it was
    written; these two never did.
    """
    _log.warning(
        "%s is not a positive integer — falling back to the default",
        name,
        extra={"event": "limits_config", "detail": raw, "limit": default},
    )
    return default


def max_body_bytes(default: int) -> int:
    """Configured request-body ceiling (MAX_REQUEST_BODY_BYTES), else `default`."""
    raw = os.environ.get("MAX_REQUEST_BODY_BYTES")
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return _misconfigured("MAX_REQUEST_BODY_BYTES", raw, default)
    # Zero would refuse every request carrying a body; a negative one is not a
    # cap at all. Neither is something the operator can have meant.
    return value if value > 0 else _misconfigured("MAX_REQUEST_BODY_BYTES", raw, default)


# Methods that may carry a body. A GET or a HEAD arrives with neither a
# Content-Length nor a body, so there is nothing to meter and no reason to pay
# for an extra `receive()` round-trip on the hottest paths (/health, /ready).
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


async def _read_capped(receive: Receive, limit_bytes: int) -> list[dict] | None:
    """Drain the request body, stopping the moment it passes `limit_bytes`.

    Returns the ASGI messages read (to be replayed downstream), or ``None`` if
    the body went over — in which case the rest of it is never read, so what
    was buffered is bounded by the cap itself.
    """
    messages: list[dict] = []
    total = 0
    while True:
        message = await receive()
        messages.append(message)
        if message["type"] != "http.request":
            return messages  # http.disconnect — nothing more is coming
        total += len(message.get("body", b""))
        if total > limit_bytes:
            return None
        if not message.get("more_body", False):
            return messages


def make_body_limit_middleware(limit_bytes: int):
    """Middleware that 413s requests whose body exceeds `limit_bytes`.

    ``Content-Length`` is the cheap answer and is checked first: it refuses the
    request before a single byte of the body is read.

    It is not, however, the only way a body arrives. A chunked request
    (``Transfer-Encoding: chunked``) carries no Content-Length at all, so the
    header check saw ``None``, waved it through, and the body was then buffered
    in full by ``request.json()`` — the exact OOM this middleware exists to
    prevent, reachable by anyone who can set one header. So when no length is
    declared, the body is metered as it streams and abandoned at the ceiling,
    and the messages already read are replayed to the route so a legitimate
    chunked request still sees its body.
    """

    def factory(app: ASGIApp) -> ASGIApp:
        async def body_limit_middleware(scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await app(scope, receive, send)
                return
            content_length = Headers(scope=scope).get("content-length")
            if content_length is not None:
                try:
                    declared = int(content_length)
                except ValueError:
                    await error_response(400, "Invalid Content-Length")(scope, receive, send)
                    return
                # A negative length is not a small body; it is a malformed header
                # that would otherwise slip under the comparison below.
                if declared < 0:
                    await error_response(400, "Invalid Content-Length")(scope, receive, send)
                    return
                if declared > limit_bytes:
                    await error_response(413, f"Request body exceeds {limit_bytes} bytes")(scope, receive, send)
                    return
                await app(scope, receive, send)
                return

            if scope["method"] not in _BODY_METHODS:
                await app(scope, receive, send)
                return

            messages = await _read_capped(receive, limit_bytes)
            if messages is None:
                await error_response(413, f"Request body exceeds {limit_bytes} bytes")(scope, receive, send)
                return

            pending = iter(messages)

            async def replay() -> dict:
                # After the buffered messages run out the body is finished; a
                # downstream read past the end is answered with a disconnect, which
                # is what an ASGI server sends once the client is done.
                return next(pending, {"type": "http.disconnect"})

            # Pure ASGI replaces `receive` for everything downstream rather than
            # reaching into a Request's private `_receive`: the route builds its
            # own Request from whatever this hands on, so there is no object to
            # patch and nothing that can be handed the original by mistake.
            await app(scope, replay, send)

        return body_limit_middleware

    return factory


def threadpool_size(default: int = 40) -> int:
    """Configured sync-handler threadpool size (THREADPOOL_MAX), else `default`."""
    raw = os.environ.get("THREADPOOL_MAX")
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return _misconfigured("THREADPOOL_MAX", raw, default)
    # A pool of zero threads runs no sync handler at all — every `def` route
    # would hang forever rather than fail.
    return value if value > 0 else _misconfigured("THREADPOOL_MAX", raw, default)


def configure_threadpool(total_tokens: int) -> None:
    """Set the anyio threadpool capacity (must run inside the event loop)."""
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = total_tokens
    _log.info("threadpool sized", extra={"event": "threadpool", "limit": total_tokens})
