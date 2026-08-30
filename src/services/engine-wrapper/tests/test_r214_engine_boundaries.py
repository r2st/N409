"""Engine boundaries whose failure is a plausible number rather than an error.

R214 (M1). Each case below is an input a half-filled intake form or an
aggressive-but-legal assumption produces, where the engine answered with
something shaped exactly like a conclusion: a fair market value of $0.0000, a
per-share figure struck on a share count nobody holds, an indication drawn from
a comp set of one. The guards those cases walked past all exist; what they had
in common is that each was asked about a figure other than the one the
conclusion was struck with.
"""

from __future__ import annotations

import math

import pytest

from app.engine.compute import _resolve_discounts, compute
from app.engine.debt_valuation import convertible_note
from app.engine.dloc import control_premium_dloc, studies_dloc
from app.engine.errors import EngineInputError

COMMON = {"name": "Common", "kind": "common", "shares": 8_000_000.0}

OPM_PARAMS = {
    "weight_asset": 0,
    "weight_opm": 1,
    "weight_income": 0,
    "weight_market": 0,
    "dlom": 0.2,
}
OPM_INPUTS = {
    "last_round_post_money": 5e7,
    "shares_outstanding_common": 8e6,
    "options_outstanding": 1e6,
    "shares_outstanding_preferred": 4e6,
    "liquidation_preference": 2e7,
    "volatility": 0.6,
}


# ── a DLOM that is 100% by the time it is applied ────────────────────────────
#
# `_check_discount_range` excludes 1.0 at both ends and says why: a 100%
# discount concludes the interest is worthless, and two of them applied
# multiplicatively make each other unfalsifiable. It was checking the figure
# before `round(dlom, 4)`, and four decimals is the quantum the DLOM is applied
# and reported at — so everything in [0.99995, 1.0) cleared the guard and was
# then used as exactly 1.0.


@pytest.mark.parametrize("dlom", [0.99995, 0.99996, 0.999999])
def test_a_dlom_that_rounds_to_one_is_refused_not_applied(dlom):
    with pytest.raises(EngineInputError) as err:
        _resolve_discounts({"dlom": dlom}, 0.6, 3.0, 0.04)
    assert "[0, 1)" in str(err.value)
    # The refusal names the figures, because the one being refused is not the
    # one the caller typed.
    assert "dlom 1" in str(err.value)


def test_the_qualitative_path_reaches_the_same_quantum():
    """`dlom_qualitative` takes an analyst's figure with no model to clamp it."""
    with pytest.raises(EngineInputError):
        _resolve_discounts(
            {"dlom_method": "qualitative", "dlom_qualitative": 0.99999}, 0.6, 3.0, 0.04
        )


def test_a_dlom_just_below_the_quantum_still_concludes():
    """0.9999 is four decimals exactly and stays a discount, not an erasure."""
    d = _resolve_discounts({"dlom": 0.9999}, 0.6, 3.0, 0.04)
    assert d.dlom == 0.9999
    assert 1.0 - d.dlom > 0


def test_end_to_end_the_engine_no_longer_concludes_a_zero_fair_market_value():
    with pytest.raises(EngineInputError):
        compute({**OPM_PARAMS, "dlom": 0.99997}, dict(OPM_INPUTS))

    out = compute({**OPM_PARAMS, "dlom": 0.9999}, dict(OPM_INPUTS))
    fmv = out["results"]["fmv_per_share"]
    assert math.isfinite(fmv)
    assert out["results"]["discounts"]["dlom"] == 0.9999


# ── a blend leg outside [0, 1) ───────────────────────────────────────────────
#
# `_blended_dlom` documents each leg as resolved "through exactly the path a
# single-method run would take", so that a leg and a single-method run of the
# same method are the same arithmetic on the same inputs. On the *range* they
# were not: the concluded blend is clamped to [0, 0.99], and the clamp caught
# what the single path refuses.


@pytest.mark.parametrize("qualitative", [3.0, 1.0, -2.0])
def test_a_blend_leg_is_held_to_the_range_the_single_method_run_is(qualitative):
    single = {"dlom_method": "qualitative", "dlom_qualitative": qualitative}
    with pytest.raises(EngineInputError):
        _resolve_discounts(single, 0.6, 3.0, 0.04)

    blend = {
        "dlom_qualitative": qualitative,
        "dlom_methods": [
            {"method": "qualitative", "weight": 0.5},
            {"method": "chaffee", "weight": 0.5},
        ],
    }
    with pytest.raises(EngineInputError) as err:
        _resolve_discounts(blend, 0.6, 3.0, 0.04)
    # Named by leg, because the blend has several and only one is wrong.
    assert "qualitative" in str(err.value)


