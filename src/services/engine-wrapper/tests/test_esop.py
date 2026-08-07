"""ESOP valuation engine unit tests (feature: ESOP Valuation)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.esop import (
    dloc_from_control_premium,
    esop_share_value,
    repurchase_obligation,
)


# ── DLOC / control premium duality ───────────────────────────────────────────


def test_dloc_from_control_premium_inverts():
    # 25% premium ⇒ 20% DLOC: 1 − 1/1.25.
    assert dloc_from_control_premium(0.25) == pytest.approx(0.20)
    assert dloc_from_control_premium(0.0) == 0.0


# ── Level-of-value chain ─────────────────────────────────────────────────────


def test_control_basis_steps_down_through_both_discounts():
    out = esop_share_value(
        equity_value=10_000_000.0,
        shares_outstanding=1_000_000.0,
        value_basis="control",
        dloc=0.20,
        dlom=0.10,
    )
    assert out["levels"]["control"] == pytest.approx(10_000_000.0)
    assert out["levels"]["marketable_minority"] == pytest.approx(8_000_000.0)
    assert out["levels"]["nonmarketable_minority"] == pytest.approx(7_200_000.0)
    assert out["fmv_per_share"] == pytest.approx(7.20)


def test_control_premium_input_equals_equivalent_dloc():
    via_premium = esop_share_value(
        equity_value=10_000_000.0,
        shares_outstanding=1_000_000.0,
        control_premium=0.25,
        dlom=0.0,
    )
    via_dloc = esop_share_value(
        equity_value=10_000_000.0,
        shares_outstanding=1_000_000.0,
        dloc=0.20,
        dlom=0.0,
    )
    assert via_premium["fmv_per_share"] == pytest.approx(via_dloc["fmv_per_share"])


def test_minority_basis_applies_only_dlom_and_discloses_control():
    out = esop_share_value(
        equity_value=8_000_000.0,
        shares_outstanding=1_000_000.0,
        value_basis="minority",
        dloc=0.20,
        dlom=0.10,
    )
    # Conclusion: 8M × 0.9 / 1M shares — DLOC must not touch it.
    assert out["fmv_per_share"] == pytest.approx(7.20)
    # Control level disclosed by stepping UP.
    assert out["levels"]["control"] == pytest.approx(10_000_000.0)


def test_no_discounts_is_a_passthrough():
    out = esop_share_value(equity_value=5_000_000.0, shares_outstanding=500_000.0)
    assert out["fmv_per_share"] == pytest.approx(10.0)


def test_esop_stake_value():
    out = esop_share_value(
        equity_value=10_000_000.0,
        shares_outstanding=1_000_000.0,
        dlom=0.10,
        esop_shares=300_000.0,
    )
    assert out["esop_stake_value"] == pytest.approx(out["fmv_per_share"] * 300_000.0)


def test_both_dloc_and_premium_rejected():
    with pytest.raises(EngineInputError, match="not both"):
        esop_share_value(
            equity_value=1.0, shares_outstanding=1.0, dloc=0.2, control_premium=0.25
        )


def test_esop_shares_above_outstanding_rejected():
    with pytest.raises(EngineInputError, match="exceeds"):
        esop_share_value(equity_value=1.0, shares_outstanding=100.0, esop_shares=101.0)


def test_bad_basis_rejected():
    with pytest.raises(EngineInputError, match="value_basis"):
        esop_share_value(equity_value=1.0, shares_outstanding=1.0, value_basis="strategic")


def test_zero_shares_rejected():
    with pytest.raises(EngineInputError, match="must be positive"):
        esop_share_value(equity_value=1.0, shares_outstanding=0.0)


# ── Repurchase obligation ────────────────────────────────────────────────────


def test_repurchase_survival_process_never_exhausts():
    out = repurchase_obligation(
        esop_share_balance=100_000.0,
        fmv_per_share=10.0,
        annual_redemption_rate=0.10,
        years=10,
    )
    assert out["ending_share_balance"] == pytest.approx(100_000.0 * 0.9**10)
    assert out["ending_share_balance"] > 0
    assert len(out["schedule"]) == 10


def test_repurchase_first_year_manual():
    out = repurchase_obligation(
        esop_share_balance=100_000.0,
        fmv_per_share=10.0,
        share_value_growth=0.05,
        annual_redemption_rate=0.10,
        years=1,
    )
    row = out["schedule"][0]
    assert row["share_price"] == pytest.approx(10.5)
    assert row["shares_redeemed"] == pytest.approx(10_000.0)
    assert row["repurchase_cost"] == pytest.approx(105_000.0)
    assert out["total_obligation"] == pytest.approx(105_000.0)


def test_repurchase_pv_discounts_when_rate_given():
    undiscounted = repurchase_obligation(
        esop_share_balance=100_000.0, fmv_per_share=10.0, annual_redemption_rate=0.10, years=5
    )
    discounted = repurchase_obligation(
        esop_share_balance=100_000.0,
        fmv_per_share=10.0,
        annual_redemption_rate=0.10,
        years=5,
        discount_rate=0.08,
    )
    assert undiscounted["pv_of_obligation"] is None
    assert discounted["pv_of_obligation"] < discounted["total_obligation"]
    assert discounted["total_obligation"] == pytest.approx(undiscounted["total_obligation"])


def test_repurchase_full_redemption_first_year():
    out = repurchase_obligation(
        esop_share_balance=1_000.0, fmv_per_share=10.0, annual_redemption_rate=1.0, years=3
    )
    assert out["schedule"][0]["shares_redeemed"] == pytest.approx(1_000.0)
    assert out["ending_share_balance"] == pytest.approx(0.0)
    assert out["schedule"][1]["repurchase_cost"] == pytest.approx(0.0)


def test_repurchase_years_bounds():
    with pytest.raises(EngineInputError, match="between 1 and"):
        repurchase_obligation(
            esop_share_balance=1.0, fmv_per_share=1.0, annual_redemption_rate=0.1, years=0
        )
    with pytest.raises(EngineInputError, match="between 1 and"):
        repurchase_obligation(
            esop_share_balance=1.0, fmv_per_share=1.0, annual_redemption_rate=0.1, years=99
        )


def test_repurchase_non_integer_years_rejected():
    with pytest.raises(EngineInputError, match="integer"):
        repurchase_obligation(
            esop_share_balance=1.0, fmv_per_share=1.0, annual_redemption_rate=0.1, years=2.5
        )


def test_repurchase_redemption_rate_above_one_rejected():
    with pytest.raises(EngineInputError, match="<= 1"):
        repurchase_obligation(
            esop_share_balance=1.0, fmv_per_share=1.0, annual_redemption_rate=1.5, years=3
        )
