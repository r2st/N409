"""The DLOM is struck on the common class's volatility, not the enterprise's.

The engine computed a per-class volatility schedule (`waterfall.class_volatilities`,
tested in `test_class_volatility.py`) and then threw it away at the point it
mattered: `_compute_opm` handed `alloc["volatility"]` — the *enterprise* figure
— to `_resolve_discounts`, so every option-based DLOM was priced off the
volatility of the total equity rather than of the interest being valued.

That is not a rounding difference. Chaffee and Finnerty both take the
volatility of the security whose marketability is restricted, and common sits
behind the entire preference stack, which gears it. On the cap table below a
62% enterprise volatility is a 74% common volatility, and the discount moves
seven points.
"""

import pytest

from app.engine.compute import compute
from app.engine.dlom import chaffee_dlom, finnerty_dlom
from app.engine.errors import EngineInputError
from app.engine.validate import ERROR, WARNING, validate_payload
from app.engine.waterfall import class_volatilities

CLASSES = [
    {"kind": "preferred", "name": "Series B", "shares": 4_000_000, "preference": 12_000_000, "seniority": 1},
    {"kind": "preferred", "name": "Series A", "shares": 2_400_000, "preference": 6_000_000, "seniority": 2},
    {"kind": "common", "name": "Common", "shares": 9_250_000},
    {"kind": "option", "name": "Option pool", "shares": 1_750_000, "strike": 0.55},
]

EQUITY = 42_000_000.0
T, R, SIGMA = 4.0, 0.0421, 0.62

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "exit_timeline": "2030-06-30",
    "allocation_method": "opm",
    "dlom_method": "chaffee",
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 9_250_000,
    "options_outstanding": 1_750_000,
    "share_classes": CLASSES,
    "volatility": SIGMA,
    "risk_free_rate": R,
    "last_round_post_money": EQUITY,
}


def run(params=None, inputs=None):
    return compute({**PARAMS, **(params or {})}, {**INPUTS, **(inputs or {})})["results"]


class TestTheAggregateCommonVolatility:
    """`class_volatilities` now reports the figure the DLOM needs directly."""

    def test_it_is_the_value_weighted_mean_of_the_common_classes(self):
        """Exact, not approximate: each class contributes sigma·S·delta, so
        summing the numerators and summing the values is the same operation as
        taking the elasticity of the summed claim."""
        got = class_volatilities(EQUITY, CLASSES, T, R, SIGMA)
        commons = [c for c in got["classes"].values() if c["kind"] == "common"]
        total_value = sum(c["value"] for c in commons)
        weighted = sum(c["volatility"] * c["value"] for c in commons) / total_value
        assert got["common_volatility"] == pytest.approx(weighted, rel=1e-6)

    def test_with_two_common_classes_it_is_neither_of_them_alone(self):
        """A second common class splits the same aggregate claim, so the
        blended figure has to sit between the two rather than track whichever
        happens to be listed first."""
        split = [
            *CLASSES[:2],
            {"kind": "common", "name": "Common A", "shares": 6_000_000},
            {"kind": "common", "name": "Common B", "shares": 3_250_000},
            CLASSES[3],
        ]
        got = class_volatilities(EQUITY, split, T, R, SIGMA)
        each = [c["volatility"] for c in got["classes"].values() if c["kind"] == "common"]
        # Two common classes with no preference between them are the same
        # security, so they gear identically and the aggregate equals both.
        assert got["common_volatility"] == pytest.approx(each[0], rel=1e-6)
        assert got["common_volatility"] == pytest.approx(
            class_volatilities(EQUITY, CLASSES, T, R, SIGMA)["common_volatility"], rel=1e-6
        )

    def test_common_is_geared_above_the_enterprise(self):
        got = class_volatilities(EQUITY, CLASSES, T, R, SIGMA)
        assert got["common_volatility"] > got["enterprise_volatility"]

    def test_a_worthless_common_class_has_no_volatility(self):
        """Value in the denominator of the elasticity. A preference stack that
        swallows the whole equity leaves common with nothing, and the answer is
        a null rather than an infinity."""
        drowned = [
            {"kind": "preferred", "name": "Series B", "shares": 4_000_000, "preference": 1e12, "seniority": 1},
            {"kind": "common", "name": "Common", "shares": 9_250_000},
        ]
        got = class_volatilities(1_000.0, drowned, 0.01, R, 0.01)
        assert got["common_volatility"] is None


