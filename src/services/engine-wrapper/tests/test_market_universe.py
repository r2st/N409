"""The universe the screen ranks: live where the feed answered, snapshot where not.

Every test here injects a stub provider. The point of the module is that it
degrades rather than fails, so most of what is asserted is the shape of a
degradation: which rows kept their snapshot figures, what the resolution called
itself afterwards, and whether the reason survived as far as the caller.
"""

import time

import pytest
from fastapi.testclient import TestClient

from app.engine import market_universe as mu
from app.engine.comparables import comparable_analysis, screen_comparables
from app.engine.market_data import Company
from app.engine.market_feed import MarketFeedClient
from app.main import app

NAN = float("nan")

BASE = Company(
    ticker="DDOG",
    name="Datadog, Inc.",
    sic_code="7372",
    sic_description="Prepackaged Software",
    sector="Observability SaaS",
    market_cap=42_000_000_000,
    ev_revenue=14.2,
    ev_ebitda=78.0,
    revenue_growth=0.25,
)

# A well-formed `info` payload: the six fields a refreshed row is made of.
LIVE_INFO = {
    "marketCap": 50_000_000_000.0,
    "enterpriseToRevenue": 11.0,
    "enterpriseToEbitda": 60.0,
    "revenueGrowth": 0.30,
    "totalRevenue": 4_500_000_000.0,
    # Deliberately present and deliberately ignored — see the classification test.
    "sector": "Technology",
    "country": "United States",
    "longName": "Datadog Inc",
}


@pytest.fixture()
def client():
    return TestClient(app)


class StubProvider:
    """Answers `info` from a per-ticker table; counts calls so caching is assertable."""

    def __init__(self, infos=None, default=None, fails=()):
        self.infos = infos or {}
        self.default = default if default is not None else dict(LIVE_INFO)
        self.fails = set(fails)
        self.calls = 0

    def info(self, ticker):
        self.calls += 1
        if ticker in self.fails:
            raise RuntimeError(f"network down for {ticker}")
        return dict(self.infos.get(ticker, self.default))

    def prices(self, ticker, start, end):  # pragma: no cover - unused here
        return []

    def financials(self, ticker):  # pragma: no cover - unused here
        return {}


def feed(provider) -> MarketFeedClient:
    return MarketFeedClient(provider=provider)


# ── the environment switch ───────────────────────────────────────────────────


def test_live_is_on_when_nothing_says_otherwise(monkeypatch):
    """Installing the provider is the whole of enabling this; there is no
    second switch to forget to flip."""
    monkeypatch.delenv(mu.LIVE_ENV_VAR, raising=False)
    assert mu.live_enabled() is True


@pytest.mark.parametrize("word", ["0", "false", "no", "off", "OFF", " Off ", "none", "disabled"])
def test_a_falsey_word_pins_the_snapshot(monkeypatch, word):
    monkeypatch.setenv(mu.LIVE_ENV_VAR, word)
    assert mu.live_enabled() is False


@pytest.mark.parametrize("word", ["1", "true", "yes", "on", "auto"])
def test_anything_else_means_live(monkeypatch, word):
    monkeypatch.setenv(mu.LIVE_ENV_VAR, word)
    assert mu.live_enabled() is True


def test_the_switch_is_read_per_call_not_at_import(monkeypatch):
    monkeypatch.setenv(mu.LIVE_ENV_VAR, "off")
    assert mu.live_enabled() is False
    monkeypatch.setenv(mu.LIVE_ENV_VAR, "on")
    assert mu.live_enabled() is True


# ── one row ──────────────────────────────────────────────────────────────────


def test_a_refreshed_row_carries_the_observed_figures():
    company, reason = mu.refresh_company(BASE, LIVE_INFO, "2026-08-09T12:00:00Z")
    assert reason is None
    assert company is not None
    assert company.market_cap == 50_000_000_000.0
    assert company.ev_revenue == 11.0
    assert company.ev_ebitda == 60.0
    assert company.revenue_growth == 0.30
    assert company.figures_source == "live"
    assert company.figures_as_of == "2026-08-09T12:00:00Z"


