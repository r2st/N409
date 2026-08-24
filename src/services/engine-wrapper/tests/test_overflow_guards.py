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
from app.engine.bs import bs_call, bs_call_delta, bs_call_terms, discount_factor
from app.engine.compute import compute
from app.engine.dlom import (
    chaffee_dlom,
    finnerty_dlom,
    ghaidarov_dlom,
    longstaff_bound,
    longstaff_dlom,
)
from app.engine.errors import EngineInputError
from app.engine.waterfall import allocate_waterfall
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


# ── the discount factor, which the risk-free rate reaches unbounded ───────────
#
# `risk_free_rate` outside its plausible band is a `warn`, not an `error` — a
# band is a review opinion rather than a fact about the arithmetic — so a rate
# typed as a whole number instead of a fraction clears the pre-flight validator
# with `ok: true` and then meets `math.exp` in the Black-Scholes discount
# factor, which raises rather than saturating. Same pairing as everything
# above: told the inputs were good, then handed a 500 for using them.


def opm_only_params(**over) -> dict:
    return {
        "weight_asset": 0.0,
        "weight_opm": 1.0,
        "weight_income": 0.0,
        "weight_market": 0.0,
        "allocation_method": "opm",
        "dlom_method": "qualitative",
        "dlom": 0.2,
        "dloc": 0.0,
        "exit_timeline": "2029-06-30",
        **over,
    }


def opm_only_inputs(**over) -> dict:
    return {
        "valuation_date": "2026-06-30",
        "shares_outstanding_common": 7_000_000,
        "options_outstanding": 1_000_000,
        "shares_outstanding_preferred": 2_000_000,
        "liquidation_preference": 5_000_000,
        "volatility": 0.6,
        "risk_free_rate": 0.042,
        "last_round_post_money": 20_000_000,
        **over,
    }


def test_discount_factor_refuses_a_rate_whose_exponential_overflows():
    with pytest.raises(EngineInputError) as err:
        discount_factor(-1e6, 3.0)
    assert "overflowed" in str(err.value)
    assert "risk_free_rate" in str(err.value)


def test_discount_factor_refuses_a_rate_times_horizon_that_saturates_to_inf():
    """`r * t` saturates silently where `math.exp` raises, so `math.exp(inf)`
    returns `inf` and no exception is raised at all. Left alone it becomes
    `inf * norm_cdf(d2)` — a NaN the moment the tail underflows — and FastAPI
    serialises that as `null` on a 200."""
    with pytest.raises(EngineInputError) as err:
        discount_factor(-1e308, 1e10)
    assert "finite" in str(err.value)


def test_discount_factor_is_the_plain_exponential_in_the_ordinary_range():
    assert discount_factor(0.042, 3.0) == pytest.approx(math.exp(-0.042 * 3.0), rel=1e-15)
    assert discount_factor(0.0, 5.0) == 1.0
    # Underflow is not overflow: a huge *positive* rate discounts to zero, which
    # is a representable answer and must not be refused.
    assert discount_factor(1e6, 3.0) == 0.0


def test_bs_call_refuses_an_overflowing_rate_rather_than_raising_overflowerror():
    with pytest.raises(EngineInputError):
        bs_call(1e6, 5e5, 3.0, -1e6, 0.6)
    # The degenerate (t → 0) branch discounts too, so it needs the same guard.
    with pytest.raises(EngineInputError):
        bs_call(1e6, 5e5, 3.0, -1e6, 0.0)


def test_bs_call_is_unchanged_on_ordinary_inputs():
    assert bs_call(1e6, 5e5, 3.0, 0.042, 0.6) == pytest.approx(637457.6440384055, rel=1e-12)
    assert bs_call(100.0, 100.0, 0.0, 0.05, 0.3) == 0.0


