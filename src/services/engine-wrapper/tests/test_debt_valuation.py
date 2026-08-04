"""Debt / credit instrument valuation unit tests (feature: Debt Valuation Engine)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.debt_valuation import (
    MAX_TREE_STEPS,
    MIN_TREE_STEPS,
    convertible_note,
    coupon_schedule,
    credit_spread_valuation,
    duration_convexity,
    present_value,
    rating_implied_spread,
    safe_conversion,
    term_loan_fair_value,
    value_instrument,
    yield_dcf,
    yield_to_maturity,
)


# ── Schedules ────────────────────────────────────────────────────────────────


def test_bullet_schedule_pays_face_at_maturity():
    rows = coupon_schedule(face=1000, coupon_rate=0.06, frequency=2, maturity_years=3)
    assert len(rows) == 6
    assert all(r["principal"] == 0 for r in rows[:-1])
    assert rows[-1]["principal"] == pytest.approx(1000)
    assert rows[0]["interest"] == pytest.approx(30.0)  # 1000 * 6% / 2


def test_amortizing_schedule_declines_balance_and_interest():
    rows = coupon_schedule(face=1000, coupon_rate=0.06, frequency=2, maturity_years=3, amortizing=True)
    assert rows[-1]["balance"] == pytest.approx(0.0)
    assert sum(r["principal"] for r in rows) == pytest.approx(1000)
    assert rows[1]["interest"] < rows[0]["interest"]  # interest on a shrinking balance


# ── Pricing ──────────────────────────────────────────────────────────────────


def test_par_bond_prices_at_par_when_yield_equals_coupon():
    v = yield_dcf(face=1000, coupon_rate=0.05, frequency=2, maturity_years=5, market_yield=0.05)
    assert v["dirty_price"] == pytest.approx(1000, abs=1e-3)
    assert v["clean_price"] == pytest.approx(1000, abs=1e-3)


def test_bond_below_par_when_yield_above_coupon():
    v = yield_dcf(face=1000, coupon_rate=0.05, frequency=2, maturity_years=5, market_yield=0.08)
    assert v["dirty_price"] < 1000


def test_accrued_interest_between_coupons():
    v = yield_dcf(face=1000, coupon_rate=0.06, frequency=2, maturity_years=5, market_yield=0.06, settlement_fraction=0.5)
    # Half a period into a $30 coupon → ~$15 accrued.
    assert v["accrued_interest"] == pytest.approx(15.0, abs=1e-6)
    assert v["dirty_price"] == pytest.approx(v["clean_price"] + v["accrued_interest"], abs=1e-6)


def test_present_value_matches_manual_discount():
    pv = present_value([{"amount": 105, "t_years": 1.0}], 0.05, frequency=1)
    assert pv == pytest.approx(100.0)


# ── YTM ──────────────────────────────────────────────────────────────────────


def test_ytm_inverts_pricing():
    price = yield_dcf(face=1000, coupon_rate=0.05, frequency=2, maturity_years=7, market_yield=0.065)["dirty_price"]
    ytm = yield_to_maturity(price=price, face=1000, coupon_rate=0.05, frequency=2, maturity_years=7)
    assert ytm == pytest.approx(0.065, abs=1e-4)


# ── Duration / convexity ─────────────────────────────────────────────────────


def test_duration_and_convexity_are_positive_and_ordered():
    d = duration_convexity(face=1000, coupon_rate=0.05, frequency=2, maturity_years=10, market_yield=0.05)
    assert 0 < d["modified_duration"] < d["macaulay_duration"] * 1.01
    assert d["macaulay_duration"] > 7  # a 10y 5% bond ~ 7-8y duration
    assert d["convexity"] > 0


# ── Credit spread + rating ───────────────────────────────────────────────────


def test_rating_spread_map_is_monotone():
    assert rating_implied_spread("AAA") < rating_implied_spread("BBB") < rating_implied_spread("B")


def test_credit_spread_valuation_uses_rating_when_no_spread():
    v = credit_spread_valuation(
        face=1000, coupon_rate=0.05, frequency=2, maturity_years=5, benchmark_yield=0.03, rating="BB"
    )
    assert v["all_in_yield"] == pytest.approx(0.03 + rating_implied_spread("BB"))
    assert v["fair_value"] > 0


def test_credit_spread_rejects_missing_inputs():
    with pytest.raises(EngineInputError):
        credit_spread_valuation(face=1000, coupon_rate=0.05, frequency=2, maturity_years=5, benchmark_yield=0.03)


# ── Term loan ────────────────────────────────────────────────────────────────


def test_amortizing_term_loan_worth_less_than_bullet_when_yield_above_coupon():
    amort = term_loan_fair_value(principal=1000, coupon_rate=0.05, frequency=4, maturity_years=5, market_yield=0.09)
    bullet = term_loan_fair_value(
        principal=1000, coupon_rate=0.05, frequency=4, maturity_years=5, market_yield=0.09, amortizing=False
    )
    assert amort["structure"] == "amortizing"
    # Earlier principal return means less exposure to the discount → closer to par.
    assert amort["fair_value"] > bullet["fair_value"]


# ── Convertible (Tsiveriotis-Fernandes) ──────────────────────────────────────


def test_convertible_is_worth_at_least_conversion_parity_and_debt_floor():
    v = convertible_note(
        face=1000,
        coupon_rate=0.04,
        frequency=2,
        maturity_years=5,
        conversion_ratio=20,  # converts into 20 shares
        stock_price=40,  # parity = 800
        volatility=0.4,
        risk_free_rate=0.03,
        credit_spread=0.02,
        steps=150,
    )
    assert v["fair_value"] >= v["parity"] - 1e-6
    assert v["fair_value"] >= v["straight_debt_value"] - 1e-6
    assert v["option_value"] >= 0


def test_convertible_deep_in_the_money_tracks_parity():
    v = convertible_note(
        face=1000,
        coupon_rate=0.04,
        frequency=2,
        maturity_years=3,
        conversion_ratio=20,
        stock_price=200,  # parity = 4000, far above redemption
        volatility=0.4,
        risk_free_rate=0.03,
        credit_spread=0.02,
        steps=150,
    )
    assert v["fair_value"] == pytest.approx(v["parity"], rel=0.05)


def test_convertible_with_no_conversion_right_prices_as_a_straight_bond():
    """The invariant that pins the tree's coupon schedule.

    With conversion_ratio = 0 the note can never convert, so the whole
    Tsiveriotis-Fernandes tree collapses to a bond discounted at r + spread and
    the answer is analytic. It was not matching: the coupon due at maturity was
    counted once inside the terminal redemption value and again on the last
    rollback step, so every coupon-bearing convertible was overpriced by a full
    coupon's present value — 2.2% of face here, and more as the coupon rises.
    A convertible that is worth more than its own contractual cash flows also
    reports a negative option value the moment conversion is out of the money.
    """
    import math

    face, coupon_rate, freq, years, rf, spread = 1000.0, 0.05, 2, 3.0, 0.04, 0.02
    risky = rf + spread
    coupon = face * coupon_rate / freq
    analytic = sum(
        coupon * math.exp(-risky * (k / freq)) for k in range(1, round(years * freq) + 1)
    ) + face * math.exp(-risky * years)

    for steps in (60, 150, 600):
        v = convertible_note(
            face=face,
            coupon_rate=coupon_rate,
            frequency=freq,
            maturity_years=years,
            conversion_ratio=0.0,
            stock_price=10.0,
            volatility=0.4,
            risk_free_rate=rf,
            credit_spread=spread,
            steps=steps,
        )
        assert v["fair_value"] == pytest.approx(analytic, rel=1e-4)
        # Nothing to convert into, so none of the value is optionality.
        assert v["option_value"] == pytest.approx(0.0, abs=1e-4)


@pytest.mark.parametrize(
    "coupon_rate,freq,years",
    [(0.0, 2, 3.0), (0.08, 4, 5.0), (0.06, 1, 7.0), (0.05, 12, 2.0), (0.04, 2, 0.5)],
)
def test_convertible_pays_exactly_the_contractual_coupons(coupon_rate, freq, years):
    """Every schedule shape, not just the one the double-count was found on.

    Monthly coupons and a half-year maturity are the two ends that a
    steps-per-coupon heuristic gets wrong: at frequency 12 several coupons can
    share a tree step, and at half a year there is exactly one coupon and it
    falls on maturity.
    """
    import math

    face, rf, spread = 1000.0, 0.03, 0.03
    risky = rf + spread
    coupon = face * coupon_rate / freq
    n_coupons = max(1, round(years * freq))
    analytic = sum(
        coupon * math.exp(-risky * (k / freq)) for k in range(1, n_coupons + 1)
    ) + face * math.exp(-risky * years)

    v = convertible_note(
        face=face,
        coupon_rate=coupon_rate,
        frequency=freq,
        maturity_years=years,
        conversion_ratio=0.0,
        stock_price=10.0,
        volatility=0.35,
        risk_free_rate=rf,
        credit_spread=spread,
        steps=600,
    )
    assert v["fair_value"] == pytest.approx(analytic, rel=1e-3)


def test_convertible_coupon_stream_is_worth_its_present_value():
    """Raising the coupon adds exactly the PV of the extra coupons, no more.

    Stated as a difference, this isolates the coupon leg from the bond floor
    and from any conversion value, and it is the form the double-count broke
    most visibly: an extra coupon at maturity was worth a whole undiscounted
    coupon more than it should have been.
    """
    import math

    face, freq, years, rf, spread = 1000.0, 2, 4.0, 0.03, 0.02
    risky = rf + spread
    base = dict(
        face=face,
        frequency=freq,
        maturity_years=years,
        conversion_ratio=0.0,
        stock_price=10.0,
        volatility=0.3,
        risk_free_rate=rf,
        credit_spread=spread,
        steps=800,
    )
    zero = convertible_note(coupon_rate=0.0, **base)["fair_value"]
    paying = convertible_note(coupon_rate=0.06, **base)["fair_value"]

    coupon = face * 0.06 / freq
    expected = sum(coupon * math.exp(-risky * (k / freq)) for k in range(1, round(years * freq) + 1))
    assert paying - zero == pytest.approx(expected, rel=1e-3)


def test_higher_credit_spread_lowers_a_debt_like_convertible():
    base = dict(
        face=1000, coupon_rate=0.04, frequency=2, maturity_years=5,
        conversion_ratio=10, stock_price=40, volatility=0.3, risk_free_rate=0.03, steps=150,
    )
    tight = convertible_note(**base, credit_spread=0.01)
    wide = convertible_note(**base, credit_spread=0.06)
    assert wide["fair_value"] < tight["fair_value"]


# ── SAFE ─────────────────────────────────────────────────────────────────────


def test_safe_converts_at_the_cap_when_cap_binds():
    r = safe_conversion(
        investment=100_000,
        valuation_cap=5_000_000,
        discount=0.20,
        next_round_pre_money=20_000_000,
        next_round_shares=10_000_000,
    )
    # Round price = 2.00; discount price = 1.60; cap price = 0.50 → cap binds.
    assert r["conversion_price"] == pytest.approx(0.50)
    assert r["converted_via"] == "cap"
    assert r["shares_received"] == pytest.approx(200_000)
    assert r["fair_value"] == pytest.approx(400_000)  # 200k shares × $2


def test_safe_converts_at_discount_when_no_cap():
    r = safe_conversion(
        investment=100_000,
        valuation_cap=None,
        discount=0.20,
        next_round_pre_money=20_000_000,
        next_round_shares=10_000_000,
    )
    assert r["conversion_price"] == pytest.approx(1.60)
    assert r["converted_via"] == "discount"


def test_safe_mfn_adopts_better_discount():
    base = dict(investment=100_000, valuation_cap=None, next_round_pre_money=20_000_000, next_round_shares=10_000_000)
    plain = safe_conversion(discount=0.10, **base)
    mfn = safe_conversion(discount=0.10, mfn_discount=0.30, **base)
    assert mfn["conversion_price"] < plain["conversion_price"]


# ── Dispatcher ───────────────────────────────────────────────────────────────


def test_value_instrument_dispatches_and_bond_includes_duration():
    v = value_instrument(
        "bond",
        {"face": 1000, "coupon_rate": 0.05, "frequency": 2, "maturity_years": 5, "market_yield": 0.05},
    )
    assert "modified_duration" in v and "convexity" in v
    assert v["dirty_price"] == pytest.approx(1000, abs=1e-3)


def test_value_instrument_rejects_unknown_type():
    with pytest.raises(EngineInputError):
        value_instrument("mortgage", {})


# ── Schedule size bounds ─────────────────────────────────────────────────────


def test_coupon_frequency_is_capped_at_daily():
    # `n_periods = maturity_years × frequency` drove every schedule and neither
    # factor was bounded: frequency=100000 over 50 years is ~150 bytes of JSON
    # asking for five million cash-flow rows.
    with pytest.raises(EngineInputError) as exc:
        coupon_schedule(face=1000, coupon_rate=0.05, frequency=100_000, maturity_years=50)
    assert "366" in str(exc.value)


def test_maturity_is_capped_at_a_century():
    with pytest.raises(EngineInputError) as exc:
        coupon_schedule(face=1000, coupon_rate=0.05, frequency=12, maturity_years=1_000_000)
    assert "maturity_years" in str(exc.value)


def test_the_longest_real_instrument_still_builds():
    # A hundred-year daily-pay note is the worst honest case: it must still work.
    rows = coupon_schedule(face=1000, coupon_rate=0.05, frequency=366, maturity_years=100)
    assert len(rows) == 36_600


def test_non_numeric_frequency_is_an_input_error_not_a_crash():
    # `int("weekly")` raises ValueError, which the route does not map to a 422.
    with pytest.raises(EngineInputError):
        coupon_schedule(face=1000, coupon_rate=0.05, frequency="weekly", maturity_years=5)
    with pytest.raises(EngineInputError):
        duration_convexity(
            face=1000, coupon_rate=0.05, frequency="weekly", maturity_years=5, market_yield=0.05
        )


def test_convertible_tree_bounds_its_coupon_schedule_too():
    # The tree's `n_coupons = maturity_years × frequency` loop had the same gap.
    with pytest.raises(EngineInputError):
        convertible_note(
            face=1000,
            coupon_rate=0.05,
            frequency=500_000,
            maturity_years=30,
            conversion_ratio=10,
            stock_price=50,
            volatility=0.5,
            risk_free_rate=0.04,
            credit_spread=0.03,
        )


def test_oversized_debt_request_answers_422_over_http():
    from fastapi.testclient import TestClient

    from app.main import app

    res = TestClient(app).post(
        "/engine/v1/debt-valuation",
        json={
            "instrument_type": "bond",
            "params": {
                "face": 1000,
                "coupon_rate": 0.05,
                "frequency": 1_000_000,
                "maturity_years": 90,
                "market_yield": 0.05,
            },
        },
    )
    assert res.status_code == 422


# ── Integer coercion on a free-form params dict ──────────────────────────────
#
# `/engine/v1/debt-valuation` splats `params` into these functions, so anything
# JSON can carry reaches the `int()` calls behind `frequency` and `steps`. Only
# TypeError was handled there; ValueError ("abc", nan) and OverflowError (inf,
# which is what `json.loads("1e400")` produces) escaped as neither an
# EngineInputError nor one of the (KeyError, TypeError) the route maps, so a bad
# input answered 500 with a logged traceback instead of a 422 naming the field.

CONVERTIBLE_BASE = {
    "face": 1000,
    "coupon_rate": 0.05,
    "frequency": 2,
    "maturity_years": 3,
    "conversion_ratio": 10,
    "stock_price": 50,
    "volatility": 0.4,
    "risk_free_rate": 0.04,
    "credit_spread": 0.02,
}


@pytest.mark.parametrize("steps", ["abc", float("inf"), float("nan"), [], {}, "1.5x"])
def test_unparseable_tree_steps_is_an_input_error(steps):
    with pytest.raises(EngineInputError, match="steps must be an integer"):
        convertible_note(**CONVERTIBLE_BASE, steps=steps)


@pytest.mark.parametrize("frequency", ["abc", float("inf"), float("nan"), []])
def test_unparseable_frequency_is_an_input_error(frequency):
    with pytest.raises(EngineInputError, match="frequency must be an integer"):
        coupon_schedule(face=1000, coupon_rate=0.05, frequency=frequency, maturity_years=3)


def test_tree_steps_still_accept_the_lenient_forms_they_always_did():
    """Numeric strings and floats truncate, as `int()` has always done here."""
    for steps in (400, 400.9, "400"):
        assert convertible_note(**CONVERTIBLE_BASE, steps=steps)["fair_value"] > 0


def test_tree_steps_are_clamped_to_the_usable_range():
    """Out-of-range steps clamp rather than raise — the bound is on our work."""
    coarse = convertible_note(**CONVERTIBLE_BASE, steps=-5)
    floored = convertible_note(**CONVERTIBLE_BASE, steps=MIN_TREE_STEPS)
    assert coarse == floored
    huge = convertible_note(**CONVERTIBLE_BASE, steps=10**9)
    capped = convertible_note(**CONVERTIBLE_BASE, steps=MAX_TREE_STEPS)
    assert huge == capped


@pytest.mark.parametrize(
    "overrides",
    [
        '"steps": "abc"',
        # `1e400` is a JSON number the parser hands back as `inf`, and
        # `int(inf)` is an OverflowError. Written into the body as raw text
        # because a JSON *encoder* refuses to emit `inf` — only a decoder
        # produces one, which is exactly how the service meets it.
        '"steps": 1e400',
        '"frequency": "quarterly"',
    ],
)
def test_unparseable_integers_answer_422_over_http(overrides):
    import json

    from fastapi.testclient import TestClient

    from app.main import app

    base = ", ".join(f'"{k}": {json.dumps(v)}' for k, v in CONVERTIBLE_BASE.items())
    body = f'{{"instrument_type": "convertible", "params": {{{base}, {overrides}}}}}'
    res = TestClient(app, raise_server_exceptions=False).post(
        "/engine/v1/debt-valuation",
        content=body,
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 422
    assert "must be an integer" in res.json()["detail"]


# ── overflow: a finite input whose arithmetic has no answer ──────────────────
#
# Three operations in this module raise OverflowError rather than saturating to
# `inf`, and none of them was caught: the route maps EngineInputError, KeyError
# and TypeError to 422 and lets everything else out as a 500. Every input below
# is finite and passes every range check the module applies.


def _debt_post(instrument_type: str, params: dict):
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app, raise_server_exceptions=False).post(
        "/engine/v1/debt-valuation",
        json={"instrument_type": instrument_type, "params": params},
    )


def test_a_volatility_that_overflows_the_tree_is_named_before_it_is_built():
    """`u**j` on a 200-step tree, where u = e^{σ√dt}. A volatility of 100 is a
    mistyped 10,000%, and the engine caps volatility nowhere — the band is a
    warning, not a limit — so this arrives as an ordinary convertible."""
    with pytest.raises(EngineInputError) as err:
        convertible_note(**{**CONVERTIBLE_BASE, "volatility": 100.0})
    detail = str(err.value)
    assert "binomial tree" in detail
    assert "volatility" in detail


def test_the_lattice_guard_leaves_a_high_but_workable_volatility_alone():
    """The ceiling is the double's exponent range, not a view on volatility. A
    150% vol is ordinary for an early-stage note and must still price."""
    out = convertible_note(**{**CONVERTIBLE_BASE, "volatility": 1.5})
    assert out["fair_value"] > 0
    assert out["fair_value"] >= out["parity"]


@pytest.mark.parametrize(
    ("instrument", "overrides"),
    [
        # math.exp(-r·dt) — the risk-free discount factor.
        pytest.param("convertible", {"risk_free_rate": -1e6}, id="convertible-rate-underflows"),
        # math.exp((r − q)·dt) — the risk-neutral drift.
        pytest.param("convertible", {"risk_free_rate": 1e6}, id="convertible-rate-overflows"),
        # (1 + y/m)^(m·t) — the DCF discount factor.
        pytest.param("term_loan", {"market_yield": 1e9}, id="term-loan-yield-overflows"),
    ],
)
def test_an_overflowing_rate_answers_422_where_it_used_to_answer_500(instrument, overrides):
    base = (
        CONVERTIBLE_BASE
        if instrument == "convertible"
        else {
            "principal": 1_000_000,
            "coupon_rate": 0.07,
            "frequency": 12,
            "maturity_years": 5.0,
            "market_yield": 0.08,
        }
    )
    res = _debt_post(instrument, {**base, **overrides})
    assert res.status_code == 422, res.text
    assert "overflow" in res.json()["detail"].lower()


def test_the_overflow_backstop_names_the_instrument():
    with pytest.raises(EngineInputError, match="term_loan"):
        value_instrument(
            "term_loan",
            {
                "principal": 1_000_000,
                "coupon_rate": 0.07,
                "frequency": 12,
                "maturity_years": 5.0,
                "market_yield": 1e9,
            },
        )


def test_the_backstop_does_not_swallow_an_ordinary_valuation():
    """Guarding the dispatcher must not change what a good request returns."""
    assert value_instrument("convertible", dict(CONVERTIBLE_BASE)) == convertible_note(
        **CONVERTIBLE_BASE
    )
