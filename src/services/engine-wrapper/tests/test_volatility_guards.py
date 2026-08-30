"""Volatility and market-movement guards — the series and blocks that are refused.

Both modules read numbers straight off the wire, and both were carrying
unexecuted refusal branches. The common thread is the one the volatility module
documents at length: a price series that is *nearly* valid takes the bad value
several operations past the check that should have caught it, and what surfaces
is a bare `ValueError` from `statistics` or `math` — a 500 for what is plainly a
bad input. Each guard below is the point where that stops, so each is worth a
test that names the input it turns away.

The market-movement block has a second failure of its own: it is the only
adjustment in the engine that can be off by an order of magnitude and still look
plausible, because an index quoted at 56 against one quoted at 5,600 is a
decimal point rather than a hundred-fold market move.
"""

import math

import pytest

from app.engine.errors import EngineInputError
from app.engine.market_movement import market_movement
from app.engine.volatility import (
    estimate_volatility,
    ewma_volatility,
    historical_volatility,
    parkinson_volatility,
)

RISING = [100.0, 101.0, 99.5, 102.0, 103.5, 101.0, 104.0]


# ── _clean_series ────────────────────────────────────────────────────────────


def test_a_price_series_must_be_a_list():
    with pytest.raises(EngineInputError, match="prices must be a list of prices"):
        historical_volatility("100,101,102")
    with pytest.raises(EngineInputError, match="prices must be a list of prices"):
        historical_volatility({"2026-01-01": 100.0})


def test_a_tuple_is_an_acceptable_series():
    assert historical_volatility(tuple(RISING)) == pytest.approx(historical_volatility(RISING))


def test_a_non_numeric_price_is_refused():
    with pytest.raises(EngineInputError, match="prices must contain only numbers"):
        historical_volatility([100.0, "one hundred one", 102.0])
    with pytest.raises(EngineInputError, match="prices must contain only numbers"):
        historical_volatility([100.0, None, 102.0])
    with pytest.raises(EngineInputError, match="prices must contain only numbers"):
        historical_volatility([100.0, [101.0], 102.0])


def test_a_non_finite_price_is_refused():
    # `NaN <= 0` is False, so a NaN survives the positivity check and makes
    # every log return NaN; statistics.stdev then raises a bare ValueError.
    with pytest.raises(EngineInputError, match="must contain only finite numbers"):
        historical_volatility([100.0, float("nan"), 102.0])
    with pytest.raises(EngineInputError, match="must contain only finite numbers"):
        historical_volatility([100.0, float("inf"), 102.0])


def test_a_non_positive_price_cannot_produce_a_log_return():
    with pytest.raises(EngineInputError, match="prices must be positive to take log returns"):
        historical_volatility([100.0, 0.0, 102.0, 103.0])
    with pytest.raises(EngineInputError, match="prices must be positive to take log returns"):
        historical_volatility([100.0, -5.0, 102.0, 103.0])


def test_log_returns_survive_prices_far_apart_in_magnitude():
    # `log(cur/prev)` flushes the quotient to 0.0 here and raises inside
    # math.log; the difference of logs is defined for every positive pair.
    vol = historical_volatility([1e-300, 1e300, 1e-300, 1e300])
    assert math.isfinite(vol)


# ── Series-length floors ─────────────────────────────────────────────────────


def test_each_estimator_states_the_series_length_it_needs():
    with pytest.raises(EngineInputError, match="needs at least 3 prices"):
        historical_volatility([100.0, 101.0])
    with pytest.raises(EngineInputError, match="ewma volatility needs at least 3 prices"):
        ewma_volatility([100.0, 101.0])
    with pytest.raises(EngineInputError, match="needs at least 1 high/low pair"):
        parkinson_volatility([], [])


def test_a_series_too_short_for_even_one_return_is_caught_earlier():
    # One price yields no return at all, so it fails in `_log_returns` — a
    # different message from the three-price floor the estimators state.
    for series in ([100.0], []):
        with pytest.raises(EngineInputError, match="needs at least 2 prices to compute a return"):
            historical_volatility(series)
        with pytest.raises(EngineInputError, match="needs at least 2 prices to compute a return"):
            ewma_volatility(series)


def test_parkinson_concludes_on_a_single_pair():
    # Unlike the close-to-close estimators, the range estimator needs no
    # second observation: one high/low pair is one measurement.
    assert parkinson_volatility([11.0], [10.0]) > 0.0


# ── Parkinson ────────────────────────────────────────────────────────────────


def test_parkinson_needs_matching_series_lengths():
    with pytest.raises(EngineInputError, match="highs and lows must be the same length"):
        parkinson_volatility([10.0, 11.0, 12.0], [9.0, 10.0])


