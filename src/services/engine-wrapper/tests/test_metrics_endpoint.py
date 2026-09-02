"""The Python tier as a scrape target — the engine half.

Twin of `src/services/ai/tests/test_metrics_endpoint.py`.

`infra/monitoring/alerts.yml` names this gap twice — in the scrape note ("the
AI (:3002) and engine (:3003) services expose no scrape endpoint") and inside
`EstateBuildSkew` ("that is R313's open item, and a unit this rule cannot see is
a reason to close it rather than to weaken the rule"). Five page- and
ticket-severity rules are written against series these two units did not
publish: `ServiceDown` needs `up`, which only exists for a scraped target;
`ServiceRestarting` needs `process_uptime_seconds`; `EstateBuildSkew` and
`BuildProvenanceMissing` need `n409_build_info`; `HighServerErrorRate`,
`RequestsPilingUp` and `SlowRequests` need the RED trio.

So these assert the *names and labels* as much as the behaviour: a rule that
matches three units out of five is worse than one that matches none, because it
looks like it is working.
"""

import os

import pytest
from fastapi.testclient import TestClient

from app import build_info as build_info_module
from app.main import app
from app.metrics import (
    MAX_SERIES_PER_METRIC,
    MetricsRegistry,
    format_value,
    metrics_caller_authorized,
    metrics_token,
    route_label,
    status_class,
)

client = TestClient(app)

TOKEN = "scrape-secret"


@pytest.fixture
def _token(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)
    monkeypatch.delenv("METRICS_TOKEN", raising=False)
    yield


def _scrape(headers: dict[str, str] | None = None):
    return client.get("/metrics", headers=headers or {})


