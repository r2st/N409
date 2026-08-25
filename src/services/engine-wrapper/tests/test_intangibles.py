"""Intangible-asset method unit tests (features: PPA / ASC 805, IP Valuation)."""

import math

import pytest

from app.engine.errors import EngineInputError
from app.engine.intangibles import (
    TAX_AMORTIZATION_YEARS,
    cost_approach,
    meem,
    purchase_price_allocation,
    relief_from_royalty,
    tax_amortization_benefit,
    value_intangible,
    with_and_without,
)


# ── Tax amortization benefit ─────────────────────────────────────────────────


def test_tab_exceeds_one_and_grows_with_tax_rate():
    low = tax_amortization_benefit(0.15, 0.10)
    high = tax_amortization_benefit(0.15, 0.30)
    assert 1.0 < low < high < 1.5


def test_tab_matches_manual_fixed_point():
    rate, tax = 0.12, 0.25
    annuity = sum(1.0 / (1.0 + rate) ** y for y in range(1, TAX_AMORTIZATION_YEARS + 1))
    expected = 1.0 / (1.0 - tax * annuity / TAX_AMORTIZATION_YEARS)
    assert tax_amortization_benefit(rate, tax) == pytest.approx(expected)


def test_tab_zero_tax_is_identity():
    assert tax_amortization_benefit(0.15, 0.0) == pytest.approx(1.0)


# ── Relief from royalty ──────────────────────────────────────────────────────


def test_rfr_single_year_manual_check():
    # 1000 revenue × 5% royalty × (1−25%) / 1.10 = 34.09..., then TAB.
    out = relief_from_royalty(
        revenues=[1000.0], royalty_rate=0.05, tax_rate=0.25, discount_rate=0.10, include_tab=False
    )
    assert out["value_before_tab"] == pytest.approx(1000 * 0.05 * 0.75 / 1.1)
    assert out["fair_value"] == out["value_before_tab"]  # no TAB
    assert out["tab_multiplier"] == 1.0


def test_rfr_tab_grosses_up():
    base = relief_from_royalty(
        revenues=[1000.0] * 5, royalty_rate=0.04, tax_rate=0.21, discount_rate=0.14, include_tab=False
    )
    with_tab = relief_from_royalty(
        revenues=[1000.0] * 5, royalty_rate=0.04, tax_rate=0.21, discount_rate=0.14
    )
    assert with_tab["fair_value"] == pytest.approx(base["fair_value"] * with_tab["tab_multiplier"])
    assert with_tab["tab_multiplier"] > 1.0


def test_rfr_terminal_value_adds_pv():
    finite = relief_from_royalty(
        revenues=[1000.0] * 5, royalty_rate=0.05, tax_rate=0.25, discount_rate=0.15, include_tab=False
    )
    perpetual = relief_from_royalty(
        revenues=[1000.0] * 5,
        royalty_rate=0.05,
        tax_rate=0.25,
        discount_rate=0.15,
        terminal_growth=0.02,
        include_tab=False,
    )
    assert perpetual["pv_terminal"] > 0
    assert perpetual["fair_value"] > finite["fair_value"]


def test_rfr_terminal_growth_at_discount_rate_rejected():
    with pytest.raises(EngineInputError, match="must exceed terminal_growth"):
        relief_from_royalty(
            revenues=[100.0], royalty_rate=0.05, tax_rate=0.25, discount_rate=0.10, terminal_growth=0.10
        )


def test_rfr_royalty_above_one_rejected():
    with pytest.raises(EngineInputError, match="royalty_rate"):
        relief_from_royalty(revenues=[100.0], royalty_rate=5.0, tax_rate=0.25, discount_rate=0.10)


def test_rfr_percentage_style_discount_rate_normalized():
    a = relief_from_royalty(revenues=[100.0], royalty_rate=0.05, tax_rate=0.25, discount_rate=0.12)
    b = relief_from_royalty(revenues=[100.0], royalty_rate=0.05, tax_rate=0.25, discount_rate=12)
    assert a["fair_value"] == pytest.approx(b["fair_value"])


