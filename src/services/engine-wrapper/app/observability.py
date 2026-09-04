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
from typing import Callable

from starlette.datastructures import Headers, MutableHeaders

from .asgi import ASGIApp, Receive, Scope, Send

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
    # how long something is being held off for, and the denominator for
    # `count`. Carried here because the two formatters are copied byte for byte
    # and the census holds the AI tier's list to a subset of this one — a key on
    # one side only is a field that logs on one service and vanishes on the
    # other, from call sites that read identically. Their users are in
    # `websearch` and `pipelines`, neither of which this tier has.
    "cooldown_s",
    "total",
    # which readiness checks came back invalid, and whether one of them gates
    # the verdict. Carried here for the same subset rule: the users are on the
    # AI tier's `/ready`, which is where R337 added them — and where the
    # formatter dropped both in silence until R338 named them.
    "failed",
    "gating",
    # how far out a run that could not be completed was — see
    # `engine.errors.EngineDegradedError`. Named rather than folded into
    # `count`/`limit`, which is the overloading the note above exists about:
    # `limit` already means a configured ceiling on requests, and a tolerance
    # asked the same question of it would answer both queries wrongly.
    "relative_error",
    "tolerance",
    "paths",
    # Which calculation a line is about (R428, methodology M11).
    #
    # `main._call_engine` writes it on the one line this tier emits about a 4xx,
    # under a comment saying why the line exists at all: the caller "cannot act
    # on `unsupported operand type ... for *: 'str' and 'float'`. Kept for
    # whoever can". Naming the calculation is the whole of what makes it
    # actionable — there are forty engine endpoints and the message names none
    # of them — and the formatter was dropping the field, which is exactly the
    # failure the note at the top of this list describes: from the call site a
    # silently discarded field reads the same as a logged one. The line has been
    # going out since R320 saying only that *some* calculation was handed a
    # value it could not use.
    #
    # Engine-only, like `relative_error` and `tolerance` above: `path` is the
    # URL an access-log line was served under and this is the calculation label
    # — `qsbs`, `backsolve` — a route handed its helper, so folding the two
    # together is the model-id overloading this list was widened to undo.
    "endpoint",
    # What a market-feed line is about: the feed method — prices, financials or
    # multiples — and the symbol it was asked for. Added in R305 with the first
    # log line this tier's `app/engine` package has ever written — a fallback
    # payload, which is how every market-data failure is reported. Two named
    # dimensions rather than prose in the message, because the diagnosis is a
    # group-by: one ticker the source does not carry looks nothing like every
    # ticker on the box failing, and only the second is an outage.
    "feed_kind",
    "ticker",
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
    # The one form this platform *stores*: `domain/phone.ts` normalizes every
    # accepted number to canonical E.164 on the way into `users.phone` and
    # `contact_submissions.phone`, and the rule below cannot match it — it
    # requires a separator between the groups, and E.164 has none. So the shape
    # a document excerpt or an error quotes back from the database was the one
    # shape the phone rule could not see.
    #
    # The leading `+` is what makes this safe beside a valuation's own numbers:
    # a share count, a cent amount and an epoch are all long runs of digits and
    # none is written with a plus, and a leading zero is not a country code,
    # which keeps a `+0530` offset out of it.
    (re.compile(r"(?<![\d+.,])\+[1-9]\d{6,14}(?!\d)"), "[PHONE]"),
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
    # The research provider's own prefix. The literal net below strikes this
    # deployment's *current* key; the shape strikes one that is not it — a key
    # rotated while a call was in flight, and the case R241 called out on the
    # 422 path, where pydantic's error list quotes the payload it refused back
    # to the caller. A credential someone pasted into a request body is exactly
    # the input that gets refused.
    (re.compile(r"\bpplx-[A-Za-z0-9._-]{16,}"), "[API_KEY]"),
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
    # The provider the round above did not count. R241 read "a second
    # completion provider" as the whole of what had arrived since the list was
    # written, and there were two: Bedrock, and the research provider restored
    # three weeks earlier. `PERPLEXITY_API_KEY` was held, sent and verified by
    # this service the whole time and named in neither half of `redact` —
    # exactly the omission R241 exists to have closed, one file further down.
    #
    # `test_secret_env_census.py` now derives this membership from the source
    # rather than from anybody noticing, so the next provider's credential
    # fails the suite on the commit that reads it.
    "PERPLEXITY_API_KEY",
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


# ── The degrade vocabulary, counted where the alerting happens ───────────────
#
# R376, methodology M11. This tier says what it is degrading to in a vocabulary
# of its own: ``documents_unreadable``, ``corpus_truncated``,
# ``llm_prose_fallback``, ``market_feed_fallback``, ``openrouter_key``, the four
# ``*_config`` lines a mistyped unit file falls back through. Every one of them
# is a feature quietly working less well than it says it does, and every one was
# a line in the journal and nothing else.
#
# R346 wrote that down and named the reason: "the AI and engine tiers still
# expose no ``/metrics``, so this round's neighbours in that tier —
# ``llm_prose_fallback``, ``xlsx_sheets_unreadable``, ``documents_unreadable`` —
# are structurally unalertable however well they are written". R369 made both
# units scrape targets, which removed the reason and left the instruments
# unbuilt: what they publish is the RED trio, the process facts and the cgroup,
# so a scraper can see that this service is *up* and nothing about what it is
# quietly falling back to.
#
# Counted here rather than at the sixty call sites, for the same reason
# ``logger.ts`` counts ``alert: true`` at the logger on the TS side: the
# vocabulary is the contract. An event added next round is counted by
# construction, and one whose level drops below WARNING stops being counted,
# which is the same event.
#
# ``format`` runs once per record the handler actually writes, after the level
# filter, so this counts lines written rather than lines attempted.
_degraded_sink: Callable[[str, str], None] | None = None


def set_degraded_event_sink(sink: Callable[[str, str], None] | None) -> None:
    """Install the counter warning-or-worse ``event`` lines are tallied into.

    Called by ``register_process_metrics``. Null clears it, which is what a test
    does between cases; a process with no sink installed logs exactly as before.
    """
    global _degraded_sink
    _degraded_sink = sink


def _count_degraded(record: logging.LogRecord) -> None:
    """Tally one line if it is a degrade this tier named. Never raises."""
    if _degraded_sink is None or record.levelno < logging.WARNING:
        return
    event = getattr(record, "event", None)
    if not isinstance(event, str) or not event:
        return
    try:
        _degraded_sink(event, record.levelname.lower())
    except Exception:  # noqa: BLE001 - a broken counter must not cost a log line
        pass


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
        _count_degraded(record)
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

    def factory(app: ASGIApp) -> ASGIApp:
        async def request_context_middleware(scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await app(scope, receive, send)
                return
            incoming = Headers(scope=scope).get(REQUEST_ID_HEADER)
            request_id = acceptable_request_id(incoming) or uuid.uuid4().hex
            token = _request_id.set(request_id)
            started = time.perf_counter()
            # 500 is what a request that never produced a response had: this
            # runs in a `finally`, so an exception escaping the route reaches
            # the access log as the failure it is rather than as a 200.
            status = 500

            async def send_wrapper(message: dict) -> None:
                nonlocal status
                if message["type"] == "http.response.start":
                    status = message["status"]
                    MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
                await send(message)

            try:
                await app(scope, receive, send_wrapper)
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
                        "http_method": scope["method"],
                        "path": scope["path"],
                        "status": status,
                        "duration_ms": duration_ms,
                    },
                )
                _request_id.reset(token)

        return request_context_middleware

    return factory
