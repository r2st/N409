"""Prometheus exposition for the Python tier.

The Python half of ``src/packages/shared/src/prometheus.ts``, and it exists for
a reason that is written down in two places already.
``infra/monitoring/alerts.yml`` says, in the scrape-configuration note, "the AI
(:3002) and engine (:3003) services expose no scrape endpoint; they are
measured from the caller instead"; and ``EstateBuildSkew`` says "the two Python
units carry their own ``build_info`` and have no scrape endpoint to publish it
on; that is R313's open item, and a unit this rule cannot see is a reason to
close it rather than to weaken the rule".

Measuring them from the caller answers one question well and three not at all.
``upstream_requests_total`` is recorded in the valuation service and is the
right series for "did a user see a failure" — a request abandoned at our
deadline is a success in the engine's own access log, so the caller's view is
the one that decides. But it is silent about everything that is not a call in
flight:

  * ``up`` — the scraper's own synthetic series, and the only thing that can
    tell "the process is not answering" from "the process is answering and
    reporting zero of everything". ``ServiceDown`` fires on it, and it can only
    exist for a target that is scraped. Two of five units had no such series,
    so the page for a dead unit was whatever the valuation service happened to
    notice the next time it called one.
  * ``process_uptime_seconds`` — ``ServiceRestarting``. A crash-looping unit
    restarts faster than anything calls it, and from the caller's side a
    process that dies between requests is indistinguishable from an idle one.
  * ``n409_build_info`` — ``EstateBuildSkew`` and ``BuildProvenanceMissing``.
    Both units compute this already (``build_info.py``) and report it on
    ``/health``, which is a place somebody looks after they suspect something.
  * the RED trio, for the requests these services serve that the valuation
    service did not make — a scanner that found the port, the readiness probes,
    and every 401 the token gate returns.

So this is the minimum that makes the two units first-class scrape targets,
with the metric names, label names and semantics of the TS registry rather than
near-misses of them: ``alerts.yml`` groups by ``job`` and selects on ``method``,
``route``, ``status``, ``service``, ``sha`` and ``source``, and a rule that
matches three units out of five is worse than one that matches none, because it
looks like it is working.

Deliberately *not* a whole port of the TS file, and the half that is missing
decides which rules cover these units — so it is stated exactly rather than
approximately (R369, methodology M11; this paragraph previously said there was
no ``n409_metric_collect_failures_total`` here, and ``render`` has always
written one).

  * ``n409_metric_collect_failures_total`` **is** here, minted by ``render``
    when a gauge's ``collect`` raises. ``MetricCollectFailing`` therefore covers
    all five units, and it has to: most of the page-severity rules on this
    estate are gauge-backed, and a ``collect`` that throws drops its series
    silently, leaving a rule matching nothing — which is indistinguishable from
    a healthy system.
  * ``seriesCensus`` is **not**, so ``n409_metric_series`` and
    ``n409_metric_series_folded`` are published by the three Fastify services
    and by neither of these, and ``MetricAttributionFolded`` covers three units
    of five. That is a gap with a bounded blast radius rather than a live one:
    the rule already excludes the ``http_request*`` family by name, and every
    other instrument on these units carries a fixed handful of label values —
    four states, five kernel events, one metric name each — so nothing here can
    currently reach the cap on a metric that rule would look at.
  * The cap itself **is** kept, because the thing it defends against — a scanner
    minting one series per invented path — reaches these ports the same way it
    reaches the others.
"""

from __future__ import annotations

import hmac
import math
import os
import re
import time
from typing import Callable, Generic, Iterable, Mapping, Sequence, TypedDict, TypeVar

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse, Response

from .asgi import ASGIApp, Receive, Scope, Send
from .build_info import build_info
from .cgroup_memory import register_cgroup_memory_metrics
from .observability import set_degraded_event_sink

#: The exposition format this module writes. Prometheus text, version 0.0.4.
PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

#: Distinct label sets one metric will attribute before folding the rest.
MAX_SERIES_PER_METRIC = 200

#: Every label of the reserved series that absorbs everything past the cap.
OVERFLOW_LABEL = "__other__"

#: Default duration buckets, in seconds. One millisecond to ten seconds.
DEFAULT_DURATION_BUCKETS: tuple[float, ...] = (
    0.001,
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
)

METRICS_TOKEN_ENV = "METRICS_TOKEN"
INTERNAL_TOKEN_ENV = "INTERNAL_SERVICE_TOKEN"
INTERNAL_TOKEN_HEADER = "x-internal-token"

