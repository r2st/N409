"""`fully_diluted_common` is the count the concluded per-share figure is over.

The summary page of a 409A prints three numbers side by side: the concluded
FMV per common share, the common equity value, and the fully diluted common
count. A reader — a board, an auditor, the IRS — divides the second by the
third and expects the first back, before discounts.

They did not reconcile on the cap-table paths. `allocate_waterfall` values the
option pool as its own class at its own strike, so its `common_value` is what
is left for the *common* classes and its `common_per_share` is over the cap
table's common shares. The result document nonetheless reported
`shares_outstanding_common + options_outstanding`, a strictly larger number, so
the division came out short by the pool's share — 20% on the fixture below.
Both figures were defensible alone; printing them together was not.

`current_value.allocate_cvm` already reported the waterfall's own count, which
is what made the other three paths visibly the outliers.

The contract now: `common_equity_value / fully_diluted_common`, discounted,
equals `fmv_per_share` on every allocation path and every branch within one,
and `fully_diluted_basis` says which count it is.
"""

from __future__ import annotations

import pytest

from app.engine.compute import ALLOCATION_METHODS, compute

DLOC = 0.05
DLOM = 0.10

WEIGHTS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": DLOC,
    "dlom": DLOM,
}

# 8M common, a 2M pool and 4M preferred behind a $10M preference — the shape
# that made the gap 20%, because the pool is a fifth of the fully diluted base.
CAP_TABLE = [
    {"name": "Common", "kind": "common", "shares": 8_000_000},
    {"name": "Pool", "kind": "option", "shares": 2_000_000, "strike": 0.50},
    {
        "name": "Series A",
        "kind": "preferred",
        "shares": 4_000_000,
        "preference": 10_000_000,
        "seniority": 1,
    },
]

BASE_INPUTS = {
    "shares_outstanding_common": 8_000_000,
    "options_outstanding": 2_000_000,
    "shares_outstanding_preferred": 4_000_000,
    "liquidation_preference": 10_000_000,
    "volatility": 0.65,
    "risk_free_rate": 0.04,
    "time_to_exit_years": 4.0,
    "last_round_post_money": 20_000_000,
}

PWERM_SCENARIOS = [
    {"name": "IPO", "probability": 0.6, "equity_value": 50_000_000, "time_to_exit_years": 3.0},
    {"name": "Wind-down", "probability": 0.4, "equity_value": 8_000_000, "time_to_exit_years": 2.0},
]

CASES = {
    "opm": ({}, {"share_classes": CAP_TABLE}),
    "pwerm": (
        {"allocation_method": "pwerm"},
        {"share_classes": CAP_TABLE, "pwerm": {"scenarios": PWERM_SCENARIOS}},
    ),
    "hybrid": (
        {"allocation_method": "hybrid"},
        {
            "share_classes": CAP_TABLE,
            "pwerm": {"scenarios": PWERM_SCENARIOS},
            "hybrid": {"opm_weight": 0.5, "pwerm_weight": 0.5},
        },
    ),
    "cvm": ({"allocation_method": "cvm"}, {"share_classes": CAP_TABLE}),
    # The simulated allocation values the option pool as its own class at its
    # own strike, exactly as the breakpoint waterfall does, so it belongs with
    # the cap-table-basis paths rather than the aggregate ones. Path count kept
    # low: these tests are about which denominator is disclosed, and the
    # reconciliation identity holds path-for-path regardless of sample size.
    "monte_carlo": (
        {"allocation_method": "monte_carlo"},
        {"share_classes": CAP_TABLE, "monte_carlo": {"paths": 4_000}},
    ),
}


def _run(params_extra: dict, inputs_extra: dict) -> dict:
    return compute({**WEIGHTS, **params_extra}, {**BASE_INPUTS, **inputs_extra})["results"]


def _implied_fmv(results: dict) -> float:
    """What a reader of the summary page computes from the printed figures."""
    per_share = results["common_equity_value"] / results["fully_diluted_common"]
    d = results["discounts"]
    return per_share * (1 - d["dloc"]) * (1 - d["dlom"])