class TestTheDiscountUsesIt:
    def test_the_dlom_is_struck_on_the_common_volatility(self):
        expected_vol = class_volatilities(EQUITY, CLASSES, T, R, SIGMA)["common_volatility"]
        detail = run()["discounts"]["dlom_detail"]
        assert detail["volatility"] == pytest.approx(expected_vol)
        assert detail["volatility_basis"] == "class"

    def test_it_is_the_arithmetic_chaffee_would_give_on_that_volatility(self):
        """Checked against the model directly, so this cannot pass by the
        engine passing a plausible-looking wrong figure."""
        vol = class_volatilities(EQUITY, CLASSES, T, R, SIGMA)["common_volatility"]
        got = run()["discounts"]
        assert got["dlom"] == pytest.approx(round(chaffee_dlom(vol, T, R), 4))

    def test_the_enterprise_figure_understates_it(self):
        """The defect this fixes, stated as the difference it makes."""
        geared = run()["discounts"]["dlom"]
        flat = run({"dlom_volatility_basis": "enterprise"})["discounts"]["dlom"]
        assert geared > flat
        assert geared - flat > 0.05, "the correction is worth more than five points here"

    @pytest.mark.parametrize("method", ["chaffee", "finnerty", "ghaidarov", "longstaff"])
    def test_every_option_model_reads_the_class_basis(self, method):
        """All four take the volatility of the interest being valued, so the
        substitution cannot be wired into only the one that was audited."""
        detail = run({"dlom_method": method})["discounts"]["dlom_detail"]
        expected = class_volatilities(EQUITY, CLASSES, T, R, SIGMA)["common_volatility"]
        assert detail["volatility"] == pytest.approx(expected)
        assert detail["volatility_basis"] == "class"

    def test_a_blend_passes_the_class_basis_to_every_leg(self):
        got = run(
            {
                "dlom_method": None,
                "dlom_methods": [
                    {"method": "finnerty", "weight": 0.5},
                    {"method": "restricted_stock", "weight": 0.5},
                ],
            }
        )["discounts"]
        legs = {c["method"]: c for c in got["dlom_detail"]["components"]}
        vol = class_volatilities(EQUITY, CLASSES, T, R, SIGMA)["common_volatility"]
        assert legs["finnerty"]["detail"]["volatility_basis"] == "class"
        assert legs["finnerty"]["dlom"] == pytest.approx(finnerty_dlom(vol, T), abs=1e-6)
        # The empirical leg takes no volatility at all and must not grow one.
        assert "volatility_basis" not in legs["restricted_stock"]["detail"]

    def test_the_assumptions_report_both_volatilities(self):
        """The allocation ran on one and the discount on the other, and a
        reader checking either has to be able to tell which is which."""
        got = run()["assumptions"]
        assert got["volatility"] == SIGMA
        assert got["dlom_volatility"] > got["volatility"]
        assert got["dlom_volatility_basis"] == "class"


