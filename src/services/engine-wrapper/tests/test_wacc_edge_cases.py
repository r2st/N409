"""Boundaries of the cost-of-capital build-up.

`test_wacc.py` pins the ordinary path: a handful of comparables, a plausible
capital structure, a WACC between zero and one. This file covers the inputs
that arrive when something upstream is wrong — a mistyped tax rate, a NaN that
survived a JSON round-trip, a market cap sitting exactly on a tier boundary —
because the discount rate is multiplied through every later year of the DCF,
and a cost of capital that is quietly wrong is worse than one that fails.
"""

import math
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.wacc import (
    DEFAULT_TREASURY_CURVE,
    compute_wacc,
    relever_beta,
    risk_free_rate,
    size_premium,
    unlever_beta,
)
from app.main import app

client = TestClient(app)

# Annotated loosely so the override-and-splat pattern below does not confuse a
# type checker about each keyword's declared type.
BASE: dict[str, Any] = {
    "unlevered_beta_input": 1.0,
    "risk_free_rate_override": 0.04,
    "equity_risk_premium": 0.05,
}


# ── Hamada levering ───────────────────────────────────────────────────────────


def test_hamada_rejects_negative_leverage_both_ways():
    # Negative D/E is not a capital structure; it used to be caught on the way
    # down but not on the way back up.
    with pytest.raises(EngineInputError, match="debt_to_equity"):
        unlever_beta(1.2, -0.5, 0.21)
    with pytest.raises(EngineInputError, match="debt_to_equity"):
        relever_beta(1.2, -0.5, 0.21)


def test_a_tax_rate_above_one_cannot_divide_the_beta_by_zero():
    # 1 + (1 − 2.0)·1.0 == 0. Unguarded this is a ZeroDivisionError surfacing
    # as a 500 rather than a message naming the input that caused it.
    with pytest.raises(EngineInputError, match="Hamada"):
        unlever_beta(1.2, 1.0, 2.0)


def test_a_tax_rate_above_one_cannot_flip_the_sign_of_the_beta():
    # 1 + (1 − 1.5)·3.0 == −0.5. This one is worse than the divide-by-zero: it
    # returns a *negative* beta, and a negative beta builds a cost of equity
    # below the risk-free rate without anything looking wrong.
    with pytest.raises(EngineInputError, match="Hamada"):
        unlever_beta(1.2, 3.0, 1.5)


def test_a_tax_rate_of_exactly_one_is_still_a_valid_factor():
    # (1 − 1.0)·D/E == 0, so the factor is exactly 1 — degenerate but sound,
    # and the guard must not reject it. It is the boundary the guard sits on.
    assert unlever_beta(1.2, 2.0, 1.0) == pytest.approx(1.2)


def test_a_comparables_own_tax_rate_is_held_to_the_same_band_as_the_subjects():
    # A comparable's rate feeds the same Hamada factor the subject's does, so
    # it is refused by the same [0, 1) band — before the factor, not by it.
    comps = [{"ticker": "A", "beta": 1.2, "debt_to_equity": 1.0, "tax_rate": 2.0}]
    with pytest.raises(EngineInputError, match=r"comparable\.tax_rate must be in \[0, 1\)"):
        compute_wacc(
            comparable_betas=comps,
            risk_free_rate_override=0.04,
            equity_risk_premium=0.05,
        )


def test_an_impossible_comparable_rate_the_hamada_guard_cannot_see_is_refused():
    # The Hamada guard only fires where the factor lands at or below zero. Pair
    # a tax rate above 1 with a small enough D/E and it stays positive:
    # 1 + (1 − 2.0)·0.5 == 0.5. The comp's beta is then *divided* by a half,
    # and the build-up returned an unlevered beta of 2.4 where 0.86 was right
    # and a 16% cost of equity where 8.3% was — on a successful 200, with
    # nothing in the response to say the number was impossible.
    comps = [{"ticker": "A", "beta": 1.2, "debt_to_equity": 0.5, "tax_rate": 2.0}]
    with pytest.raises(EngineInputError, match=r"comparable\.tax_rate must be in \[0, 1\)"):
        compute_wacc(
            comparable_betas=comps,
            risk_free_rate_override=0.04,
            equity_risk_premium=0.05,
        )