def test_parkinson_refuses_non_positive_bounds():
    with pytest.raises(EngineInputError, match="highs/lows must be positive"):
        parkinson_volatility([10.0, 0.0], [9.0, 0.0])
    with pytest.raises(EngineInputError, match="highs/lows must be positive"):
        parkinson_volatility([10.0, -1.0], [9.0, -2.0])


def test_parkinson_refuses_a_high_below_its_low():
    # Swapped columns, which otherwise produces a perfectly finite — and
    # perfectly wrong — volatility from the squared negative log range.
    with pytest.raises(EngineInputError, match="high must be >= low"):
        parkinson_volatility([10.0, 9.0], [9.0, 11.0])


def test_parkinson_accepts_a_high_equal_to_its_low():
    assert parkinson_volatility([10.0, 10.0], [10.0, 10.0]) == 0.0


# ── periods_per_year ─────────────────────────────────────────────────────────


def test_periods_per_year_must_be_a_positive_integer():
    with pytest.raises(EngineInputError, match="must be an integer"):
        historical_volatility(RISING, periods_per_year=252.0)
    with pytest.raises(EngineInputError, match="must be an integer"):
        historical_volatility(RISING, periods_per_year=True)
    with pytest.raises(EngineInputError, match="must be a positive integer"):
        historical_volatility(RISING, periods_per_year=0)
    with pytest.raises(EngineInputError, match="must be a positive integer"):
        # Negative reaches math.sqrt and raises a bare ValueError → a 500.
        historical_volatility(RISING, periods_per_year=-252)


def test_periods_per_year_is_bounded_above():
    with pytest.raises(EngineInputError, match="periods_per_year must be <="):
        historical_volatility(RISING, periods_per_year=10**9)


# ── _company_volatility dispatch ─────────────────────────────────────────────


def test_a_comparable_must_be_an_object():
    with pytest.raises(EngineInputError, match="each comparable must be an object"):
        estimate_volatility([["DDOG", RISING]])


def test_a_comparable_without_prices_names_its_ticker():
    with pytest.raises(EngineInputError, match="comparable 'DDOG' needs a prices series"):
        estimate_volatility([{"ticker": "DDOG"}])


def test_an_unnamed_comparable_is_reported_as_a_question_mark():
    with pytest.raises(EngineInputError, match=r"comparable '\?' needs a prices series"):
        estimate_volatility([{"prices": None}])


def test_the_parkinson_method_needs_highs_and_lows():
    with pytest.raises(EngineInputError, match="needs highs/lows for the parkinson method"):
        estimate_volatility([{"ticker": "DDOG", "prices": RISING}], method="parkinson")


def test_each_method_dispatches_to_its_own_estimator():
    comps = [
        {
            "ticker": "DDOG",
            "prices": RISING,
            "highs": [p * 1.02 for p in RISING],
            "lows": [p * 0.98 for p in RISING],
        }
    ]
    hist = estimate_volatility(comps, method="historical")["companies"][0]["volatility"]
    ewma = estimate_volatility(comps, method="ewma")["companies"][0]["volatility"]
    park = estimate_volatility(comps, method="parkinson")["companies"][0]["volatility"]

    assert hist == pytest.approx(round(historical_volatility(RISING), 4))
    assert ewma == pytest.approx(round(ewma_volatility(RISING), 4))
    assert park == pytest.approx(
        round(parkinson_volatility([p * 1.02 for p in RISING], [p * 0.98 for p in RISING]), 4)
    )
    assert len({hist, ewma, park}) == 3  # three genuinely different estimators


def test_an_unrecognised_method_names_the_vocabulary():
    with pytest.raises(EngineInputError, match="method must be one of"):
        estimate_volatility([{"prices": RISING}], method="garch")


# ── manual_override ──────────────────────────────────────────────────────────


def test_a_non_numeric_manual_override_is_refused():
    with pytest.raises(EngineInputError, match="manual_override must be a number"):
        estimate_volatility([{"prices": RISING}], manual_override="60%")
    with pytest.raises(EngineInputError, match="manual_override must be a number"):
        estimate_volatility([{"prices": RISING}], manual_override=[0.6])


def test_a_manual_override_outside_the_band_is_refused():
    for bad in (0.0, -0.1, 5.0, 12.0):
        with pytest.raises(EngineInputError, match=r"fraction in \[0\.0001, 5\)"):
            estimate_volatility([{"prices": RISING}], manual_override=bad)


def test_a_manual_override_under_the_measurable_floor_is_refused():
    """The band's floor is the one the estimator applies to a measured comp.

    Everything on this response is reported at four decimals, so an override of
    3e-5 came back as `recommended_volatility: 0.0` — beside, on this very
    request, a `median_volatility` the same call had measured off the prices.
    """
    for bad in (1e-5, 3e-5, 4.9e-5):
        with pytest.raises(EngineInputError, match="indistinguishable from zero"):
            estimate_volatility([{"prices": RISING}], manual_override=bad)