class TestDisclosedFiguresReconcile:
    @pytest.mark.parametrize("method", sorted(CASES))
    def test_common_equity_over_the_disclosed_count_is_the_concluded_fmv(self, method):
        results = _run(*CASES[method])
        # Absolute tolerance: `fmv_per_share` is rounded to 4dp and
        # `common_equity_value` to the cent, so the identity holds to the
        # coarser quantum, not to machine precision.
        assert _implied_fmv(results) == pytest.approx(results["fmv_per_share"], abs=5e-4)

    @pytest.mark.parametrize("method", sorted(CASES))
    def test_cap_table_paths_disclose_the_cap_tables_common_count(self, method):
        results = _run(*CASES[method])
        assert results["fully_diluted_basis"] == "cap_table_common"
        assert results["fully_diluted_common"] == 8_000_000

    def test_the_option_pool_is_not_silently_dropped_from_the_valuation(self):
        """The pool leaves the *common* count; it does not leave the cap table.

        The fix moves which denominator is printed, so the thing to hold down
        is that the pool is still valued — as its own class, at its own strike.
        """
        results = _run(*CASES["opm"])
        pool = results["allocation"]["classes"]["Pool"]
        assert pool["kind"] == "option"
        assert pool["value"] > 0


class TestAggregatePathsAreUnchanged:
    """No cap table means no separate option class, so the pool stays folded in."""

    def _aggregate_inputs(self, **extra) -> dict:
        return {k: v for k, v in {**BASE_INPUTS, **extra}.items() if k != "share_classes"}

    def test_single_breakpoint_branch_still_reports_common_plus_options(self):
        results = compute(dict(WEIGHTS), self._aggregate_inputs())["results"]
        assert results["allocation"]["method"] == "opm_single_breakpoint"
        assert results["fully_diluted_basis"] == "common_plus_options"
        assert results["fully_diluted_common"] == 10_000_000
        assert _implied_fmv(results) == pytest.approx(results["fmv_per_share"], abs=5e-4)

    def test_as_converted_branch_still_reports_common_plus_options(self):
        inputs = self._aggregate_inputs()
        del inputs["liquidation_preference"]
        del inputs["shares_outstanding_preferred"]
        results = compute(dict(WEIGHTS), inputs)["results"]
        assert results["allocation"]["method"] == "as_converted"
        assert results["fully_diluted_basis"] == "common_plus_options"
        assert results["fully_diluted_common"] == 10_000_000
        assert _implied_fmv(results) == pytest.approx(results["fmv_per_share"], abs=5e-4)

    def test_cvm_simplified_branch_still_reports_common_plus_options(self):
        results = compute(
            {**WEIGHTS, "allocation_method": "cvm"}, self._aggregate_inputs()
        )["results"]
        assert results["allocation"]["method"] == "cvm_single_preference"
        assert results["fully_diluted_basis"] == "common_plus_options"
        assert results["fully_diluted_common"] == 10_000_000


class TestEveryPathDeclaresItsBasis:
    def test_no_allocation_path_leaves_the_basis_unnamed(self):
        assert set(CASES) == set(ALLOCATION_METHODS)
        for method in ALLOCATION_METHODS:
            results = _run(*CASES[method])
            assert results["fully_diluted_basis"] in ("cap_table_common", "common_plus_options")

    def test_pwerm_still_requires_a_common_share_count(self):
        """The scalar is no longer the disclosed basis, but it is still input.

        A PWERM payload with no `shares_outstanding_common` is incomplete, and
        the check that says so must not have gone away with the field's other
        use.
        """
        params, inputs = CASES["pwerm"]
        payload = {**BASE_INPUTS, **inputs}
        del payload["shares_outstanding_common"]
        with pytest.raises(Exception, match="shares_outstanding_common"):
            compute({**WEIGHTS, **params}, payload)