_METRIC_NAME = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$")
_LABEL_NAME = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

#: A path segment that is an identifier rather than a name — the TS side's
#: HTTP_ID_SEGMENT, and the same argument: a ULID or a number in a path is a
#: value, and one series per value is one series per row in the database.
_ID_SEGMENT = re.compile(r"^(?:[0-9]+|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F-]{16,})$")


def route_label(path: str | None, fallback: str = "unknown") -> str:
    """A path with its id-shaped segments collapsed, for use as a label."""
    if not path:
        return fallback
    bare = path.split("?")[0].split("#")[0]
    if bare in ("", "/"):
        return "/"
    segments = [
        ":id" if _ID_SEGMENT.match(s) else s for s in bare.split("/") if s
    ]
    return "/" + "/".join(segments)


#: The methods a request may be counted under by name.
#:
#: RFC 9110's own set, plus PATCH (RFC 5789), and the WebDAV verbs a scanner
#: reaches for often enough that folding them would lose a real signal. Nothing
#: here serves any of the last group; a spike of them is somebody looking.
KNOWN_METHODS: frozenset[str] = frozenset(
    {
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "DELETE",
        "CONNECT",
        "OPTIONS",
        "TRACE",
        "PATCH",
        "PROPFIND",
        "PROPPATCH",
        "MKCOL",
        "COPY",
        "MOVE",
        "LOCK",
        "UNLOCK",
    }
)

#: What an unrecognised method is counted as. `route_label`'s spelling for the
#: same idea, so a dashboard reads one word for "we could not attribute this".
UNKNOWN_METHOD = "unknown"


def method_label(method: str) -> str:
    """A request method as a label value, folded when it is not one we know.

    The other half of the port's inherited assumption (R370, methodology M6;
    see `escape_label_value` for the first). On the TypeScript registry this is
    a port of, `req.method.toUpperCase()` needs no bound because it cannot
    have one that matters: Node's HTTP parser accepts only the methods in
    llhttp's table and answers anything else at the parser, before Fastify
    exists. So `method` there is drawn from about thirty values.

    h11 accepts any token. `curl -X FOOBAR1 http://host/health` is answered
    405 by Starlette's router — and counted, correctly, because it is a
    request this unit served — under `method="FOOBAR1"`. Two hundred invented
    verbs against one path therefore fill `MAX_SERIES_PER_METRIC` on
    `http_requests_total` and `http_request_duration_seconds`, from an
    unauthenticated caller, and everything after that folds into `__other__`
    for the life of the process.

    The fold keeps totals exact, which is exactly what makes it quiet: a rule
    that *selects* a label value stops matching the folded readings entirely
    while `sum by (job)` stays right. `HighServerErrorRate`, `SlowRequests`
    and `RequestsPilingUp` all select on `method` and `route`, so the estate's
    RED rules for these two units would go on evaluating against a series that
    no longer receives anything, which is indistinguishable from a healthy
    system.

    Not case-normalised beyond `upper()`: methods are case-sensitive per RFC
    9110, so `get` is not GET, and counting it as one would report a request
    this service refused as one it served.
    """
    upper = method.upper()
    return upper if upper in KNOWN_METHODS else UNKNOWN_METHOD


def status_class(code: int) -> str:
    """RED bucket for a status code: 1xx / 2xx / 3xx / 4xx / 5xx."""
    bucket = code // 100
    return f"{bucket}xx" if 1 <= bucket <= 5 else "unknown"


#: Control characters the exposition format cannot represent inside a label
#: value. ``\n`` is excluded because the format defines an escape for it; every
#: other C0 code point, DEL, and the C1 block have none.
_UNREPRESENTABLE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f-\x9f]")


