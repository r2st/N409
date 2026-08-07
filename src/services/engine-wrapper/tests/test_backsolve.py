"""OPM backsolve tests: waterfall + single-breakpoint round-trips (remaining-gaps §2)."""

import pytest

from app.engine.approaches import opm_backsolve
from app.engine.bs import bs_call
from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.waterfall import _allocate, allocate_waterfall, class_per_share

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


# ── The backsolve objective must not be rounded ──────────────────────────────
#
# `class_per_share` is what Newton differentiates. It used to read
# `allocate_waterfall`'s response, whose `per_share` is rounded to six decimals
# for display, which made the objective a step function: the central difference
# over `h = |x|·1e-6` moves the per-share figure by `2h / total_shares`, so past
# a few hundred million shares the entire difference sits inside one rounding
# quantum and the derivative reads quantization noise. The error that leaves in
# the solved equity is the quantum over the slope — `1e-6 · total_shares` — so
# it grows with the share count, while the reported `solved_pps`, rounded the
# same way, still shows a clean hit on the target.


def _classes(scale: int) -> list[dict]:
    """The cap table above, with every share count multiplied by `scale`."""
    return [
        {"name": "Common", "kind": "common", "shares": 7_000_000 * scale},
        {
            "name": "Series A",
            "kind": "preferred",
            "shares": 2_000_000 * scale,
            "preference": 5_000_000,
            "seniority": 1,
        },
        {"name": "Options", "kind": "option", "shares": 1_000_000 * scale, "strike": 0.5 / scale},
    ]


def _exact_pps(equity: float, classes: list[dict], name: str) -> float:
    """Per-share value straight off the allocation, bypassing the response.

    Not `alloc["classes"][name]["value"] / shares`: that value is rounded to
    cents, which on a ten-billion-share class is its own quantum an order of
    magnitude coarser than what these tests are measuring.
    """
    _, _, _, values = _allocate(equity, classes, T, R, SIGMA)
    shares = next(c["shares"] for c in classes if c["name"] == name)
    return values[name] / shares


def test_class_per_share_is_not_rounded_to_the_response_precision():
    """The objective returns the arithmetic, not the six-decimal display value."""
    classes = _classes(1000)  # 10bn shares — one quantum is $10,000 of equity
    equity = 20_000_000.0
    objective = class_per_share(equity, classes, "Series A", T, R, SIGMA)
    displayed = allocate_waterfall(equity, classes, T, R, SIGMA)["classes"]["Series A"]["per_share"]

    assert objective != round(objective, 6), "objective still rounded to the response precision"
    # Same quantity as the response reports — only the rounding is gone. The
    # response value is on the 1e-6 grid, so it can be off by half a quantum.
    assert objective == pytest.approx(displayed, abs=5e-7)


@pytest.mark.parametrize("scale", [1, 100, 1_000, 10_000])
def test_backsolve_recovers_the_known_equity_at_every_share_count(scale):
    """The solved equity tracks the share count instead of drifting with it.

    `rel=1e-9` is four orders under what the rounded objective could manage at
    the top of this range, where it landed 0.12% away.
    """
    classes = _classes(scale)
    known_equity = 20_000_000.0
    pps = _exact_pps(known_equity, classes, "Series A")

    out = opm_backsolve(
        last_round_pps=pps,
        share_classes=classes,
        last_round_class="Series A",
        t=T,
        r=R,
        sigma=SIGMA,
    )
    assert out["method"] == "backsolve_waterfall"
    assert out["equity_value"] == pytest.approx(known_equity, rel=1e-9)
    # `solved_pps` is the residual an auditor checks convergence against, so it
    # has to carry the precision the solve actually reached rather than a value
    # rounded until it agrees with the target.
    assert out["solved_pps"] == pytest.approx(pps, rel=1e-9)


