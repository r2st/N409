"""Finite in, finite out — or a 422 that says why.

`test_nonfinite_guards.py` covers the front door: a NaN or Inf *arriving* on a
request is refused. These cover the other half, which the front door cannot
see. Every scalar here is finite and passes every range check, and the
arithmetic between them is what leaves the finite floats: multiplication and
division saturate to ``inf`` in Python rather than raising, so a large cash
flow, a large market metric, or a share count near zero produces an infinite
result out of inputs that were each individually fine.

That mattered because nothing downstream noticed. ``inf <= 0`` is False, so the
weighted-value guard passed it; ``round(inf, 2)`` is ``inf``; and the figure
travelled all the way to Starlette's JSON encoder, which renders with
``allow_nan=False`` and raises — a 500 naming nothing. The pre-flight validator
cleared the identical payload first, because every figure in it *is* finite, so
a caller was told the inputs were good and then handed an unhandled error for
using them. Each case below asserts the pair: validate says ok, and compute now
answers 422 rather than 500.

Two related fixes are pinned here as well, because they are the same shape one
operation lower down: `math.log(a / b)` on two positive doubles far apart in
magnitude flushes the quotient to 0.0 and raises a bare ValueError, which is
not an EngineInputError and so was a 500 too.
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.engine.approaches import asset_value, income_dcf, market_multiples
from app.engine.bs import bs_call
from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.volatility import ewma_volatility, historical_volatility, parkinson_volatility
from app.main import app

HUGE = 1e308
client = TestClient(app)


def params(**over) -> dict:
    return {
        "weight_asset": 0.0,
        "weight_opm": 1.0,
        "weight_income": 0.0,
        "weight_market": 0.0,
        "allocation_method": "opm",
        "dlom_method": "qualitative",
        "dlom": 0.2,
        "dloc": 0.0,
        **over,
    }


def inputs(**over) -> dict:
    return {
        "shares_outstanding_common": 1_000_000,
        "last_round_post_money": 10_000_000,
        "volatility": 0.6,
        **over,
    }


# ── the approach layer, which names the figure that overflowed ────────────────


def test_income_dcf_refuses_an_overflowing_terminal_value():
    with pytest.raises(EngineInputError) as err:
        income_dcf([HUGE], 0.5, 0.0)
    assert "overflowed" in str(err.value)
    assert "income." in str(err.value)


def test_income_dcf_refuses_an_overflowing_bridge():
    """The bridge is the other way in: the DCF itself is small, `cash` is not."""
    with pytest.raises(EngineInputError) as err:
        income_dcf([1.0], 0.5, 0.0, cash=HUGE, debt=-HUGE)
    assert "income.equity_value" in str(err.value)


def test_market_multiples_refuses_an_overflowing_enterprise_value():
    with pytest.raises(EngineInputError) as err:
        market_multiples(HUGE, [10.0])
    assert "market.enterprise_value" in str(err.value)


def test_asset_value_refuses_an_overflowing_nav():
    with pytest.raises(EngineInputError) as err:
        asset_value(HUGE, -HUGE)
    assert "asset.equity_value" in str(err.value)


def test_ordinary_approaches_are_untouched():
    dcf = income_dcf([100.0, 110.0, 120.0], 0.25, 0.02, cash=50.0, debt=20.0)
    assert math.isfinite(dcf["equity_value"])
    assert dcf["equity_value"] > 0
    market = market_multiples(1_000_000.0, [8.0, 10.0, 12.0])
    assert market["selected_multiple"] == 10.0
    assert market["equity_value"] == pytest.approx(10_000_000.0)
    assert asset_value(5_000_000.0, 1_000_000.0)["equity_value"] == pytest.approx(4_000_000.0)


# ── the result sweep, for the overflows no single formula owns ────────────────


def test_a_denormal_share_count_is_refused_rather_than_dividing_to_infinity():
    """`1e-320` is positive, so every range check passes; the division is what
    overflows. Nothing in the approach layer can see this one — it happens in
    `common_equity / fully_diluted_common`, after the approaches are done."""
    with pytest.raises(EngineInputError) as err:
        compute(params(), inputs(shares_outstanding_common=1e-320))
    assert "non-finite" in str(err.value)
    assert "fmv_per_share" in str(err.value)


def test_a_waterfall_breakpoint_that_overflows_is_refused():
    with pytest.raises(EngineInputError) as err:
        compute(
            params(),
            inputs(
                share_classes=[
                    {"kind": "common", "name": "Common", "shares": 1e-310},
                    {"kind": "preferred", "name": "A", "shares": 1_000_000, "preference": HUGE},
                ],
                time_to_exit_years=3.0,
                risk_free_rate=0.04,
            ),
        )
    assert "non-finite" in str(err.value)


def test_a_healthy_calculation_still_returns_a_full_document():
    out = compute(params(), inputs())
    assert out["results"]["fmv_per_share"] > 0
    assert math.isfinite(out["results"]["equity_value"])


# ── end to end: validate must not clear what compute cannot serialise ─────────


OVERFLOWING_PAYLOADS = {
    "income": (
        params(weight_opm=0.0, weight_income=1.0),
        inputs(income={"free_cash_flows": [HUGE], "discount_rate": 0.5, "terminal_growth": 0.0}),
    ),
    "market": (
        params(weight_opm=0.0, weight_market=1.0),
        inputs(market={"metric": HUGE, "multiples": [10.0]}),
    ),
    "asset": (
        params(weight_opm=0.0, weight_asset=1.0),
        inputs(asset={"total_assets": HUGE, "total_liabilities": -HUGE}),
    ),
    "shares": (params(), inputs(shares_outstanding_common=1e-320)),
}


@pytest.mark.parametrize("name", sorted(OVERFLOWING_PAYLOADS))
def test_compute_answers_422_where_it_used_to_answer_500(name):
    p, i = OVERFLOWING_PAYLOADS[name]
    body = {"params": p, "inputs": i}

    # The payload really does clear pre-flight validation — which is the whole
    # reason a 500 here was indefensible rather than merely untidy.
    pre = client.post("/engine/v1/validate", json=body)
    assert pre.status_code == 200
    assert pre.json()["ok"] is True

    res = client.post("/engine/v1/compute", json=body)
    assert res.status_code == 422, res.text
    assert "detail" in res.json()


# ── log of a ratio, where a difference of logs is defined ─────────────────────


def test_black_scholes_survives_a_strike_far_above_the_spot():
    """`s / k` flushes to 0.0 here, and `math.log(0.0)` raises. The call is
    worthless at this strike; that is a number, not an exception."""
    assert bs_call(1e7, HUGE, 3.0, 0.04, 0.6) == 0.0


def test_black_scholes_is_unchanged_on_ordinary_inputs():
    assert bs_call(100.0, 90.0, 1.0, 0.04, 0.5) == pytest.approx(25.925118, abs=1e-5)
    # Deep in the money, the call is worth the discounted intrinsic value.
    assert bs_call(100.0, 1.0, 1.0, 0.0, 1e-9) == pytest.approx(99.0, abs=1e-6)


@pytest.mark.parametrize(
    "prices",
    [
        pytest.param([1e308, 1e-300, 1e308, 1e-300], id="ratio-underflows"),
        pytest.param([1e-300, 1e308, 1e-300, 1e308], id="ratio-overflows"),
    ],
)
def test_log_return_estimators_survive_extreme_but_positive_prices(prices):
    for estimator in (historical_volatility, ewma_volatility):
        vol = estimator(prices)
        assert math.isfinite(vol) and vol > 0


def test_parkinson_survives_a_range_that_overflows_as_a_ratio():
    vol = parkinson_volatility([1e308, 1e308], [1e-300, 1e-300])
    assert math.isfinite(vol) and vol > 0


def test_log_return_estimators_are_unchanged_on_an_ordinary_series():
    """The differenced form has to be the same estimator, not merely a safer one.

    These are the values the ratio form produced; it agrees with the difference
    of logs to about a part in 1e13 on this series — the last few ULPs of a
    double, which is the accumulated rounding of the two forms and nothing more.
    Pinned loosely enough not to fail on that, tightly enough that an actual
    change of formula could not slip through.
    """
    prices = [100.0, 102.0, 101.0, 105.0, 104.0]
    assert historical_volatility(prices) == pytest.approx(0.37841674280008425, rel=1e-12)
    assert ewma_volatility(prices) == pytest.approx(0.33600388037315265, rel=1e-12)
    assert parkinson_volatility([101.0, 103.0], [99.0, 100.0]) == pytest.approx(
        0.24059386704902141, rel=1e-12
    )


def test_a_non_positive_price_is_still_the_error_it_was():
    with pytest.raises(EngineInputError, match="positive"):
        historical_volatility([100.0, 0.0, 100.0])