def test_compute_answers_422_for_a_rate_the_validator_only_warned_about():
    """The pair that made this a bug: validate says ok, compute used to 500."""
    payload = {"params": opm_only_params(), "inputs": opm_only_inputs(risk_free_rate=-1e6)}
    pre = client.post("/engine/v1/validate", json=payload)
    assert pre.status_code == 200
    assert pre.json()["ok"] is True

    res = client.post("/engine/v1/compute", json=payload)
    assert res.status_code == 422
    assert "risk_free_rate" in res.json()["detail"]


def test_compute_still_succeeds_on_the_same_payload_with_a_sane_rate():
    payload = {"params": opm_only_params(), "inputs": opm_only_inputs()}
    res = client.post("/engine/v1/compute", json=payload)
    assert res.status_code == 200
    assert math.isfinite(res.json()["results"]["fmv_per_share"])


# ── d1/d2, which the volatility reaches unbounded ─────────────────────────────
#
# The mirror of the section above, and the same pairing. `volatility` outside
# `VOLATILITY_BAND` is a `warn`, not an `error`, for the same reason the rate's
# band is: it is a review opinion rather than a fact about the arithmetic. So
# any finite positive sigma clears the pre-flight validator with `ok: true` and
# arrives at `d1_d2`, where the variance term `0.5·sigma²·t` leaves the doubles
# long before sigma itself does.
#
# What made this worth a guard rather than a shrug is that neither regime says
# anything. Where `sigma²` saturates but `sigma·sqrt(t)` does not, `d1` and `d2`
# are both `inf`, so `N(d2)` is 1 where the limit it stands in for is 0 and the
# call silently collapses to its *intrinsic* value. Where both saturate, `d1` is
# `inf/inf` and every class value in the allocation is a NaN — serialised as
# `null` on a 200, the exact failure `waterfall._finite` refuses one layer up.

# Overflows `(r + 0.5·sigma²)·t` at the three-year horizon these payloads use,
# while `sigma·sqrt(t)` is still finite: the silently-intrinsic regime.
VOL_VARIANCE_OVERFLOW = 1e155
# Overflows `sigma·sqrt(t)` as well, so `d1` is `inf/inf`: the NaN regime.
VOL_DIFFUSION_OVERFLOW = 1e308


def test_bs_call_refuses_a_volatility_whose_variance_term_overflows():
    """The regime that used to answer with intrinsic value and no complaint.

    On this call the true limit as sigma grows is the spot, $10,000,000. What
    it returned instead was $5,739,281 — a 43% understatement, on a 200.
    """
    with pytest.raises(EngineInputError) as err:
        bs_call(1e7, 5e6, 4.0, 0.04, 1e154)
    assert "volatility" in str(err.value)


def test_bs_call_refuses_a_volatility_whose_diffusion_term_overflows():
    with pytest.raises(EngineInputError) as err:
        bs_call(1e7, 5e6, 4.0, 0.04, VOL_DIFFUSION_OVERFLOW)
    assert "volatility" in str(err.value)


def test_the_delta_and_the_schedule_refuse_it_on_the_same_branch():
    """`bs_call_delta` and `bs_call_terms` mirror `bs_call` by construction —
    the class volatilities divide one by the other and the report prints the
    third, so a guard on one of the three and not the others would put a
    refused value and a tabulated one on the same page."""
    for fn in (bs_call_delta, bs_call_terms):
        with pytest.raises(EngineInputError):
            fn(1e7, 5e6, 4.0, 0.04, VOL_DIFFUSION_OVERFLOW)


def test_the_waterfall_refuses_it_rather_than_allocating_nan():
    """Every class came back NaN — `null` in the response — and the values
    summed to NaN against an equity value of $10,000,000."""
    classes = [
        {"name": "Common", "kind": "common", "shares": 8e6},
        {"name": "A", "kind": "preferred", "shares": 2e6, "preference": 5e6, "seniority": 1},
    ]
    with pytest.raises(EngineInputError):
        allocate_waterfall(1e7, classes, 4.0, 0.04, VOL_DIFFUSION_OVERFLOW)


