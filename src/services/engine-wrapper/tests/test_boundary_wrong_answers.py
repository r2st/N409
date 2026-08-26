"""Boundary inputs the engine answered — with the wrong number.

The neighbouring boundary suites cover the two failure modes that announce
themselves. `test_overflow_guards.py` covers finite inputs whose *arithmetic*
leaves the doubles, where the result is `inf` or NaN and something eventually
raises. `test_nonfinite_guards.py` covers a NaN arriving on the request.
`test_boundary_inputs.py` pins behaviour exactly on the guards that exist.

This file is the third case, and it is the one a reviewer cannot spot: an input
on a boundary that produced a *finite, plausible, well-formed* answer that is
simply not the right one. Nothing overflows, nothing raises, the pre-flight
validator says `ok: true`, and the response is a 200 carrying a concluded FMV
per share a board is asked to adopt.

Four of them, in three families:

* **A weight that is not a weight.** Four approach weights summing to 1.0 is
  not the same claim as four weights each in [0, 1]. `{income: 1.5, market:
  -0.5}` satisfies the sum and is not a weighting.
* **A growth rate below −100%.** `(1 + g)` goes negative, so the thing being
  compounded flips sign every period. Both the explicit forecast and the
  perpetuity had this hole, and they express it differently: the projection
  alternates the sign of revenue, the Gordon perpetuity turns a positive cash
  flow into a negative terminal value.
* **A multiple struck on zero.** A pre-revenue target is `revenue: 0`, not a
  missing revenue, and 11.3x $0 is $0 — returned in the field a real indicated
  enterprise value arrives in.

Each test states the wrong answer the engine used to give, so the fix is
falsifiable: revert the guard and the recorded figure is what comes back.
"""

from __future__ import annotations

import pytest

from app.engine.approaches import income_dcf
from app.engine.comparables import comparable_analysis, score_company
from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.market_universe import resolve_universe
from app.engine.projection import project_financials, terminal_value_gordon
from app.engine.sensitivity import sensitivity
from app.engine.validate import split_issues, validate_payload

# The reference payload the fixtures below perturb: an income + market
# valuation over an ordinary cap table.
INPUTS = {
    "shares_outstanding_common": 8e6,
    "options_outstanding": 2e6,
    "shares_outstanding_preferred": 4e6,
    "liquidation_preference": 1e7,
    "volatility": 0.6,
    "income": {
        "free_cash_flows": [1e6, 2e6, 3e6, 4e6, 5e6],
        "discount_rate": 0.20,
        "terminal_growth": 0.03,
    },
    "market": {"multiples": [8.0], "metric": 5e6},
}


def _params(**over) -> dict:
    return {
        "weight_asset": 0.0,
        "weight_opm": 0.0,
        "weight_income": 1.0,
        "weight_market": 0.0,
        "dlom": 0.2,
        **over,
    }


# ── a weight that is not a weight ────────────────────────────────────────────


def test_approach_weights_summing_to_one_must_also_each_be_in_range():
    """`{income: 1.5, market: -0.5}` sums to 1.0 and is not a weighting.

    The sum check was the only one `compute` applied, and the weighted total a
    few hundred lines below filters on `w > 0` — so the negative leg is dropped
    from the sum *and* its approach is never computed, leaving the positive legs
    at their inflated weights. The result is not a negative combination of two
    approaches; it is 1.5x the income approach alone, reported with a
    `weight_total` of 1.0 beside it.
    """
    honest = compute(_params(), INPUTS)["results"]
    assert honest["fmv_per_share"] == pytest.approx(0.7304)

    # Both legs are out of range — 1.5 as much as −0.5 — and the first one
    # reached is the one named.
    with pytest.raises(EngineInputError, match=r"weight_income must be between 0 and 1"):
        compute(_params(weight_income=1.5, weight_market=-0.5), INPUTS)
    with pytest.raises(EngineInputError, match=r"weight_market must be between 0 and 1"):
        compute(_params(weight_income=1.0, weight_market=-0.5, weight_asset=0.5), INPUTS)


def test_a_negative_weight_used_to_inflate_the_conclusion_fourfold():
    """The magnitude, so the guard is worth keeping.

    At `{income: 3.0, market: -2.0}` the engine returned $2.9498 a share against
    the $0.7304 the same inputs support — a 4x overstatement of the figure
    option strike prices are set from, on a successful 200.
    """
    for weights in (
        {"weight_income": 1.5, "weight_market": -0.5},
        {"weight_income": 3.0, "weight_market": -2.0},
        {"weight_asset": -1.0, "weight_income": 1.0, "weight_market": 1.0},
    ):
        assert abs(sum(_params(**weights)[k] for k in
                       ("weight_asset", "weight_opm", "weight_income", "weight_market")) - 1.0) < 1e-9
        with pytest.raises(EngineInputError, match=r"must be between 0 and 1"):
            compute(_params(**weights), INPUTS)


