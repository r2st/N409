"""The specialty engines' input contracts, one refusal at a time.

Each specialty engine keeps a private `_num` that refuses a non-numeric value,
a non-finite one, and one outside the band the standard allows — and above it,
shape guards for the lists and objects the endpoint takes. The per-engine test
files exercise the arithmetic those guards protect. This one exercises the
guards.

Why they are worth their own tests rather than being taken on trust: these
engines are reached over HTTP with a JSON body, so every argument arrives as
whatever the caller put in the field. A `_num` that let `float("nan")` through
would not raise anywhere — NaN propagates silently through every arithmetic
operation in the module and lands in a disclosure as `null`, or worse as a
number computed from it. `math.isfinite` is the only place that fact gets
noticed, and a guard nothing tests is a guard that can be deleted by a
refactor without a single failure.

The band checks are the other half, and they encode the standard rather than
defensive programming: a negative carrying amount is not an impairment input,
an option exercise price below zero is not a grant, and a sensitivity shift of
200% is not a shift. Each refusal here is a 422 the analyst can act on instead
of a number nobody can explain.
"""

import math

import pytest

from app.engine import emi_csop, esop, fair_value_820, gift_estate, ifrs2, impairment, intangibles
from app.engine.errors import EngineInputError

# The values every `_num` in the tree must refuse, and the reason each one is
# in the list rather than a single "bad input" case:
#
#   "abc"      — a string field posted where a number was meant
#   None       — an absent value that reached the engine as a key with no value
#   {} / []    — a nested object flattened wrong by a caller
#   nan / inf  — the ones that do NOT raise on their own and must be caught
NOT_NUMBERS = ["abc", None, {}, [], float("nan"), float("inf"), float("-inf")]


def assert_refuses(fn, kwargs, field, values=NOT_NUMBERS):
    """`fn(**kwargs)` must raise EngineInputError for each bad value of `field`."""
    for bad in values:
        with pytest.raises(EngineInputError) as excinfo:
            fn(**{**kwargs, field: bad})
        assert field.split(".")[-1] in str(excinfo.value) or field in str(excinfo.value), (
            f"{field}={bad!r} raised without naming the field: {excinfo.value}"
        )


# ── ESOP (ERISA adequate consideration) ───────────────────────────────────────

ESOP_OK = {"equity_value": 50_000_000.0, "shares_outstanding": 1_000_000.0}


def test_esop_share_value_refuses_unusable_numbers():
    assert_refuses(esop.esop_share_value, ESOP_OK, "equity_value")
    assert_refuses(esop.esop_share_value, ESOP_OK, "shares_outstanding")


def test_esop_refuses_a_negative_equity_value():
    with pytest.raises(EngineInputError):
        esop.esop_share_value(**{**ESOP_OK, "equity_value": -1.0})


def test_esop_repurchase_obligation_refuses_unusable_numbers():
    ok = {
        "esop_share_balance": 100_000.0,
        "fmv_per_share": 50.0,
        "annual_redemption_rate": 0.05,
    }
    assert_refuses(esop.repurchase_obligation, ok, "esop_share_balance")
    assert_refuses(esop.repurchase_obligation, ok, "fmv_per_share")
    assert_refuses(esop.repurchase_obligation, ok, "annual_redemption_rate")


def test_esop_repurchase_refuses_a_growth_rate_that_overflows_the_schedule():
    """A repurchase cost that reaches infinity is a runaway input, not a number.

    The schedule compounds the share price for `years`, so a large growth rate
    over a long horizon overflows to `inf` — which would otherwise be summed
    into `total_obligation` and disclosed as a funding requirement.
    """
    with pytest.raises(EngineInputError, match="overflow"):
        esop.repurchase_obligation(
            esop_share_balance=1e300,
            fmv_per_share=1e300,
            share_value_growth=1e300,
            annual_redemption_rate=0.5,
            years=30,
        )


# ── EMI / CSOP (HMRC tax-advantaged schemes) ──────────────────────────────────

EMI_VALUES_OK = {"equity_value": 10_000_000.0, "total_shares": 1_000_000.0}


