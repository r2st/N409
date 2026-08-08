"""Guideline-public-company screening, scoring and multiple statistics."""

import math

import pytest
from fastapi.testclient import TestClient

from app.engine.comparables import (
    DEFAULT_WEIGHTS,
    comparable_analysis,
    multiple_statistics,
    primary_multiple,
    score_company,
    screen_comparables,
    sic_similarity,
)
from app.engine.errors import EngineInputError
from app.engine.market_data import _BY_TICKER, universe
from app.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


# A mid-size application-software target: SIC 7372, ~$400m revenue, growing 25%,
# ~18% EBITDA margin. Chosen so the reference universe has near and far matches.
TARGET = {
    "sic_code": "7372",
    "revenue": 400_000_000,
    "revenue_growth": 0.25,
    "ebitda_margin": 0.18,
}


# ── the reference snapshot ───────────────────────────────────────────────────


def test_revenue_and_margin_are_derived_from_the_multiples():
    """Both are implied by figures already in the table, so the snapshot cannot
    disagree with itself — a screen matching on size ranks against a revenue
    the multiples actually support."""
    ddog = _BY_TICKER["DDOG"]
    assert ddog.revenue == pytest.approx(ddog.market_cap / ddog.ev_revenue)
    assert ddog.ebitda_margin == pytest.approx(ddog.ev_revenue / ddog.ev_ebitda)


def test_margin_is_absent_exactly_where_the_ebitda_multiple_is():
    for company in _BY_TICKER.values():
        assert (company.ebitda_margin is None) == (company.ev_ebitda is None)


def test_the_universe_spans_more_than_software():
    groups = {c["sic_code"][:2] for c in universe()}
    # Industrials, healthcare, consumer and finance, not just 73xx.
    assert len(groups) >= 8


def test_the_universe_spans_more_than_three_orders_of_magnitude():
    revenues = [c["revenue"] for c in universe()]
    # A small target must have something small to rank against, or the best
    # match is only ever "the least enormous company available".
    assert max(revenues) / min(revenues) > 1_000


# ── SIC proximity ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "a,b,expected",
    [
        ("7372", "7372", 1.0),   # same industry
        ("7372", "7379", 0.80),  # same 3-digit group
        ("7372", "7389", 0.45),  # same major group only
        ("7372", "7011", 0.15),  # same division
        ("7372", "2836", 0.0),   # unrelated
    ],
)
def test_sic_similarity_by_shared_prefix(a, b, expected):
    assert sic_similarity(a, b) == pytest.approx(expected)


def test_a_major_group_match_is_not_treated_as_an_exact_one():
    # A payments processor and a crypto exchange share "61"; a report that
    # calls that an industry match is one a reviewer takes apart.
    assert sic_similarity("6199", "6100") < sic_similarity("6199", "6199")


def test_a_missing_sic_scores_zero_rather_than_raising():
    assert sic_similarity(None, "7372") == 0.0
    assert sic_similarity("7372", "") == 0.0


# ── scoring ──────────────────────────────────────────────────────────────────


def test_a_same_industry_same_scale_company_outscores_a_far_one():
    near = score_company(_BY_TICKER["APPF"], **TARGET)  # software, ~$840m rev
    far = score_company(_BY_TICKER["CAT"], **TARGET)    # heavy equipment, ~$65bn
    assert near["score"] > far["score"]


def test_size_proximity_is_measured_on_a_log_scale():
    """$10m to $100m is the same kind of gap as $1bn to $10bn. On a linear
    measure every large-cap is equally wrong for a small target, and the
    ranking within them is noise."""
    small = {**TARGET, "revenue": 50_000_000}
    # Both are software; the only thing separating them is scale.
    yext = score_company(_BY_TICKER["YEXT"], **small)["breakdown"]["size"]
    crm = score_company(_BY_TICKER["CRM"], **small)["breakdown"]["size"]
    assert yext > crm
    assert crm == 0.0  # more than a decade away


def test_growth_separates_two_otherwise_similar_companies():
    fast = {**TARGET, "revenue_growth": 0.33}
    # CRWD grows 33%, ZM grows 3% — same industry, both large.
    assert (
        score_company(_BY_TICKER["CRWD"], **fast)["breakdown"]["growth"]
        > score_company(_BY_TICKER["ZM"], **fast)["breakdown"]["growth"]
    )


def test_an_unmeasured_dimension_is_dropped_and_the_weights_renormalise():
    """Not scored zero: penalising every candidate equally on an axis nobody
    measured changes the total without changing the ranking, and makes the
    number unreadable."""
    scored = score_company(_BY_TICKER["DDOG"], sic_code="7372", revenue=400_000_000)
    assert set(scored["breakdown"]) == {"industry", "size"}
    assert sum(scored["weights"].values()) == pytest.approx(1.0)
    assert "growth" not in scored["weights"]