def test_a_comparable_rate_of_exactly_one_is_out_of_band():
    # (1 − 1.0) zeroes the leverage adjustment entirely, so the comp is treated
    # as unlevered however much debt it carries. Sound as a limit, not as a
    # tax rate — and the subject's band excludes it, so this one does too.
    comps = [{"ticker": "A", "beta": 1.2, "debt_to_equity": 1.0, "tax_rate": 1.0}]
    with pytest.raises(EngineInputError, match=r"comparable\.tax_rate must be in \[0, 1\)"):
        compute_wacc(comparable_betas=comps, risk_free_rate_override=0.04)


def test_a_comparable_without_its_own_rate_still_inherits_the_subjects():
    # The band check must not disturb the default: no `tax_rate` on the comp
    # means the subject's rate, which is in band by construction.
    comps: list[dict[str, Any]] = [{"ticker": "A", "beta": 1.2, "debt_to_equity": 1.0}]
    out = compute_wacc(
        comparable_betas=comps,
        tax_rate=0.21,
        risk_free_rate_override=0.04,
        equity_risk_premium=0.05,
    )
    # βu = 1.2 / (1 + 0.79·1.0)
    assert out["capm"]["beta_unlevered"] == pytest.approx(1.2 / 1.79, abs=1e-4)


def test_an_in_band_comparable_rate_is_unaffected():
    comps: list[dict[str, Any]] = [
        {"ticker": "A", "beta": 1.2, "debt_to_equity": 0.5, "tax_rate": 0.21}
    ]
    out = compute_wacc(
        comparable_betas=comps,
        risk_free_rate_override=0.04,
        equity_risk_premium=0.05,
    )
    assert out["capm"]["beta_unlevered"] == pytest.approx(1.2 / (1 + 0.79 * 0.5), abs=1e-4)
    assert out["cost_of_equity"] == pytest.approx(0.083011, abs=1e-5)


# ── Non-finite inputs ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_inputs_are_refused_rather_than_propagated(bad):
    # A NaN compares false against every bound, so without an explicit check it
    # passes each one and comes back out as the WACC.
    with pytest.raises(EngineInputError, match="finite"):
        compute_wacc(**{**BASE, "unlevered_beta_input": bad})


@pytest.mark.parametrize("field", ["equity_risk_premium", "company_specific_premium", "cost_of_debt"])
def test_every_numeric_input_is_checked_for_finiteness(field):
    with pytest.raises(EngineInputError, match="finite"):
        compute_wacc(**{**BASE, field: float("nan")})


@pytest.mark.parametrize("bad", ["not a number", None, {}, [1.0]])
def test_a_value_that_is_not_a_number_is_named_in_the_error(bad: Any):
    # The message has to name the field: these arrive from a JSON body where
    # "which one?" is the only useful thing to say back.
    with pytest.raises(EngineInputError, match="equity_risk_premium must be a number"):
        compute_wacc(**{**BASE, "equity_risk_premium": bad})


@pytest.mark.parametrize("bad", ["nan", "inf", "-inf"])
def test_the_endpoint_refuses_a_non_finite_number_instead_of_returning_a_null_wacc(bad):
    # JSON has no NaN literal, but float("nan") parses the *string*, so this
    # reaches the engine from a real payload. Before the guard it answered 200
    # with {"wacc": null} — a broken discount rate the caller is told nothing
    # about, which is the failure mode worth a regression test.
    r = client.post("/engine/v1/wacc", json={"inputs": {**BASE, "unlevered_beta_input": bad}})
    assert r.status_code == 422
    assert "finite" in r.json()["detail"]


def test_a_good_payload_still_returns_a_finite_wacc():
    r = client.post("/engine/v1/wacc", json={"inputs": BASE})
    assert r.status_code == 200
    body = r.json()
    assert math.isfinite(body["wacc"])
    assert body["wacc"] == pytest.approx(0.09)


# ── Tax rate and weights ──────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", [1.0, 1.5, -0.01])
def test_subject_tax_rate_is_held_to_the_zero_to_one_band(bad):
    with pytest.raises(EngineInputError):
        compute_wacc(**{**BASE, "tax_rate": bad})