def test_emi_share_values_refuses_unusable_numbers():
    assert_refuses(emi_csop.share_values, EMI_VALUES_OK, "equity_value")
    assert_refuses(emi_csop.share_values, EMI_VALUES_OK, "total_shares")


def test_emi_share_values_refuses_a_discount_outside_zero_to_one():
    for bad in (-0.1, 1.0, 1.5):
        with pytest.raises(EngineInputError):
            emi_csop.share_values(**{**EMI_VALUES_OK, "restriction_discount": bad})


def test_emi_csop_valuation_refuses_an_unknown_scheme():
    with pytest.raises(EngineInputError, match="emi"):
        emi_csop.emi_csop_valuation("saye", {**EMI_VALUES_OK})


def test_emi_csop_valuation_refuses_params_that_are_not_an_object():
    """The endpoint hands `params` straight through, so a list must be refused."""
    for bad in ([], "equity_value=10", 42, None):
        with pytest.raises(EngineInputError, match="params must be an object"):
            emi_csop.emi_csop_valuation("emi", bad)


def test_emi_csop_valuation_accepts_either_scheme_name_case_insensitively():
    result = emi_csop.emi_csop_valuation(
        "EMI ",
        {
            **EMI_VALUES_OK,
            "gross_assets": 10_000_000.0,
            "employee_count": 40,
            "options_granted": 1_000,
        },
    )
    assert "unrestricted_market_value" in result or "umv_per_share" in str(result)


# ── IFRS 2 (share-based payment) ──────────────────────────────────────────────

IFRS2_OK = {
    "share_price": 10.0,
    "exercise_price": 8.0,
    "expected_term_years": 4.0,
    "expected_volatility": 0.5,
    "risk_free_rate": 0.04,
}


def test_ifrs2_grant_date_fair_value_refuses_unusable_numbers():
    for field in IFRS2_OK:
        assert_refuses(ifrs2.grant_date_fair_value, IFRS2_OK, field)


def test_ifrs2_refuses_a_negative_share_or_exercise_price():
    for field in ("share_price", "exercise_price", "expected_term_years", "expected_volatility"):
        with pytest.raises(EngineInputError):
            ifrs2.grant_date_fair_value(**{**IFRS2_OK, field: -1.0})


def test_ifrs2_refuses_a_market_condition_discount_above_one():
    """A discount over 100% would turn the grant-date fair value negative."""
    with pytest.raises(EngineInputError):
        ifrs2.grant_date_fair_value(**{**IFRS2_OK, "market_condition_discount": 1.5})


# ── ASC 350 / 360 impairment ──────────────────────────────────────────────────


def test_indefinite_lived_impairment_refuses_unusable_numbers():
    ok = {"carrying_amount": 1_000_000.0, "fair_value": 900_000.0}
    assert_refuses(impairment.indefinite_lived_impairment, ok, "carrying_amount")
    assert_refuses(impairment.indefinite_lived_impairment, ok, "fair_value")


def test_impairment_refuses_a_negative_carrying_amount():
    with pytest.raises(EngineInputError):
        impairment.indefinite_lived_impairment(carrying_amount=-1.0, fair_value=1.0)


def test_long_lived_impairment_needs_a_non_empty_cash_flow_list():
    for bad in ([], None, "1,2,3", {}):
        with pytest.raises(EngineInputError, match="undiscounted_cash_flows"):
            impairment.long_lived_impairment(
                carrying_amount=1_000_000.0, undiscounted_cash_flows=bad, fair_value=900_000.0
            )


def test_long_lived_impairment_caps_the_projection_horizon():
    """A hundred years of recoverability-test cash flows is a caller bug."""
    with pytest.raises(EngineInputError, match="at most"):
        impairment.long_lived_impairment(
            carrying_amount=1_000_000.0,
            undiscounted_cash_flows=[1.0] * (impairment.MAX_FLOW_YEARS + 1),
            fair_value=900_000.0,
        )


def test_run_impairment_test_refuses_an_unknown_kind_and_lists_the_real_ones():
    with pytest.raises(EngineInputError, match="goodwill"):
        impairment.run_impairment_test("inventory", {})