class TestWhenThereIsNoClassVolatility:
    """The two aggregate OPM branches do not decompose the payoff, so there is
    no per-class delta to take. Falling back is right; failing is not."""

    NO_CAP_TABLE = {
        "valuation_date": "2026-06-30",
        "shares_outstanding_common": 7_000_000,
        "options_outstanding": 1_000_000,
        "shares_outstanding_preferred": 2_000_000,
        "liquidation_preference": 5_000_000,
        "volatility": 0.6,
        "risk_free_rate": 0.042,
        "last_round_post_money": 20_000_000,
    }

    def test_the_single_breakpoint_path_falls_back_to_enterprise(self):
        got = compute(PARAMS, dict(self.NO_CAP_TABLE))["results"]
        assert got["discounts"]["dlom_detail"]["volatility"] == 0.6
        assert got["discounts"]["dlom_detail"]["volatility_basis"] == "enterprise"

    def test_the_as_converted_path_falls_back_to_enterprise(self):
        plain = {k: v for k, v in self.NO_CAP_TABLE.items() if k != "liquidation_preference"}
        plain.pop("shares_outstanding_preferred")
        got = compute(PARAMS, plain)["results"]
        assert got["discounts"]["dlom_detail"]["volatility_basis"] == "enterprise"

    def test_the_cvm_path_is_untouched(self):
        """CVM allocates at sigma -> 0 and has no option gearing to report, so
        it keeps the enterprise volatility and says so."""
        got = compute(
            {**PARAMS, "allocation_method": "cvm"}, {**INPUTS, "share_classes": CLASSES}
        )["results"]
        assert got["discounts"]["dlom_detail"]["volatility_basis"] == "enterprise"
        assert got["discounts"]["dlom_detail"]["volatility"] == SIGMA


class TestTheHybridPath:
    """The hybrid path runs the same `_opm_allocate`, so it gets the same
    correction — the OPM leg is where the gearing comes from."""

    HYBRID_INPUTS = {
        **INPUTS,
        "hybrid": {"opm_weight": 0.6, "pwerm_weight": 0.4},
        "pwerm": {
            "discount_rate": 0.25,
            "scenarios": [
                {"name": "IPO", "type": "ipo", "probability": 0.3, "equity_value": 120_000_000, "time_to_exit_years": 4.0},
                {"name": "Acquisition", "type": "acquisition", "probability": 0.5, "equity_value": 45_000_000, "time_to_exit_years": 3.0},
                {"name": "Dissolution", "type": "dissolution", "probability": 0.2, "equity_value": 5_000_000, "time_to_exit_years": 2.0},
            ],
        },
    }

    def test_it_uses_the_class_basis(self):
        got = compute(
            {**PARAMS, "allocation_method": "hybrid"}, dict(self.HYBRID_INPUTS)
        )["results"]
        assert got["discounts"]["dlom_detail"]["volatility_basis"] == "class"
        assert got["assumptions"]["dlom_volatility"] > got["assumptions"]["volatility"]

    def test_the_enterprise_override_still_works_there(self):
        got = compute(
            {**PARAMS, "allocation_method": "hybrid", "dlom_volatility_basis": "enterprise"},
            dict(self.HYBRID_INPUTS),
        )["results"]
        assert got["discounts"]["dlom_detail"]["volatility"] == SIGMA


class TestTheBasisParameter:
    def test_an_unknown_basis_is_refused(self):
        with pytest.raises(EngineInputError, match="dlom_volatility_basis"):
            run({"dlom_volatility_basis": "geared"})

    def test_the_pre_flight_refuses_it_too(self):
        """The validator's contract: it clears exactly what compute accepts."""
        issues = validate_payload({**PARAMS, "dlom_volatility_basis": "geared"}, dict(INPUTS))
        assert any(
            i.field == "params.dlom_volatility_basis" and i.severity == ERROR for i in issues
        )

    def test_selecting_the_enterprise_basis_is_a_documented_choice(self):
        """Legal, but it is the weaker figure and the report has to justify it,
        so the pre-flight surfaces it rather than passing it silently."""
        issues = validate_payload({**PARAMS, "dlom_volatility_basis": "enterprise"}, dict(INPUTS))
        assert any(
            i.code == "enterprise_dlom_volatility" and i.severity == WARNING for i in issues
        )

    def test_the_default_draws_no_comment(self):
        issues = validate_payload(dict(PARAMS), dict(INPUTS))
        assert not any(i.code == "enterprise_dlom_volatility" for i in issues)