def test_rfr_ambiguous_discount_rate_rejected():
    with pytest.raises(EngineInputError, match="neither"):
        relief_from_royalty(revenues=[100.0], royalty_rate=0.05, tax_rate=0.25, discount_rate=1.2)


# ── MEEM ─────────────────────────────────────────────────────────────────────


def test_meem_attrition_decays_attributable_revenue():
    out = meem(
        revenues=[1000.0] * 3,
        attrition_rate=0.10,
        ebit_margin=0.30,
        contributory_charges_pct=0.05,
        tax_rate=0.25,
        discount_rate=0.15,
        include_tab=False,
    )
    survivals = [row["survival"] for row in out["schedule"]]
    assert survivals == pytest.approx([1.0, 0.9, 0.81])
    assert out["schedule"][0]["attributable_revenue"] == pytest.approx(1000.0)


def test_meem_manual_first_year():
    out = meem(
        revenues=[1000.0],
        attrition_rate=0.0,
        ebit_margin=0.30,
        contributory_charges_pct=0.05,
        tax_rate=0.20,
        discount_rate=0.10,
        include_tab=False,
    )
    # (1000×30%×0.8 − 1000×5%) / 1.1 = (240 − 50)/1.1
    assert out["fair_value"] == pytest.approx(190 / 1.1)


def test_meem_cac_reduces_value():
    lo = meem(
        revenues=[1000.0] * 5,
        ebit_margin=0.30,
        contributory_charges_pct=0.02,
        tax_rate=0.25,
        discount_rate=0.15,
    )
    hi = meem(
        revenues=[1000.0] * 5,
        ebit_margin=0.30,
        contributory_charges_pct=0.10,
        tax_rate=0.25,
        discount_rate=0.15,
    )
    assert hi["fair_value"] < lo["fair_value"]


def test_meem_full_attrition_leaves_only_year_one():
    out = meem(
        revenues=[1000.0] * 10,
        attrition_rate=1.0,
        ebit_margin=0.30,
        contributory_charges_pct=0.0,
        tax_rate=0.25,
        discount_rate=0.10,
        include_tab=False,
    )
    assert sum(r["attributable_revenue"] for r in out["schedule"][1:]) == 0.0


# ── With and without ─────────────────────────────────────────────────────────


def test_www_differential_manual():
    out = with_and_without(
        cash_flows_with=[500.0, 500.0],
        cash_flows_without=[300.0, 400.0],
        tax_rate=0.25,
        discount_rate=0.10,
        include_tab=False,
    )
    expected = (200 * 0.75) / 1.1 + (100 * 0.75) / 1.21
    assert out["fair_value"] == pytest.approx(expected)


def test_www_mismatched_years_rejected():
    with pytest.raises(EngineInputError, match="same years"):
        with_and_without(
            cash_flows_with=[1.0, 2.0], cash_flows_without=[1.0], tax_rate=0.25, discount_rate=0.10
        )


# ── Cost approach ────────────────────────────────────────────────────────────


def test_cost_approach_layers_compound():
    out = cost_approach(
        replacement_cost=1000.0,
        physical_obsolescence_pct=0.10,
        functional_obsolescence_pct=0.10,
        economic_obsolescence_pct=0.10,
    )
    assert out["fair_value"] == pytest.approx(1000 * 0.9 * 0.9 * 0.9)


def test_cost_approach_developer_profit_and_opportunity_cost():
    out = cost_approach(replacement_cost=1000.0, developer_profit_pct=0.10, opportunity_cost_pct=0.05)
    assert out["replacement_cost_new"] == pytest.approx(1150.0)
    assert out["fair_value"] == pytest.approx(1150.0)


def test_cost_approach_total_obsolescence_zeroes_value():
    out = cost_approach(replacement_cost=1000.0, economic_obsolescence_pct=1.0)
    assert out["fair_value"] == pytest.approx(0.0)


# ── Dispatch ─────────────────────────────────────────────────────────────────


def test_value_intangible_dispatches():
    out = value_intangible(
        "relief_from_royalty",
        {"revenues": [100.0], "royalty_rate": 0.05, "tax_rate": 0.25, "discount_rate": 0.10},
    )
    assert out["method"] == "relief_from_royalty"


def test_value_intangible_unknown_method_rejected():
    with pytest.raises(EngineInputError, match="unknown intangible method"):
        value_intangible("dcf", {})