def test_the_blend_table_sums_to_the_discount_printed_beside_it():
    """The one check a reviewer runs on a weighted average.

    A 300% qualitative leg at 50% weight used to conclude 0.99 — the clamp,
    not the average — beside components summing to 1.66.
    """
    d = _resolve_discounts(
        {
            "dlom_qualitative": 0.4,
            "dlom_methods": [
                {"method": "qualitative", "weight": 0.5},
                {"method": "chaffee", "weight": 0.5},
            ],
        },
        0.6,
        3.0,
        0.04,
    )
    components = d.dlom_detail["components"]
    assert d.dlom == pytest.approx(sum(c["weighted"] for c in components), abs=5e-5)
    assert all(0.0 <= c["dlom"] < 1.0 for c in components)


# ── a control premium past the DLOC ceiling ──────────────────────────────────
#
# `_invert_premium` reports the premium, the discount, and the formula joining
# them. Past a premium of 19 the clamp replaced the discount and left the other
# two describing the inversion, so the one row a reviewer recomputes by hand
# stopped recomputing.


def test_a_control_premium_past_the_ceiling_is_refused_not_clamped():
    with pytest.raises(EngineInputError) as err:
        control_premium_dloc(30.0)
    assert "0.30" in str(err.value)  # the fraction convention the typo missed


def test_the_reported_discount_is_the_one_the_reported_formula_produces():
    for premium in (0.25, 0.4, 3.0, 19.0):
        out = control_premium_dloc(premium)
        assert out["formula"] == "DLOC = 1 − 1/(1 + control premium)"
        assert out["dloc"] == pytest.approx(
            1.0 - 1.0 / (1.0 + out["control_premium_applied"]), abs=5e-7
        )


def test_a_studies_table_reaches_the_same_ceiling():
    """The studies method inverts through `_invert_premium` too."""
    with pytest.raises(EngineInputError):
        studies_dloc(studies=[{"study": "typo", "premium": 30.0}])


def test_the_synergy_deduction_is_applied_before_the_ceiling():
    """It is the premium actually inverted that has to clear the ceiling."""
    out = control_premium_dloc(30.0, 0.99)
    assert out["control_premium_applied"] == pytest.approx(0.3)
    assert out["dloc"] == pytest.approx(1.0 - 1.0 / 1.3, abs=5e-7)


# ── a binomial tree that stopped being a diffusion ───────────────────────────
#
# The CRR risk-neutral probability is only a probability while the drift over a
# step sits strictly inside the lattice's move range. `convertible_note` used to
# clamp it to [0, 1] instead of checking, which pins the tree to one direction at
# every node — and the clamped value stops being a function of the input that
# broke it.

CONVERTIBLE = {
    "face": 1000.0,
    "coupon_rate": 0.05,
    "frequency": 2,
    "maturity_years": 5.0,
    "conversion_ratio": 10.0,
    "stock_price": 80.0,
    "volatility": 0.30,
    "risk_free_rate": 0.05,
    "credit_spread": 0.03,
}


def test_a_dividend_yield_that_breaks_the_lattice_is_refused_with_the_step_count():
    """`dividend_yield: 2.0` is 2% typed as a whole number."""
    with pytest.raises(EngineInputError) as err:
        convertible_note(**CONVERTIBLE, dividend_yield=2.0)
    assert "steps to at least 212" in str(err.value)

    # And 212 is not a brush-off: the note prices at that discretisation.
    out = convertible_note(**CONVERTIBLE, dividend_yield=2.0, steps=212)
    assert out["fair_value"] > 0


def test_a_clamped_tree_had_stopped_responding_to_the_input():
    """Two very different yields must not price identically.

    Under the clamp both landed on the same endpoint and returned 872.28 —
    the same number to the cent, from inputs two and a half times apart.
    """
    a = convertible_note(**CONVERTIBLE, dividend_yield=2.0, steps=2000)["fair_value"]
    b = convertible_note(**CONVERTIBLE, dividend_yield=5.0, steps=2000)["fair_value"]
    assert a != b


def test_a_low_volatility_note_on_a_coarse_tree_is_refused_too():
    """The condition is about σ against the drift, not about the yield."""
    with pytest.raises(EngineInputError, match="move range"):
        convertible_note(**{**CONVERTIBLE, "volatility": 0.005}, steps=10)


def test_an_ordinary_convertible_is_untouched():
    for q in (0.0, 0.02, 0.5):
        out = convertible_note(**CONVERTIBLE, dividend_yield=q)
        assert out["fair_value"] >= out["parity"]
