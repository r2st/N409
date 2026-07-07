"""OPM backsolve tests: waterfall + single-breakpoint round-trips (remaining-gaps §2)."""

import pytest

from app.engine.approaches import opm_backsolve
from app.engine.bs import bs_call
from app.engine.compute import compute
from app.engine.waterfall import allocate_waterfall

T, R, SIGMA = 3.0, 0.04, 0.6

CLASSES = [
    {"name": "Common", "kind": "common", "shares": 7_000_000},
    {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000, "seniority": 1},
    {"name": "Options", "kind": "option", "shares": 1_000_000, "strike": 0.5},
]


def test_backsolve_waterfall_round_trip():
    known_equity = 20_000_000.0
    pps = allocate_waterfall(known_equity, CLASSES, T, R, SIGMA)["classes"]["Series A"]["per_share"]

    out = opm_backsolve(
        last_round_pps=pps,
        share_classes=CLASSES,
        last_round_class="Series A",
        t=T,
        r=R,
        sigma=SIGMA,
    )
    assert out["method"] == "backsolve_waterfall"
    assert out["equity_value"] == pytest.approx(known_equity, rel=1e-4)
    assert out["solved_pps"] == pytest.approx(pps, rel=1e-4)
    assert out["iterations"] >= 1


def test_backsolve_single_breakpoint_round_trip():
    common, preferred, lp = 8_000_000.0, 2_000_000.0, 5_000_000.0
    known_equity = 25_000_000.0
    upside = bs_call(known_equity, lp, T, R, SIGMA)
    pref_fraction = preferred / (preferred + common)
    pps = ((known_equity - upside) + pref_fraction * upside) / preferred

    out = opm_backsolve(
        last_round_pps=pps,
        preferred_shares=preferred,
        liquidation_preference=lp,
        common_shares=common,
        t=T,
        r=R,
        sigma=SIGMA,
    )
    assert out["method"] == "backsolve_single"
    assert out["equity_value"] == pytest.approx(known_equity, rel=1e-4)


def test_post_money_fallback_unchanged():
    out = opm_backsolve(20_000_000)
    assert out["equity_value"] == 20_000_000
    assert out["method"] == "post_money"


def test_backsolve_reports_implied_volatility_when_well_posed():
    out = opm_backsolve(
        20_000_000,
        last_round_pps=3.0,
        preferred_shares=2_000_000.0,
        liquidation_preference=5_000_000.0,
        common_shares=8_000_000.0,
        t=T,
        r=R,
        sigma=SIGMA,
    )
    assert out["method"] == "backsolve_single"
    assert out["last_round_post_money"] == 20_000_000
    # 3.0 * 2M = 6M call value on a 20M spot with 5M strike → solvable vol
    assert 0.01 <= out["implied_volatility"] <= 5.0


# ── compute() integration ────────────────────────────────────────────────────

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.0,
    "dlom": 0.3,
}

BASE_INPUTS = {
    "time_to_exit_years": T,
    "risk_free_rate": R,
    "volatility": SIGMA,
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
}


def test_compute_with_share_classes_uses_waterfall_and_backsolve():
    known_equity = 20_000_000.0
    pps = allocate_waterfall(known_equity, CLASSES, T, R, SIGMA)["classes"]["Series A"]["per_share"]

    res = compute(
        PARAMS,
        {
            **BASE_INPUTS,
            "share_classes": CLASSES,
            "last_round_class": "Series A",
            "last_round_price_per_share": pps,
        },
    )["results"]

    backsolve = res["approaches"]["opm_backsolve"]
    assert backsolve["method"] == "backsolve_waterfall"
    assert res["equity_value"] == pytest.approx(known_equity, rel=1e-3)
    assert res["allocation"]["method"] == "opm_waterfall"

    expected_fmv = res["allocation"]["common_per_share"] * 0.7  # dlom 0.3
    assert res["fmv_per_share"] == pytest.approx(expected_fmv, abs=1e-3)


def test_compute_post_money_path_still_works():
    res = compute(PARAMS, {**BASE_INPUTS, "last_round_post_money": 20_000_000})["results"]
    assert res["approaches"]["opm_backsolve"]["method"] == "post_money"
    assert res["allocation"]["method"] == "opm_single_breakpoint"