def test_a_zero_tax_rate_is_allowed():
    out = compute_wacc(**{**BASE, "tax_rate": 0.0, "cost_of_debt": 0.08, "debt_weight": 0.5})
    # No shield: the after-tax cost of debt is the cost of debt.
    assert out["after_tax_cost_of_debt"] == pytest.approx(0.08)


@pytest.mark.parametrize("bad", [-0.1, 1.1])
def test_debt_weight_outside_zero_to_one_is_refused(bad):
    with pytest.raises(EngineInputError, match="debt_weight"):
        compute_wacc(**{**BASE, "debt_weight": bad})


def test_an_all_debt_weighting_prices_only_the_debt():
    out = compute_wacc(**{**BASE, "debt_weight": 1.0, "cost_of_debt": 0.10, "tax_rate": 0.25})
    assert out["weights"] == {"equity": 0.0, "debt": 1.0}
    assert out["wacc"] == pytest.approx(0.075)  # 0.10 · (1 − 0.25)


def test_an_all_equity_weighting_ignores_the_cost_of_debt():
    out = compute_wacc(**{**BASE, "debt_weight": 0.0, "cost_of_debt": 0.99})
    assert out["wacc"] == pytest.approx(out["cost_of_equity"])


def test_an_explicit_debt_weight_overrides_the_one_implied_by_leverage():
    # D/E of 1.0 implies Wd = 0.5; the explicit weight has to win, or the
    # analyst's target structure is silently ignored.
    out = compute_wacc(**{**BASE, "target_debt_to_equity": 1.0, "debt_weight": 0.2})
    assert out["weights"]["debt"] == pytest.approx(0.2)


# ── Risk-free curve ───────────────────────────────────────────────────────────


def test_an_empty_treasury_curve_is_an_error_not_a_zero_rate():
    with pytest.raises(EngineInputError, match="curve"):
        risk_free_rate(5.0, {})


@pytest.mark.parametrize("bad", [0.0, -1.0])
def test_a_non_positive_maturity_is_refused(bad):
    with pytest.raises(EngineInputError, match="maturity_years"):
        risk_free_rate(bad)


def test_a_single_point_curve_clamps_in_both_directions():
    curve = {5.0: 0.042}
    assert risk_free_rate(0.5, curve) == pytest.approx(0.042)
    assert risk_free_rate(5.0, curve) == pytest.approx(0.042)
    assert risk_free_rate(30.0, curve) == pytest.approx(0.042)


def test_interpolation_is_linear_between_two_points():
    curve = {1.0: 0.04, 3.0: 0.05}
    assert risk_free_rate(1.0, curve) == pytest.approx(0.04)
    assert risk_free_rate(2.0, curve) == pytest.approx(0.045)
    assert risk_free_rate(3.0, curve) == pytest.approx(0.05)


def test_the_default_curve_is_covered_end_to_end_without_a_gap():
    # Every maturity between the endpoints has to yield a rate inside the
    # curve's own range — a hole would show up as a wild discount rate for one
    # particular forecast horizon.
    lo, hi = min(DEFAULT_TREASURY_CURVE), max(DEFAULT_TREASURY_CURVE)
    floor, ceiling = min(DEFAULT_TREASURY_CURVE.values()), max(DEFAULT_TREASURY_CURVE.values())
    steps = 50
    for i in range(steps + 1):
        years = lo + (hi - lo) * i / steps
        assert floor <= risk_free_rate(years) <= ceiling


# ── Size premium ──────────────────────────────────────────────────────────────


def test_a_cap_on_a_tier_boundary_belongs_to_the_upper_tier():
    # Tiers are [lo, hi), so $250M is small-cap, not micro. Worth pinning: the
    # two tiers differ by 200bp of discount rate.
    assert size_premium(2.5e8)[0] == 0.0350
    assert size_premium(2.5e8 - 1)[0] == 0.0550


def test_a_company_worth_nothing_still_lands_in_the_smallest_tier():
    premium, tier = size_premium(0.0)
    assert premium == 0.0550
    assert tier.startswith("[0,")


def test_a_negative_market_cap_is_refused():
    with pytest.raises(EngineInputError, match="market_cap"):
        size_premium(-1.0)


