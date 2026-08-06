"""Every allocation path names itself in `results.allocation_method`.

Three of the four did. The OPM path — the default, and the one nearly every
409A runs through — did not, leaving consumers to fall back to
`results.allocation.method`. That field is a different vocabulary: it names the
*mechanism* the OPM used ("opm_waterfall", "opm_single_breakpoint",
"as_converted"), not the allocation method the analyst chose.

The report service fell back exactly that way and had no label for the
mechanism names, so its unmapped-key path fired and the summary page of a
board-facing 409A read "Allocation method: OPM_WATERFALL".

So the contract is: whatever `params.allocation_method` selected comes back
under the same name, on every path and every branch within a path.
"""

from __future__ import annotations

import pytest

from app.engine.compute import ALLOCATION_METHODS, compute

BASE_INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "last_round_post_money": 30_000_000,
}

OPM_WEIGHTS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.05,
    "dlom": 0.2,
}

CAP_TABLE = [
    {"name": "Common", "kind": "common", "shares": 7_000_000},
    {
        "name": "Series A",
        "kind": "preferred",
        "shares": 2_000_000,
        "preference": 5_000_000,
        "seniority": 1,
    },
]

PWERM_SCENARIOS = [
    {"name": "IPO", "probability": 0.3, "equity_value": 120_000_000, "years_to_exit": 4.0},
    {"name": "M&A", "probability": 0.5, "equity_value": 40_000_000, "years_to_exit": 3.0},
    {"name": "Wind-down", "probability": 0.2, "equity_value": 5_000_000, "years_to_exit": 2.0},
]


def _opm(**extra) -> dict:
    return compute(dict(OPM_WEIGHTS), {**BASE_INPUTS, **extra})["results"]


class TestOpmPathNamesItself:
    """All three OPM allocation branches, since the mechanism differs by branch."""

    def test_waterfall_branch(self):
        results = _opm(share_classes=CAP_TABLE)
        assert results["allocation"]["method"] == "opm_waterfall"
        assert results["allocation_method"] == "opm"

    def test_single_breakpoint_branch(self):
        results = _opm(shares_outstanding_preferred=2_000_000, liquidation_preference=5_000_000)
        assert results["allocation"]["method"] == "opm_single_breakpoint"
        assert results["allocation_method"] == "opm"

    def test_as_converted_branch(self):
        results = _opm()
        assert results["allocation"]["method"] == "as_converted"
        assert results["allocation_method"] == "opm"

    def test_naming_does_not_disturb_the_arithmetic(self):
        """A label is metadata — the concluded value must be untouched by it.

        Tolerance is absolute, not relative: `fmv_per_share` is the response's
        rounded figure (4dp) while `common_per_share` is the allocation's (6dp),
        so the identity holds only to the coarser of the two quanta.
        """
        results = _opm(share_classes=CAP_TABLE)
        assert results["fmv_per_share"] == pytest.approx(
            results["allocation"]["common_per_share"] * (1 - 0.05) * (1 - 0.2), abs=5e-5
        )


class TestEveryPathNamesItself:
    @pytest.mark.parametrize(
        "method, params, inputs",
        [
            ("opm", OPM_WEIGHTS, {"share_classes": CAP_TABLE}),
            (
                "pwerm",
                {**OPM_WEIGHTS, "allocation_method": "pwerm"},
                {"share_classes": CAP_TABLE, "pwerm": {"scenarios": PWERM_SCENARIOS}},
            ),
            (
                "hybrid",
                {**OPM_WEIGHTS, "allocation_method": "hybrid"},
                {
                    "share_classes": CAP_TABLE,
                    "pwerm": {"scenarios": PWERM_SCENARIOS},
                    "hybrid": {"opm_weight": 0.5, "pwerm_weight": 0.5},
                },
            ),
            ("cvm", {**OPM_WEIGHTS, "allocation_method": "cvm"}, {"share_classes": CAP_TABLE}),
        ],
    )
    def test_result_echoes_the_selected_method(self, method, params, inputs):
        results = compute(dict(params), {**BASE_INPUTS, **inputs})["results"]
        assert results["allocation_method"] == method

    def test_no_allocation_method_is_left_unnamed(self):
        """Guards the next path added: the parametrisation above covers the set."""
        covered = {"opm", "pwerm", "hybrid", "cvm"}
        assert set(ALLOCATION_METHODS) == covered
