"""Behaviour exactly *on* the guards, not comfortably inside them.

Every one of these cases was found by the mutation run
(docs/mutation-testing.md): a mutant flipped `> 0` to `>= 0`, or `and` to
`or`, and the whole suite still passed — which means no test had ever put a
value on the boundary, so nothing would notice if the boundary moved.

They are not exotic inputs. They are what a half-filled intake form sends: an
empty cap-table array, a pre-revenue company with zero revenue, an exit
scenario an analyst zeroed out but left in the model, a volatility field left
blank. Each assertion below pins the behaviour the engine has *today*, so a
future change to a comparison operator has to be deliberate.
"""

from __future__ import annotations

import pytest

from app.engine.approaches import asset_value, market_multiples
from app.engine.compute import compute
from app.engine.current_value import allocate_cvm
from app.engine.dlom import chaffee_dlom, finnerty_dlom
from app.engine.errors import EngineInputError
from app.engine.pwerm import allocate_pwerm
from app.engine.waterfall import allocate_waterfall, exit_allocation

COMMON = {"name": "Common", "kind": "common", "shares": 8_000_000.0}
PREF = {"name": "Series A", "kind": "preferred", "shares": 4_000_000.0, "preference": 2e7}

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


# ── an empty cap table is not a cap table ────────────────────────────────────


def test_empty_share_classes_falls_back_to_the_single_breakpoint_opm():
    """`share_classes: []` must not be treated as "a waterfall was supplied".

    The frontend sends an empty array whenever the cap-table step was skipped.
    `len(share_classes) > 0` is the only thing standing between that and
    `allocate_waterfall([])`, which raises — so an analyst who skipped one
    optional step would get an error instead of the single-breakpoint OPM.
    """
    out = compute(OPM_PARAMS, {**OPM_INPUTS, "share_classes": []})
    assert out["results"]["allocation"]["method"] == "opm_single_breakpoint"
    assert out["results"]["fmv_per_share"] > 0


def test_a_supplied_cap_table_switches_to_the_full_waterfall():
    """The same payload *with* classes takes the other branch — the pair is
    what makes the boundary above meaningful rather than incidental."""
    out = compute(OPM_PARAMS, {**OPM_INPUTS, "share_classes": [COMMON, PREF]})
    assert out["results"]["allocation"]["method"] == "opm_waterfall"


def test_preferred_shares_without_a_preference_amount_means_as_converted():
    """`preferred_shares > 0 AND liquidation_preference > 0` — both, not either.

    With `or`, a company that has preferred shares but no liquidation
    preference recorded would be priced through a Black-Scholes call struck at
    zero. The strike is the preference; without one there is nothing to be
    senior to, and the allocation is simply pro-rata.
    """
    no_pref_amount = compute(OPM_PARAMS, {**OPM_INPUTS, "liquidation_preference": 0})
    assert no_pref_amount["results"]["allocation"]["method"] == "as_converted"
    # Preferred is still outstanding, so it still takes its as-converted share.
    assert no_pref_amount["results"]["allocation"]["common_fraction"] < 1.0


def test_a_preference_amount_without_preferred_shares_is_refused_rather_than_dropped():
    """The other side of the same `and`, and it is not symmetric with the one above.

    This case used to fall through to as-converted as well, with a
    `common_fraction` of 1.0 — common taking the entire equity value while the
    $20,000,000 preference the payload names is never mentioned again. There is
    no reading of this input on which that is right: the preference is senior to
    something, and the model needs the preferred share count to size the slice of
    upside sitting behind it. It cannot be inferred from the preference.

    The direction matters. Dropping the stack always *overstates* the concluded
    common FMV, which is the direction that under-prices employee option strikes,
    and it did so as a clean 200 with no error and no warning.
    """
    with pytest.raises(EngineInputError, match="shares_outstanding_preferred"):
        compute(OPM_PARAMS, {**OPM_INPUTS, "shares_outstanding_preferred": 0})

    # Saying "no preferred stock" — both fields cleared — is still fine, and is
    # the payload for which common really does take everything.
    both_cleared = compute(
        OPM_PARAMS, {**OPM_INPUTS, "shares_outstanding_preferred": 0, "liquidation_preference": 0}
    )
    assert both_cleared["results"]["allocation"]["method"] == "as_converted"
    assert both_cleared["results"]["allocation"]["common_fraction"] == 1.0