def test_a_cap_outside_every_supplied_tier_takes_no_premium():
    # Rather than raising: a custom tier table that does not reach the subject
    # means "no size adjustment", which is the conservative reading.
    assert size_premium(5.0, tiers=[(0.0, 1.0, 0.9)]) == (0.0, "large")


# ── Comparable betas ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", [[], "AAPL", [1.2]])
def test_a_comparable_set_that_is_not_a_list_of_objects_is_refused(bad: Any):
    with pytest.raises(EngineInputError):
        compute_wacc(
            comparable_betas=bad,
            risk_free_rate_override=0.04,
            equity_risk_premium=0.05,
        )


def test_an_even_number_of_comparables_averages_the_middle_two():
    # statistics.median, not "the lower middle" — with four comps the answer
    # is between the second and third unlevered betas.
    comps = [
        {"ticker": "A", "beta": 1.0},
        {"ticker": "B", "beta": 1.2},
        {"ticker": "C", "beta": 1.4},
        {"ticker": "D", "beta": 9.9},  # the mis-estimated comp the median exists to survive
    ]
    out = compute_wacc(comparable_betas=comps, risk_free_rate_override=0.04, equity_risk_premium=0.05)
    assert out["capm"]["beta_unlevered"] == pytest.approx(1.3)


def test_a_comparable_without_leverage_is_taken_as_unlevered():
    out = compute_wacc(
        comparable_betas=[{"ticker": "A", "beta": 1.4}],
        risk_free_rate_override=0.04,
        equity_risk_premium=0.05,
    )
    assert out["capm"]["beta_unlevered"] == pytest.approx(1.4)
    assert out["comparables"][0]["debt_to_equity"] == 0.0


def test_a_comparable_is_unlevered_at_its_own_tax_rate():
    # Comps are frequently in other jurisdictions; using the subject's rate for
    # all of them is the mistake this override exists to prevent.
    subject_rate = 0.21
    comps = [{"ticker": "A", "beta": 1.5, "debt_to_equity": 1.0, "tax_rate": 0.40}]
    out = compute_wacc(
        comparable_betas=comps,
        tax_rate=subject_rate,
        risk_free_rate_override=0.04,
        equity_risk_premium=0.05,
    )
    assert out["capm"]["beta_unlevered"] == pytest.approx(1.5 / (1 + 0.60 * 1.0), abs=1e-4)


def test_an_unnamed_comparable_still_gets_a_label():
    out = compute_wacc(
        comparable_betas=[{"beta": 1.1}, {"beta": 1.3}],
        risk_free_rate_override=0.04,
        equity_risk_premium=0.05,
    )
    tickers = [c["ticker"] for c in out["comparables"]]
    assert tickers == ["comp1", "comp2"]


# ── Structure of the build-up ─────────────────────────────────────────────────


def test_a_beta_source_is_required():
    with pytest.raises(EngineInputError, match="comparable_betas or unlevered_beta_input"):
        compute_wacc(target_debt_to_equity=0.0)


def test_an_explicit_unlevered_beta_wins_over_a_comparable_set():
    # Both supplied is an analyst overriding the comps; the override has to
    # take effect, and the comparables table is then empty rather than
    # reporting figures that did not feed the answer.
    out = compute_wacc(
        unlevered_beta_input=2.0,
        comparable_betas=[{"ticker": "A", "beta": 1.0}],
        risk_free_rate_override=0.04,
        equity_risk_premium=0.05,
    )
    assert out["capm"]["beta_unlevered"] == pytest.approx(2.0)
    assert out["comparables"] == []


def test_a_size_premium_override_replaces_the_tier_lookup():
    out = compute_wacc(**{**BASE, "market_cap": 1e8, "size_premium_override": 0.0125})
    assert out["capm"]["size_premium"] == pytest.approx(0.0125)
    assert out["capm"]["size_tier"] == "override"


def test_without_a_market_cap_no_size_premium_is_invented():
    out = compute_wacc(**BASE)
    assert out["capm"]["size_premium"] == 0.0
    assert out["capm"]["size_tier"] == "n/a"


def test_each_premium_adds_to_the_cost_of_equity_one_for_one():
    # The build-up is additive by construction; if a term were ever folded in
    # multiplicatively this is what would catch it.
    plain = compute_wacc(**BASE)["cost_of_equity"]
    with_csrp = compute_wacc(**{**BASE, "company_specific_premium": 0.03})["cost_of_equity"]
    assert with_csrp - plain == pytest.approx(0.03)