@pytest.mark.parametrize("vol", [VOL_VARIANCE_OVERFLOW, VOL_DIFFUSION_OVERFLOW])
def test_compute_answers_422_for_a_volatility_the_validator_only_warned_about(vol):
    payload = {"params": opm_only_params(), "inputs": opm_only_inputs(volatility=vol)}
    pre = client.post("/engine/v1/validate", json=payload)
    assert pre.status_code == 200
    assert pre.json()["ok"] is True

    res = client.post("/engine/v1/compute", json=payload)
    assert res.status_code == 422
    assert "volatility" in res.json()["detail"]


@pytest.mark.parametrize("vol", [VOL_VARIANCE_OVERFLOW, VOL_DIFFUSION_OVERFLOW])
def test_the_full_cap_table_path_refuses_it_too(vol):
    """The aggregate model and the breakpoint waterfall are separate code
    paths into `bs_call`, and a 409A runs whichever the cap table supports."""
    payload = {
        "params": opm_only_params(),
        "inputs": opm_only_inputs(
            volatility=vol,
            share_classes=[
                {"kind": "common", "name": "Common", "shares": 7_000_000},
                {
                    "kind": "preferred",
                    "name": "A",
                    "shares": 2_000_000,
                    "preference": 5_000_000,
                    "seniority": 1,
                },
            ],
        ),
    }
    assert client.post("/engine/v1/validate", json=payload).json()["ok"] is True
    res = client.post("/engine/v1/compute", json=payload)
    assert res.status_code == 422
    assert "volatility" in res.json()["detail"]


def test_an_overflowing_breakpoint_is_blamed_on_the_breakpoint_not_the_volatility():
    """A waterfall strike is a *sum* of a preference stack, so it arrives here
    already infinite on a table whose stack overflowed — with a volatility of
    0.6 that is entirely fine. The moneyness is checked separately so the
    message does not send the reader to the one input that was not at fault."""
    with pytest.raises(EngineInputError) as err:
        bs_call(1e7, math.inf, 3.0, 0.04, 0.6)
    message = str(err.value)
    assert "preference stack" in message
    assert "volatility" not in message


def test_ordinary_volatilities_are_untouched():
    """The guard must be invisible to every real 409A. These are pinned to the
    full double, not approximately: the healthy path is the same expression it
    always was, so a change in the last bit here means the arithmetic moved."""
    assert bs_call(1e6, 5e5, 3.0, 0.042, 0.6) == 637457.6440384055
    assert bs_call_delta(1e6, 5e5, 3.0, 0.042, 0.6) == 0.9045362054234627
    assert bs_call_terms(1e6, 5e5, 3.0, 0.042, 0.6)["call"] == 637457.6440384055
    # A volatility far outside the plausible band is still a *number*, and the
    # band is only a warning — so a large-but-representable sigma must keep
    # allocating rather than being swept up by the overflow guard.
    assert math.isfinite(bs_call(1e7, 5e6, 4.0, 0.04, 1e150))


def test_compute_still_succeeds_on_the_same_payload_with_a_sane_volatility():
    payload = {"params": opm_only_params(), "inputs": opm_only_inputs(volatility=0.6)}
    res = client.post("/engine/v1/compute", json=payload)
    assert res.status_code == 200
    assert math.isfinite(res.json()["results"]["fmv_per_share"])


# ── the DLOM models, which the volatility reaches by a second road ────────────
#
# `d1_d2` above is not the only place a caller-supplied sigma is squared. The
# four option-based DLOM models take (σ, T) directly, and three of them compute
# σ²T themselves rather than through Black-Scholes — so the guard `d1_d2` grew
# for exactly this input covered `chaffee` (which goes through `bs_put`) and
# none of the other three.
#
# Past sigma ≈ 1.3e154 the product saturates to `inf`, and each closed form then
# evaluates `inf · e^{−inf}` — a NaN, which survives the `_MAX_DLOM` clamp
# because every comparison against it is False. `compute._check_discount_range`
# does stop it, so this was never a NaN in a report; what it could not do is say
# what went wrong. It answers "dloc/dlom must be fractions in [0, 1)", naming a
# discount that on a model method is the *output* these functions were asked to
# produce, and pointing the caller away from the volatility they mistyped.