def test_a_refreshed_row_keeps_the_classification():
    """SIC is the axis the screen weights most heavily and the feed does not
    report it. Its free-text `sector` is not the same fact under another name,
    and its prose country is not the snapshot's ISO code."""
    company, _ = mu.refresh_company(BASE, LIVE_INFO, "2026-08-09T12:00:00Z")
    assert company.ticker == BASE.ticker
    assert company.name == BASE.name  # not "Datadog Inc"
    assert company.sic_code == BASE.sic_code
    assert company.sic_description == BASE.sic_description
    assert company.sector == BASE.sector  # not "Technology"
    assert company.country == BASE.country  # not "United States"


def test_a_live_row_reports_revenue_rather_than_implying_it():
    """The snapshot derives revenue from market cap ÷ EV/Revenue because it has
    no revenue column. A live row has one, read off the same filing as its
    multiples, and using the derivation instead would substitute market cap for
    enterprise value and understate revenue by exactly the net debt."""
    company, _ = mu.refresh_company(BASE, LIVE_INFO, "2026-08-09T12:00:00Z")
    assert company.revenue == 4_500_000_000.0
    assert company.revenue != company.market_cap / company.ev_revenue


def test_a_live_rows_enterprise_value_is_the_one_its_multiples_are_struck_on():
    """A caller storing EV alongside revenue has to store this one, or the
    multiples it implies are not the ones reported here."""
    company, _ = mu.refresh_company(BASE, LIVE_INFO, "2026-08-09T12:00:00Z")
    assert company.enterprise_value == pytest.approx(11.0 * 4_500_000_000.0)
    # Not market cap: this company holds net cash, so its EV is below it. That
    # gap is exactly what a caller storing market cap under an "EV" column
    # would misreport, and the multiple it implied would not be the one here.
    assert company.enterprise_value != company.market_cap
    assert company.enterprise_value / company.revenue == pytest.approx(company.ev_revenue)


def test_a_snapshot_rows_enterprise_value_is_exactly_its_market_cap():
    """Not a round trip through the multiple — exactly the tabulated figure, so
    a caller that stored it before these columns existed still reconciles."""
    assert BASE.enterprise_value == BASE.market_cap


def test_the_margin_identity_survives_a_refresh():
    company, _ = mu.refresh_company(BASE, LIVE_INFO, "2026-08-09T12:00:00Z")
    assert company.ebitda_margin == pytest.approx(company.ev_revenue / company.ev_ebitda)


@pytest.mark.parametrize(
    "field,reason",
    [
        ("enterpriseToRevenue", "no usable EV/Revenue reported"),
        ("totalRevenue", "no LTM revenue reported"),
        ("revenueGrowth", "no usable revenue growth reported"),
    ],
)
def test_a_missing_figure_rejects_the_whole_row(field, reason):
    """Refreshed whole or left as it was. A today market cap over a snapshot
    revenue is a multiple that never existed anywhere."""
    info = {k: v for k, v in LIVE_INFO.items() if k != field}
    company, got = mu.refresh_company(BASE, info, "2026-08-09T12:00:00Z")
    assert company is None
    assert got == reason


@pytest.mark.parametrize("field", ["enterpriseToRevenue", "totalRevenue", "revenueGrowth"])
def test_a_pandas_nan_is_treated_as_missing(field):
    """`.info` is pandas-backed, so an absent figure arrives as `nan` at least
    as often as it arrives absent — and `nan` survives both `float()` and
    `isinstance(..., float)`."""
    company, reason = mu.refresh_company(BASE, {**LIVE_INFO, field: NAN}, "2026-08-09T12:00:00Z")
    assert company is None
    assert reason is not None


@pytest.mark.parametrize("value", [0, -1.0, 10_000.0])
def test_an_out_of_band_ev_revenue_rejects_the_row(value):
    company, reason = mu.refresh_company(
        BASE, {**LIVE_INFO, "enterpriseToRevenue": value}, "2026-08-09T12:00:00Z"
    )
    assert company is None
    assert reason == "no usable EV/Revenue reported"


@pytest.mark.parametrize("value", [-1.5, 25.0])
def test_an_out_of_band_growth_rejects_the_row(value):
    company, reason = mu.refresh_company(
        BASE, {**LIVE_INFO, "revenueGrowth": value}, "2026-08-09T12:00:00Z"
    )
    assert company is None
    assert reason == "no usable revenue growth reported"


def test_a_shrinking_company_is_not_an_error():
    company, _ = mu.refresh_company(
        BASE, {**LIVE_INFO, "revenueGrowth": -0.30}, "2026-08-09T12:00:00Z"
    )
    assert company.revenue_growth == -0.30


