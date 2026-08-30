"""Uniform error envelopes for the FastAPI tier.

Every deliberate failure in these services already answers with a JSON
``{"detail": ...}`` body — ``HTTPException`` from a route, 401 from the
internal-token gate, 413 from the body cap. The *undeliberate* one did not: an
exception nobody caught fell through to Starlette's default 500, which is the
bytes ``Internal Server Error`` as ``text/plain``, with no ``x-request-id`` on
the response and no log line carrying the traceback. So the one failure that
most needs diagnosing was the only one that could not be: the operator saw a
500 in the access log and had nothing to join it to.

This module closes that. ``make_unhandled_error_middleware`` catches whatever
escapes, logs it once at ``error`` with the traceback and the active request
id, and answers with the same JSON envelope every other failure uses. The
detail stays generic — an exception message can quote the input that caused it,
and in this tier that input is a client's cap table — so the traceback goes to
the log and the caller gets the request id to quote in a bug report.

``install_error_handlers`` puts the request id on the deliberate failures too,
so *every* error response can be traced back to its log line — and logs the 5xx
ones, which until R225 was the half that had no log line to be traced to. A 503
raised because OpenRouter never answered, or a 502 because a model returned
nothing parseable, is as much a server failure as an exception nobody caught;
it was merely a failure somebody had thought about, which is not the same thing
as one somebody was told about. The give-up in ``openrouter.py`` logs each
*attempt* at ``warning`` and raises the final failure without a line of its own,
so the condition that reaches a client had no record at all.

4xx stays unlogged. Those describe the request, the caller was told, and their
rate is set by whoever is making the mistakes.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .observability import REQUEST_ID_HEADER, current_request_id

# What the caller is told when an exception escaped. Deliberately says nothing
# about the exception: the request id is the handle for the real story, which
# lives in the log.
INTERNAL_ERROR_DETAIL = "Internal Server Error"


def error_response(status_code: int, detail: object, **extra: object) -> JSONResponse:
    """A JSON error body carrying the active request id, in both places.

    The id goes in the body *and* the header: a caller reading a failed
    response in a browser devtools pane sees one, a caller logging the
    exception object sees the other.
    """
    request_id = current_request_id()
    content: dict[str, object] = {"detail": detail, "request_id": request_id, **extra}
    return JSONResponse(
        status_code=status_code,
        content=content,
        headers={REQUEST_ID_HEADER: request_id},
    )


def make_unhandled_error_middleware(service: str):
    """Middleware turning an escaped exception into a logged, traceable 500.

    Must sit *inside* the request-context middleware so the request id is
    bound when this runs, and *outside* everything else so it catches their
    failures too.
    """
    log = logging.getLogger(service)

    async def unhandled_error_middleware(request: Request, call_next):
        try:
            return await call_next(request)
        except Exception:
            # exc_info, not str(exc): the message alone rarely says which line
            # of which approach raised, and this is the only record there is.
            log.error(
                "unhandled exception",
                exc_info=True,
                extra={
                    "event": "unhandled_error",
                    "http_method": request.method,
                    "path": request.url.path,
                    "status": 500,
                },
            )
            return error_response(500, INTERNAL_ERROR_DETAIL)

    return unhandled_error_middleware


def install_error_handlers(app: FastAPI, service: str | None = None) -> None:
    """Re-shape FastAPI's built-in error responses to carry the request id.

    ``detail`` keeps the exact shape FastAPI already produced — a string for
    ``HTTPException``, the list of field errors for a request-validation
    failure — so existing clients read these responses unchanged and only gain
    a field.

    ``service`` names the logger the 5xx line goes to, matching
    ``make_unhandled_error_middleware``. Left unset — as the rate-limit tests
    do, which build a bare app to exercise one route — the module logger is
    used, which the root handler formats identically.
    """
    log = logging.getLogger(service) if service else logging.getLogger(__name__)

    @app.exception_handler(StarletteHTTPException)
    async def _http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        if exc.status_code >= 500:
            # `detail` is in the formatter's allowlist and is redacted on the
            # way out like the message is, which matters here: these details
            # are built from an upstream's own words (`str(exc)`), and an
            # OpenRouter error quotes the URL it called, key and all.
            log.error(
                "request failed",
                extra={
                    "event": "request_failed",
                    "http_method": request.method,
                    "path": request.url.path,
                    "status": exc.status_code,
                    "detail": str(exc.detail),
                },
            )
        response = error_response(exc.status_code, exc.detail)
        # 401 challenges and 405s carry headers (WWW-Authenticate, Allow) that
        # are part of the protocol, not decoration.
        for key, value in (exc.headers or {}).items():
            response.headers[key] = value
        return response

    @app.exception_handler(RequestValidationError)
    async def _validation_exception_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # jsonable_encoder equivalent: errors() can hold non-serialisable ctx
        # values (a ValueError instance, typically), so stringify defensively.
        return error_response(422, _serialisable_errors(exc))

    return None


def _serialisable_errors(exc: RequestValidationError) -> list:
    """`exc.errors()` with any non-JSON `ctx` value rendered as a string."""
    out = []
    for error in exc.errors():
        item = dict(error)
        ctx = item.get("ctx")
        if isinstance(ctx, dict):
            item["ctx"] = {k: str(v) for k, v in ctx.items()}
        if "url" in item:
            del item["url"]  # pydantic docs link, noise in an API response
        out.append(item)
    return out
