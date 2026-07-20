"""Roll-forward / calibration engine tests."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.rollforward import roll_forward
from app.main import app

client = TestClient(app)

PRIOR = {"results": {"equity_value": 10_000_000.0, "approaches": {"income": {"discount_rate": 0.2}}}}


def test_time_accretion():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2025-07-20",
        new_valuation_date="2026-07-20",
        annual_accretion=0.20,
    )
    # ~1 year at 20% → ~12M (365/365.25 exponent).
    assert out["rolled_equity_value"] == pytest.approx(10_000_000 * 1.20**(365 / 365.25), rel=1e-4)
    assert out["pre_populated_inputs"]["last_round_post_money"] == out["rolled_equity_value"]
    assert out["pre_populated_inputs"]["valuation_date"] == "2026-07-20"


def test_default_accretion_uses_prior_discount_rate():
    out = roll_forward(
        PRIOR, prior_valuation_date="2025-07-20", new_valuation_date="2026-07-20"
    )
    assert out["annual_accretion"] == pytest.approx(0.20)  # from prior income discount_rate


def test_new_round_overrides_time_decay():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2025-01-01",
        new_valuation_date="2026-01-01",
        new_round_post_money=25_000_000.0,
    )
    assert out["rolled_equity_value"] == 25_000_000.0
    assert any(c["field"] == "new_round" and c["material"] for c in out["material_changes"])
    assert out["requires_full_revaluation"] is True


def test_value_adjustments_apply_in_order():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2026-01-01",
        new_valuation_date="2026-01-01",  # no time gap
        annual_accretion=0.0,
        value_adjustments=[{"label": "down round markdown", "pct": -0.30}],
    )
    assert out["rolled_equity_value"] == pytest.approx(7_000_000.0)


def test_material_change_detection():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2026-01-01",
        new_valuation_date="2026-04-01",
        annual_accretion=0.1,
        prior_inputs={"revenue": 1_000_000, "shares_outstanding_common": 7_000_000},
        updated_inputs={"revenue": 1_500_000, "shares_outstanding_common": 8_000_000},
    )
    fields = {c["field"]: c for c in out["material_changes"]}
    assert fields["revenue"]["material"] is True
    assert fields["revenue"]["delta_pct"] == pytest.approx(0.5)
    assert fields["shares_outstanding_common"]["material"] is True


def test_immaterial_revenue_move_flagged_nonmaterial():
    out = roll_forward(
        PRIOR,
        prior_valuation_date="2026-01-01",
        new_valuation_date="2026-02-01",
        annual_accretion=0.1,
        prior_inputs={"revenue": 1_000_000},
        updated_inputs={"revenue": 1_050_000},  # +5% < 20% threshold
    )
    rev = next(c for c in out["material_changes"] if c["field"] == "revenue")
    assert rev["material"] is False
    assert out["requires_full_revaluation"] is False


def test_validation_and_endpoint():
    with pytest.raises(EngineInputError):
        roll_forward(PRIOR, prior_valuation_date="2026-06-01", new_valuation_date="2026-01-01")
    with pytest.raises(EngineInputError):
        roll_forward({"results": {"equity_value": 0}}, prior_valuation_date="2025-01-01", new_valuation_date="2026-01-01")

    r = client.post(
        "/engine/v1/rollforward",
        json={
            "prior_results": PRIOR,
            "prior_valuation_date": "2025-07-20",
            "new_valuation_date": "2026-07-20",
            "annual_accretion": 0.2,
        },
    )
    assert r.status_code == 200
    assert r.json()["rolled_equity_value"] > 10_000_000

    bad = client.post(
        "/engine/v1/rollforward",
        json={"prior_results": {"results": {"equity_value": 0}}, "prior_valuation_date": "2025-01-01", "new_valuation_date": "2026-01-01"},
    )
    assert bad.status_code == 422