def test_run_impairment_test_refuses_params_that_are_not_an_object():
    for bad in ([], "carrying_amount=1", 7):
        with pytest.raises(EngineInputError, match="must be an object"):
            impairment.run_impairment_test("goodwill", bad)


def test_run_impairment_test_turns_a_wrong_argument_set_into_an_input_error():
    """A TypeError from `fn(**params)` reaches the caller as a 422, not a 500."""
    with pytest.raises(EngineInputError, match="invalid params"):
        impairment.run_impairment_test("goodwill", {"not_a_real_argument": 1})


# ── gift and estate (Rev. Rul. 59-60) ─────────────────────────────────────────

GIFT_OK = {"entity_value": 10_000_000.0, "percent_interest": 0.2}


def test_gift_estate_refuses_unusable_numbers():
    assert_refuses(gift_estate.gift_estate_valuation, GIFT_OK, "entity_value")
    assert_refuses(gift_estate.gift_estate_valuation, GIFT_OK, "percent_interest")


def test_factors_addressed_must_be_a_list():
    for bad in ("earning_capacity", {"earning_capacity": True}, 5):
        with pytest.raises(EngineInputError, match="factors_addressed"):
            gift_estate.gift_estate_valuation(**{**GIFT_OK, "factors_addressed": bad})


def test_an_unknown_59_60_factor_is_named_rather_than_ignored():
    # Silently dropping an unrecognised key would report the file as addressing
    # fewer factors than the analyst listed, with no indication which.
    with pytest.raises(EngineInputError, match="unknown factor"):
        gift_estate.gift_estate_valuation(**{**GIFT_OK, "factors_addressed": ["vibes"]})


def test_factors_addressed_accepts_none_as_none_addressed():
    result = gift_estate.gift_estate_valuation(**{**GIFT_OK, "factors_addressed": None})
    assert result is not None


# ── intangibles (ASC 805 / IVS 210) ───────────────────────────────────────────

RFR_OK = {
    "revenues": [1_000_000.0, 1_100_000.0, 1_200_000.0],
    "royalty_rate": 0.05,
    "tax_rate": 0.21,
    "discount_rate": 0.15,
}


def test_relief_from_royalty_refuses_unusable_numbers():
    for field in ("royalty_rate", "tax_rate", "discount_rate"):
        assert_refuses(intangibles.relief_from_royalty, RFR_OK, field)


def test_a_revenue_schedule_must_be_a_non_empty_list():
    for bad in ([], None, "1000000", {}):
        with pytest.raises(EngineInputError, match="revenues"):
            intangibles.relief_from_royalty(**{**RFR_OK, "revenues": bad})


def test_a_revenue_schedule_is_capped():
    with pytest.raises(EngineInputError, match="at most"):
        intangibles.relief_from_royalty(
            **{**RFR_OK, "revenues": [1.0] * (intangibles.MAX_SCHEDULE_YEARS + 1)}
        )


def test_a_tax_rate_given_in_percent_is_accepted_and_one_at_or_above_100_is_not():
    """21 and 0.21 both mean 21%; 100 means the step-up is unbounded."""
    as_percent = intangibles.relief_from_royalty(**{**RFR_OK, "tax_rate": 21.0})
    as_fraction = intangibles.relief_from_royalty(**{**RFR_OK, "tax_rate": 0.21})
    assert as_percent["fair_value"] == pytest.approx(as_fraction["fair_value"])

    with pytest.raises(EngineInputError, match="below 100"):
        intangibles.relief_from_royalty(**{**RFR_OK, "tax_rate": 100.0})


def test_a_discount_rate_that_cannot_amortise_is_refused():
    """The TAB step-up diverges when tax_rate × amortisation PV reaches 1.

    A negative discount rate is the input that gets there with an ordinary tax
    rate: it makes each year's factor greater than one, so the annuity grows
    with the horizon instead of converging. `1 / (1 - shield)` would then be
    negative or a division by zero, and the step-up is a multiplier applied to
    the whole intangible value.
    """
    with pytest.raises(EngineInputError, match="unbounded"):
        intangibles.tax_amortization_benefit(discount_rate=-0.5, tax_rate=0.21)


