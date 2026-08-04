"""Shared-secret authentication for the internal AI service (audit B-1 P0).

The AI and engine services have no user-facing auth: the valuation service is
their only legitimate caller. This middleware requires a constant-time-checked
``X-Internal-Token`` header on every non-health route whenever
``INTERNAL_SERVICE_TOKEN`` is configured, so exposing the port no longer means
exposing the LLM pipelines. Combined with binding uvicorn to loopback (see the
Dockerfile ``--host 127.0.0.1``), this closes the "zero auth on 0.0.0.0" gap.

The token is read from the environment per-request (not at import) so a
deployment can rotate it without a code change and tests can toggle it.
"""

from __future__ import annotations

import hmac
import logging
import os

from fastapi import Request

from .errors import error_response

INTERNAL_TOKEN_HEADER = "x-internal-token"
INTERNAL_TOKEN_ENV = "INTERNAL_SERVICE_TOKEN"

# Liveness / readiness / API introspection are always reachable so a load
# balancer or `docker healthcheck` never needs the secret.
_PUBLIC_PATHS = frozenset(
    {"/", "/health", "/ready", "/engine/v1/health", "/docs", "/redoc", "/openapi.json"}
)

_log = logging.getLogger("internal_auth")


def _configured_token() -> str | None:
    token = os.environ.get(INTERNAL_TOKEN_ENV)
    return token or None


def is_public_path(path: str) -> bool:
    return path in _PUBLIC_PATHS


def _header_bytes(value: str) -> bytes:
    """The bytes a header value arrived as, back from the ``str`` we were given.

    Starlette decodes request headers as latin-1, which is a byte-for-byte
    mapping, so re-encoding that way recovers exactly what the client sent.
    The fallback exists because the decoding is the ASGI server's choice, not
    ours: a value holding a character above U+00FF did not come from a latin-1
    decode, and UTF-8 is the only other reading worth trying.
    """
    try:
        return value.encode("latin-1")
    except UnicodeEncodeError:
        return value.encode("utf-8")


def tokens_match(provided: str | None, expected: str) -> bool:
    """Constant-time comparison that answers for *any* header value.

    ``hmac.compare_digest`` on two ``str`` arguments raises ``TypeError`` the
    moment either one holds a character outside ASCII, and a header value is
    not ours to keep inside it: a single latin-1 byte above 0x7f —
    ``X-Internal-Token: caf\\xe9`` — produced one. The raise happened *inside*
    the gate, above every handler, so the request was never rejected; it fell
    through to the unhandled-error middleware and came back 500 with a full
    traceback logged. A rejected token has to look like a rejected token, or
    the one check whose job is to say "no" becomes a way to make the service
    throw, and to tell from outside exactly which byte did it.

    Comparing bytes instead is total over the input and stays constant-time.
    The two sides are recovered from different encodings on purpose: `expected`
    came from the environment, which Python decodes as UTF-8, while `provided`
    came off the wire — so this compares the bytes the operator configured
    against the bytes the caller actually sent, and a secret is free to be any
    of them.
    """
    if provided is None:
        return False
    return hmac.compare_digest(_header_bytes(provided), expected.encode("utf-8"))


async def internal_token_middleware(request: Request, call_next):
    """Reject non-health requests whose ``X-Internal-Token`` doesn't match.

    A no-op when the secret is unset (local dev / tests). Production MUST set
    ``INTERNAL_SERVICE_TOKEN`` — ``warn_if_unset`` logs a startup warning so a
    misconfigured deploy is loud rather than silently open.
    """
    expected = _configured_token()
    if expected is not None and not is_public_path(request.url.path):
        if not tokens_match(request.headers.get(INTERNAL_TOKEN_HEADER), expected):
            return error_response(401, "Missing or invalid internal service token")
    return await call_next(request)


def warn_if_unset() -> None:
    if _configured_token() is None:
        _log.warning(
            "%s is not set — the service accepts unauthenticated requests. "
            "Set it in production and bind to loopback.",
            INTERNAL_TOKEN_ENV,
        )
