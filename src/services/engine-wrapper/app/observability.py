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
import re
import time
import uuid

from fastapi import Request

REQUEST_ID_HEADER = "x-request-id"
_request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

# Keys the formatter promotes from ``logging`` extras onto the JSON line.
# An allowlist, not a passthrough: a caller cannot widen what gets logged by
# adding a key to ``extra``.
#
# ## Why there are more than five of them
#
# There were five — ``http_method``, ``path``, ``status``, ``duration_ms``,
# ``event`` — and they are the right five for an access log, which is where they
# came from. Everything else this tier logs was then squeezed into them, and the
# result is fields whose names are not true:
#
#   * ``status`` held an HTTP status at seven sites and, at twenty others, a
#     retry attempt number, a token total, a configured limit, a count of
#     citations, and two different strings. Nothing can alert on ``status >=
#     500`` against that.
#   * ``path`` held a URL path, and also the model id an LLM call was routed to
#     and the name of a research provider, so "group the failures by model" and
#     "group by endpoint" are the same query and neither answers.
#   * ``duration_ms`` held a cumulative *token* count on the usage line.
#
# And ``detail`` was passed by four call sites that are not in this list at all,
# so the value each of them thought it was logging — the finish reason a
# completion was truncated at, the malformed value an operator had typed into a
# limit — was dropped on the floor by the formatter with nothing to say so. A
# field that is silently discarded reads, from the call site, exactly like a
# field that is logged.
#
# So the allowlist is widened with named dimensions rather than the five being
# overloaded further. It is still an allowlist: a key not named here is still
# dropped, which is the property this list exists for.
_EXTRA_KEYS = (
    # access log
    "http_method",
    "path",
    "status",
    "duration_ms",
    "event",
    # free text — redacted like the message, since it can quote an input
    "detail",
    # who served the work
    "model",
    "provider",
    "pipeline",
    # how much of it there was
    "attempt",
    "tokens",
    "tokens_total",
    "count",
    "limit",
)

# ── Redaction ────────────────────────────────────────────────────────────────
# The TS services redact through pino's `redact` paths (packages/shared logger),
# which works because pino logs structured objects with known field names. The
# free-text fields here — the message a caller formatted, and the traceback of
# an exception nobody caught — have no field names to key off, so they are
# matched by shape instead.
#
# Not a replacement for app/anonymize.py, which redacts document text before it
# reaches an external LLM and can afford to be aggressive. This is a safety net
# on the way to disk: it catches the identifiers that are unambiguous by shape,
# and deliberately leaves alone the bare numbers a valuation log is full of
# (share counts, dollar amounts) rather than mangling every line to catch a
# phone number that was never there.
_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[EMAIL]"),
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[SSN]"),
    (re.compile(r"\b\d{2}-\d{7}\b"), "[EIN]"),
    # Phone-shaped only: an area code in parentheses or followed by a
    # separator, so a 10-digit share count is untouched.
    (
        re.compile(
            r"""(?<![\d.,$-])
                (?:\+\d{1,3}[\s.-]?)?
                (?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])
                \d{3}[\s.-]\d{4}
                (?!\d)(?![.,]\d)""",
            re.VERBOSE,
        ),
        "[PHONE]",
    ),
    # Credentials that reached a message or a URL. `Bearer …` and `sk-…` were
    # the two shapes this estate produced — internal token, OpenRouter — until a
    # second completion provider was added and signed its own requests.
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", re.IGNORECASE), "Bearer [REDACTED]"),
    (re.compile(r"\bsk-[A-Za-z0-9._-]{16,}"), "[API_KEY]"),
    # AWS SigV4, which `bedrock.py` builds by hand rather than through botocore.
    # Its authorization header is `AWS4-HMAC-SHA256 Credential=AKIA…/…,
    # SignedHeaders=…, Signature=<64 hex>` and matches none of the rules above.
    #
    # Reachable by an ordinary misconfiguration rather than by bad luck: AWS
    # answers a signature it will not accept — a skewed clock, a region that
    # does not match the one signed for — with `SignatureDoesNotMatch`, and that
    # body quotes the canonical request and the string-to-sign back at the
    # caller. `_error_message` keeps 200 characters of it, and the credential
    # scope is at the front of both.
    (re.compile(r"(?i)\bSignature=[0-9a-f]{16,}"), "Signature=[REDACTED]"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[AWS_KEY_ID]"),
    # Query-string credentials, e.g. an upstream URL in a traceback.
    (
        re.compile(r"(?i)\b(api[_-]?key|token|secret|password)=[^&\s\"']+"),
        r"\1=[REDACTED]",
    ),
)

