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


async def internal_token_middleware(request: Request, call_next):
    """Reject non-health requests whose ``X-Internal-Token`` doesn't match.

    A no-op when the secret is unset (local dev / tests). Production MUST set
    ``INTERNAL_SERVICE_TOKEN`` — ``warn_if_unset`` logs a startup warning so a
    misconfigured deploy is loud rather than silently open.
    """
    expected = _configured_token()
    if expected is not None and not is_public_path(request.url.path):
        provided = request.headers.get(INTERNAL_TOKEN_HEADER)
        if provided is None or not hmac.compare_digest(provided, expected):
            return error_response(401, "Missing or invalid internal service token")
    return await call_next(request)


def warn_if_unset() -> None:
    if _configured_token() is None:
        _log.warning(
            "%s is not set — the service accepts unauthenticated requests. "
            "Set it in production and bind to loopback.",
            INTERNAL_TOKEN_ENV,
        )