def test_sensitivity_is_the_path_that_had_no_other_guard():
    """`validate` always refused this; `/engine/v1/sensitivity` never runs it.

    The pre-flight validator has always reported an out-of-range weight as an
    error, so `/engine/v1/compute` was covered. `sensitivity` calls `compute`
    directly and deliberately — which is why the engine's own `_weights` had to
    hold the same rule rather than trusting the layer above it.
    """
    errors, _ = split_issues(
        validate_payload(_params(weight_income=1.5, weight_market=-0.5), INPUTS)
    )
    assert {e.code for e in errors} == {"out_of_range"}
    assert {e.field for e in errors} == {"params.weight_income", "params.weight_market"}

    assert sensitivity(_params(), INPUTS)["base"]["fmv_per_share"] == pytest.approx(0.7304)
    with pytest.raises(EngineInputError, match=r"must be between 0 and 1"):
        sensitivity(_params(weight_income=1.5, weight_market=-0.5), INPUTS)


def test_a_zero_weight_is_still_a_weight():
    """The boundary itself: 0 and 1 are both legal, and the guard is not `> 0`."""
    out = compute(_params(weight_income=0.0, weight_market=1.0), INPUTS)["results"]
    assert out["fmv_per_share"] > 0


# ── a growth rate below −100%: the explicit forecast ─────────────────────────


def test_revenue_growth_below_minus_one_alternated_the_sign_of_revenue():
    """`-1.5` made the forecast read −$500k, $250k, −$125k, $62.5k, −$31.25k.

    Every line derived from revenue inherited the alternation, so the odd years
    carried a *positive* EBITDA struck on negative revenue, and the resulting
    free cash flows went to the DCF with nothing marking them.
    """
    with pytest.raises(EngineInputError, match=r"revenue_growth must be >= -1"):
        project_financials(
            method="growth", years=5, base_revenue=1e6, revenue_growth=-1.5, cogs_pct=0.4
        )


def test_a_single_bad_year_in_a_growth_vector_is_named_by_index():
    """The per-year form has the same hole, and a five-year vector needs the year."""
    with pytest.raises(EngineInputError, match=r"revenue_growth\[1\] must be >= -1"):
        project_financials(
            method="growth", years=3, base_revenue=1e6, revenue_growth=[0.1, -2.0, 0.1]
        )


def test_minus_one_hundred_percent_exactly_is_a_wind_down_not_an_error():
    """The floor is inclusive: revenue goes to zero and stays there, monotonically.

    That is a thing a forecast means to say, and it is the same bound
    `comparables.comparable_analysis` (`minimum=-1.0`) and
    `intangibles.relief_from_royalty` already apply to their own growth rates.
    """
    out = project_financials(method="growth", years=3, base_revenue=1e6, revenue_growth=-1.0)
    assert [p["revenue"] for p in out["projections"]] == [0.0, 0.0, 0.0]


def test_a_steep_but_representable_decline_still_projects():
    """−99% is not −100%: the series decays towards zero and never crosses it."""
    out = project_financials(method="growth", years=3, base_revenue=1e6, revenue_growth=-0.99)
    assert [p["revenue"] for p in out["projections"]] == [10_000.0, 100.0, 1.0]


def test_the_margin_vectors_are_deliberately_not_bounded_below():
    """Only the rates that *compound* take the floor.

    A negative `capex_pct` is a disposal and a negative `nwc_pct` is deferred
    revenue funding the business; neither multiplies the prior year, so neither
    can flip a sign forward. Bounding them would refuse ordinary forecasts.
    """
    out = project_financials(
        method="growth", years=2, base_revenue=1e6, revenue_growth=0.1,
        capex_pct=-1.5, nwc_pct=-2.0,
    )
    assert all(p["revenue"] > 0 for p in out["projections"])


# ── a growth rate below −100%: the perpetuity ────────────────────────────────


@pytest.mark.parametrize(
    "growth,was",
    [(-1.5, -30.303030303030305), (-3.0, -63.49206349206349)],
)
def test_terminal_growth_below_minus_one_capitalised_a_profit_into_a_liability(growth, was):
    """A positive $100 final flow returned a *negative* terminal value.

    `(1 + g)` goes negative while `(r − g)` stays positive. As g → −∞ the
    figure converges on −$100, so it is wrong in direction and not merely in
    magnitude: the limit is zero. `r > g` is satisfied by every rate below −1,
    so the existing inequality could never catch it.
    """
    assert 0.15 > growth  # the only guard there was
    assert 100.0 * (1.0 + growth) / (0.15 - growth) == pytest.approx(was)  # what it returned
    with pytest.raises(EngineInputError, match=r"terminal_growth must be >= -1"):
        terminal_value_gordon(100.0, 0.15, growth)