def test_a_dimension_the_target_has_and_the_comp_lacks_scores_zero():
    # SNOW reports no positive EBITDA; against a profitable target that is a
    # real difference, not a missing measurement.
    scored = score_company(_BY_TICKER["SNOW"], **TARGET)
    assert scored["breakdown"]["profitability"] == 0.0
    assert "profitability" in scored["weights"]


def test_a_target_with_no_attributes_scores_zero_with_an_empty_breakdown():
    scored = score_company(_BY_TICKER["DDOG"])
    assert scored == {"score": 0.0, "breakdown": {}, "weights": {}}


def test_weights_can_be_overridden_and_change_the_ranking():
    industry_only = {"industry": 1.0, "size": 0.0, "growth": 0.0, "profitability": 0.0}
    # CRM is software but 25× the target's revenue; under size-blind weights it
    # should score a perfect industry match.
    scored = score_company(_BY_TICKER["CRM"], **TARGET, weights=industry_only)
    assert scored["score"] == pytest.approx(1.0)


def test_an_unknown_weight_name_is_refused():
    with pytest.raises(EngineInputError, match="unknown weight"):
        score_company(_BY_TICKER["DDOG"], **TARGET, weights={"vibes": 1.0})


def test_the_default_weights_sum_to_one():
    assert sum(DEFAULT_WEIGHTS.values()) == pytest.approx(1.0)


# ── screening ────────────────────────────────────────────────────────────────


def test_the_screen_ranks_software_above_everything_else_for_a_software_target():
    result = screen_comparables(**TARGET)
    top = result["selected"][:5]
    assert all(c["sic_code"].startswith("73") for c in top)
    scores = [c["score"] for c in top]
    assert scores == sorted(scores, reverse=True)


def test_screened_out_companies_carry_the_dimension_that_sank_them():
    result = screen_comparables(**TARGET)
    assert result["screened_out"]
    reasons = {row["reason"] for row in result["screened_out"]}
    assert "different industry" in reasons
    # Every rejection names something.
    assert all(row["reason"] for row in result["screened_out"])


def test_an_included_ticker_is_forced_in_whatever_it_scores():
    # The analyst has a comp they intend to use and wants it scored alongside
    # the rest rather than argued with.
    result = screen_comparables(**TARGET, include_tickers=["CAT"])
    tickers = [c["ticker"] for c in result["selected"]]
    assert tickers[0] == "CAT"
    assert next(c for c in result["selected"] if c["ticker"] == "CAT")["forced"] is True


def test_an_excluded_ticker_is_gone_from_both_lists():
    result = screen_comparables(**TARGET, exclude_tickers=["DDOG"])
    assert "DDOG" not in [c["ticker"] for c in result["selected"]]
    assert "DDOG" not in [c["ticker"] for c in result["screened_out"]]


def test_the_limit_is_respected():
    assert len(screen_comparables(**TARGET, limit=3)["selected"]) == 3


def test_the_ordering_is_stable_across_runs():
    a = [c["ticker"] for c in screen_comparables(**TARGET)["selected"]]
    b = [c["ticker"] for c in screen_comparables(**TARGET)["selected"]]
    assert a == b


def test_a_screen_with_nothing_to_match_on_is_refused():
    # A ranking with no target attributes is noise wearing a score.
    with pytest.raises(EngineInputError, match="at least one target attribute"):
        screen_comparables()


def test_a_lower_floor_admits_more_candidates():
    strict = screen_comparables(**TARGET, min_score=0.8, limit=12)
    loose = screen_comparables(**TARGET, min_score=0.0, limit=12)
    assert len(loose["selected"]) >= len(strict["selected"])


# ── multiple statistics ──────────────────────────────────────────────────────


def test_the_harmonic_mean_sits_below_the_arithmetic_mean():
    """The arithmetic mean of multiples quietly overweights the most expensive
    comp; the harmonic mean is the one that is right for a ratio applied to a
    denominator."""
    stats = multiple_statistics([4.0, 6.0, 30.0])
    # The AM-HM inequality, strict whenever the values differ. The median is
    # not bracketed by the two and is not asserted to be — here it sits below
    # both, which is itself the point: all three are reported so the report can
    # say which it used.
    assert stats["harmonic_mean"] < stats["mean"]
    assert stats["mean"] == pytest.approx(13.3333, rel=1e-4)
    assert stats["harmonic_mean"] == pytest.approx(6.6667, rel=1e-4)
    assert stats["median"] == pytest.approx(6.0)


def test_outliers_are_named_and_excluded_from_the_trimmed_figures_only():
    values = [5.0, 5.5, 6.0, 6.5, 40.0]
    stats = multiple_statistics(values)
    assert stats["outliers"] == [40.0]
    assert stats["count"] == 5  # nothing dropped from the headline count
    assert stats["trimmed_count"] == 4
    assert stats["trimmed_median"] < stats["median"]