@pytest.mark.parametrize("value", [None, NAN, 0, -12.0])
def test_a_missing_ebitda_multiple_is_null_rather_than_fatal(value):
    """Null is already the snapshot's way of saying EBITDA is not meaningfully
    positive, and such a company is a normal member of this universe."""
    info = dict(LIVE_INFO)
    if value is None:
        del info["enterpriseToEbitda"]
    else:
        info["enterpriseToEbitda"] = value
    company, reason = mu.refresh_company(BASE, info, "2026-08-09T12:00:00Z")
    assert reason is None
    assert company.ev_ebitda is None
    assert company.ebitda_margin is None


def test_a_boolean_is_not_a_figure():
    company, reason = mu.refresh_company(
        BASE, {**LIVE_INFO, "totalRevenue": True}, "2026-08-09T12:00:00Z"
    )
    assert company is None
    assert reason == "no LTM revenue reported"


# A live row does not read market cap — scale comes from revenue and the
# enterprise value is implied by the multiple — so an absent one is reported as
# absent rather than sinking the row or being filled from the snapshot.


def test_an_unreported_market_cap_does_not_sink_the_row():
    """Not hypothetical: the feed omits `marketCap` for Salesforce, a company
    it otherwise covers completely."""
    info = {k: v for k, v in LIVE_INFO.items() if k != "marketCap"}
    company, reason = mu.refresh_company(BASE, info, "2026-08-09T12:00:00Z")
    assert reason is None
    assert company.market_cap is None
    assert company.revenue == 4_500_000_000.0  # scale is unaffected
    assert company.enterprise_value == pytest.approx(11.0 * 4_500_000_000.0)


def test_an_unreported_market_cap_is_not_borrowed_from_the_snapshot():
    """Filling the hole with the tabulated figure would date a live row's scale
    to whenever this file was last edited."""
    info = {k: v for k, v in LIVE_INFO.items() if k != "marketCap"}
    company, _ = mu.refresh_company(BASE, info, "2026-08-09T12:00:00Z")
    assert company.market_cap != BASE.market_cap


# ── the symbol has to name the right kind of thing ───────────────────────────


def test_a_fund_is_not_a_guideline_public_company():
    """Bare "WISE" on the feed is a generative-AI ETF, not Wise plc. Without
    this check a refresh keyed on that symbol puts a fund's figures into a
    fintech comp set."""
    company, reason = mu.refresh_company(
        BASE, {**LIVE_INFO, "quoteType": "ETF"}, "2026-08-09T12:00:00Z"
    )
    assert company is None
    assert reason == "the symbol resolves to a ETF, not an operating company"


def test_an_equity_passes_the_quote_type_check():
    company, reason = mu.refresh_company(
        BASE, {**LIVE_INFO, "quoteType": "equity"}, "2026-08-09T12:00:00Z"
    )
    assert reason is None
    assert company.figures_source == "live"


def test_an_unstated_quote_type_is_not_held_against_the_row():
    company, reason = mu.refresh_company(BASE, LIVE_INFO, "2026-08-09T12:00:00Z")
    assert reason is None


@pytest.mark.parametrize("field", ["financialCurrency", "currency"])
def test_a_row_reported_in_another_currency_keeps_its_snapshot_figures(field):
    """Adyen and Spotify are quoted in USD and report their financials in EUR,
    so their revenue and their market cap are in different units and the ratio
    between them has none. A screen ranking a USD target against a EUR revenue
    is measuring an exchange rate as if it were scale."""
    company, reason = mu.refresh_company(
        BASE, {**LIVE_INFO, field: "EUR"}, "2026-08-09T12:00:00Z"
    )
    assert company is None
    assert reason == "reported in EUR, and the universe is denominated in USD"


def test_a_usd_reporter_is_refreshed():
    company, reason = mu.refresh_company(
        BASE,
        {**LIVE_INFO, "financialCurrency": "USD", "currency": "usd"},
        "2026-08-09T12:00:00Z",
    )
    assert reason is None
    assert company.figures_source == "live"


# ── the whole universe ───────────────────────────────────────────────────────

SNAP = (
    BASE,
    Company("CRM", "Salesforce, Inc.", "7372", "Prepackaged Software", "CRM SaaS",
            250_000_000_000, 7.4, 32.0, 0.11),
    Company("CAT", "Caterpillar Inc.", "3531", "Construction Machinery", "Heavy Equipment",
            170_000_000_000, 2.6, 11.0, 0.02),
)