# Secrets whose literal value must never appear, whatever shape it happens to
# have. Read per-line from the environment so a rotation takes effect without a
# restart — the same reason internal_auth reads its token per-request.
#
# The AWS pair are the round-241 addition and the reason this list is a list
# rather than a pattern. A second completion provider arrived with three
# credential variables of its own, and the shape rules above knew none of them:
# an AWS secret access key is forty characters of base64 with no prefix to
# recognise, and a session token is a few kilobytes of the same. Nothing failed
# and nothing looked wrong — which is the failure mode this net exists for, and
# it went one whole provider without being told.
#
# `AWS_ACCESS_KEY_ID` is deliberately not here: it is an identifier rather than
# a secret, it is matched by shape above, and putting it here would mean the
# literal comparison ran against a value short enough to appear in ordinary
# text the day an operator set it to something odd.
_SECRET_ENV_VARS = (
    "INTERNAL_SERVICE_TOKEN",
    "OPENROUTER_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
)

# Below this, a "secret" is either unset or too short to match without hitting
# ordinary words.
_MIN_SECRET_LEN = 8


def redact(text: str) -> str:
    """Strike identifiers and credentials from a free-text log field."""
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    for name in _SECRET_ENV_VARS:
        value = os.environ.get(name) or ""
        if len(value) >= _MIN_SECRET_LEN and value in text:
            text = text.replace(value, "[REDACTED]")
    return text


# The most of an inbound ``x-request-id`` this hop will repeat.
#
# Matches ``MAX_REQUEST_ID_CHARS`` in packages/shared: a UUID is 36 characters, a
# ULID 26, a W3C trace id 32, so this is far above any real id and is a ceiling
# on what one request can cost.
MAX_REQUEST_ID_CHARS = 128

# What an id is made of: the unreserved URL characters plus the separators
# tracing formats already use.
_ACCEPTABLE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._~:@=+-]+$")


def acceptable_request_id(raw: str | None) -> str | None:
    """An inbound ``x-request-id``, if it is one, and ``None`` if it is anything else.

    The Python half of the rule `packages/shared/src/requestContext.ts` states
    for the three Fastify services. Those adopt the header through
    ``requestIdFromHeaders``; these two took it verbatim, which is the behaviour
    that rule exists to replace — and the doc there counts *five* services,
    because the valuation service forwards its id to the engine and the AI
    gateway and every line of all five carries it.

    Two halves. The length, because an 8 KB header — the most Node's limit
    allows — becomes 8 KB on every line of a five-service trace, in a journal on
    a box with 3.8 GB of memory; nothing about it is malformed, it is simply a
    string the estate agreed to repeat without bound. And the charset, because
    an id is a value things are *joined* on: the JSON formatter escapes a
    newline rather than letting it forge a second line, but a control character
    in an id does not survive the grep or the journal query that a join is made
    of.

    A refusal is not an error. The caller sent something this hop will not
    adopt, and the answer is the id it would have minted anyway — the request is
    served and it is correlatable, just not under a name a client chose.
    """
    if not raw:
        return None
    if len(raw) > MAX_REQUEST_ID_CHARS:
        return None
    return raw if _ACCEPTABLE_REQUEST_ID.match(raw) else None


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

    def __init__(self, service: str | None = None) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": redact(record.getMessage()),
            "request_id": _request_id.get(),
        }
        # Matches pino's `base: { service }` on the TS side, so one aggregator
        # query can filter across the whole estate. `logger` is the module
        # within the service and is not a substitute — both the AI service and
        # the engine log under "limits" and "ratelimit".
        if self.service:
            payload["service"] = self.service
        for key in _EXTRA_KEYS:
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = redact(value) if isinstance(value, str) else value
        if record.exc_info:
            # The traceback carries the exception's own message, which in this
            # tier can quote the input that caused it.
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, default=str)


def configure_logging(service: str, level: str | None = None) -> None:
    """Installs the JSON formatter on the root logger (idempotent)."""
    log_level = (level or os.environ.get("LOG_LEVEL") or "info").upper()
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLogFormatter(service))
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, log_level, logging.INFO))
    logging.getLogger(service).setLevel(getattr(logging, log_level, logging.INFO))


def make_request_context_middleware(service: str):
    """Middleware that binds a request id and logs one access line per request."""
    access_log = logging.getLogger(service)

    async def request_context_middleware(request: Request, call_next):
        request_id = acceptable_request_id(request.headers.get(REQUEST_ID_HEADER)) or uuid.uuid4().hex
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
