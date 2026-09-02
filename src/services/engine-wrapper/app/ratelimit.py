"""Per-caller request rate limiting for the FastAPI tier.

The valuation service throttles every edge it owns — partner API keys, SCIM,
the unauthenticated auth routes, a weighted budget for expensive renders. The
Python tier had nothing. That gap matters more than the "only the valuation
service calls us" framing suggests: both services do unbounded work per
request (a compute holds a CPU for its duration, a pipeline blocks on an LLM
for up to 90 seconds), so a caller that loops — a retry storm, a batch job
with a bug, anything that reached the port — saturates the box with a request
count that no body-size cap or threadpool ceiling turns away. The threadpool
bounds how much runs at once; it does nothing about how much queues up.

Fixed windows in process memory, matching plugins/rateLimit.ts: these services
are single-process, and if that changes the counters move to Redis alongside
the TS ones.

Two deliberate choices:

* **On by default.** An opt-in limiter is off in production — this deployment's
  ``.env`` sets little beyond ``DATABASE_URL`` — so the default is a ceiling
  high enough that no legitimate caller meets it and low enough to stop a loop.
* **Health checks are exempt.** A limiter that 429s the load balancer's probe
  takes the service out of rotation exactly when it is busiest, which is the
  opposite of what it is for.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from starlette.datastructures import MutableHeaders

from .asgi import ASGIApp, Receive, Scope, Send
from .errors import error_response
from .internal_auth import is_public_path

# Generous by design: a valuation makes a handful of engine calls, and a
# sensitivity grid is one request however many cells it computes. Anything
# approaching this is a loop, not a workload. Each service passes its own.
DEFAULT_LIMIT_PER_MINUTE = 1200

# Keys are client addresses. On loopback that is one key; the ceiling exists so
# a service reachable from a wider network can't be made to grow without bound.
_MAX_KEYS = 10_000

_log = logging.getLogger("ratelimit")


def limit_per_minute(default: int = DEFAULT_LIMIT_PER_MINUTE) -> int:
    """Configured per-caller ceiling (RATE_LIMIT_RPM); 0 disables the limiter."""
    raw = os.environ.get("RATE_LIMIT_RPM")
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        _log.warning(
            "RATE_LIMIT_RPM is not an integer — falling back to the default",
            extra={"event": "ratelimit_config", "limit": default},
        )
        return default
    # Negative is a typo for "off", not a licence to admit everything.
    return max(value, 0)


class FixedWindowRateLimiter:
    """Counts requests per key per window. Thread-safe: sync handlers run in a pool."""

    def __init__(self, limit: int, window_s: float = 60.0) -> None:
        self.limit = limit
        self.window_s = window_s
        self._windows: dict[str, list[float]] = {}  # key → [window_start, count]
        self._lock = threading.Lock()

    def check(self, key: str, now: float | None = None) -> tuple[bool, int, float]:
        """``(allowed, remaining, reset_at)`` for one request against `key`."""
        now = time.time() if now is None else now
        with self._lock:
            window = self._windows.get(key)
            if window is None or now - window[0] >= self.window_s:
                self._sweep(now)
                self._windows[key] = [now, 1.0]
                return True, self.limit - 1, now + self.window_s

            reset_at = window[0] + self.window_s
            if window[1] >= self.limit:
                return False, 0, reset_at
            window[1] += 1
            return True, int(self.limit - window[1]), reset_at

    def _sweep(self, now: float) -> None:
        """Drop expired windows so idle keys don't accumulate. Caller holds the lock."""
        if len(self._windows) < _MAX_KEYS:
            return
        for key in [k for k, w in self._windows.items() if now - w[0] >= self.window_s]:
            del self._windows[key]
        if len(self._windows) >= _MAX_KEYS:
            # Keys are arriving faster than they expire. Staying up matters more
            # than holding every counter, so drop the oldest — they are closest
            # to resetting anyway, so the least budget is handed back.
            for key in sorted(self._windows, key=lambda k: self._windows[k][0])[: _MAX_KEYS // 2]:
                del self._windows[key]

    @property
    def tracked_keys(self) -> int:
        """Number of live windows — for tests and diagnostics."""
        with self._lock:
            return len(self._windows)


def client_key(scope: Scope) -> str:
    """Identify the caller by peer address.

    Deliberately not X-Forwarded-For: it is caller-supplied, and a limiter that
    trusts it can be defeated by varying one header. These services bind to
    loopback behind the valuation service, so the peer address is the truth.

    Takes the raw ASGI scope rather than a ``Request``: this middleware is pure
    ASGI (see ``asgi.py``) and the scope's ``client`` is the same
    ``(host, port)`` pair ``Request.client`` reads.
    """
    client = scope.get("client")
    host = client[0] if client else None
    return host if host else "unknown"


def make_rate_limit_middleware(limit: int, window_s: float = 60.0):
    """Middleware enforcing `limit` requests per `window_s` per caller.

    Returns a pass-through when `limit` is 0, so disabling costs nothing per
    request rather than running a limiter that always says yes.
    """
    if limit <= 0:
        _log.warning(
            "rate limiting disabled (RATE_LIMIT_RPM=0)",
            extra={"event": "ratelimit_config", "limit": 0},
        )

        def passthrough(app: ASGIApp) -> ASGIApp:
            return app

        return passthrough

    limiter = FixedWindowRateLimiter(limit, window_s)
    _log.info(
        "rate limiting enabled",
        extra={"event": "ratelimit_config", "limit": limit},
    )

    def factory(app: ASGIApp) -> ASGIApp:
        async def rate_limit_middleware(scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await app(scope, receive, send)
                return
            # Same set the internal-token gate leaves open — liveness, readiness,
            # API introspection — so the two can't drift into disagreeing about
            # which endpoints are infrastructure.
            if is_public_path(scope["path"]):
                await app(scope, receive, send)
                return

            key = client_key(scope)
            allowed, remaining, reset_at = limiter.check(key)
            headers = {
                "x-ratelimit-limit": str(limit),
                "x-ratelimit-remaining": str(remaining),
                "x-ratelimit-reset": str(int(reset_at)),
            }
            if not allowed:
                retry_after = max(1, int(reset_at - time.time() + 0.999))
                _log.warning(
                    "rate limit exceeded",
                    extra={
                        "event": "ratelimit_exceeded",
                        "http_method": scope["method"],
                        "path": scope["path"],
                        "status": 429,
                    },
                )
                response = error_response(429, f"Rate limit exceeded: {limit} requests per minute")
                response.headers.update(headers)
                response.headers["retry-after"] = str(retry_after)
                await response(scope, receive, send)
                return

            async def send_wrapper(message: dict) -> None:
                if message["type"] == "http.response.start":
                    # Headroom on every answer, so a caller can back off before
                    # it is cut off rather than discovering the limit by hitting
                    # it.
                    existing = MutableHeaders(scope=message)
                    for name, value in headers.items():
                        existing[name] = value
                await send(message)

            await app(scope, receive, send_wrapper)

        return rate_limit_middleware

    return factory