def resolve(provider, **kw):
    return mu.resolve_universe(live=True, client=feed(provider), snapshot=SNAP, **kw)


def test_a_fully_answered_universe_is_live():
    resolution = resolve(StubProvider())
    assert resolution.source == "live"
    assert resolution.live_count == 3
    assert resolution.snapshot_count == 0
    assert resolution.warnings == ()
    assert resolution.as_of is not None
    assert all(c.figures_source == "live" for c in resolution.companies)


def test_a_partly_answered_universe_is_mixed_and_says_which_rows():
    resolution = resolve(StubProvider(fails=["CAT"]))
    assert resolution.source == "mixed"
    assert resolution.live_count == 2
    assert resolution.snapshot_count == 1
    assert any("CAT" in w for w in resolution.warnings)
    by_ticker = {c.ticker: c for c in resolution.companies}
    assert by_ticker["CAT"].figures_source == "snapshot"
    assert by_ticker["DDOG"].figures_source == "live"


def test_an_unrefreshed_row_is_left_exactly_as_it_was():
    resolution = resolve(StubProvider(fails=["CAT"]))
    kept = next(c for c in resolution.companies if c.ticker == "CAT")
    assert kept == SNAP[2]  # the same frozen row, not a rebuilt one
    assert kept.figures_as_of is None


def test_a_ticker_the_feed_answers_badly_keeps_its_snapshot_figures():
    """A fetch that succeeds and returns nothing usable is the same outcome as
    one that fails — the row is not half-refreshed."""
    resolution = resolve(StubProvider(infos={"CRM": {"marketCap": 1.0}}))
    by_ticker = {c.ticker: c for c in resolution.companies}
    assert by_ticker["CRM"] == SNAP[1]
    assert any("CRM" in w and "EV/Revenue" in w for w in resolution.warnings)
    assert resolution.source == "mixed"


def test_no_provider_falls_back_to_the_snapshot_without_raising():
    """The ordinary case: yfinance is an optional dependency and is not
    installed. The engine must screen anyway."""
    resolution = mu.resolve_universe(live=True, client=MarketFeedClient(provider=None), snapshot=SNAP)
    assert resolution.source == "snapshot"
    assert resolution.companies == SNAP
    assert resolution.live_count == 0
    assert resolution.as_of is None
    assert "no market-data provider" in resolution.warnings[0]


def test_a_total_outage_falls_back_to_the_snapshot():
    resolution = resolve(StubProvider(fails=["DDOG", "CRM", "CAT"]))
    assert resolution.source == "snapshot"
    assert resolution.companies == SNAP
    assert len(resolution.warnings) == 3
    assert all("network down" in w for w in resolution.warnings)


def test_a_resolution_with_nothing_live_in_it_has_no_moment():
    """Stamping `as_of` on an all-snapshot set would date figures of unknown
    vintage to now, which is the one claim this module exists to prevent."""
    resolution = resolve(StubProvider(fails=["DDOG", "CRM", "CAT"]))
    assert resolution.as_of is None
    assert resolution.provenance()["as_of"] is None


def test_live_false_pins_the_snapshot_without_touching_the_provider():
    stub = StubProvider()
    resolution = mu.resolve_universe(live=False, client=feed(stub), snapshot=SNAP)
    assert resolution.source == "snapshot"
    assert stub.calls == 0


def test_the_environment_can_pin_the_snapshot(monkeypatch):
    monkeypatch.setenv(mu.LIVE_ENV_VAR, "off")
    stub = StubProvider()
    resolution = mu.resolve_universe(client=feed(stub), snapshot=SNAP)
    assert resolution.source == "snapshot"
    assert stub.calls == 0


def test_the_environment_can_turn_it_on(monkeypatch):
    monkeypatch.setenv(mu.LIVE_ENV_VAR, "1")
    resolution = mu.resolve_universe(client=feed(StubProvider()), snapshot=SNAP)
    assert resolution.source == "live"


def test_the_as_of_stamp_is_utc_and_zulu():
    resolution = resolve(StubProvider())
    assert resolution.as_of.endswith("Z")
    assert "+00:00" not in resolution.as_of


# ── provenance ───────────────────────────────────────────────────────────────