def test_the_three_model_dloms_refuse_the_volatility_chaffee_already_refused():
    """One payload, four methods, and it used to matter which one you picked."""
    with pytest.raises(EngineInputError) as chaffee:
        chaffee_dlom(VOL_VARIANCE_OVERFLOW, 3.0, 0.04)
    assert "volatility" in str(chaffee.value)

    for fn in (finnerty_dlom, ghaidarov_dlom, longstaff_dlom, longstaff_bound):
        with pytest.raises(EngineInputError) as err:
            fn(VOL_VARIANCE_OVERFLOW, 3.0)
        assert "volatility" in str(err.value), fn.__name__


def test_the_horizon_reaches_the_same_product_and_is_named_with_it():
    """σ²T overflows from either side, and `exit_timeline` is the other one."""
    with pytest.raises(EngineInputError) as err:
        finnerty_dlom(0.6, math.inf)
    assert "time to exit" in str(err.value)


def test_compute_blames_the_volatility_rather_than_the_discount_it_derived():
    """End to end, on an allocation that does not itself need a volatility.

    `cvm` is the point: with `opm` the same payload is refused by `bs_call`
    first, so the DLOM's own guard is never reached and a test through the
    default allocation would pass without exercising it.
    """
    payload = {
        "params": {
            "weight_asset": 1.0,
            "weight_opm": 0.0,
            "weight_income": 0.0,
            "weight_market": 0.0,
            "allocation_method": "cvm",
            "dlom_method": "finnerty",
            "dloc": 0.0,
        },
        "inputs": {
            "shares_outstanding_common": 1_000_000,
            "last_round_post_money": 10_000_000,
            "volatility": VOL_VARIANCE_OVERFLOW,
            "asset": {"total_assets": 10_000_000, "total_liabilities": 2_000_000},
        },
    }
    pre = client.post("/engine/v1/validate", json=payload)
    assert pre.status_code == 200
    assert pre.json()["ok"] is True

    res = client.post("/engine/v1/compute", json=payload)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "volatility" in detail
    # The message `_check_discount_range` used to answer with, which names a
    # field the caller never supplied.
    assert "dloc/dlom must be fractions" not in detail


@pytest.mark.parametrize("method", ["finnerty", "ghaidarov", "longstaff"])
def test_the_same_payload_with_a_sane_volatility_still_concludes(method):
    payload = {
        "params": {
            "weight_asset": 1.0,
            "weight_opm": 0.0,
            "weight_income": 0.0,
            "weight_market": 0.0,
            "allocation_method": "cvm",
            "dlom_method": method,
            "dloc": 0.0,
        },
        "inputs": {
            "shares_outstanding_common": 1_000_000,
            "last_round_post_money": 10_000_000,
            "volatility": 0.6,
            "asset": {"total_assets": 10_000_000, "total_liabilities": 2_000_000},
        },
    }
    res = client.post("/engine/v1/compute", json=payload)
    assert res.status_code == 200, res.text
    assert math.isfinite(res.json()["results"]["fmv_per_share"])


def test_ordinary_and_merely_large_volatilities_are_untouched():
    """Pinned to the full double: the healthy path is the same arithmetic it
    always was, and a volatility far outside the plausible band is still a
    *number* — the band is a warning, so a large-but-representable sigma must
    keep producing a discount rather than being swept up by the guard."""
    assert finnerty_dlom(0.6, 2.0) == 0.18200209692882635
    assert ghaidarov_dlom(0.6, 2.0) == 0.19927352958814804
    assert longstaff_bound(0.6, 2.0) == 0.8771578490474592
    for fn in (finnerty_dlom, ghaidarov_dlom, longstaff_dlom):
        assert math.isfinite(fn(1e150, 3.0)), fn.__name__