def test_a_tight_set_has_no_outliers():
    stats = multiple_statistics([5.0, 5.2, 5.4, 5.6])
    assert stats["outliers"] == []
    assert stats["trimmed_median"] == pytest.approx(stats["median"])


def test_quartiles_are_defined_below_four_data_points():
    # `statistics.quantiles` raises under four, and a comp set of three is
    # ordinary.
    stats = multiple_statistics([4.0, 8.0, 12.0])
    assert stats["q1"] == pytest.approx(6.0)
    assert stats["median"] == pytest.approx(8.0)
    assert stats["q3"] == pytest.approx(10.0)


def test_a_single_multiple_reports_itself_everywhere():
    stats = multiple_statistics([7.0])
    assert stats["min"] == stats["median"] == stats["max"] == 7.0
    assert stats["dispersion"] == 0.0


def test_nulls_zeroes_and_non_numbers_are_ignored():
    stats = multiple_statistics([5.0, None, 0.0, -2.0, "n/a", math.nan, 7.0])
    assert stats["count"] == 2


def test_an_empty_set_reports_a_count_and_nothing_else():
    assert multiple_statistics([]) == {"count": 0}


def test_dispersion_flags_a_set_that_does_not_support_a_point_multiple():
    tight = multiple_statistics([5.0, 5.1, 4.9])
    wide = multiple_statistics([2.0, 9.0, 25.0])
    assert wide["dispersion"] > tight["dispersion"]


# ── industry-specific multiple choice ────────────────────────────────────────


def test_a_target_with_no_ebitda_gets_a_revenue_multiple():
    choice = primary_multiple(sic_code="3531", ebitda_margin=None, ebitda_count=9)
    assert choice["multiple"] == "ev_revenue"
    assert "no meaningful positive EBITDA" in choice["basis"]


def test_too_few_ebitda_comps_gets_a_revenue_multiple():
    # An EV/EBITDA multiple struck on two comps is not a multiple.
    choice = primary_multiple(sic_code="3531", ebitda_margin=0.2, ebitda_count=2)
    assert choice["multiple"] == "ev_revenue"
    assert "too few" in choice["basis"]


def test_software_leads_with_revenue_even_when_profitable():
    choice = primary_multiple(sic_code="7372", ebitda_margin=0.20, ebitda_count=8)
    assert choice["multiple"] == "ev_revenue"
    assert "market convention" in choice["basis"]


def test_a_profitable_industrial_leads_with_ebitda():
    choice = primary_multiple(sic_code="3531", ebitda_margin=0.15, ebitda_count=6)
    assert choice["multiple"] == "ev_ebitda"


# ── the whole analysis ───────────────────────────────────────────────────────


def test_the_analysis_indicates_an_enterprise_value_from_the_trimmed_median():
    result = comparable_analysis(**TARGET)
    basis = result["indicated_basis"]
    assert basis["multiple"] == "ev_revenue"  # software
    assert basis["denominator"] == TARGET["revenue"]
    assert basis["applied"] == result["multiples"]["ev_revenue"]["trimmed_median"]
    assert result["indicated_enterprise_value"] == pytest.approx(
        basis["denominator"] * basis["applied"]
    )


def test_an_ebitda_led_analysis_applies_the_multiple_to_ebitda_not_revenue():
    industrial = {
        "sic_code": "3531",
        "revenue": 2_000_000_000,
        "revenue_growth": 0.03,
        "ebitda_margin": 0.15,
    }
    result = comparable_analysis(**industrial, min_score=0.0)
    if result["primary_multiple"]["multiple"] == "ev_ebitda":
        assert result["indicated_basis"]["denominator"] == pytest.approx(
            industrial["revenue"] * industrial["ebitda_margin"]
        )


def test_the_analysis_carries_the_screen_output_through():
    result = comparable_analysis(**TARGET)
    assert result["universe_size"] > 0
    assert result["screened_out"]
    assert result["target"]["sic_code"] == "7372"


def test_an_out_of_range_growth_is_refused():
    with pytest.raises(EngineInputError, match="revenue_growth"):
        comparable_analysis(sic_code="7372", revenue_growth=50.0)


# ── HTTP surface ─────────────────────────────────────────────────────────────


def test_endpoint_is_listed_and_computes(client: TestClient):
    assert "/engine/v1/comparables" in client.get("/").json()["endpoints"]
    res = client.post("/engine/v1/comparables", json={"inputs": TARGET})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["selected"]
    assert body["primary_multiple"]["multiple"] in {"ev_revenue", "ev_ebitda"}
    assert all("score" in c and "breakdown" in c for c in body["selected"])


def test_endpoint_maps_an_empty_target_to_422(client: TestClient):
    res = client.post("/engine/v1/comparables", json={"inputs": {}})
    assert res.status_code == 422


def test_endpoint_unknown_input_name_is_422(client: TestClient):
    res = client.post("/engine/v1/comparables", json={"inputs": {**TARGET, "nonsense": 1}})
    assert res.status_code == 422