def test_the_tab_horizon_must_be_positive():
    with pytest.raises(EngineInputError, match="years must be positive"):
        intangibles.tax_amortization_benefit(discount_rate=0.15, tax_rate=0.21, years=0)


def test_a_discount_rate_of_zero_or_below_is_refused():
    """Discounting at zero is not discounting, and below zero inverts the schedule."""
    for bad in (0.0, -0.05):
        with pytest.raises(EngineInputError, match="must be positive"):
            intangibles.relief_from_royalty(**{**RFR_OK, "discount_rate": bad})


def test_a_royalty_rate_above_one_is_refused_and_zero_is_allowed():
    """A 100%+ royalty is not a rate; a zero one is a real, if unusual, input."""
    with pytest.raises(EngineInputError):
        intangibles.relief_from_royalty(**{**RFR_OK, "royalty_rate": 1.5})
    assert intangibles.relief_from_royalty(**{**RFR_OK, "royalty_rate": 0.0})["fair_value"] == 0.0


def test_a_revenue_schedule_that_overflows_is_caught_before_it_is_discounted():
    """Finite inputs, non-finite product.

    Each guard above checks one number as it arrives. This checks the result of
    combining them: revenues near the float ceiling multiplied by a royalty rate
    overflow to `inf`, which no per-input check would have seen, and `inf` in a
    discounted schedule yields a fair value of `inf` or `nan`.
    """
    with pytest.raises(EngineInputError, match="non-finite"):
        intangibles.relief_from_royalty(
            **{
                **RFR_OK,
                "revenues": [1e308, 1e308, 1e308],
                "royalty_rate": 0.99,
                "discount_rate": 1e-300,
                "terminal_growth": None,
            }
        )


def test_value_intangible_refuses_params_that_are_not_an_object():
    for bad in ([], "revenues=1", 3):
        with pytest.raises(EngineInputError, match="must be an object"):
            intangibles.value_intangible("relief_from_royalty", bad)


def test_a_purchase_price_allocation_needs_positive_consideration():
    for bad in (0.0, -1.0):
        with pytest.raises(EngineInputError, match="consideration_transferred"):
            intangibles.purchase_price_allocation(
                consideration_transferred=bad, intangibles=[{"name": "Tech", "fair_value": 1.0}]
            )


def test_a_purchase_price_allocation_caps_the_asset_count():
    with pytest.raises(EngineInputError, match="at most 50"):
        intangibles.purchase_price_allocation(
            consideration_transferred=1e8,
            intangibles=[{"name": f"Asset {i}", "fair_value": 1.0} for i in range(51)],
        )


# ── ASC 820 fair value measurement ────────────────────────────────────────────


def position(**over):
    return {"name": "Series A preferred", "fair_value": 1_000_000.0, "level": "level_3", **over}


def test_positions_must_be_a_non_empty_list():
    for bad in ([], None, {}, "one position"):
        with pytest.raises(EngineInputError, match="positions"):
            fair_value_820.fair_value_measurement(positions=bad)


def test_the_position_count_is_capped():
    with pytest.raises(EngineInputError, match="capped"):
        fair_value_820.fair_value_measurement(
            positions=[position()] * (fair_value_820.MAX_POSITIONS + 1)
        )


def test_a_positions_inputs_field_must_be_a_list():
    with pytest.raises(EngineInputError, match=r"inputs must be a list"):
        fair_value_820.fair_value_measurement(positions=[position(inputs={"vol": 0.6})])


def test_each_unobservable_input_must_be_an_object():
    with pytest.raises(EngineInputError, match=r"inputs\[0\] must be an object"):
        fair_value_820.fair_value_measurement(positions=[position(inputs=["volatility"])])


def test_the_level_3_rollforward_must_be_an_object():
    with pytest.raises(EngineInputError, match="level_3_rollforward must be an object"):
        fair_value_820.fair_value_measurement(
            positions=[position()], level_3_rollforward=[("beginning_balance", 1.0)]
        )