def test_value_intangible_bad_kwargs_are_input_errors():
    with pytest.raises(EngineInputError, match="invalid params"):
        value_intangible("cost_approach", {"replacement_cost": 100.0, "bogus": 1})


# ── Purchase price allocation ────────────────────────────────────────────────


def _ppa_inputs(**overrides) -> dict:
    kwargs = dict(
        consideration_transferred=10_000_000.0,
        net_working_capital=500_000.0,
        fixed_assets=1_000_000.0,
        assumed_liabilities=300_000.0,
        intangibles=[
            {
                "name": "Developed technology",
                "method": "relief_from_royalty",
                "params": {
                    "revenues": [2_000_000.0] * 5,
                    "royalty_rate": 0.08,
                    "tax_rate": 0.25,
                    "discount_rate": 0.16,
                },
            },
            {
                "name": "Customer relationships",
                "method": "meem",
                "params": {
                    "revenues": [2_000_000.0] * 8,
                    "attrition_rate": 0.15,
                    "ebit_margin": 0.25,
                    "contributory_charges_pct": 0.06,
                    "tax_rate": 0.25,
                    "discount_rate": 0.17,
                },
            },
        ],
    )
    kwargs.update(overrides)
    return kwargs


def test_ppa_goodwill_is_the_residual():
    out = purchase_price_allocation(**_ppa_inputs())
    assert out["tangible_net_assets"] == pytest.approx(1_200_000.0)
    assert out["identifiable_net_assets"] == pytest.approx(
        out["tangible_net_assets"] + out["total_intangible_value"]
    )
    assert out["goodwill"] == pytest.approx(
        out["consideration_transferred"] - out["identifiable_net_assets"]
    )
    assert out["goodwill"] > 0
    assert out["bargain_purchase_gain"] == 0.0
    assert [a["name"] for a in out["intangibles"]] == [
        "Developed technology",
        "Customer relationships",
    ]


def test_ppa_allocation_ties_out():
    out = purchase_price_allocation(**_ppa_inputs())
    total = out["tangible_net_assets"] + out["total_intangible_value"] + out["goodwill"]
    assert total == pytest.approx(out["consideration_transferred"])


def test_ppa_bargain_purchase_reported_not_negative_goodwill():
    out = purchase_price_allocation(**_ppa_inputs(consideration_transferred=1_500_000.0))
    assert out["goodwill"] == 0.0
    assert out["bargain_purchase_gain"] > 0


def test_ppa_deferred_revenue_haircut_reduces_tangibles():
    base = purchase_price_allocation(**_ppa_inputs())
    cut = purchase_price_allocation(**_ppa_inputs(deferred_revenue_haircut=200_000.0))
    assert cut["tangible_net_assets"] == pytest.approx(base["tangible_net_assets"] - 200_000.0)
    assert cut["goodwill"] == pytest.approx(base["goodwill"] + 200_000.0)


def test_ppa_empty_intangibles_rejected():
    with pytest.raises(EngineInputError, match="non-empty"):
        purchase_price_allocation(**_ppa_inputs(intangibles=[]))


def test_ppa_bad_intangible_row_names_its_index():
    with pytest.raises(EngineInputError, match=r"intangibles\[1\]"):
        purchase_price_allocation(
            **_ppa_inputs(intangibles=[_ppa_inputs()["intangibles"][0], "not a dict"])
        )


def test_ppa_results_all_finite():
    out = purchase_price_allocation(**_ppa_inputs())
    for key in ("goodwill", "total_intangible_value", "identifiable_net_assets"):
        assert math.isfinite(out[key])


# ── A negative conclusion is not a valuation ─────────────────────────────────
#
# Two of the income methods could reach one, and neither said so. What made it
# worth a guard rather than a note is where the number went next: it is
# multiplied by the tax amortization benefit, so the step-up that grosses an
# asset *up* made the deficit larger; and in an allocation it is subtracted
# from identifiable net assets, so the goodwill residual absorbed it silently
# and the balance still tied out.


