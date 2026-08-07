"""Impairment engine unit tests (feature: Goodwill & Intangible Impairment)."""

import pytest

from app.engine.errors import EngineInputError
from app.engine.impairment import (
    goodwill_impairment,
    indefinite_lived_impairment,
    long_lived_impairment,
    run_impairment_test,
)


# ── Goodwill (ASC 350-20) ────────────────────────────────────────────────────


def test_goodwill_no_impairment_when_fair_exceeds_carrying():
    out = goodwill_impairment(carrying_amount=100.0, fair_value=120.0, goodwill_carrying_amount=30.0)
    assert out["impaired"] is False
    assert out["impairment_loss"] == 0.0
    assert out["headroom"] == pytest.approx(20.0)
    assert out["goodwill_after"] == pytest.approx(30.0)


def test_goodwill_loss_is_the_shortfall():
    out = goodwill_impairment(carrying_amount=100.0, fair_value=85.0, goodwill_carrying_amount=30.0)
    assert out["impaired"] is True
    assert out["impairment_loss"] == pytest.approx(15.0)
    assert out["goodwill_after"] == pytest.approx(15.0)


def test_goodwill_loss_capped_at_goodwill_on_books():
    out = goodwill_impairment(carrying_amount=100.0, fair_value=40.0, goodwill_carrying_amount=30.0)
    assert out["impairment_loss"] == pytest.approx(30.0)  # not 60
    assert out["goodwill_after"] == 0.0


def test_goodwill_exceeding_carrying_rejected():
    with pytest.raises(EngineInputError, match="exceeds the reporting unit"):
        goodwill_impairment(carrying_amount=20.0, fair_value=10.0, goodwill_carrying_amount=30.0)


def test_goodwill_qualitative_flag_passes_through():
    out = goodwill_impairment(
        reporting_unit="US SaaS",
        carrying_amount=100.0,
        fair_value=150.0,
        goodwill_carrying_amount=30.0,
        qualitative_only=True,
    )
    assert out["qualitative_only"] is True
    assert out["reporting_unit"] == "US SaaS"


# ── Indefinite-lived (ASC 350-30) ────────────────────────────────────────────


def test_indefinite_lived_writes_down_to_fair_value():
    out = indefinite_lived_impairment(asset="Trade name", carrying_amount=50.0, fair_value=35.0)
    assert out["impairment_loss"] == pytest.approx(15.0)
    assert out["carrying_after"] == pytest.approx(35.0)


def test_indefinite_lived_no_loss_when_fair_higher():
    out = indefinite_lived_impairment(carrying_amount=50.0, fair_value=60.0)
    assert out["impaired"] is False
    assert out["carrying_after"] == pytest.approx(50.0)


# ── Long-lived (ASC 360-10) ──────────────────────────────────────────────────


def test_long_lived_recoverable_means_no_loss_even_below_fair_value():
    # Undiscounted flows (120) cover carrying (100) though fair value is 80:
    # the 360-10 screen passes and NO impairment is recorded.
    out = long_lived_impairment(
        carrying_amount=100.0,
        undiscounted_cash_flows=[40.0, 40.0, 40.0],
        fair_value=80.0,
    )
    assert out["recoverable"] is True
    assert out["impaired"] is False
    assert out["impairment_loss"] == 0.0


def test_long_lived_failed_screen_writes_down_to_fair_value():
    out = long_lived_impairment(
        asset_group="Plant A",
        carrying_amount=100.0,
        undiscounted_cash_flows=[20.0, 20.0, 20.0],
        fair_value=45.0,
    )
    assert out["recoverable"] is False
    assert out["impairment_loss"] == pytest.approx(55.0)
    assert out["carrying_after"] == pytest.approx(45.0)


def test_long_lived_screen_at_exact_carrying_passes():
    out = long_lived_impairment(
        carrying_amount=100.0, undiscounted_cash_flows=[50.0, 50.0], fair_value=10.0
    )
    assert out["recoverable"] is True
    assert out["impairment_loss"] == 0.0


def test_long_lived_negative_flow_years_count():
    out = long_lived_impairment(
        carrying_amount=100.0, undiscounted_cash_flows=[80.0, -30.0, 40.0], fair_value=70.0
    )
    assert out["undiscounted_cash_flows_total"] == pytest.approx(90.0)
    assert out["recoverable"] is False
    assert out["impairment_loss"] == pytest.approx(30.0)


def test_long_lived_empty_flows_rejected():
    with pytest.raises(EngineInputError, match="non-empty"):
        long_lived_impairment(carrying_amount=100.0, undiscounted_cash_flows=[], fair_value=50.0)


def test_long_lived_bad_flow_names_index():
    with pytest.raises(EngineInputError, match=r"undiscounted_cash_flows\[1\]"):
        long_lived_impairment(
            carrying_amount=100.0, undiscounted_cash_flows=[10.0, "x"], fair_value=50.0
        )


# ── Dispatch ─────────────────────────────────────────────────────────────────


def test_dispatch_routes_each_kind():
    out = run_impairment_test(
        "goodwill", {"carrying_amount": 10.0, "fair_value": 12.0, "goodwill_carrying_amount": 3.0}
    )
    assert out["standard"] == "ASC 350-20"
    out = run_impairment_test("indefinite_lived", {"carrying_amount": 10.0, "fair_value": 8.0})
    assert out["standard"] == "ASC 350-30"
    out = run_impairment_test(
        "long_lived",
        {"carrying_amount": 10.0, "undiscounted_cash_flows": [1.0], "fair_value": 5.0},
    )
    assert out["standard"] == "ASC 360-10"


def test_dispatch_unknown_kind_rejected():
    with pytest.raises(EngineInputError, match="unknown impairment test"):
        run_impairment_test("asc999", {})


def test_dispatch_bad_kwargs_are_input_errors():
    with pytest.raises(EngineInputError, match="invalid params"):
        run_impairment_test("goodwill", {"carrying_amount": 10.0, "bogus": 1})