def escape_label_value(value: str) -> str:
    """Backslash, double quote and newline, per the exposition format.

    Plus the half the format has no spelling for. The three escapes above are
    the whole of what Prometheus text defines, and on the TypeScript registry
    this file is the port of, that is enough: every label value there is either
    a constant, an operator-configured string, or ``routeLabel(req.url)`` — and
    Fastify hands a handler the *raw* request target, so a caller writing
    ``%00`` in a path gets the three literal characters ``%``, ``0``, ``0``.

    Here it is not enough, and the difference is one line of ASGI. Uvicorn
    percent-decodes the request target before it reaches ``scope["path"]``, so
    ``GET /z%00q`` arrives at ``route_label`` as a real NUL between two letters
    and went into the body as one — a byte the exposition format gives no
    representation for, in a label value chosen from the network by anyone who
    can reach the port. What a scrape parser does with it is the parser's
    choice, and this estate has five units feeding one scrape.

    Replaced rather than dropped: a label value is what an operator reads to
    find the request that produced it, and silently deleting the byte makes
    ``/z\x00q`` and ``/zq`` the same series. ``\ufffd`` is the standard
    "there was a character here and this is not it", it is what
    ``decode_text`` already substitutes on the document path, and it survives
    the escapes above unchanged.
    """
    return (
        _UNREPRESENTABLE.sub("\ufffd", value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
    )


def escape_help(help_text: str) -> str:
    """HELP escapes only backslash and newline — a quote is literal there."""
    return help_text.replace("\\", "\\\\").replace("\n", "\\n")


def format_value(value: float) -> str:
    """A value as the exposition format spells it.

    Python's ``repr`` gives ``inf`` and ``nan``; Prometheus wants ``+Inf`` and
    ``NaN``. Worth getting right rather than assuming it cannot happen: a
    duration histogram's ``_sum`` is a running total that one absurd reading
    pushes to infinity, and it never comes back.
    """
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if value == math.inf:
            return "+Inf"
        if value == -math.inf:
            return "-Inf"
        if value.is_integer() and abs(value) < 1e16:
            return str(int(value))
    return repr(float(value))


def _render_labels(
    names: Sequence[str],
    values: Sequence[str],
    extra: tuple[str, str] | None = None,
) -> str:
    parts = [
        f'{name}="{escape_label_value(values[i] if i < len(values) else "")}"'
        for i, name in enumerate(names)
    ]
    if extra is not None:
        parts.append(f'{extra[0]}="{escape_label_value(extra[1])}"')
    return "{" + ",".join(parts) + "}" if parts else ""


_T = TypeVar("_T")


class _Family(Generic[_T]):
    """Shared bookkeeping for the capped label-set map every instrument keeps."""

    def __init__(
        self,
        name: str,
        help_text: str,
        label_names: Sequence[str],
        max_series: int,
    ) -> None:
        if not _METRIC_NAME.match(name):
            raise ValueError(f"Invalid Prometheus metric name: {name!r}")
        for label in label_names:
            if not _LABEL_NAME.match(label):
                raise ValueError(f"Invalid Prometheus label name: {label!r}")
        self.name = name
        self.help = help_text
        self.label_names = tuple(label_names)
        self._max_series = max_series
        self._series: dict[tuple[str, ...], _T] = {}
        self._overflow_key: tuple[str, ...] | None = None

    def _create(self) -> _T:  # pragma: no cover - overridden
        raise NotImplementedError

    def _key(self, labels: Mapping[str, str] | None) -> tuple[str, ...]:
        return tuple(str((labels or {}).get(n, "")) for n in self.label_names)

    def _at(self, labels: Mapping[str, str] | None) -> _T:
        key = self._key(labels)
        existing = self._series.get(key)
        if existing is not None:
            return existing
        if len(self._series) >= self._max_series:
            # One reserved series, minted at most once, so the cap bounds this
            # map's size rather than being a ceiling plus one per overflow.
            if self._overflow_key is None:
                self._overflow_key = tuple(OVERFLOW_LABEL for _ in self.label_names)
            overflow = self._series.get(self._overflow_key)
            if overflow is None:
                overflow = self._create()
                self._series[self._overflow_key] = overflow
            return overflow
        created = self._create()
        self._series[key] = created
        return created


class Counter(_Family[list[float]]):
    """A monotonically increasing tally, per label set."""

    def _create(self) -> list[float]:
        return [0.0]

    def inc(self, labels: Mapping[str, str] | None = None, value: float = 1) -> None:
        # A negative increment is the one thing a counter must never take: it
        # makes `rate()` see a counter reset and invent a spike. Ignored rather
        # than raised, because this is called from a request hook and a metric
        # that throws there turns a mislabelled series into a 500.
        if value < 0:
            return
        cell = self._at(labels)
        cell[0] += value

    def render(self) -> list[str]:
        out = [f"# HELP {self.name} {escape_help(self.help)}", f"# TYPE {self.name} counter"]
        for values, cell in self._series.items():
            out.append(
                f"{self.name}{_render_labels(self.label_names, values)} "
                f"{format_value(cell[0])}"
            )
        return out


class _HistogramCell(TypedDict):
    counts: list[int]
    sum: float
    count: int


class Histogram(_Family[_HistogramCell]):
    """Cumulative buckets, a sum and a count, per label set."""

    def __init__(
        self,
        name: str,
        help_text: str,
        label_names: Sequence[str],
        bounds: Sequence[float],
        max_series: int,
    ) -> None:
        super().__init__(name, help_text, label_names, max_series)
        self.bounds = tuple(sorted(bounds))

    def _create(self) -> _HistogramCell:
        return {"counts": [0 for _ in self.bounds], "sum": 0.0, "count": 0}

    def observe(self, value: float, labels: Mapping[str, str] | None = None) -> None:
        cell = self._at(labels)
        # The *first* bound this reading falls under, not every bound above it.
        # Buckets are stored disjoint and made cumulative in `render`; counting
        # into all of them here and accumulating there counts each observation
        # once per bucket it fits, which reads as a histogram whose lowest
        # bucket already holds every request ever served.
        for i, bound in enumerate(self.bounds):
            if value <= bound:
                cell["counts"][i] += 1
                break
        cell["sum"] += value
        cell["count"] += 1

    def render(self) -> list[str]:
        out = [f"# HELP {self.name} {escape_help(self.help)}", f"# TYPE {self.name} histogram"]
        for values, cell in self._series.items():
            running = 0
            for i, bound in enumerate(self.bounds):
                running += cell["counts"][i]
                le = _render_labels(self.label_names, values, ("le", format_value(bound)))
                out.append(f"{self.name}_bucket{le} {running}")
            inf = _render_labels(self.label_names, values, ("le", "+Inf"))
            out.append(f"{self.name}_bucket{inf} {cell['count']}")
            base = _render_labels(self.label_names, values)
            out.append(f"{self.name}_sum{base} {format_value(cell['sum'])}")
            out.append(f"{self.name}_count{base} {cell['count']}")
        return out


#: One reading of a gauge: a value and the labels it carries.
Reading = tuple[float, Mapping[str, str]]


class Gauge:
    """A value sampled at scrape time.

    ``collect`` runs *inside* the scrape request, so it must be cheap and
    synchronous — an in-memory counter, a monotonic clock. Deliberately no
    async variant, for the reason the TS registry gives: a scrape that queries
    the database adds load to the thing being monitored, hardest at exactly the
    moment the database is the problem.
    """

    def __init__(
        self,
        name: str,
        help_text: str,
        collect: Callable[[], float | Iterable[Reading]],
        label_names: Sequence[str] = (),
    ) -> None:
        if not _METRIC_NAME.match(name):
            raise ValueError(f"Invalid Prometheus metric name: {name!r}")
        for label in label_names:
            if not _LABEL_NAME.match(label):
                raise ValueError(f"Invalid Prometheus label name: {label!r}")
        self.name = name
        self.help = help_text
        self.label_names = tuple(label_names)
        self._collect = collect

    def render(self) -> list[str]:
        out = [f"# HELP {self.name} {escape_help(self.help)}", f"# TYPE {self.name} gauge"]
        sampled = self._collect()
        readings: Iterable[Reading]
        readings = ((float(sampled), {}),) if isinstance(sampled, (int, float)) else sampled
        for value, labels in readings:
            values = [str(labels.get(n, "")) for n in self.label_names]
            out.append(
                f"{self.name}{_render_labels(self.label_names, values)} {format_value(value)}"
            )
        return out


class MetricsRegistry:
    """Every instrument this process publishes, and the text they render to."""

    def __init__(self, max_series: int = MAX_SERIES_PER_METRIC) -> None:
        self._max_series = max_series
        self._counters: dict[str, Counter] = {}
        self._histograms: dict[str, Histogram] = {}
        self._gauges: dict[str, Gauge] = {}

    def counter(self, name: str, help_text: str, label_names: Sequence[str] = ()) -> Counter:
        existing = self._counters.get(name)
        if existing is not None:
            return existing
        created = Counter(name, help_text, label_names, self._max_series)
        self._counters[name] = created
        return created

    def histogram(
        self,
        name: str,
        help_text: str,
        label_names: Sequence[str] = (),
        bounds: Sequence[float] = DEFAULT_DURATION_BUCKETS,
    ) -> Histogram:
        existing = self._histograms.get(name)
        if existing is not None:
            return existing
        created = Histogram(name, help_text, label_names, bounds, self._max_series)
        self._histograms[name] = created
        return created

    def gauge(
        self,
        name: str,
        help_text: str,
        collect: Callable[[], float | Iterable[Reading]],
        label_names: Sequence[str] = (),
    ) -> Gauge:
        created = Gauge(name, help_text, collect, label_names)
        self._gauges[name] = created
        return created

    def render(self) -> str:
        """The whole registry as Prometheus text. Never raises.

        A gauge whose ``collect`` throws is dropped and counted rather than
        taking the scrape down with it — the TS registry's R341 lesson, and the
        same reason: an absent series is indistinguishable from a healthy one,
        so a collector that fails silently is worse than one that fails loudly,
        and a scrape that 500s takes every *other* instrument with it.
        """
        lines: list[str] = []
        for gauge in self._gauges.values():
            try:
                lines.extend(gauge.render())
            except Exception:
                self.counter(
                    "n409_metric_collect_failures_total",
                    "Scrapes on which a gauge's collect callback raised and its series were dropped",
                    ("metric",),
                ).inc({"metric": gauge.name})
        for counter in self._counters.values():
            lines.extend(counter.render())
        for histogram in self._histograms.values():
            lines.extend(histogram.render())
        return "\n".join(lines) + "\n"


def metrics_token(env: Mapping[str, str] | None = None) -> str | None:
    """The secret a scraper must present, or None when none is configured.

    ``METRICS_TOKEN`` first so a scraper can hold a credential that is not the
    internal service token — the two rotate on different schedules, and a
    Prometheus configuration file is a wider blast radius than a systemd unit.
    Falls back to ``INTERNAL_SERVICE_TOKEN`` so an estate that already has one
    needs no new configuration to turn this on.
    """
    environ = os.environ if env is None else env
    return (environ.get(METRICS_TOKEN_ENV) or "").strip() or (
        environ.get(INTERNAL_TOKEN_ENV) or ""
    ).strip() or None


def _matches(provided: str | None, expected: str) -> bool:
    if provided is None:
        return False
    try:
        supplied = provided.encode("latin-1")
    except UnicodeEncodeError:
        supplied = provided.encode("utf-8")
    return hmac.compare_digest(supplied, expected.encode("utf-8"))


def metrics_caller_authorized(headers: Mapping[str, str], expected: str) -> bool:
    """True when the request carries the metrics secret, under either spelling.

    ``X-Internal-Token`` is what the rest of this service asks for and what the
    valuation tier sends. ``Authorization: Bearer`` is what a Prometheus scrape
    config can send without a custom-header stanza, and is what
    ``alerts.yml``'s scrape note describes — so a scraper configured once
    collects from all five units instead of silently 401ing against two.
    """
    if _matches(headers.get(INTERNAL_TOKEN_HEADER), expected):
        return True
    auth = headers.get("authorization")
    if not auth:
        return False
    match = re.match(r"^Bearer\s+(.+)$", auth.strip(), re.IGNORECASE)
    return _matches(match.group(1), expected) if match else False


def is_production(env: Mapping[str, str] | None = None) -> bool:
    environ = os.environ if env is None else env
    return (environ.get("APP_ENV", "") or "").lower() == "production"


def register_process_metrics(
    registry: MetricsRegistry,
    service: str,
    started_monotonic: float,
) -> None:
    """Facts about the process itself: what it is and how long it has been up.

    ``n409_build_info`` is a gauge fixed at 1 whose labels carry the
    interesting part — the standard ``*_info`` idiom, and the same three label
    names the TS side uses, because ``EstateBuildSkew`` counts distinct ``sha``
    across every series of this metric in the estate and
    ``BuildProvenanceMissing`` selects ``source="unknown"``.
    """
    build = build_info()
    registry.gauge(
        "n409_build_info",
        "Always 1; the labels carry the build this process is running",
        lambda: ((1.0, {"service": service, "sha": build.sha, "source": build.source}),),
        ("service", "sha", "source"),
    )
    registry.gauge(
        "process_uptime_seconds",
        "Seconds since this process started",
        lambda: time.monotonic() - started_monotonic,
    )

    # The degrade vocabulary this tier logs, at the endpoint that alerts
    # (R376, methodology M11). See `set_degraded_event_sink` in
    # observability.py for why it is counted at the formatter and what R346
    # left open here.
    #
    # `event` is a literal at every call site — a closed vocabulary of about
    # forty words — and `level` is one of three, so the pair is inside
    # MAX_SERIES_PER_METRIC by a wide margin. No series is minted: unlike a
    # gauge, an absent counter series here means "this has never happened",
    # which is exactly what it says.
    degraded = registry.counter(
        "log_degraded_events_total",
        "Warning-or-worse log lines carrying an event name, by event and level. This tier reports most of its degrades — an unreadable document, a truncated corpus, a model answering prose, a market feed falling back, a mistyped limit — in the log and nowhere else.",
        ("event", "level"),
    )
    set_degraded_event_sink(lambda event, level: degraded.inc({"event": event, "level": level}))


def install_metrics(
    app: FastAPI,
    registry: MetricsRegistry,
    service: str,
    started_monotonic: float,
    env: Mapping[str, str] | None = None,
) -> None:
    """Register the RED instruments, the process facts and ``GET /metrics``.

    The middleware is added by the caller so it sits at a deliberate place in
    the stack; this only mints the instruments and the route.

    The route carries its own gate rather than being covered by
    ``internal_token_middleware``, which is why ``/metrics`` is in that
    module's public set. Two reasons, both the TS endpoint's: a scraper sends
    ``Authorization: Bearer`` and the middleware only reads
    ``X-Internal-Token``, and an unauthorized scrape must be answered the way
    this service answers a path it does not have — a 404 — so that the
    existence of the endpoint is not itself published to whoever found the
    port.
    """
    environ = os.environ if env is None else env
    register_process_metrics(registry, service, started_monotonic)
    # Silent and gauge-less off cgroup v2, which is every developer machine —
    # see `cgroup_memory` for why an absent series beats one that reads zero.
    register_cgroup_memory_metrics(registry)

    @app.get("/metrics", include_in_schema=False)
    async def metrics_endpoint(request: Request) -> Response:  # pragma: no cover - via TestClient
        # Re-read per request so the secret can rotate without a restart, the
        # same way internal_auth does it — including a rotation to nothing,
        # which must close the endpoint rather than open it.
        secret = metrics_token(environ)
        if is_production(environ) if secret is None else not metrics_caller_authorized(
            request.headers, secret
        ):
            return PlainTextResponse("Not Found", status_code=404)
        return PlainTextResponse(
            registry.render(),
            media_type=PROMETHEUS_CONTENT_TYPE,
            # A cached scrape is a lie about the moment it describes.
            headers={"cache-control": "no-store"},
        )


def make_metrics_middleware(registry: MetricsRegistry):
    """RED for every request this service answers, including the refused ones.

    ``_total`` and ``_seconds`` suffixes and the ``http_*`` names are the
    conventions ``alerts.yml`` already assumes; naming them anything else makes
    ``HighServerErrorRate``, ``RequestsPilingUp`` and ``SlowRequests`` not
    apply to this unit while appearing to.
    """
    requests = registry.counter(
        "http_requests_total",
        "HTTP requests handled, by method, route and status class",
        ("method", "route", "status"),
    )
    errors = registry.counter(
        "http_request_errors_total",
        "HTTP requests that returned a 5xx",
        ("method", "route"),
    )
    duration = registry.histogram(
        "http_request_duration_seconds",
        "HTTP request duration in seconds",
        ("method", "route"),
    )
    in_flight = {"n": 0}
    registry.gauge(
        "http_requests_in_flight",
        "Requests this process is holding open right now",
        lambda: float(in_flight["n"]),
    )

    def factory(app: ASGIApp) -> ASGIApp:
        async def metrics_middleware(scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await app(scope, receive, send)
                return
            method = method_label(scope["method"])
            route = route_label(scope["path"])
            started = time.perf_counter()
            in_flight["n"] += 1
            # 500 is the status a request that never produced a response had: an
            # exception escaping the whole stack is a failed request, and counting
            # it as anything else is how an outage reads as an idle service.
            status = 500

            async def send_wrapper(message: dict) -> None:
                nonlocal status
                if message["type"] == "http.response.start":
                    status = message["status"]
                await send(message)

            try:
                await app(scope, receive, send_wrapper)
            finally:
                in_flight["n"] -= 1
                requests.inc({"method": method, "route": route, "status": status_class(status)})
                if status >= 500:
                    errors.inc({"method": method, "route": route})
                duration.observe(max(0.0, time.perf_counter() - started), {"method": method, "route": route})

        return metrics_middleware

    return factory