def test_backsolve_converges_in_a_handful_of_iterations_on_a_large_cap_table():
    """A smooth objective is quadratically convergent; a quantized one is not.

    At 10bn shares the rounded objective needed 20 Newton iterations (~25 full
    waterfall allocations, each of which is itself quadratic in the class
    count). The bound is loose enough to be about the exponent, not the machine.
    """
    classes = _classes(1_000)
    pps = _exact_pps(20_000_000.0, classes, "Series A")

    out = opm_backsolve(
        last_round_pps=pps,
        share_classes=classes,
        last_round_class="Series A",
        t=T,
        r=R,
        sigma=SIGMA,
    )
    assert out["iterations"] <= 8


def test_allocate_waterfall_response_still_rounds_for_display():
    """The rounding belongs in the response, and stays there."""
    alloc = allocate_waterfall(20_000_000.0, CLASSES, T, R, SIGMA)
    for name, cls in alloc["classes"].items():
        assert cls["per_share"] == round(cls["per_share"], 6), name
        assert cls["value"] == round(cls["value"], 2), name
    assert alloc["common_per_share"] == round(alloc["common_per_share"], 6)
    for bp in alloc["breakpoints"]:
        assert bp["value"] == round(bp["value"], 2)


def test_allocation_still_conserves_value_after_the_split():
    """`_allocate` feeds both callers, so the conservation identity must hold."""
    equity = 20_000_000.0
    alloc = allocate_waterfall(equity, CLASSES, T, R, SIGMA)
    total = sum(c["value"] for c in alloc["classes"].values())
    assert total == pytest.approx(equity, rel=1e-9)


def test_class_per_share_still_rejects_an_unknown_class():
    with pytest.raises(EngineInputError, match="not found in share_classes"):
        class_per_share(20_000_000.0, CLASSES, "Series Z", T, R, SIGMA)


# ── The single-breakpoint backsolve and the allocation share one cap table ───
#
# `_opm_allocate` splits residual upside `fd / (fd + preferred)`, where `fd` is
# common *plus the option pool*. The backsolve inverts that same split and used
# to leave the pool out, so the equity value it solved was calibrated against a
# cap table the very next step did not use: the round did not reprice to its own
# PPS under the model that produced the opinion, and the concluded FMV came out
# low by roughly the size of the pool.

SB_COMMON = 8_000_000.0
SB_OPTIONS = 2_000_000.0
SB_PREFERRED = 4_000_000.0
SB_LP = 10_000_000.0
SB_T, SB_R, SB_SIGMA = 4.0, 0.04, 0.65


def _allocation_model_pps(equity: float, junior_base: float) -> float:
    """Preferred per share under `compute._opm_allocate`'s payoff split."""
    upside = bs_call(equity, SB_LP, SB_T, SB_R, SB_SIGMA)
    pref_fraction = SB_PREFERRED / (SB_PREFERRED + junior_base)
    return ((equity - upside) + pref_fraction * upside) / SB_PREFERRED


def test_single_breakpoint_backsolve_uses_fully_diluted_common():
    """The solved equity reprices the round under the *allocation's* cap table."""
    target = 2.50
    out = opm_backsolve(
        last_round_pps=target,
        preferred_shares=SB_PREFERRED,
        liquidation_preference=SB_LP,
        common_shares=SB_COMMON,
        options_shares=SB_OPTIONS,
        t=SB_T,
        r=SB_R,
        sigma=SB_SIGMA,
    )
    assert out["method"] == "backsolve_single"
    fully_diluted = SB_COMMON + SB_OPTIONS
    assert _allocation_model_pps(out["equity_value"], fully_diluted) == pytest.approx(target, rel=1e-9)
    # And it is *not* the answer the bare-common model gives — the two differ by
    # far more than solver tolerance, which is why the mismatch mattered.
    assert _allocation_model_pps(out["equity_value"], SB_COMMON) != pytest.approx(target, rel=1e-3)


