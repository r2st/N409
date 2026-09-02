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

It also scrubs what those bodies carry. The log was already treated as a place
a credential must not land and the response was not, though both are built from
the same ``str(exc)`` — see ``_scrubbed``.

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
from math import isfinite

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .asgi import ASGIApp, Receive, Scope, Send
from .observability import REQUEST_ID_HEADER, current_request_id, redact

# What the caller is told when an exception escaped. Deliberately says nothing
# about the exception: the request id is the handle for the real story, which
# lives in the log.
INTERNAL_ERROR_DETAIL = "Internal Server Error"


# How far into a ``detail`` the scrub reaches. A detail is a string, or the list
# of dicts a request-validation failure produces; three levels covers both with
# headroom, and bounds the work on a shape nobody anticipated.
_SCRUB_DEPTH = 3


def _scrubbed(value: object, depth: int = 0) -> object:
    """``detail``, with every string in it put through the log's redactions.

    The same string reaches two sinks and only one of them was treated as a
    disclosure. ``install_error_handlers`` logs a 5xx ``detail`` through the JSON
    formatter, which redacts it — the note there says why, in as many words:
    "these details are built from an upstream's own words (``str(exc)``), and an
    OpenRouter error quotes the URL it called, key and all". The very next line
    put that identical string into the response body untouched, and the response
    is the half that leaves the process.

    Where it goes from there is not a hypothetical. The valuation service reads
    a string ``detail`` as the upstream's own sentence (``InternalServiceError``
    is explicit that this is the non-opaque case), writes it to
    ``network_items.error`` on the engagement, and renders it to the analyst in a
    problem document. So an address, an ``sk-`` key or a ``Bearer`` header that
    appeared in a provider's body was struck from the journal on this box and
    kept in Postgres on the other one.

    Deliberately the log's own ``redact`` rather than a second list: two
    redaction policies for one string is how the halves drift, and everything it
    strikes — addresses, national identifiers, phone numbers, credentials — is a
    thing no caller needs in order to act on the failure. The pass reaches
    strings wherever they sit, because a 422 ``detail`` is pydantic's error list
    and its entries carry an ``input`` field echoing the offending payload.

    That ``input`` field is also why this pass has to make the value *JSON*-safe
    and not only disclosure-safe. ``1e999`` and ``NaN`` are accepted by every
    JSON parser in use here and become Python ``inf``/``nan``, which
    ``json.dumps`` refuses — so a field pydantic had already refused, correctly,
    with the field named in ``loc``, was echoed back into the response body and
    killed the encoder. The 422 became an ``Internal Server Error`` with the
    field name lost, a traceback in the log and the failure counted as this
    service breaking rather than as the request being wrong. Every endpoint of
    both Python services was reachable this way, on any field whose declared
    type refuses a float: a string, an int, an enum, a list element.
    """
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, float) and not isfinite(value):
        return repr(value)
    if isinstance(value, (list, dict)) and depth >= _SCRUB_DEPTH:
        # Rendered rather than returned, so the walk is total: past the cap a
        # container was handed back untouched, and `json.dumps` cannot encode
        # every container — the one that reaches here is the caller's own
        # payload, echoed by pydantic's `input`, and it may hold anything.
        # `redact` is applied to the rendering for the same reason it is applied
        # to a string: the scrub must not have a depth past which it stops.
        return redact(str(value))
    if isinstance(value, list):
        return [_scrubbed(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {key: _scrubbed(item, depth + 1) for key, item in value.items()}
    return value


def error_response(status_code: int, detail: object, **extra: object) -> JSONResponse:
    """A JSON error body carrying the active request id, in both places.

    The id goes in the body *and* the header: a caller reading a failed
    response in a browser devtools pane sees one, a caller logging the
    exception object sees the other.

    ``detail`` is scrubbed on the way out — see {@link _scrubbed}. This is the
    one funnel every error body in this tier passes through: the deliberate
    ``HTTPException``, the 422 field list, and the generic 500, so nothing has to
    remember.
    """
    request_id = current_request_id()
    content: dict[str, object] = {"detail": _scrubbed(detail), "request_id": request_id, **extra}
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

    def factory(app: ASGIApp) -> ASGIApp:
        async def unhandled_error_middleware(scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await app(scope, receive, send)
                return
            started = False

            async def send_wrapper(message: dict) -> None:
                nonlocal started
                if message["type"] == "http.response.start":
                    started = True
                await send(message)

            try:
                await app(scope, receive, send_wrapper)
            except Exception:
                # exc_info, not str(exc): the message alone rarely says which line
                # of which approach raised, and this is the only record there is.
                log.error(
                    "unhandled exception",
                    exc_info=True,
                    extra={
                        "event": "unhandled_error",
                        "http_method": scope["method"],
                        "path": scope["path"],
                        "status": 500,
                    },
                )
                # Once the status line is on the wire there is no 500 left to
                # send — the client already has a header block saying otherwise.
                # Re-raising hands it to the server, which closes the connection
                # rather than appending an error body to a response that claimed
                # success. The log line above is written either way, so the
                # failure is still recorded.
                if started:
                    raise
                await error_response(500, INTERNAL_ERROR_DETAIL)(scope, receive, send)

        return unhandled_error_middleware

    return factory


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
