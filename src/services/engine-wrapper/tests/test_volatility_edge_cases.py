"""Edge cases in the volatility estimator that reached the caller as a 500,
or as a 200 carrying a number nobody should have used.

Two separate failures, both found by driving the public endpoint:

1. ``periods_per_year`` arrives off the wire as an unbounded ``int`` and is fed
   straight to ``math.sqrt``. Negative → bare ``ValueError`` → 500. Zero →
   every estimate annualizes to exactly 0.0 and returns 200; the zero is only
   caught much later by the OPM, which rejects it as "volatility is required"
   — an error naming a field the caller never touched.

2. A comparable whose price series never moves contributes a 0.0 to the
   aggregate. Five such comps returned ``recommended_volatility: 0.0`` graded
   ``confidence: "high"``: unusable, and labelled trustworthy. Three flat comps
   among five put the *median* exactly on zero while the grade only fell to
   "low".
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.volatility import (
    _MAX_PERIODS_PER_YEAR,
    estimate_volatility,
    ewma_volatility,
    historical_volatility,
    parkinson_volatility,
)
from app.main import app

client = TestClient(app)

MOVING = [10.0, 10.4, 10.1, 10.9, 10.3, 11.2, 10.8]
FLAT = [10.0] * 8


def comp(ticker: str, prices: list[float]) -> dict:
    return {"ticker": ticker, "prices": list(prices)}


# --- 1. periods_per_year -----------------------------------------------------


@pytest.mark.parametrize("bad", [-252, -1, 0])
def test_non_positive_periods_is_rejected_not_a_math_domain_error(bad: int) -> None:
    # math.sqrt(-1) raises a bare ValueError; math.sqrt(0) silently annualizes
    # everything to zero. Neither is a usable answer.
    with pytest.raises(EngineInputError, match="periods_per_year"):
        historical_volatility(MOVING, periods_per_year=bad)


def test_absurd_periods_is_rejected() -> None:
    with pytest.raises(EngineInputError, match="periods_per_year must be <="):
        historical_volatility(MOVING, periods_per_year=_MAX_PERIODS_PER_YEAR + 1)


def test_the_boundary_values_are_allowed() -> None:
    assert historical_volatility(MOVING, periods_per_year=1) > 0
    assert historical_volatility(MOVING, periods_per_year=_MAX_PERIODS_PER_YEAR) > 0


def test_a_bool_is_not_an_acceptable_period_count() -> None:
    # bool is an int subclass, so `True` would otherwise annualize by 1.
    with pytest.raises(EngineInputError, match="must be an integer"):
        historical_volatility(MOVING, periods_per_year=True)  # type: ignore[arg-type]


def test_every_estimator_guards_the_annualisation_factor() -> None:
    with pytest.raises(EngineInputError, match="periods_per_year"):
        ewma_volatility(MOVING, periods_per_year=0)
    with pytest.raises(EngineInputError, match="periods_per_year"):
        parkinson_volatility([11.0, 11.5], [10.0, 10.5], periods_per_year=-5)


def test_bad_periods_is_a_422_not_a_500() -> None:
    body = {"comparables": [comp("AAA", MOVING)], "periods_per_year": -1}
    res = client.post("/engine/v1/volatility", json=body)
    assert res.status_code == 422
    assert "periods_per_year" in res.json()["detail"]


def test_zero_periods_is_a_422_rather_than_a_zero_volatility_200() -> None:
    body = {"comparables": [comp("AAA", MOVING)], "periods_per_year": 0}
    res = client.post("/engine/v1/volatility", json=body)
    assert res.status_code == 422


# --- 2. degenerate comparables ----------------------------------------------


def test_a_flat_comp_is_excluded_and_named() -> None:
    out = estimate_volatility([comp("AAA", MOVING), comp("DEAD", FLAT)])
    assert [e["ticker"] for e in out["excluded_companies"]] == ["DEAD"]
    # Still listed, so the exclusion is auditable rather than silent.
    assert {c["ticker"] for c in out["companies"]} == {"AAA", "DEAD"}
    assert {c["ticker"]: c["used"] for c in out["companies"]} == {"AAA": True, "DEAD": False}
    assert out["company_count"] == 1


def test_flat_comps_no_longer_drag_the_median_to_zero() -> None:
    live = [comp(f"L{i}", [p * (1 + i / 100) for p in MOVING]) for i in range(2)]
    dead = [comp(f"D{i}", FLAT) for i in range(3)]
    out = estimate_volatility(dead + live)
    # Median of [0, 0, 0, σ1, σ2] is 0. Median of [σ1, σ2] is not.
    assert out["recommended_volatility"] > 0
    assert out["median_volatility"] == pytest.approx(
        estimate_volatility(live)["median_volatility"]
    )


def test_all_flat_comps_is_an_error_not_a_confident_zero() -> None:
    with pytest.raises(EngineInputError, match="measurable price movement"):
        estimate_volatility([comp(f"D{i}", FLAT) for i in range(5)])


def test_all_flat_comps_is_a_422_at_the_endpoint() -> None:
    body = {"comparables": [comp(f"D{i}", FLAT) for i in range(5)]}
    res = client.post("/engine/v1/volatility", json=body)
    assert res.status_code == 422
    assert "measurable price movement" in res.json()["detail"]


def test_a_grade_is_never_earned_by_comps_the_estimate_ignores() -> None:
    # The dispersion grade used to be computed over the flat comps too, so a
    # tight cluster of zeros read as agreement. The grade must now reflect only
    # the comps the recommendation rests on: two live comps cannot buy "high",
    # however many dead ones sit beside them.
    live = [comp(f"L{i}", [p * (1 + i / 50) for p in MOVING]) for i in range(2)]
    dead = [comp(f"D{i}", FLAT) for i in range(6)]
    out = estimate_volatility(live + dead)
    assert out["company_count"] == 2
    assert out["confidence"] == "low"


def test_the_recommendation_is_never_a_volatility_the_opm_would_reject() -> None:
    # The OPM requires sigma > 0; anything the estimator recommends must clear
    # that bar, or the caller gets an error pointing at the wrong field.
    live = [comp(f"L{i}", [p * (1 + i / 50) for p in MOVING]) for i in range(4)]
    for comps in (live, live + [comp("DEAD", FLAT)]):
        assert estimate_volatility(comps)["recommended_volatility"] > 0


def test_a_manual_override_survives_a_full_set_of_dead_comps() -> None:
    # The analyst pinned the assumption; the dead comps cost nothing.
    out = estimate_volatility([comp(f"D{i}", FLAT) for i in range(3)], manual_override=0.62)
    assert out["recommended_volatility"] == 0.62
    assert out["confidence"] == "manual"
    assert len(out["excluded_companies"]) == 3


def test_dead_comps_publish_no_peer_distribution() -> None:
    """Round 386, methodology M2. The answer stands; the *distribution* cannot.

    The rescue used to be `vols = [manual_override]`, and the five figures
    below are all struck from `vols` — so the pinned assumption came back as
    the median, mean, minimum and maximum of a peer set no peer had entered,
    with a coefficient of variation of 0.0 saying they agreed and a
    `company_count` of 1 counting a company that is not there.

    `reportExhibits.ts` prints exactly these five as a "Distribution" table,
    under a "Guideline companies measured" line it derives from `companies` —
    so the exhibit read `0` companies above four identical percentages. A null
    is what the whole chain already handles: `fin()` maps it through,
    `push()` drops the row, and `measuredCount` never trusted the count.
    """
    out = estimate_volatility([comp(f"D{i}", FLAT) for i in range(3)], manual_override=0.62)
    assert out["recommended_volatility"] == 0.62
    assert out["company_count"] == 0
    for key in (
        "median_volatility",
        "mean_volatility",
        "min_volatility",
        "max_volatility",
        "coefficient_of_variation",
    ):
        assert out[key] is None, f"{key} was published off an empty measured set"


def test_a_measured_set_still_reports_its_distribution() -> None:
    """The discriminator: nulling the five unconditionally would pass above."""
    out = estimate_volatility([comp("A", MOVING), comp("B", [p * 1.01 for p in MOVING])])
    assert out["company_count"] == 2
    assert out["median_volatility"] is not None
    assert out["min_volatility"] <= out["median_volatility"] <= out["max_volatility"]
    assert out["coefficient_of_variation"] is not None


def test_a_pinned_override_beside_live_comps_keeps_both_figures() -> None:
    """A measured distribution and an override are two facts, not one.

    The override is the recommendation; the comps that *did* move are still the
    peer set the exhibit tabulates, and nulling them would lose the disclosure
    the analyst overrode.
    """
    out = estimate_volatility(
        [comp("LIVE", MOVING), comp("DEAD", FLAT)], manual_override=0.62
    )
    assert out["recommended_volatility"] == 0.62
    assert out["company_count"] == 1
    assert out["median_volatility"] is not None
    assert out["median_volatility"] != 0.62


# --- the autopilot path, where the zero used to end up ----------------------


def test_the_autopilot_blames_the_comps_not_the_opm() -> None:
    """The whole point of the exclusion, end to end.

    ``auto_volatility`` writes ``recommended_volatility`` into
    ``inputs["volatility"]``. A set of dead comps used to write 0.0 there, and
    the run then died inside the waterfall with "volatility is required for the
    waterfall allocation" — an error about a field the caller *did* supply, via
    an autopilot they asked for. It now fails naming the price series.
    """
    from app.engine.compute import compute

    params = {
        "weight_asset": 0.0,
        "weight_opm": 1.0,
        "weight_income": 0.0,
        "weight_market": 0.0,
        "dloc": 0.0,
        "dlom_method": "finnerty",
        "exit_timeline": "2029-06-30",
    }
    inputs = {
        "valuation_date": "2026-06-30",
        "shares_outstanding_common": 7_000_000,
        "options_outstanding": 1_000_000,
        "shares_outstanding_preferred": 2_000_000,
        "liquidation_preference": 5_000_000,
        "risk_free_rate": 0.042,
        "last_round_post_money": 20_000_000,
        "volatility_comparables": [comp(f"D{i}", FLAT) for i in range(4)],
    }
    with pytest.raises(EngineInputError) as excinfo:
        compute(params, inputs, auto_volatility=True)
    message = str(excinfo.value)
    assert "measurable price movement" in message
    assert "waterfall" not in message


def test_the_autopilot_still_runs_when_only_some_comps_are_dead() -> None:
    from app.engine.compute import compute

    params = {
        "weight_asset": 0.0,
        "weight_opm": 1.0,
        "weight_income": 0.0,
        "weight_market": 0.0,
        "dloc": 0.0,
        "dlom_method": "finnerty",
        "exit_timeline": "2029-06-30",
    }
    live = [comp(f"L{i}", [p * (1 + i / 50) for p in MOVING]) for i in range(3)]
    inputs = {
        "valuation_date": "2026-06-30",
        "shares_outstanding_common": 7_000_000,
        "options_outstanding": 1_000_000,
        "shares_outstanding_preferred": 2_000_000,
        "liquidation_preference": 5_000_000,
        "risk_free_rate": 0.042,
        "last_round_post_money": 20_000_000,
        "volatility_comparables": live + [comp("DEAD", FLAT)],
    }
    out = compute(params, inputs, auto_volatility=True)["results"]
    assert out["auto"]["volatility"]["recommended_volatility"] > 0
    assert [e["ticker"] for e in out["auto"]["volatility"]["excluded_companies"]] == ["DEAD"]


def test_a_healthy_set_reports_no_exclusions() -> None:
    live = [comp(f"L{i}", [p * (1 + i / 50) for p in MOVING]) for i in range(5)]
    out = estimate_volatility(live)
    assert out["excluded_companies"] == []
    assert out["company_count"] == 5
    assert all(c["used"] for c in out["companies"])