def test_the_floor_itself_is_accepted_and_survives_the_reported_quantum():
    out = estimate_volatility([], manual_override=1e-4)
    assert out["recommended_volatility"] == 0.0001
    assert out["manual_override"] == 0.0001


def test_a_manual_override_stands_in_for_an_empty_comparable_set():
    out = estimate_volatility([], manual_override=0.65, time_to_exit_years=3.0)
    assert out["method"] == "manual"
    assert out["recommended_volatility"] == 0.65
    assert out["confidence"] == "manual"
    assert out["companies"] == []
    assert out["time_to_exit_years"] == 3.0


def test_no_comparables_and_no_override_is_refused():
    with pytest.raises(EngineInputError, match="non-empty list"):
        estimate_volatility([])
    with pytest.raises(EngineInputError, match="non-empty list"):
        estimate_volatility("DDOG")


# ── market_movement ──────────────────────────────────────────────────────────


def test_a_non_numeric_beta_is_refused():
    with pytest.raises(EngineInputError, match="beta must be a number"):
        market_movement({"beta": "1.2x", "index_start": 100.0, "index_end": 110.0})
    with pytest.raises(EngineInputError, match="beta must be a number"):
        market_movement({"beta": [1.2], "index_start": 100.0, "index_end": 110.0})


def test_a_non_finite_beta_is_refused():
    with pytest.raises(EngineInputError, match="beta must be a finite number"):
        market_movement({"beta": float("nan"), "index_start": 100.0, "index_end": 110.0})
    with pytest.raises(EngineInputError, match="beta must be a finite number"):
        market_movement({"beta": float("inf"), "index_start": 100.0, "index_end": 110.0})


def test_a_negative_beta_is_refused():
    with pytest.raises(EngineInputError, match=r"beta must be >= 0"):
        market_movement({"beta": -0.5, "index_start": 100.0, "index_end": 110.0})


def test_beta_defaults_to_one():
    out = market_movement({"index_start": 100.0, "index_end": 110.0})
    assert out["beta"] == 1.0
    assert out["factor"] == pytest.approx(1.10)


def test_a_non_numeric_return_is_refused():
    with pytest.raises(EngineInputError, match="return must be a number"):
        market_movement({"return": "+10%"})
    with pytest.raises(EngineInputError, match="return must be a number"):
        market_movement({"return": {"pct": 0.1}})


def test_a_non_finite_return_is_refused():
    with pytest.raises(EngineInputError, match="return must be a finite number"):
        market_movement({"return": float("nan")})
    with pytest.raises(EngineInputError, match="return must be a finite number"):
        market_movement({"return": float("-inf")})


def test_a_block_with_neither_levels_nor_a_return_is_refused():
    with pytest.raises(EngineInputError, match="needs index_start and index_end, or a return"):
        market_movement({})
    with pytest.raises(EngineInputError, match="needs index_start and index_end, or a return"):
        market_movement({"beta": 1.1})


def test_a_half_supplied_level_pair_names_the_missing_side():
    with pytest.raises(EngineInputError, match="index_end is required"):
        market_movement({"index_start": 100.0})
    with pytest.raises(EngineInputError, match="index_start is required"):
        market_movement({"index_end": 110.0})


def test_levels_win_over_a_return_when_both_are_supplied():
    # The levels are the reviewable form: a reader can check them against the
    # published index, which they cannot do with a bare return.
    out = market_movement({"index_start": 100.0, "index_end": 120.0, "return": -0.50})
    assert out["factor"] == pytest.approx(1.20)


def test_a_non_numeric_index_level_is_refused():
    with pytest.raises(EngineInputError, match="index_start must be a number"):
        market_movement({"index_start": "4,200", "index_end": 4600.0})


def test_a_non_positive_index_level_is_refused():
    with pytest.raises(EngineInputError, match=r"index_start must be positive"):
        market_movement({"index_start": 0.0, "index_end": 4600.0})
    with pytest.raises(EngineInputError, match=r"index_end must be positive"):
        market_movement({"index_start": 4200.0, "index_end": -1.0})


def test_a_non_finite_index_level_is_refused():
    with pytest.raises(EngineInputError, match="index_end must be a finite number"):
        market_movement({"index_start": 4200.0, "index_end": float("inf")})


def test_a_factor_driven_non_positive_is_refused_before_the_band_check():
    # A high beta against a deep drawdown is arithmetically capable of a
    # negative factor, which is not a discount — it is a sign error.
    with pytest.raises(EngineInputError, match="adjustment factor is not positive"):
        market_movement({"beta": 3.0, "return": -0.40})


def test_a_factor_outside_the_band_reads_as_a_decimal_point():
    with pytest.raises(EngineInputError, match="outside the"):
        market_movement({"index_start": 56.0, "index_end": 5600.0})
    with pytest.raises(EngineInputError, match="outside the"):
        market_movement({"index_start": 5600.0, "index_end": 56.0})