def test_wacc_rises_with_the_company_specific_premium():
    rates = [
        compute_wacc(**{**BASE, "target_debt_to_equity": 0.5, "company_specific_premium": c})["wacc"]
        for c in (0.0, 0.02, 0.05, 0.10)
    ]
    assert rates == sorted(rates)
    assert len(set(rates)) == len(rates)


# ── Treasury curve over the wire ──────────────────────────────────────────────
#
# `treasury_curve` is typed `dict[float, float]`, and JSON object keys are
# always strings — so the shape the signature asks for is one no HTTP caller can
# send. Everything below is about the override being usable, and failing by name
# when it is not.


def test_a_curve_posted_as_json_has_string_maturities_and_still_works():
    # The exact body a client sends: {"5": 0.041} — not {5.0: 0.041}. This used
    # to compare a float to a str inside the interpolation and raise a bare
    # TypeError, which /compute returned as a 500.
    curve = {"1": 0.04, "3": 0.05}
    assert risk_free_rate(1.0, curve) == pytest.approx(0.04)
    assert risk_free_rate(2.0, curve) == pytest.approx(0.045)
    assert risk_free_rate(3.0, curve) == pytest.approx(0.05)


def test_string_maturities_sort_numerically_not_lexically():
    # Lexically "10" < "5", which put the endpoints in the wrong order and made
    # the clamps return the wrong end of the curve.
    curve = {"5": 0.041, "10": 0.045}
    assert risk_free_rate(1.0, curve) == pytest.approx(0.041)  # clamp to short end
    assert risk_free_rate(50.0, curve) == pytest.approx(0.045)  # clamp to long end
    assert risk_free_rate(7.5, curve) == pytest.approx(0.043)


@pytest.mark.parametrize("bad", [[], [(1.0, 0.04)], "1:0.04", 5.0])
def test_a_curve_that_is_not_an_object_is_refused_by_name(bad):
    # `[].items()` raised AttributeError before any guard ran — a 500 for a
    # malformed input. (`None` is the documented "use the default curve"
    # sentinel and is covered by the default-curve tests above.)
    with pytest.raises(EngineInputError, match="treasury_curve must be an object"):
        risk_free_rate(5.0, bad)


@pytest.mark.parametrize("bad", [{"abc": 0.04}, {"5": "high"}, {"5": float("nan")}, {"0": 0.04}, {"-1": 0.04}])
def test_a_curve_with_an_unusable_point_names_the_point(bad):
    with pytest.raises(EngineInputError, match="treasury_curve"):
        risk_free_rate(5.0, bad)


def test_duplicate_maturities_are_refused_rather_than_dividing_by_zero():
    # "5" and 5.0 collapse to the same maturity; interpolating strictly between
    # two points at 5.0 divides by (m1 - m0) == 0.
    with pytest.raises(EngineInputError, match="duplicate maturity"):
        risk_free_rate(5.0, {"5": 0.04, 5.0: 0.05})


def test_a_non_numeric_forecast_horizon_is_a_422_not_a_type_error():
    with pytest.raises(EngineInputError, match="maturity_years"):
        risk_free_rate("five years")


def test_the_wacc_endpoint_accepts_a_json_curve():
    res = client.post(
        "/engine/v1/wacc",
        json={
            "inputs": {
                "unlevered_beta_input": 1.0,
                "equity_risk_premium": 0.05,
                "treasury_curve": {"1": 0.04, "10": 0.05},
                "forecast_horizon_years": 5.5,
            }
        },
    )
    assert res.status_code == 200, res.json()
    # 5.5y interpolates to 0.045 on a straight 1y→10y line.
    assert res.json()["capm"]["risk_free_rate"] == pytest.approx(0.045)


def test_the_wacc_endpoint_refuses_a_malformed_curve_with_422():
    res = client.post(
        "/engine/v1/wacc",
        json={"inputs": {"unlevered_beta_input": 1.0, "treasury_curve": []}},
    )
    assert res.status_code == 422
    assert "treasury_curve" in res.json()["detail"]