def test_volatility_is_only_required_when_something_actually_uses_it():
    """No preference, no waterfall, no model DLOM → no volatility needed.

    Each of the three conditions is `or`-ed; flipping any one to `and` makes
    the engine demand a volatility it never uses, which is a hard stop on a
    payload that should compute fine.
    """
    inputs = {
        "last_round_post_money": 5e7,
        "shares_outstanding_common": 8e6,
        "shares_outstanding_preferred": 0,
        "liquidation_preference": 0,
    }
    assert compute(OPM_PARAMS, inputs)["results"]["fmv_per_share"] > 0

    # …but each of the three does demand it, independently.
    with pytest.raises(EngineInputError, match="volatility"):
        compute(OPM_PARAMS, {**inputs, "liquidation_preference": 2e7,
                             "shares_outstanding_preferred": 4e6})
    with pytest.raises(EngineInputError, match="volatility"):
        compute(OPM_PARAMS, {**inputs, "share_classes": [COMMON, PREF]})
    with pytest.raises(EngineInputError, match="volatility"):
        compute({**OPM_PARAMS, "dlom_method": "chaffee"}, inputs)


# ── market approach: a pre-revenue company has a metric of exactly zero ──────


def test_zero_metric_is_rejected_rather_than_valued_at_zero():
    """Revenue of 0 × any multiple is 0, which is not a valuation.

    `metric <= 0` is what turns this into a named error instead of an equity
    value of zero that only fails later, with a message about weights.
    """
    with pytest.raises(EngineInputError, match="metric must be positive"):
        market_multiples(0.0, [10.0])
    with pytest.raises(EngineInputError, match="metric must be positive"):
        market_multiples(-1.0, [10.0])


def test_non_positive_multiples_are_dropped_not_averaged_in():
    """A comparable with a zero or negative multiple is bad data, not a data
    point — averaging it in would drag the whole conclusion down."""
    out = market_multiples(1e6, [10.0, 0.0, -3.0, 12.0])
    assert out["multiples"] == [10.0, 12.0]
    assert out["selected_multiple"] == pytest.approx(11.0)


def test_explicit_multiples_win_over_a_single_multiple():
    """`market.multiples` and `market.multiple` can both arrive; the list wins.

    The single-value field is the legacy shape. If precedence flipped, a stale
    `multiple` left on the record would silently override the comparable set
    the analyst actually selected.
    """
    params = {**OPM_PARAMS, "weight_opm": 0, "weight_market": 1, "dlom": 0.0}
    out = compute(
        params,
        {
            "market": {"multiples": [10.0], "multiple": 2.0, "metric": 1e6},
            "shares_outstanding_common": 1e6,
        },
    )
    assert out["results"]["equity_value"] == pytest.approx(1e7)


def test_zero_cost_to_replicate_is_caught_downstream_not_silently_valued():
    """`asset_value` returns 0 rather than raising, and the weighted step
    rejects it. Pinned because the two halves are in different modules: if
    `asset_value` started raising, this is the test that says so."""
    assert asset_value(
        cost_to_replicate=0.0, method="cost_to_replicate", total_assets=None,
        total_liabilities=None,
    )["equity_value"] == 0.0
    params = {**OPM_PARAMS, "weight_opm": 0, "weight_asset": 1,
              "asset_method": "cost_to_replicate"}
    with pytest.raises(EngineInputError, match="not positive"):
        compute(params, {"asset": {"cost_to_replicate": 0.0},
                         "shares_outstanding_common": 1e6})


# ── time and volatility at zero ──────────────────────────────────────────────


def test_zero_time_to_exit_is_legal_and_gives_the_intrinsic_allocation():
    """An exit today is a real input, and `t < 0` (not `t <= 0`) is what allows
    it. At t = 0 the option value vanishes and the OPM waterfall must return
    the same split as the deterministic one."""
    classes = [COMMON, PREF]
    opm = allocate_waterfall(5e7, classes, 0.0, 0.04, 0.6)
    deterministic = exit_allocation(5e7, classes)
    assert opm["common_per_share"] == pytest.approx(
        deterministic["common_per_share"], rel=1e-6
    )

    with pytest.raises(EngineInputError, match="time_to_exit must be >= 0"):
        allocate_waterfall(5e7, classes, -0.01, 0.04, 0.6)


def test_dlom_models_return_zero_at_the_degenerate_edges_but_not_beyond():
    """σ = 0 or t = 0 means no optionality, so no marketability discount.

    Both guards are `<= 0`; at exactly zero the models must return 0.0 rather
    than evaluating a put with a zero denominator.
    """
    assert chaffee_dlom(0.0, 3.0, 0.04) == 0.0
    assert chaffee_dlom(0.6, 0.0, 0.04) == 0.0
    assert finnerty_dlom(0.0, 3.0) == 0.0
    assert finnerty_dlom(0.6, 0.0) == 0.0
    # Just past the edge they are positive and ordered.
    assert 0.0 < finnerty_dlom(0.6, 0.01) < finnerty_dlom(0.6, 3.0)
    assert 0.0 < chaffee_dlom(0.01, 3.0, 0.04) < chaffee_dlom(0.6, 3.0, 0.04)