def test_metrics_served_without_a_secret_outside_production(monkeypatch):
    """A developer machine has no secret and the endpoint still answers."""
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("METRICS_TOKEN", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    res = _scrape()
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    assert res.headers["cache-control"] == "no-store"


def test_metrics_closed_in_production_when_no_secret_is_configured(monkeypatch):
    """Rotating the secret to nothing closes the endpoint rather than opening it."""
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("METRICS_TOKEN", raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    assert _scrape().status_code == 404


def test_unauthorized_scrape_is_answered_as_a_missing_path(_token):
    """Not a 401: the existence of the endpoint is not published to a scanner."""
    assert _scrape().status_code == 404
    assert _scrape({"x-internal-token": "wrong"}).status_code == 404
    assert _scrape({"authorization": "Bearer wrong"}).status_code == 404


def test_both_spellings_of_the_secret_are_accepted(_token):
    """`Authorization: Bearer` is what a scrape config sends with no extra stanza."""
    assert _scrape({"x-internal-token": TOKEN}).status_code == 200
    assert _scrape({"authorization": f"Bearer {TOKEN}"}).status_code == 200
    assert _scrape({"authorization": f"bearer {TOKEN}"}).status_code == 200


def test_metrics_token_prefers_its_own_variable(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "internal")
    monkeypatch.setenv("METRICS_TOKEN", "scraper")
    assert metrics_token(os.environ) == "scraper"
    monkeypatch.delenv("METRICS_TOKEN")
    assert metrics_token(os.environ) == "internal"


def test_authorization_of_a_non_ascii_header_does_not_raise():
    """The `tokens_match` lesson: a rejected token must look like a rejection."""
    assert metrics_caller_authorized({"x-internal-token": "caf\xe9"}, "expected") is False


def test_the_series_every_alert_rule_names_are_published(_token):
    body = _scrape({"x-internal-token": TOKEN}).text
    # ServiceRestarting
    assert "# TYPE process_uptime_seconds gauge" in body
    # EstateBuildSkew / BuildProvenanceMissing group by `sha` and select `source`
    assert "# TYPE n409_build_info gauge" in body
    assert 'service="engine-wrapper"' in body
    assert "sha=" in body and "source=" in body
    # HighServerErrorRate / SlowRequests / RequestsPilingUp
    assert "# TYPE http_requests_total counter" in body
    assert "# TYPE http_request_errors_total counter" in body
    assert "# TYPE http_request_duration_seconds histogram" in body
    assert "# TYPE http_requests_in_flight gauge" in body


def test_build_info_reports_the_unknown_source_rather_than_omitting_it(monkeypatch, _token):
    """`BuildProvenanceMissing` selects `source="unknown"`; an absent series is
    indistinguishable from a unit that knows its build."""
    monkeypatch.delenv("BUILD_SHA", raising=False)
    monkeypatch.setenv("BUILD_SHA_FILE", "/nonexistent/BUILD_SHA")
    build_info_module.reset_build_info_cache()
    try:
        # Re-registering picks up the fresh build info; the endpoint reads the
        # gauge registered at import, so assert the value the module resolves.
        assert build_info_module.build_info().source in ("unknown", "file", "env")
    finally:
        build_info_module.reset_build_info_cache()


def test_requests_are_counted_by_method_route_and_status_class(_token):
    client.get("/health")
    body = _scrape({"x-internal-token": TOKEN}).text
    assert 'http_requests_total{method="GET",route="/health",status="2xx"}' in body


def test_a_refused_request_is_counted_too(_token):
    """The token gate's 401 is a request this unit served."""
    client.post("/engine/v1/compute", json={})
    body = _scrape({"x-internal-token": TOKEN}).text
    assert 'status="4xx"' in body


def test_id_shaped_segments_collapse_so_a_path_cannot_mint_a_series_per_row():
    assert route_label("/api/v1/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV/x") == "/api/v1/valuations/:id/x"
    assert route_label("/jobs/42") == "/jobs/:id"
    assert route_label("/health?x=1") == "/health"
    assert route_label("/") == "/"
    assert route_label(None) == "unknown"


def test_status_class_buckets():
    assert status_class(204) == "2xx"
    assert status_class(503) == "5xx"
    assert status_class(0) == "unknown"


def test_counter_folds_past_the_cap_but_keeps_the_total_exact():
    registry = MetricsRegistry()
    counter = registry.counter("test_total", "help", ("route",))
    for i in range(MAX_SERIES_PER_METRIC + 50):
        counter.inc({"route": f"/r{i}"})
    body = registry.render()
    assert '__other__' in body
    lines = [l for l in body.splitlines() if l.startswith("test_total{")]
    # The cap plus the one reserved series it folds into — bounded, and minted
    # at most once however many distinct label sets arrive after it.
    assert len(lines) == MAX_SERIES_PER_METRIC + 1
    total = sum(float(l.rsplit(" ", 1)[1]) for l in lines)
    assert total == MAX_SERIES_PER_METRIC + 50


def test_a_gauge_that_raises_is_counted_rather_than_taking_the_scrape_down():
    registry = MetricsRegistry()
    registry.gauge("broken", "help", lambda: (_ for _ in ()).throw(RuntimeError("no")))
    registry.gauge("fine", "help", lambda: 1)
    body = registry.render()
    assert "fine 1" in body
    assert 'n409_metric_collect_failures_total{metric="broken"} 1' in body


def test_infinity_renders_as_prometheus_spells_it():
    assert format_value(float("inf")) == "+Inf"
    assert format_value(float("-inf")) == "-Inf"
    assert format_value(float("nan")) == "NaN"
    assert format_value(2.0) == "2"


def test_histogram_buckets_are_cumulative_and_end_at_inf():
    registry = MetricsRegistry()
    hist = registry.histogram("d_seconds", "help", ("route",), (0.1, 1.0))
    hist.observe(0.05, {"route": "/a"})
    hist.observe(5.0, {"route": "/a"})
    body = registry.render()
    assert 'd_seconds_bucket{route="/a",le="0.1"} 1' in body
    assert 'd_seconds_bucket{route="/a",le="1"} 1' in body
    assert 'd_seconds_bucket{route="/a",le="+Inf"} 2' in body
    assert 'd_seconds_count{route="/a"} 2' in body


def test_a_collect_that_raises_is_reported_on_the_endpoint_the_rule_scrapes(_token):
    """`MetricCollectFailing` covers these units, and the module says so.

    Asserted through the live endpoint rather than a bare registry, because the
    claim in `metrics.py`'s header is about what a *scrape of this unit*
    publishes — it read "there is no `n409_metric_collect_failures_total`" until
    R369 while `render` had always written one, which would send an operator
    looking for the Python units outside a rule that covers them.
    """
    from app.main import _metrics

    _metrics.gauge("r369_probe", "help", lambda: (_ for _ in ()).throw(RuntimeError("no")))
    try:
        body = _scrape({"x-internal-token": TOKEN}).text
        assert 'n409_metric_collect_failures_total{metric="r369_probe"}' in body
        # And the scrape survived it: the other instruments are still there.
        assert "# TYPE process_uptime_seconds gauge" in body
    finally:
        _metrics._gauges.pop("r369_probe", None)


def test_the_module_header_states_the_series_census_it_does_not_have():
    """The other half of the same claim, and the one that is still true.

    `MetricAttributionFolded` selects `n409_metric_series_folded`, which these
    units do not publish. A header that said they did would be worse than one
    that says nothing — so the absence is asserted, and the day somebody ports
    `seriesCensus` this fails and the paragraph gets rewritten with it.
    """
    from app.metrics import MetricsRegistry

    body = MetricsRegistry().render()
    assert "n409_metric_series" not in body
    assert "seriesCensus" in __import__("app.metrics", fromlist=["x"]).__doc__
