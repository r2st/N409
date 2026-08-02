"""Request-body cap + threadpool sizing (audit B-2 P2).

Two DoS mitigations shared by the FastAPI services:

* **Body-size cap** — FastAPI has no default body limit, so a large base64
  ``documents`` array is buffered fully in memory (OOM/DoS). Reject over-size
  requests up front from ``Content-Length``.
* **Threadpool sizing** — FastAPI runs sync ``def`` handlers in a bounded
  threadpool; LLM calls block up to 90s and CPU-bound engine work holds a
  thread for its duration. Make the size a deliberate, tunable number instead
  of an implicit default.
"""

from __future__ import annotations

import logging
import os

import anyio
from fastapi import Request

from .errors import error_response

_log = logging.getLogger("limits")


def max_body_bytes(default: int) -> int:
    """Configured request-body ceiling (MAX_REQUEST_BODY_BYTES), else `default`."""
    raw = os.environ.get("MAX_REQUEST_BODY_BYTES")
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def make_body_limit_middleware(limit_bytes: int):
    """Middleware that 413s requests whose Content-Length exceeds `limit_bytes`."""

    async def body_limit_middleware(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                declared = int(content_length)
            except ValueError:
                return error_response(400, "Invalid Content-Length")
            if declared > limit_bytes:
                return error_response(413, f"Request body exceeds {limit_bytes} bytes")
        return await call_next(request)

    return body_limit_middleware


def threadpool_size(default: int = 40) -> int:
    """Configured sync-handler threadpool size (THREADPOOL_MAX), else `default`."""
    raw = os.environ.get("THREADPOOL_MAX")
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def configure_threadpool(total_tokens: int) -> None:
    """Set the anyio threadpool capacity (must run inside the event loop)."""
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = total_tokens
    _log.info("threadpool sized", extra={"event": "threadpool", "status": total_tokens})