def test_provenance_counts_every_warning_but_prints_a_bounded_number():
    """A total outage produces one warning per name in the universe. The count
    is the fact worth carrying; the list is not."""
    big = tuple(
        Company(f"T{i}", f"Co {i}", "7372", "Prepackaged Software", "SaaS", 1e9, 5.0, 20.0, 0.1)
        for i in range(mu._MAX_WARNINGS + 5)
    )
    resolution = mu.resolve_universe(
        live=True,
        client=feed(StubProvider(fails=[c.ticker for c in big])),
        snapshot=big,
    )
    prov = resolution.provenance()
    assert prov["warning_count"] == len(big)
    assert len(prov["warnings"]) == mu._MAX_WARNINGS + 1
    assert prov["warnings"][-1] == f"… and {len(big) - mu._MAX_WARNINGS} more"


def test_provenance_reports_the_split():
    prov = resolve(StubProvider(fails=["CAT"])).provenance()
    assert prov["source"] == "mixed"
    assert (prov["live_count"], prov["snapshot_count"]) == (2, 1)


# ── caching ──────────────────────────────────────────────────────────────────


def test_a_burst_of_screens_costs_one_fan_out():
    stub = StubProvider()
    client_ = feed(stub)
    first = mu.resolve_universe(live=True, client=client_, snapshot=SNAP, use_cache=True)
    second = mu.resolve_universe(live=True, client=client_, snapshot=SNAP, use_cache=True)
    assert first is second
    assert stub.calls == 3  # three tickers, fetched once