def test_finnerty_agrees_across_its_small_variance_threshold():
    """The σ²T < 1e-4 branch is a series expansion of the closed form.

    They must meet at the threshold — a discontinuity there would be a visible
    jump in the DLOM for a small change in volatility, and it is exactly what
    a mutated comparison would introduce.
    """
    import math

    # Straddle the threshold as tightly as floating point allows, so the whole
    # difference is the two formulas disagreeing rather than the inputs. The
    # step is 9.7e-6 relative — 2e-8 of an actual DLOM, which is where the
    # expansion's truncation error has grown to by σ²T = 1e-4. That is the
    # measurement that says the threshold is in the right place: an order of
    # magnitude higher and the step would be 1e-4, an order lower and the
    # closed form's cancellation error would dominate instead.
    below = finnerty_dlom(math.sqrt(1e-4 * (1 - 1e-9)), 1.0)
    above = finnerty_dlom(math.sqrt(1e-4 * (1 + 1e-9)), 1.0)
    assert below == pytest.approx(above, rel=1e-4)
    assert abs(below - above) < 1e-7

    # The expansion's own claim, checked against the small-argument limit
    # DLOM → 2φ(0)·√(σ²T/3)/2 well inside the branch.
    assert finnerty_dlom(math.sqrt(1e-6), 1.0) == pytest.approx(
        math.sqrt(1e-6 / 3.0) * 0.3989422804014327, rel=1e-6
    )


# ── PWERM scenario boundaries ────────────────────────────────────────────────


def test_zero_probability_scenario_is_accepted_but_negative_is_not():
    """`prob < 0` rejects, `prob == 0` does not — analysts park scenarios at
    zero while the assumption is under discussion."""
    classes = [COMMON, PREF]
    ok = allocate_pwerm(
        [
            {"probability": 1.0, "equity_value": 1e8, "time_to_exit_years": 2.0},
            {"probability": 0.0, "equity_value": 0.0, "time_to_exit_years": 2.0},
        ],
        classes,
        default_discount_rate=0.2,
    )
    assert ok["common_per_share"] > 0
    with pytest.raises(EngineInputError, match="probability must be >= 0"):
        allocate_pwerm(
            [
                {"probability": 1.5, "equity_value": 1e8},
                {"probability": -0.5, "equity_value": 1e8},
            ],
            classes,
            default_discount_rate=0.2,
        )


def test_a_total_loss_scenario_is_valued_at_zero_not_rejected():
    """Dissolution at $0 is the standard downside leg of a PWERM model.

    `equity < 0` is the guard; at exactly zero the scenario must survive and
    contribute nothing, which is what pulls the weighted common value down.
    """
    classes = [COMMON, PREF]
    out = allocate_pwerm(
        [
            {"probability": 0.5, "equity_value": 0.0, "type": "dissolution"},
            {"probability": 0.5, "equity_value": 2e8, "time_to_exit_years": 3.0},
        ],
        classes,
        default_discount_rate=0.25,
    )
    assert out["scenarios"][0]["present_value"] == 0.0
    assert out["scenarios"][0]["common_present_value"] == 0.0
    assert out["common_per_share"] > 0

    with pytest.raises(EngineInputError, match="negative"):
        allocate_pwerm(
            [{"probability": 1.0, "equity_value": -1.0}], classes,
            default_discount_rate=0.25,
        )


def test_probabilities_must_sum_to_one_within_tolerance():
    """The tolerance is 1e-6, and it is two-sided — a set summing to 0.999999
    is a rounding artefact of a UI slider, while 0.99 is a modelling error."""
    classes = [COMMON, PREF]
    allocate_pwerm(
        [
            {"probability": 0.5000004, "equity_value": 1e8},
            {"probability": 0.4999996, "equity_value": 1e8},
        ],
        classes,
        default_discount_rate=0.2,
    )
    with pytest.raises(EngineInputError, match="sum to 1.0"):
        allocate_pwerm(
            [{"probability": 0.99, "equity_value": 1e8}], classes,
            default_discount_rate=0.2,
        )


# ── CVM ──────────────────────────────────────────────────────────────────────


def test_cvm_needs_both_preferred_shares_and_a_preference_to_be_senior():
    """Same `and`-not-`or` boundary as the OPM path, in the σ→0 allocator."""
    inputs = {
        "shares_outstanding_common": 8e6,
        "shares_outstanding_preferred": 4e6,
        "liquidation_preference": 0.0,
    }
    out = allocate_cvm(5e7, inputs)
    assert out["common_value"] > 0
    # With a preference, common is worth strictly less than the pro-rata split.
    with_pref = allocate_cvm(5e7, {**inputs, "liquidation_preference": 2e7})
    assert with_pref["common_per_share"] < out["common_per_share"]