def test_the_sensitivity_block_must_be_a_list_of_objects():
    with pytest.raises(EngineInputError, match="sensitivity must be a list"):
        fair_value_820.fair_value_measurement(positions=[position()], sensitivity={"shift": 0.1})

    with pytest.raises(EngineInputError, match=r"sensitivity\[0\] must be an object"):
        fair_value_820.fair_value_measurement(positions=[position()], sensitivity=["10%"])


def test_a_sensitivity_shift_beyond_plus_or_minus_one_is_refused():
    """A 200% downward shift would report a negative fair value as the result."""
    for bad in (-1.5, 1.5):
        with pytest.raises(EngineInputError):
            fair_value_820.fair_value_measurement(
                positions=[position()], sensitivity=[{"input": "discount rate", "shift": bad}]
            )


def test_an_unobservable_input_with_no_value_is_skipped_not_averaged_as_zero():
    """A named input with no number is a disclosure gap, not a zero observation.

    Averaging it in would pull the disclosed range toward zero and understate
    the weighted average an auditor reads off the table.
    """
    result = fair_value_820.fair_value_measurement(
        positions=[
            position(
                name="A",
                inputs=[{"name": "volatility", "level": "level_3", "value": 0.60}],
            ),
            position(
                name="B",
                inputs=[{"name": "volatility", "level": "level_3"}],
            ),
        ]
    )
    rows = {row["input"]: row for row in result["unobservable_inputs"]}
    volatility = rows["volatility"]
    assert volatility["weighted_average"] == pytest.approx(0.60)
    assert volatility["low"] == pytest.approx(0.60)
    assert volatility["high"] == pytest.approx(0.60)
    # Only the position that stated a number is counted, so the disclosed
    # range is over real observations rather than over one observation and a
    # gap recorded as zero.
    assert volatility["position_count"] == 1


def test_unobservable_inputs_on_zero_marked_positions_fall_back_to_an_unweighted_mean():
    """Every carrier marked at zero leaves no weight to average by.

    The weighted average is by fair value, so a portfolio whose positions are
    all written down to zero has a total weight of zero — and dividing by it is
    the bug this branch exists to avoid. The unweighted mean is the only
    defensible answer, and the row says which one it is.
    """
    result = fair_value_820.fair_value_measurement(
        positions=[
            position(
                name="A",
                fair_value=0.0,
                inputs=[{"name": "volatility", "level": "level_3", "value": 0.40}],
            ),
            position(
                name="B",
                fair_value=0.0,
                inputs=[{"name": "volatility", "level": "level_3", "value": 0.80}],
            ),
        ]
    )
    row = {r["input"]: r for r in result["unobservable_inputs"]}["volatility"]
    assert row["weighted_average"] == pytest.approx(0.60)
    assert row["weighted"] is False


def test_nan_never_reaches_a_disclosed_figure():
    """The property every `_num` above exists to hold, asserted once end to end."""
    with pytest.raises(EngineInputError, match="must be finite"):
        fair_value_820.fair_value_measurement(
            positions=[position(fair_value=float("nan"))]
        )


def test_a_positions_fair_value_must_parse_as_a_number():
    """The other half of the same guard: unparseable rather than non-finite.

    `float("1,000,000")` raises ValueError and `float({})` raises TypeError, and
    both reach the caller as the same named input error rather than as a stack
    trace from inside the aggregation.
    """
    for bad in ("1,000,000", "abc", {}, [], None):
        with pytest.raises(EngineInputError, match="must be a number"):
            fair_value_820.fair_value_measurement(positions=[position(fair_value=bad)])


def test_a_clean_820_portfolio_still_measures():
    """Guard tests are only meaningful if the good path is unaffected."""
    result = fair_value_820.fair_value_measurement(
        positions=[
            position(name="Listed equity", fair_value=500_000.0, level="level_1"),
            position(name="Series A preferred", fair_value=1_000_000.0, level="level_3"),
        ]
    )
    assert result["total_fair_value"] == pytest.approx(1_500_000.0)
    assert math.isfinite(result["total_fair_value"])