def test_www_swapped_scenarios_rejected():
    """A "without" forecast above the "with" forecast is the inputs reversed."""
    with pytest.raises(EngineInputError, match="entered the wrong way round"):
        with_and_without(
            cash_flows_with=[1_000_000.0, 1_100_000.0],
            cash_flows_without=[1_400_000.0, 1_500_000.0],
            tax_rate=0.21,
            discount_rate=0.15,
        )


def test_www_negative_year_is_still_allowed():
    """The guard is on the conclusion, not on any one year.

    A non-compete can cost more than it saves in an early year and still be
    worth something; only the total has to be an asset.
    """
    out = with_and_without(
        cash_flows_with=[100.0, 900.0],
        cash_flows_without=[300.0, 400.0],
        tax_rate=0.25,
        discount_rate=0.10,
        include_tab=False,
    )
    assert out["schedule"][0]["after_tax_differential"] < 0
    assert out["fair_value"] > 0


def test_meem_charges_above_earnings_rejected():
    with pytest.raises(EngineInputError, match="contributory asset charges exceed"):
        meem(
            revenues=[10_000_000.0] * 5,
            attrition_rate=0.15,
            ebit_margin=0.05,
            contributory_charges_pct=0.20,
            tax_rate=0.21,
            discount_rate=0.16,
        )


def test_negative_conclusion_does_not_reach_the_tab():
    """The step-up must never be applied to a deficit.

    Pinning the failure *before* the multiply, because a guard placed after it
    would report a number 8% further from zero than the arithmetic produced.
    """
    with pytest.raises(EngineInputError, match=r"-513,724\.01"):
        with_and_without(
            cash_flows_with=[1_000_000.0, 1_100_000.0],
            cash_flows_without=[1_400_000.0, 1_500_000.0],
            tax_rate=0.21,
            discount_rate=0.15,
        )


def test_ppa_negative_intangible_does_not_inflate_goodwill():
    """The consequence that made this material.

    A $560k scenario error came back as $9.56m of goodwill against $9.0m of
    consideration — an overstatement of exactly the mis-specified asset, with
    nothing on the allocation to say so, because the residual is a subtraction
    and a negative subtrahend adds.
    """
    with pytest.raises(EngineInputError, match="entered the wrong way round"):
        purchase_price_allocation(
            consideration_transferred=10_000_000.0,
            net_working_capital=1_000_000.0,
            intangibles=[
                {
                    "name": "Non-compete",
                    "method": "with_and_without",
                    "params": {
                        "cash_flows_with": [1_000_000.0, 1_100_000.0],
                        "cash_flows_without": [1_400_000.0, 1_500_000.0],
                        "tax_rate": 0.21,
                        "discount_rate": 0.15,
                    },
                }
            ],
        )


def test_rfr_negative_revenue_rejected():
    with pytest.raises(EngineInputError, match=r"rfr\.revenues\[1\] must be >= 0"):
        relief_from_royalty(
            revenues=[100.0, -100.0], royalty_rate=0.05, tax_rate=0.21, discount_rate=0.17
        )


def test_meem_negative_revenue_rejected():
    with pytest.raises(EngineInputError, match=r"meem\.revenues\[0\] must be >= 0"):
        meem(
            revenues=[-1.0],
            ebit_margin=0.25,
            contributory_charges_pct=0.06,
            tax_rate=0.25,
            discount_rate=0.17,
        )


def test_rfr_terminal_growth_below_minus_one_rejected():
    """(1 + growth) goes negative, and the terminal value with it."""
    with pytest.raises(EngineInputError, match=r"rfr\.terminal_growth must be >= -1"):
        relief_from_royalty(
            revenues=[100.0],
            royalty_rate=0.05,
            tax_rate=0.21,
            discount_rate=0.17,
            terminal_growth=-1.5,
        )


def test_rfr_terminal_growth_of_exactly_minus_one_is_a_zero_tail():
    """The legitimate floor: the flow stops after the forecast."""
    out = relief_from_royalty(
        revenues=[100.0],
        royalty_rate=0.05,
        tax_rate=0.21,
        discount_rate=0.17,
        terminal_growth=-1.0,
        include_tab=False,
    )
    assert out["pv_terminal"] == 0.0
    assert out["fair_value"] == pytest.approx(out["pv_explicit"])
