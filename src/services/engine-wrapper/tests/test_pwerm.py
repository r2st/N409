"""PWERM allocation: deterministic exit waterfall, probability weighting, and
the compute() / API wiring."""

import pytest
from fastapi.testclient import TestClient

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.pwerm import allocate_pwerm
from app.engine.waterfall import exit_allocation
from app.main import app

client = TestClient(app)

# 1M common + 1M non-participating preferred with a $5M preference, converts 1:1.
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


# ── Deterministic exit allocation (σ→0 waterfall) ────────────────────────────


def test_exit_allocation_below_breakpoint_pays_preference():
    alloc = exit_allocation(5_000_000, CAP_TABLE)
    assert alloc["classes"]["Series A"]["value"] == pytest.approx(5_000_000)
    assert alloc["classes"]["Common"]["value"] == pytest.approx(0.0)
    assert alloc["common_per_share"] == pytest.approx(0.0)


def test_exit_allocation_conserves_value():
    for exit_value in (0, 3_000_000, 5_000_000, 12_345_678, 50_000_000):
        alloc = exit_allocation(exit_value, CAP_TABLE)
        total = sum(c["value"] for c in alloc["classes"].values())
        assert total == pytest.approx(exit_value, abs=0.5)


def test_exit_allocation_conversion_point():
    # Preferred is indifferent at $10M (pref $5M vs as-converted $5M); above it
    # converts and shares residual 50/50.
    alloc = exit_allocation(10_000_000, CAP_TABLE)
    assert alloc["classes"]["Common"]["value"] == pytest.approx(5_000_000)
    assert alloc["classes"]["Series A"]["value"] == pytest.approx(5_000_000)

    alloc12 = exit_allocation(12_000_000, CAP_TABLE)
    assert alloc12["classes"]["Common"]["value"] == pytest.approx(6_000_000)
    assert alloc12["classes"]["Series A"]["value"] == pytest.approx(6_000_000)


def test_exit_allocation_rejects_negative():
    with pytest.raises(EngineInputError):
        exit_allocation(-1, CAP_TABLE)


# ── PWERM probability weighting + discounting ────────────────────────────────

SCENARIOS = [
    {"name": "IPO", "type": "ipo", "probability": 0.4, "equity_value": 20_000_000, "time_to_exit_years": 2, "discount_rate": 0.25},
    {"name": "Liquidation", "type": "liquidation", "probability": 0.6, "equity_value": 5_000_000, "time_to_exit_years": 1, "discount_rate": 0.25},
]


def test_allocate_pwerm_weighted_present_values():
    out = allocate_pwerm(SCENARIOS, CAP_TABLE, default_discount_rate=0.25)
    # Common: IPO common $10M / 1.25^2 = $6.4M, weighted 0.4 → $2.56M; liq $0.
    assert out["common_value"] == pytest.approx(2_560_000, abs=1)
    assert out["common_per_share"] == pytest.approx(2.56, abs=1e-4)
    # Total equity is the sum across classes and equals scenario PV weighting.
    assert out["equity_value"] == pytest.approx(7_520_000, abs=1)
    assert out["classes"]["Series A"]["present_value"] == pytest.approx(4_960_000, abs=1)
    assert out["expected_time_to_exit_years"] == pytest.approx(0.4 * 2 + 0.6 * 1)
    assert len(out["scenarios"]) == 2
    assert out["scenarios"][0]["common_present_value"] == pytest.approx(6_400_000, abs=1)


def test_allocate_pwerm_uses_default_discount_rate():
    scenarios = [
        {"probability": 0.5, "equity_value": 20_000_000, "time_to_exit_years": 1},
        {"probability": 0.5, "equity_value": 20_000_000, "time_to_exit_years": 1},
    ]
    out = allocate_pwerm(scenarios, CAP_TABLE, default_discount_rate=0.25)
    # Both scenarios: common $10M / 1.25 = $8M; weighted still $8M.
    assert out["common_value"] == pytest.approx(8_000_000, abs=1)


def test_allocate_pwerm_bridges_enterprise_value():
    scenarios = [{"probability": 1.0, "enterprise_value": 18_000_000, "time_to_exit_years": 0}]
    out = allocate_pwerm(scenarios, CAP_TABLE, default_discount_rate=0.2, cash=2_000_000, debt=0)
    # EV 18M + cash 2M = equity 20M at t=0 → common $10M.
    assert out["common_value"] == pytest.approx(10_000_000, abs=1)


def test_allocate_pwerm_probabilities_must_sum_to_one():
    scenarios = [
        {"probability": 0.4, "equity_value": 20_000_000},
        {"probability": 0.4, "equity_value": 5_000_000},
    ]
    with pytest.raises(EngineInputError, match="sum to 1"):
        allocate_pwerm(scenarios, CAP_TABLE, default_discount_rate=0.25)


def test_allocate_pwerm_rejects_empty_scenarios():
    with pytest.raises(EngineInputError, match="non-empty"):
        allocate_pwerm([], CAP_TABLE, default_discount_rate=0.25)


def test_allocate_pwerm_requires_a_value():
    with pytest.raises(EngineInputError, match="equity_value or enterprise_value"):
        allocate_pwerm(
            [{"probability": 1.0, "time_to_exit_years": 1}],
            CAP_TABLE,
            default_discount_rate=0.25,
        )


# ── compute() integration + API ──────────────────────────────────────────────

PWERM_PARAMS = {"allocation_method": "pwerm", "dloc": 0.0, "dlom": 0.2}
PWERM_INPUTS = {
    "shares_outstanding_common": 1_000_000,
    "share_classes": CAP_TABLE,
    "pwerm": {"scenarios": SCENARIOS},
}


def test_compute_pwerm_applies_dlom():
    out = compute(PWERM_PARAMS, PWERM_INPUTS)
    res = out["results"]
    assert res["allocation_method"] == "pwerm"
    assert res["allocation"]["method"] == "pwerm"
    # Common per share $2.56, less 20% DLOM → $2.048.
    assert res["fmv_per_share"] == pytest.approx(2.048, abs=1e-3)
    assert res["equity_value"] == pytest.approx(7_520_000, abs=1)


def test_compute_pwerm_requires_scenarios():
    with pytest.raises(EngineInputError, match="inputs.pwerm"):
        compute(PWERM_PARAMS, {"shares_outstanding_common": 1_000_000, "share_classes": CAP_TABLE})


def test_compute_rejects_unknown_allocation_method():
    with pytest.raises(EngineInputError, match="allocation_method"):
        compute({"allocation_method": "wacky"}, PWERM_INPUTS)


def test_api_compute_pwerm():
    resp = client.post(
        "/engine/v1/compute", json={"params": PWERM_PARAMS, "inputs": PWERM_INPUTS}
    )
    assert resp.status_code == 200, resp.text
    res = resp.json()["results"]
    assert res["allocation_method"] == "pwerm"
    assert res["fmv_per_share"] == pytest.approx(2.048, abs=1e-3)


def test_api_compute_pwerm_bad_scenarios_is_422():
    bad = {"params": PWERM_PARAMS, "inputs": {"shares_outstanding_common": 1_000_000, "share_classes": CAP_TABLE, "pwerm": {"scenarios": [{"probability": 0.5, "equity_value": 1_000_000}]}}}
    resp = client.post("/engine/v1/compute", json=bad)
    assert resp.status_code == 422