def test_the_dcf_absorbed_the_negative_terminal_value_into_a_positive_conclusion():
    """Which is why it was silent: the enterprise value stayed positive.

    Five years of $100 at a 15% discount rate is $335.22 with a zero tail. At
    g = −150% the terminal leg contributed −$15.07 and the DCF returned
    $320.15 — a plausible number, 4.5% light, on a 200.
    """
    zero_tail = income_dcf([100.0] * 5, 0.15, -1.0)
    assert zero_tail["terminal_value"] == 0.0
    assert zero_tail["enterprise_value"] == pytest.approx(335.2154, abs=1e-3)

    with pytest.raises(EngineInputError, match=r"terminal_growth must be >= -1"):
        income_dcf([100.0] * 5, 0.15, -1.5)


def test_the_validator_refuses_the_same_terminal_growth_the_engine_does():
    """A payload the pre-flight clears is one `/compute` runs — both halves.

    Without this the engine's new floor would be the exact mismatch the
    validator's contract exists to rule out: `ok: true`, then a 422.
    """
    bad = {**INPUTS, "income": {**INPUTS["income"], "terminal_growth": -1.5}}
    errors, _ = split_issues(validate_payload(_params(), bad))
    assert [(e.code, e.field) for e in errors] == [
        ("out_of_range", "inputs.income.terminal_growth")
    ]

    ok_errors, _ = split_issues(
        validate_payload(_params(), {**INPUTS, "income": {**INPUTS["income"], "terminal_growth": -1.0}})
    )
    assert ok_errors == []


# ── a multiple struck on zero ────────────────────────────────────────────────

PRE_REVENUE = {"sic_code": "2836", "revenue_growth": 0.2, "ebitda_margin": 0.05}


def test_a_zero_revenue_target_no_longer_indicates_an_enterprise_value_of_zero():
    """11.3x $0 came back in the field a real indication arrives in.

    `revenue: 0` is what a pre-revenue company's `ltm_revenue` overwrite holds,
    and the screen route forwards it. Every other market-approach path in the
    engine refuses a non-positive metric out loud — `approaches.market_multiples`
    and `compute._market_metric` both do — and this one answered with a number.
    """
    out = comparable_analysis(**PRE_REVENUE, revenue=0.0, live=False)
    assert out["indicated_enterprise_value"] is None
    # The zero stays visible, so a reader can see why there is no indication.
    assert out["indicated_basis"]["denominator"] == 0.0
    assert out["indicated_basis"]["applied"] is not None


def test_an_absent_revenue_and_a_zero_revenue_now_agree():
    """They are different facts, but neither supports an indicated value."""
    absent = comparable_analysis(**PRE_REVENUE, revenue=None, live=False)
    zero = comparable_analysis(**PRE_REVENUE, revenue=0.0, live=False)
    assert absent["indicated_enterprise_value"] is None
    assert zero["indicated_enterprise_value"] is None


def test_a_positive_revenue_still_indicates():
    """The guard is on zero, not on the arithmetic."""
    out = comparable_analysis(**PRE_REVENUE, revenue=1e7, live=False)
    assert out["indicated_enterprise_value"] == pytest.approx(
        1e7 * out["indicated_basis"]["applied"]
    )


def test_a_zero_revenue_target_drops_the_size_axis_rather_than_zeroing_it():
    """`_log_proximity` has no value at zero, and returning 0.0 is not one.

    Scoring every candidate zero on size turned the dimension's whole 0.25
    weight into a flat penalty, which dragged totals below `min_score`: the same
    biotech target screened 7 comparables at `revenue: 0` and 12 with the
    revenue left unset. The five it dropped were reported as "scale too far from
    the target" — a judgement about an axis the screen could not evaluate.
    """
    absent = comparable_analysis(**PRE_REVENUE, revenue=None, live=False)
    zero = comparable_analysis(**PRE_REVENUE, revenue=0.0, live=False)
    assert len(zero["selected"]) == len(absent["selected"]) == 12
    assert [c["ticker"] for c in zero["selected"]] == [c["ticker"] for c in absent["selected"]]
    assert "size" not in zero["selected"][0]["breakdown"]


def test_a_comp_with_no_revenue_against_a_real_target_is_still_scored_zero():
    """The other direction is a real difference and must keep scoring as one."""
    company = next(c for c in resolve_universe(live=False).companies if c.revenue)
    scored = score_company(company, sic_code=company.sic_code, revenue=1.0)
    assert scored["breakdown"]["size"] == 0.0
    assert scored["weights"]["size"] > 0
