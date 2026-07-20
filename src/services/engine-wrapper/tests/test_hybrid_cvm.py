"""Hybrid (OPM+PWERM blend) and Current Value Method (CVM) allocation paths."""

import pytest

from app.engine.compute import compute
from app.engine.current_value import allocate_cvm
from app.engine.errors import EngineInputError
from app.engine.hybrid import blend_hybrid, resolve_hybrid_weights

# 1M common + 1M non-participating preferred, $5M preference, converts 1:1.
CAP_TABLE = [
    {"name": "Common", "kind": "common", "shares": 1_000_000},
    {
        "name": "Series A",
        "kind": "preferred",
        "shares": 1_000_000,
        "preference": 5_000_000,
        "seniority": 1,
        "participating": False,
        "conversion_ratio": 1.0,
    },
]

# weight_asset = 1.0 gives a deterministic weighted equity value from NAV.
BASE_PARAMS = {
    "weight_asset": 1.0,
    "weight_opm": 0.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.0,
    "dlom": 0.0,
}

BASE_INPUTS = {
    "asset": {"total_assets": 10_000_000, "total_liabilities": 0},
    "shares_outstanding_common": 1_000_000,
    "share_classes": CAP_TABLE,
    "volatility": 0.5,
    "time_to_exit_years": 3.0,
    "risk_free_rate": 0.04,
    # Two equally likely exits, no discounting → PWERM common per share = 5.0.
    "pwerm": {
        "scenarios": [
            {"name": "Acquisition", "type": "acquisition", "probability": 0.5, "equity_value": 20_000_000, "time_to_exit_years": 0.0},
            {"name": "Downside", "type": "liquidation", "probability": 0.5, "equity_value": 5_000_000, "time_to_exit_years": 0.0},
        ],
    },
}


# ── CVM ──────────────────────────────────────────────────────────────────────


def test_cvm_allocates_at_current_value_via_cap_table():
    # At a $10M current equity value the preferred is indifferent (pref $5M vs
    # as-converted $5M): common gets $5M over 1M shares → $5.00/share.
    params = {**BASE_PARAMS, "allocation_method": "cvm"}
    out = compute(params, BASE_INPUTS)
    res = out["results"]
    assert res["allocation"]["method"] == "cvm_waterfall"
    assert res["fmv_per_share"] == pytest.approx(5.0)
    assert res["allocation_method"] == "cvm"


def test_cvm_distressed_common_is_wiped_out_below_preference():
    # $3M equity value is entirely consumed by the $5M preference stack.
    alloc = allocate_cvm(3_000_000, {"share_classes": CAP_TABLE})
    assert alloc["common_value"] == pytest.approx(0.0)
    assert alloc["common_per_share"] == pytest.approx(0.0)


def test_cvm_simple_path_without_share_classes():
    # No explicit cap table: synthetic single-preference structure. At $10M the
    # $5M preference leaves $5M residual shared as-converted 50/50 → common $5M.
    alloc = allocate_cvm(
        10_000_000,
        {
            "shares_outstanding_common": 1_000_000,
            "shares_outstanding_preferred": 1_000_000,
            "liquidation_preference": 5_000_000,
        },
    )
    assert alloc["method"] == "cvm_single_preference"
    assert alloc["common_per_share"] == pytest.approx(5.0)


def test_cvm_common_only_pro_rata():
    alloc = allocate_cvm(8_000_000, {"shares_outstanding_common": 2_000_000})
    assert alloc["method"] == "cvm_common_only"
    assert alloc["common_per_share"] == pytest.approx(4.0)


def test_cvm_rejects_nonpositive_equity():
    with pytest.raises(EngineInputError):
        allocate_cvm(0.0, {"share_classes": CAP_TABLE})


# ── Hybrid ───────────────────────────────────────────────────────────────────


def _fmv(method: str, inputs: dict = BASE_INPUTS) -> float:
    return compute({**BASE_PARAMS, "allocation_method": method}, inputs)["results"]["fmv_per_share"]


def test_hybrid_full_weights_reduce_to_each_method():
    opm_fmv = _fmv("opm")
    pwerm_fmv = _fmv("pwerm")

    only_opm = compute(
        {**BASE_PARAMS, "allocation_method": "hybrid"},
        {**BASE_INPUTS, "hybrid": {"opm_weight": 1.0, "pwerm_weight": 0.0}},
    )["results"]["fmv_per_share"]
    only_pwerm = compute(
        {**BASE_PARAMS, "allocation_method": "hybrid"},
        {**BASE_INPUTS, "hybrid": {"opm_weight": 0.0, "pwerm_weight": 1.0}},
    )["results"]["fmv_per_share"]

    assert only_opm == pytest.approx(opm_fmv, abs=1e-4)
    assert only_pwerm == pytest.approx(pwerm_fmv, abs=1e-4)


def test_hybrid_blends_linearly_with_no_discounts():
    opm_fmv = _fmv("opm")
    pwerm_fmv = _fmv("pwerm")
    out = compute(
        {**BASE_PARAMS, "allocation_method": "hybrid"},
        {**BASE_INPUTS, "hybrid": {"opm_weight": 0.5, "pwerm_weight": 0.5}},
    )["results"]
    assert out["allocation"]["method"] == "hybrid"
    assert out["fmv_per_share"] == pytest.approx(0.5 * opm_fmv + 0.5 * pwerm_fmv, abs=1e-4)
    # Blended equity value is the convex combination of the two legs.
    assert out["allocation"]["weights"] == {"opm": 0.5, "pwerm": 0.5}


def test_hybrid_defaults_to_5050_weights():
    weights = resolve_hybrid_weights({})
    assert weights == {"opm": 0.5, "pwerm": 0.5}


def test_hybrid_rejects_weights_not_summing_to_one():
    with pytest.raises(EngineInputError):
        resolve_hybrid_weights({"hybrid": {"opm_weight": 0.7, "pwerm_weight": 0.7}})


def test_blend_hybrid_convex_combination():
    blend = blend_hybrid(
        {"equity_value": 10.0, "common_per_share": 2.0, "time_to_exit_years": 3.0, "allocation": {}},
        {"equity_value": 20.0, "common_per_share": 6.0, "expected_time_to_exit_years": 1.0},
        {"opm": 0.25, "pwerm": 0.75},
    )
    assert blend["common_per_share"] == pytest.approx(0.25 * 2.0 + 0.75 * 6.0)
    assert blend["equity_value"] == pytest.approx(0.25 * 10.0 + 0.75 * 20.0)
    assert blend["blended_time_to_exit_years"] == pytest.approx(0.25 * 3.0 + 0.75 * 1.0)


# ── Dispatch guard ───────────────────────────────────────────────────────────


def test_compute_rejects_unknown_allocation_method():
    with pytest.raises(EngineInputError):
        compute({**BASE_PARAMS, "allocation_method": "bogus"}, BASE_INPUTS)
