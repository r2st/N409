"""Structured JSON logging + request-id propagation (audit B-2 P3).

The Python tier was a trace blind spot: no structured logger and no request
correlation, unlike the TS services (pino + OTel). This module gives both
FastAPI apps a JSON log formatter and an ``x-request-id`` that is accepted from
the caller (the valuation service) — or minted when absent — bound to a
context var so every log line for a request carries it, and echoed back on the
response.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import time
import uuid

from fastapi import Request

REQUEST_ID_HEADER = "x-request-id"
_request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

# Keys the formatter promotes from ``logging`` extras onto the JSON line.
_EXTRA_KEYS = ("http_method", "path", "status", "duration_ms", "event")


def current_request_id() -> str:
    return _request_id.get()


def _level_for(status: int) -> int:
    """Access-log level for a response status — 5xx errors, 4xx warnings."""
    if status >= 500:
        return logging.ERROR
    if status >= 400:
        return logging.WARNING
    return logging.INFO


class JsonLogFormatter(logging.Formatter):
    """One JSON object per line, with the active request id attached."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": _request_id.get(),
        }
        for key in _EXTRA_KEYS:
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(service: str, level: str | None = None) -> None:
    """Installs the JSON formatter on the root logger (idempotent)."""
    log_level = (level or os.environ.get("LOG_LEVEL") or "info").upper()
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLogFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, log_level, logging.INFO))
    logging.getLogger(service).setLevel(getattr(logging, log_level, logging.INFO))


def make_request_context_middleware(service: str):
    """Middleware that binds a request id and logs one access line per request."""
    access_log = logging.getLogger(service)

    async def request_context_middleware(request: Request, call_next):
        incoming = request.headers.get(REQUEST_ID_HEADER)
        request_id = incoming if incoming else uuid.uuid4().hex
        token = _request_id.set(request_id)
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers[REQUEST_ID_HEADER] = request_id
            return response
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            # Level tracks the status so `level=error` is a usable production
            # filter: at a uniform info, a 500 is indistinguishable from a 200
            # in any log query that isn't already parsing the status field.
            access_log.log(
                _level_for(status),
                "request",
                extra={
                    "event": "http_access",
                    "http_method": request.method,
                    "path": request.url.path,
                    "status": status,
                    "duration_ms": duration_ms,
                },
            )
            _request_id.reset(token)

    return request_context_middleware
