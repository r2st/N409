"""A misbuilt image that only the journal knew about (R369, methodology M11).

R368 made the engine tier *say* it cannot import its market-data provider:
`resolve_default_provider` quotes the exception rather than asserting "yfinance
not installed", and logs it once at construction so "a misbuilt image says so at
startup, instead of only on the first valuation that happens to want market
data". That line goes to the journal.

The one alert rule over this subsystem is `MarketFeedFallingBack`, and it cannot
catch the condition in time. It is a ratio over `market_feed_answers_total`,
which is recorded in the *valuation* tier from the caller's side, held for an
hour — so it needs an hour of sustained valuation traffic, and on a quiet night
the denominator is zero and the expression is NaN. Meanwhile the engine turns
every market-data failure into a 200 with `source: "fallback"`, so what the box
produces in the interim is correct-looking valuations on substituted figures.

`market_feed_provider` is the same fact on the scrape, reported by the unit that
knows it. These pin the four state values and the two things
`MarketFeedProviderMisbuilt` depends on: that exactly one series is 1, and that
`misbuilt` is told apart from the two states nobody should be woken for.
"""

import pytest

from app.engine.market_feed import NO_PROVIDER_REASON, MarketFeedClient
from app.engine.market_universe import (
    MARKET_FEED_PROVIDER_STATES,
    market_feed_provider_state,
    register_market_feed_metrics,
    set_client,
)
from app.metrics import MetricsRegistry


@pytest.fixture(autouse=True)
def _restore_client():
    previous = set_client(None)
    yield
    set_client(previous)


def _render() -> str:
    registry = MetricsRegistry()
    register_market_feed_metrics(registry)
    return registry.render()


def _active(text: str) -> set[str]:
    return {
        line.split('state="')[1].split('"')[0]
        for line in text.splitlines()
        if line.startswith("market_feed_provider{") and line.endswith(" 1")
    }


def test_a_process_that_has_not_wanted_market_data_reports_unresolved():
    """`default_client` is lazy on purpose, and a lazy client is not a fault."""
    set_client(None)
    assert market_feed_provider_state() == "unresolved"


def test_reading_the_state_never_constructs_the_client():
    """A collect callback that imported yfinance would do network work inside
    the scrape, against `Gauge`'s "cheap and synchronous" contract — and would
    make the metrics endpoint the thing that decides when the provider is
    resolved."""
    set_client(None)
    _render()
    assert market_feed_provider_state() == "unresolved"


def test_a_live_provider_reports_available():
    set_client(MarketFeedClient(provider=object()))
    assert market_feed_provider_state() == "available"
    assert _active(_render()) == {"available"}


def test_the_explicit_opt_out_is_told_apart_from_a_broken_import():
    """`MarketFeedClient(provider=None)` is the deliberate opt-out the whole
    test tree runs on, and `NO_PROVIDER_REASON` exists precisely because it "has
    no failure behind it to quote". Alerting on it would page somebody for a
    configuration they chose."""
    set_client(MarketFeedClient(provider=None))
    assert market_feed_provider_state() == "unconfigured"
    assert _active(_render()) == {"unconfigured"}


def test_a_provider_absent_with_a_quoted_exception_reports_misbuilt():
    """The R368 case, and the only one `MarketFeedProviderMisbuilt` fires on:
    `requirements.txt` declares yfinance, so every way to reach this is a
    deployment that is wrong."""
    client = MarketFeedClient(provider=None)
    client.no_provider_reason = (
        "no market-data provider available (importing yfinance raised ValueError: numpy ABI)"
    )
    set_client(client)
    assert market_feed_provider_state() == "misbuilt"
    assert _active(_render()) == {"misbuilt"}


def test_exactly_one_state_is_one_and_every_state_has_a_series():
    """A state-set, the idiom `upstream_circuit_state` uses: `== 1` reads as
    itself, and a state whose series is simply absent is indistinguishable from
    a unit that is down."""
    set_client(MarketFeedClient(provider=object()))
    text = _render()
    for state in MARKET_FEED_PROVIDER_STATES:
        assert f'market_feed_provider{{state="{state}"}}' in text, state
    ones = [line for line in text.splitlines() if line.startswith("market_feed_provider{") and line.endswith(" 1")]
    assert len(ones) == 1


def test_the_state_moves_between_scrapes_rather_than_freezing_at_registration():
    registry = MetricsRegistry()
    register_market_feed_metrics(registry)
    set_client(MarketFeedClient(provider=object()))
    assert _active(registry.render()) == {"available"}
    set_client(MarketFeedClient(provider=None))
    assert _active(registry.render()) == {"unconfigured"}


def test_the_opt_out_reason_is_the_constant_the_state_check_compares_against():
    """If `NO_PROVIDER_REASON` and what the constructor stores ever diverge, the
    opt-out starts reporting `misbuilt` and this rule pages every deployment
    that has one. Asserted here rather than assumed."""
    assert MarketFeedClient(provider=None).no_provider_reason == NO_PROVIDER_REASON


def test_the_gauge_is_registered_on_the_engine_unit_at_boot():
    from pathlib import Path

    main = Path(__file__).resolve().parents[1].joinpath("app/main.py").read_text()
    assert "register_market_feed_metrics(_metrics)" in main
