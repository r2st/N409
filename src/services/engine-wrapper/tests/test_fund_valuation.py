"""ASC 820 fund-holdings valuation unit tests (feature: ASC 820 Fund Holdings)."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.fund_valuation import (
    calibrate_implied_volatility,
    classify_level,
    compute_nav,
    fund_valuation,
    lp_waterfall,
    mark_position,
    roll_forward_mark,
)
from app.main import app

client = TestClient(app)


# ── ASC 820 leveling ─────────────────────────────────────────────────────────


def test_classify_level_maps_method_to_hierarchy():
    assert classify_level("market") == 1
    assert classify_level("last_round") == 2
    assert classify_level("calibrated_opm") == 3
    assert classify_level("cost") == 3
    assert classify_level("cost", has_quote=True) == 1


# ── Position marks ───────────────────────────────────────────────────────────


def test_mark_market_position_is_quantity_times_quote():
    m = mark_position(
        {"name": "PublicCo", "method": "market", "quantity": 1000, "quoted_price": 12.5, "cost_basis": 8000}
    )
    assert m["fair_value"] == pytest.approx(12500.0)
    assert m["level"] == 1
    assert m["unrealized_gain"] == pytest.approx(4500.0)


def test_mark_last_round_position_is_level_2():
    m = mark_position(
        {"name": "SeriesB", "method": "last_round", "quantity": 500, "round_price_per_share": 20, "cost_basis": 5000}
    )
    assert m["fair_value"] == pytest.approx(10000.0)
    assert m["level"] == 2


def test_mark_calibrated_opm_is_level_3():
    m = mark_position({"name": "Startup", "method": "calibrated_opm", "model_value": 42000, "cost_basis": 30000})
    assert m["fair_value"] == pytest.approx(42000.0)
    assert m["level"] == 3


def test_mark_rejects_unknown_method():
    with pytest.raises(EngineInputError):
        mark_position({"name": "X", "method": "wishful"})


def test_mark_requires_name():
    with pytest.raises(EngineInputError):
        mark_position({"method": "cost"})


# ── NAV ──────────────────────────────────────────────────────────────────────


def test_compute_nav_rolls_up_and_breaks_down_by_level():
    nav = compute_nav(
        [
            {"name": "A", "method": "market", "quantity": 100, "quoted_price": 10, "cost_basis": 500},
            {"name": "B", "method": "last_round", "quantity": 100, "round_price_per_share": 5, "cost_basis": 300},
            {"name": "C", "method": "calibrated_opm", "model_value": 2000, "cost_basis": 1000},
        ],
        liabilities=400,
    )
    assert nav["gross_asset_value"] == pytest.approx(1000 + 500 + 2000)
    assert nav["net_asset_value"] == pytest.approx(3500 - 400)
    assert nav["level_breakdown"]["level_1"] == pytest.approx(1000)
    assert nav["level_breakdown"]["level_2"] == pytest.approx(500)
    assert nav["level_breakdown"]["level_3"] == pytest.approx(2000)
    assert nav["total_unrealized_gain"] == pytest.approx(3500 - 1800)


def test_compute_nav_rejects_empty():
    with pytest.raises(EngineInputError):
        compute_nav([])


# ── Calibration to last round ────────────────────────────────────────────────


def test_calibrate_reproduces_the_round_price():
    res = calibrate_implied_volatility(
        round_price_per_share=8.0,
        total_equity_value=100_000_000,
        strike=40_000_000,
        time_to_exit_years=4.0,
        risk_free_rate=0.04,
        preferred_shares=2_000_000,
        fully_diluted_shares=10_000_000,
    )
    assert 0.01 < res["implied_volatility"] < 5.0
    # The calibrated equity call, scaled to the class fraction, reproduces the
    # target class value (price × preferred shares) = 16,000,000.
    frac = 2_000_000 / 10_000_000
    assert res["calibrated_equity_call"] * frac == pytest.approx(res["target_class_value"], rel=1e-3)
    assert res["target_class_value"] == pytest.approx(16_000_000)


def test_calibrate_rejects_zero_term():
    with pytest.raises(EngineInputError):
        calibrate_implied_volatility(
            round_price_per_share=10.0,
            total_equity_value=1e8,
            strike=4e7,
            time_to_exit_years=0.0,
            risk_free_rate=0.04,
            preferred_shares=2e6,
            fully_diluted_shares=1e7,
        )


# ── Roll-forward ─────────────────────────────────────────────────────────────


def test_roll_forward_index_applies_return():
    r = roll_forward_mark(prior_fair_value=1000, method="index", index_return=0.10)
    assert r["new_fair_value"] == pytest.approx(1100.0)
    assert r["change"] == pytest.approx(100.0)


def test_roll_forward_accretion_compounds():
    r = roll_forward_mark(prior_fair_value=1000, method="accretion", accretion_rate=0.08, periods=2)
    assert r["new_fair_value"] == pytest.approx(1000 * 1.08**2)


def test_roll_forward_calibration_adopts_new_value():
    r = roll_forward_mark(prior_fair_value=1000, method="calibration", new_calibrated_value=1500)
    assert r["new_fair_value"] == pytest.approx(1500.0)


def test_roll_forward_calibration_requires_value():
    with pytest.raises(EngineInputError):
        roll_forward_mark(prior_fair_value=1000, method="calibration")


# ── LP waterfall ─────────────────────────────────────────────────────────────


def test_waterfall_returns_capital_and_pref_before_carry():
    # Distribute exactly return of capital + a bit of preferred: GP gets nothing.
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=105,
        preferred_return_rate=0.08,
        years=1.0,
        carry_pct=0.20,
    )
    assert w["tiers"]["return_of_capital"] == pytest.approx(100.0)
    assert w["tiers"]["preferred_return"] == pytest.approx(5.0)
    assert w["gp_distribution"] == pytest.approx(0.0)
    assert w["lp_distribution"] == pytest.approx(105.0)


def test_waterfall_gp_gets_20pct_carry_after_catchup():
    # Contributed 100, pref 8 (1y @ 8%), distribute 200 → profit 100.
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=200,
        preferred_return_rate=0.08,
        years=1.0,
        carry_pct=0.20,
        gp_catch_up=True,
    )
    # LP: 100 ROC + 8 pref + 80% of residual; GP: catch-up + 20% residual.
    # GP total should be ~20% of profit above ROC (=100) once fully caught up.
    assert w["gp_distribution"] == pytest.approx(20.0, abs=1e-6)
    assert w["lp_distribution"] == pytest.approx(180.0, abs=1e-6)
    assert w["lp_distribution"] + w["gp_distribution"] == pytest.approx(200.0)


def test_waterfall_clawback_when_gp_overdistributed():
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=120,
        preferred_return_rate=0.0,
        years=1.0,
        carry_pct=0.20,
        gp_distributions_to_date=50,  # GP already took far more than entitled
    )
    # Total profit = 20, GP entitled = 4; GP already holds 50 → 46 owed back.
    assert w["gp_carry_entitled"] == pytest.approx(4.0)
    assert w["gp_carry_paid_to_date"] == pytest.approx(50.0)
    assert w["clawback_owed"] == pytest.approx(46.0)


def test_waterfall_clawback_does_not_double_count_the_run_it_is_measuring():
    """A fund paid exactly its entitlement owes nothing back.

    This is a whole-fund European waterfall: `distributable` is the fund's
    proceeds, so the `gp_distribution` computed here is the GP's full-life
    entitlement — with a catch-up it *is* `carry × total_profit`. The clawback
    used to add it to what the GP had already been paid before comparing
    against that same entitlement, so the difference was the prior payments
    themselves: every correctly-run fund reported a clawback equal to every
    dollar of carry it had ever paid.
    """
    common = dict(
        committed_capital=100,
        contributed_capital=100,
        distributable=200,
        preferred_return_rate=0.08,
        years=1.0,
        carry_pct=0.20,
        gp_catch_up=True,
    )
    full = lp_waterfall(**common)
    assert full["gp_distribution"] == pytest.approx(full["gp_carry_entitled"])
    assert full["clawback_owed"] == 0.0

    # The GP has already been paid exactly what it is entitled to. Still zero.
    paid = lp_waterfall(**common, gp_distributions_to_date=full["gp_carry_entitled"])
    assert paid["clawback_owed"] == 0.0
    # And the split itself is unchanged — the clawback is a true-up beside it,
    # not a deduction from it.
    assert paid["gp_distribution"] == pytest.approx(full["gp_distribution"])
    assert paid["lp_distribution"] == pytest.approx(full["lp_distribution"])

    # A dollar over, and exactly a dollar is owed back.
    over = lp_waterfall(**common, gp_distributions_to_date=full["gp_carry_entitled"] + 1)
    assert over["clawback_owed"] == pytest.approx(1.0)


def test_waterfall_clawback_measures_a_no_catch_up_gp_against_the_same_ceiling():
    """Without a catch-up the GP takes less than the ceiling, so it owes less."""
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=200,
        preferred_return_rate=0.08,
        years=1.0,
        carry_pct=0.20,
        gp_catch_up=False,
        gp_distributions_to_date=25,
    )
    # Profit is 100, so the ceiling is 20 whatever the tiering did; the GP
    # holds 25 and owes 5 back.
    assert w["gp_distribution"] < w["gp_carry_entitled"]
    assert w["clawback_owed"] == pytest.approx(5.0)


def test_waterfall_rejects_full_carry():
    with pytest.raises(EngineInputError):
        lp_waterfall(committed_capital=100, contributed_capital=100, distributable=100, carry_pct=1.0)


# ── Orchestration ────────────────────────────────────────────────────────────


def test_fund_valuation_returns_nav_and_waterfall():
    res = fund_valuation(
        {
            "positions": [
                {"name": "A", "method": "market", "quantity": 100, "quoted_price": 10, "cost_basis": 500},
            ],
            "liabilities": 100,
            "lp_terms": {"contributed_capital": 500, "distributable": 1200, "carry_pct": 0.2},
        }
    )
    assert res["nav"]["net_asset_value"] == pytest.approx(900.0)
    assert "waterfall" in res
    assert res["waterfall"]["lp_distribution"] > 0


# ── A mark that overflowed is not a mark ─────────────────────────────────────
#
# Every input is guarded finite by `_num`, but the arithmetic on top of them is
# not closed over the finite floats. `round(inf, 4)` is inf, and json.dumps
# writes inf as `null` — so an overflowing book came back as a 200 whose NAV
# was literally null.


def test_a_position_whose_value_overflows_fails_instead_of_marking_null():
    with pytest.raises(EngineInputError, match="fair_value"):
        mark_position(
            {"name": "Whale", "method": "market", "quantity": 1e308, "quoted_price": 1e308}
        )


def test_a_book_that_sums_past_the_float_range_fails_by_name():
    # Each mark is finite on its own; the sum is not.
    positions = [
        {"name": f"P{i}", "method": "calibrated_opm", "model_value": 1.5e308}
        for i in range(3)
    ]
    with pytest.raises(EngineInputError, match="gross_asset_value"):
        compute_nav(positions)


def test_a_cost_basis_book_that_overflows_fails_by_name():
    # Marks stay small so the gross roll-up is fine; only the cost side blows
    # up, and `total_unrealized_gain` would have been the null figure.
    positions = [
        {"name": f"P{i}", "method": "calibrated_opm", "model_value": 1.0, "cost_basis": 1.5e308}
        for i in range(3)
    ]
    with pytest.raises(EngineInputError, match="total_cost_basis"):
        compute_nav(positions)


def test_an_ordinary_book_still_marks_and_rolls_up():
    nav = compute_nav(
        [
            {"name": "A", "method": "market", "quantity": 100, "quoted_price": 10, "cost_basis": 500},
            {"name": "B", "method": "cost", "cost_basis": 250},
        ],
        liabilities=150,
    )
    assert nav["gross_asset_value"] == pytest.approx(1250.0)
    assert nav["net_asset_value"] == pytest.approx(1100.0)


# ── Roll-forward: an unrecognised method is not "index" ──────────────────────


@pytest.mark.parametrize("bad", ["acretion", "index_return", "INDEX", "", "pme"])
def test_an_unknown_roll_forward_method_is_refused_not_silently_ignored(bad):
    # `else: # index` swallowed every unrecognised name and returned the mark
    # unchanged with the bad method echoed back, so a typo produced a stale mark
    # that claimed to have been rolled forward.
    with pytest.raises(EngineInputError, match="method must be one of"):
        roll_forward_mark(prior_fair_value=1000, method=bad, index_return=0.10)


def test_the_fund_rollforward_endpoint_rejects_an_unknown_method():
    res = client.post(
        "/engine/v1/fund-rollforward", json={"prior_fair_value": 1000, "method": "nope"}
    )
    assert res.status_code == 422
    assert "method must be one of" in res.json()["detail"]


# ── Roll-forward: the two reported figures have to agree ─────────────────────


@pytest.mark.parametrize(
    "kwargs",
    [
        {"method": "index", "index_return": 0.10},
        {"method": "index", "index_return": -0.35},
        {"method": "index", "index_return": -1.0},
        {"method": "accretion", "accretion_rate": 0.08, "periods": 2},
        {"method": "calibration", "new_calibrated_value": 1500},
        {"method": "calibration", "new_calibrated_value": 0},
    ],
)
def test_prior_plus_change_always_equals_the_reported_new_value(kwargs):
    r = roll_forward_mark(prior_fair_value=1000, **kwargs)
    assert r["prior_fair_value"] + r["change"] == pytest.approx(r["new_fair_value"])
    assert r["new_fair_value"] >= 0.0


def test_a_total_loss_marks_to_zero_with_a_matching_change():
    r = roll_forward_mark(prior_fair_value=1000, method="index", index_return=-1.0)
    assert r["new_fair_value"] == pytest.approx(0.0)
    assert r["change"] == pytest.approx(-1000.0)


@pytest.mark.parametrize("bad", [-1.5, -5.0, -100.0])
def test_a_return_below_minus_one_hundred_percent_is_refused(bad):
    # It used to be absorbed by a floor at zero, which reported
    # new_fair_value 0 next to change -500 — two figures disagreeing by the
    # size of the mistake. A long position cannot lose more than all of it.
    with pytest.raises(EngineInputError, match="index_return"):
        roll_forward_mark(prior_fair_value=1000, method="index", index_return=bad)


def test_an_accretion_that_overflows_fails_instead_of_marking_null():
    with pytest.raises(EngineInputError):
        roll_forward_mark(
            prior_fair_value=1e308, method="accretion", accretion_rate=5.0, periods=200
        )


def test_the_fund_valuation_endpoint_refuses_an_overflowing_position():
    res = client.post(
        "/engine/v1/fund-valuation",
        json={"positions": [{"name": "a", "method": "market", "quantity": 1e308, "quoted_price": 1e308}]},
    )
    assert res.status_code == 422
    assert res.json()["detail"]


# ── Paid-in capital and DPI ──────────────────────────────────────────────────


def test_dpi_divides_by_paid_in_including_fees():
    """A fund that has returned exactly what its LPs put in is at 1.0x.

    Tier 1 gives the capital back as `contributed + fees`, so that pair is what
    the LPs paid in. Dividing by `contributed` alone reported 1.2x on a fund
    that had made nobody anything — and the overstatement is by the fee ratio,
    largest early in a fund's life, which is where the multiple is read most.
    """
    w = lp_waterfall(
        committed_capital=120,
        contributed_capital=100,
        distributable=120,
        preferred_return_rate=0.0,
        years=1.0,
        carry_pct=0.20,
        management_fees_paid=20,
    )
    assert w["paid_in_capital"] == pytest.approx(120.0)
    assert w["tiers"]["return_of_capital"] == pytest.approx(120.0)
    assert w["lp_distribution"] == pytest.approx(120.0)
    assert w["gp_distribution"] == pytest.approx(0.0)
    assert w["total_profit"] == pytest.approx(0.0)
    assert w["dpi"] == pytest.approx(1.0)


def test_fees_do_not_change_dpi_when_none_were_drawn():
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=150,
        preferred_return_rate=0.0,
        years=1.0,
        carry_pct=0.20,
    )
    assert w["paid_in_capital"] == pytest.approx(100.0)
    assert w["dpi"] == pytest.approx(w["lp_distribution"] / 100.0)


def test_fees_are_returned_before_profit_exists():
    """The fees come back ahead of the carry, so the GP's share is struck on
    what is left after them — not on the whole of the distribution above the
    invested capital alone."""
    w = lp_waterfall(
        committed_capital=100,
        contributed_capital=100,
        distributable=200,
        preferred_return_rate=0.0,
        years=1.0,
        carry_pct=0.20,
        gp_catch_up=True,
        management_fees_paid=20,
    )
    assert w["total_profit"] == pytest.approx(80.0)
    assert w["gp_distribution"] == pytest.approx(16.0)
    assert w["lp_distribution"] == pytest.approx(184.0)
    assert w["dpi"] == pytest.approx(184.0 / 120.0, abs=1e-4)