def test_single_breakpoint_backsolve_without_a_pool_is_unchanged():
    """No option pool, no difference — the pool is the whole of the change."""
    target = 2.50
    with_none = opm_backsolve(
        last_round_pps=target,
        preferred_shares=SB_PREFERRED,
        liquidation_preference=SB_LP,
        common_shares=SB_COMMON,
        t=SB_T,
        r=SB_R,
        sigma=SB_SIGMA,
    )
    with_zero = opm_backsolve(
        last_round_pps=target,
        preferred_shares=SB_PREFERRED,
        liquidation_preference=SB_LP,
        common_shares=SB_COMMON,
        options_shares=0.0,
        t=SB_T,
        r=SB_R,
        sigma=SB_SIGMA,
    )
    assert with_none["equity_value"] == pytest.approx(with_zero["equity_value"], rel=1e-12)
    assert _allocation_model_pps(with_none["equity_value"], SB_COMMON) == pytest.approx(target, rel=1e-9)


def test_compute_single_breakpoint_round_trips_the_last_round_price():
    """End to end: the priced round survives the backsolve → allocation chain.

    This is the property the whole approach is for, and nothing asserted it on
    the aggregate path. With the pool omitted from the solve it failed by 5.7%
    on this cap table.
    """
    target = 2.50
    params = {
        "weight_asset": 0.0,
        "weight_opm": 1.0,
        "weight_income": 0.0,
        "weight_market": 0.0,
        "dloc": 0.0,
        "dlom": 0.0,
    }
    res = compute(
        params,
        {
            "shares_outstanding_common": SB_COMMON,
            "options_outstanding": SB_OPTIONS,
            "shares_outstanding_preferred": SB_PREFERRED,
            "liquidation_preference": SB_LP,
            "last_round_price_per_share": target,
            "last_round_post_money": 30_000_000,
            "volatility": SB_SIGMA,
            "risk_free_rate": SB_R,
            "time_to_exit_years": SB_T,
        },
    )["results"]

    assert res["approaches"]["opm_backsolve"]["method"] == "backsolve_single"
    assert res["allocation"]["method"] == "opm_single_breakpoint"
    equity = res["equity_value"]

    # The allocation the engine actually ran must value the round's preferred at
    # the round's own price.
    fully_diluted = res["fully_diluted_common"]
    assert fully_diluted == SB_COMMON + SB_OPTIONS
    assert _allocation_model_pps(equity, fully_diluted) == pytest.approx(target, rel=1e-6)

    # Common's share of that same allocation is what the FMV is built from, so
    # the two halves have to agree to the cent.
    upside = bs_call(equity, SB_LP, SB_T, SB_R, SB_SIGMA)
    common_equity = upside * fully_diluted / (fully_diluted + SB_PREFERRED)
    assert res["fmv_per_share"] == pytest.approx(common_equity / fully_diluted, abs=5e-5)


def test_compute_single_breakpoint_no_longer_understates_the_pool_case():
    """A regression pin on the magnitude, not just the property.

    The old behaviour solved $18,014,475 and concluded $0.8587 per common share
    on these inputs. Both figures are wrong by the size of the option pool.
    """
    params = {
        "weight_asset": 0.0,
        "weight_opm": 1.0,
        "weight_income": 0.0,
        "weight_market": 0.0,
        "dloc": 0.0,
        "dlom": 0.0,
    }
    res = compute(
        params,
        {
            "shares_outstanding_common": SB_COMMON,
            "options_outstanding": SB_OPTIONS,
            "shares_outstanding_preferred": SB_PREFERRED,
            "liquidation_preference": SB_LP,
            "last_round_price_per_share": 2.50,
            "last_round_post_money": 30_000_000,
            "volatility": SB_SIGMA,
            "risk_free_rate": SB_R,
            "time_to_exit_years": SB_T,
        },
    )["results"]

    assert res["equity_value"] == pytest.approx(19_604_375.79, rel=1e-6)
    assert res["fmv_per_share"] == pytest.approx(0.9604, abs=5e-5)