def test_the_resolution_expires():
    """A report built next month must not quote last month's figures as
    observed. The TTL is what stops the memo becoming the snapshot's successor."""
    stub = StubProvider()
    client_ = feed(stub)
    ticks = iter([0.0, 0.0, 0.0, 0.0, mu.TTL_SECONDS + 1.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    clock = lambda: next(ticks)  # noqa: E731
    mu.resolve_universe(live=True, client=client_, snapshot=SNAP, use_cache=True, clock=clock)
    mu.resolve_universe(live=True, client=client_, snapshot=SNAP, use_cache=True, clock=clock)
    # The feed client has its own memo, so the second fan-out is served from it —
    # what is asserted here is that the resolution was rebuilt, not the fetch count.
    assert stub.calls == 3


def test_resetting_drops_the_memo():
    stub = StubProvider()
    client_ = feed(stub)
    a = mu.resolve_universe(live=True, client=client_, snapshot=SNAP, use_cache=True)
    mu.reset_cache()
    b = mu.resolve_universe(live=True, client=client_, snapshot=SNAP, use_cache=True)
    assert a is not b
    assert a.companies == b.companies


def test_a_pinned_resolution_is_not_cached_over_a_live_one():
    """`live=False` is one caller asking for a reproducible rerun, not a change
    of policy for whoever screens next."""
    stub = StubProvider()
    client_ = feed(stub)
    mu.resolve_universe(live=False, client=client_, snapshot=SNAP, use_cache=True)
    after = mu.resolve_universe(live=True, client=client_, snapshot=SNAP, use_cache=True)
    assert after.source == "live"


def test_swapping_the_client_drops_the_resolution():
    mu.set_client(feed(StubProvider()))
    live = mu.resolve_universe(live=True, use_cache=True, snapshot=SNAP)
    assert live.source == "live"
    mu.set_client(MarketFeedClient(provider=None))
    after = mu.resolve_universe(live=True, use_cache=True, snapshot=SNAP)
    assert after.source == "snapshot"


# ── the deadline ─────────────────────────────────────────────────────────────


def test_an_expired_deadline_falls_back_rather_than_hanging():
    """Simulated by a clock that jumps past the budget on its first reading
    inside the fan-out — the same state a source that has stopped answering
    puts the refresh in."""
    # The first reading sets the budget; the second is already past it.
    ticks = iter([0.0, mu.REFRESH_TIMEOUT_SECONDS + 1.0] + [0.0] * 20)
    resolution = mu.resolve_universe(
        live=True,
        client=feed(StubProvider()),
        snapshot=SNAP,
        clock=lambda: next(ticks),
        use_cache=False,
    )
    assert resolution.source == "snapshot"
    assert all("timed out" in w for w in resolution.warnings)


def test_a_slow_source_does_not_hold_the_request_open(monkeypatch):
    monkeypatch.setattr(mu, "REFRESH_TIMEOUT_SECONDS", 0.05)

    class SlowProvider(StubProvider):
        def info(self, ticker):
            time.sleep(5.0)
            raise AssertionError("unreachable — the deadline fires first")

    started = time.monotonic()
    resolution = mu.resolve_universe(
        live=True, client=feed(SlowProvider()), snapshot=SNAP, use_cache=False
    )
    assert time.monotonic() - started < 2.0
    assert resolution.source == "snapshot"


# ── the screen reads it ──────────────────────────────────────────────────────


TARGET = {
    "sic_code": "7372",
    "revenue": 4_000_000_000,
    "revenue_growth": 0.28,
    "ebitda_margin": 0.18,
}


def test_the_screen_reports_which_universe_it_ranked():
    result = screen_comparables(**TARGET, live=False)
    assert result["universe"]["source"] == "snapshot"
    assert result["universe"]["live_count"] == 0
    assert all(c["figures_source"] == "snapshot" for c in result["selected"])


def test_the_screen_ranks_the_refreshed_figures_not_the_snapshot():
    """The point of the whole module. DDOG's snapshot revenue is ~$3.0bn
    (42bn ÷ 14.2); the feed says $4.5bn, which is nearer the target — so the
    live row must score higher on size than the snapshot row does."""
    mu.set_client(feed(StubProvider(infos={"DDOG": LIVE_INFO})))
    pinned = screen_comparables(**TARGET, live=False)
    live = screen_comparables(**TARGET, live=True)

    def size_of(result):
        row = next(c for c in result["selected"] if c["ticker"] == "DDOG")
        return row["breakdown"]["size"]

    assert size_of(live) > size_of(pinned)
    assert live["universe"]["source"] in {"live", "mixed"}


def test_a_screened_row_carries_its_own_provenance():
    mu.set_client(feed(StubProvider()))
    result = screen_comparables(**TARGET, live=True)
    row = result["selected"][0]
    assert row["figures_source"] == "live"
    assert row["figures_as_of"] is not None
    assert row["enterprise_value"] > 0


def test_the_screen_still_works_with_no_provider_at_all():
    mu.set_client(MarketFeedClient(provider=None))
    result = screen_comparables(**TARGET, live=True)
    assert result["universe"]["source"] == "snapshot"
    assert len(result["selected"]) > 0
    assert "no market-data provider" in result["universe"]["warnings"][0]


def test_the_full_analysis_carries_the_provenance_through():
    result = comparable_analysis(**TARGET, live=False)
    assert result["universe"]["source"] == "snapshot"
    assert result["universe_size"] == len(mu.SNAPSHOT)


def test_a_pinned_screen_reruns_identically():
    a = screen_comparables(**TARGET, live=False)
    b = screen_comparables(**TARGET, live=False)
    assert [c["ticker"] for c in a["selected"]] == [c["ticker"] for c in b["selected"]]
    assert a["universe"] == b["universe"]


# ── over HTTP ────────────────────────────────────────────────────────────────


def test_the_comparables_endpoint_reports_provenance(client):
    resp = client.post("/engine/v1/comparables", json={"inputs": {**TARGET, "live": False}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["universe"]["source"] == "snapshot"
    assert body["selected"][0]["figures_source"] == "snapshot"


def test_the_universe_probe_reports_provenance(client):
    resp = client.get("/engine/v1/market-data?live=false")
    assert resp.status_code == 200
    body = resp.json()
    assert body["provenance"]["source"] == "snapshot"
    assert body["count"] == len(body["companies"])


def test_ticker_verification_reports_provenance(client):
    resp = client.post("/engine/v1/market-data", json={"tickers": ["DDOG"], "live": False})
    assert resp.status_code == 200
    body = resp.json()
    assert body["companies"][0]["ticker"] == "DDOG"
    assert body["provenance"]["source"] == "snapshot"


def test_ticker_verification_answers_with_live_figures_when_it_has_them(client):
    mu.set_client(feed(StubProvider()))
    resp = client.post("/engine/v1/market-data", json={"tickers": ["DDOG"], "live": True})
    assert resp.status_code == 200
    body = resp.json()
    assert body["provenance"]["source"] in {"live", "mixed"}
    ddog = body["companies"][0]
    assert ddog["figures_source"] == "live"
    assert ddog["market_cap"] == LIVE_INFO["marketCap"]


def test_a_bad_ticker_list_is_still_a_422_with_live_resolution(client):
    resp = client.post("/engine/v1/market-data", json={"tickers": "DDOG", "live": False})
    assert resp.status_code == 422
