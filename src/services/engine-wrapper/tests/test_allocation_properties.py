"""Property tests for the allocation core: invariants over *generated* cap tables.

The hand-written allocation tests each pin one structure to one expected number.
That catches a wrong answer in the case someone thought of. It does not catch a
wrong answer in the case nobody thought of — a fourth seniority rank, a
participating class that converts, an option pool struck exactly at a
breakpoint. Those combinations are where the breakpoint algebra actually gets
hard, and they are what a real cap table looks like by Series C.

So this file asserts *properties* instead: statements that must hold for every
cap table, checked against a few hundred randomly assembled ones. A property
failure names a structure the author never considered, which is the point.

Randomness is seeded per test rather than global, so a failure reproduces
exactly and CI never flakes. The generator deliberately produces awkward shapes
— zero-preference classes, ties in seniority, strikes above and below the
residual, single-class tables — because those are the boundaries the mutation
run (docs/mutation-testing.md) showed nothing was asserting on.
"""

from __future__ import annotations

import math
import random

import pytest

from app.engine.bs import bs_call
from app.engine.pwerm import allocate_pwerm
from app.engine.waterfall import allocate_waterfall, exit_allocation

T, R, SIGMA = 3.0, 0.04, 0.6

# Enough tables to cross the interesting structural combinations without making
# the suite slow — the whole file runs in well under a second.
N_TABLES = 200


def _random_cap_table(rng: random.Random) -> list[dict]:
    """A cap table with 1 common class, 0-4 preferred and 0-2 option pools."""
    classes: list[dict] = [
        {
            "name": "Common",
            "kind": "common",
            "shares": float(rng.randrange(1_000_000, 20_000_000)),
        }
    ]
    for i in range(rng.randint(0, 4)):
        classes.append(
            {
                "name": f"Series {chr(ord('A') + i)}",
                "kind": "preferred",
                "shares": float(rng.randrange(100_000, 10_000_000)),
                # 0 is legal and load-bearing: a zero-preference class takes no
                # tranche of the stack but still participates in the residual.
                "preference": float(rng.choice([0, rng.randrange(0, 30_000_000)])),
                # Ties are intentional — pari passu ranks split pro-rata, and
                # that split is its own branch in _segments.
                "seniority": rng.randint(1, 3),
                "participating": rng.random() < 0.35,
                "conversion_ratio": rng.choice([1.0, 1.0, 1.0, 0.5, 2.0]),
            }
        )
    for i in range(rng.randint(0, 2)):
        classes.append(
            {
                "name": f"Pool {i}",
                "kind": "option",
                "shares": float(rng.randrange(100_000, 5_000_000)),
                "strike": rng.choice([0.01, 0.5, 1.0, 2.5, 10.0]),
            }
        )
    return classes


def _tables(seed: int, n: int = N_TABLES):
    rng = random.Random(seed)
    for _ in range(n):
        yield rng, _random_cap_table(rng)


# ── allocate_waterfall (the OPM breakpoint model) ─────────────────────────────


def test_opm_waterfall_conserves_value_for_any_cap_table():
    """Σ class values == equity value.

    The breakpoint decomposition is a telescoping sum of call spreads, so this
    is exact rather than approximate: every tranche handed to one class is a
    tranche taken from the total. If it ever fails, a segment's participant
    fractions do not sum to 1 — value is being created or destroyed somewhere
    in the residual event loop.
    """
    for rng, classes in _tables(20260802):
        equity = float(rng.randrange(100_000, 500_000_000))
        out = allocate_waterfall(equity, classes, T, R, SIGMA)
        total = sum(c["value"] for c in out["classes"].values())
        assert total == pytest.approx(equity, rel=1e-6), (equity, classes)


def test_opm_waterfall_never_allocates_a_negative_value():
    """No class is ever worth less than nothing.

    A negative allocation means a call spread came out inverted — the segment
    bounds are out of order — and it would print a negative FMV per share.
    """
    for rng, classes in _tables(20260803):
        equity = float(rng.randrange(100_000, 500_000_000))
        out = allocate_waterfall(equity, classes, T, R, SIGMA)
        for name, data in out["classes"].items():
            assert data["value"] >= -1e-6, (name, equity, classes)
            assert data["per_share"] >= -1e-9, (name, equity, classes)


def test_common_per_share_is_monotone_in_equity_value():
    """More equity value can never make common worth less per share.

    This is the invariant an analyst checks by eye and the one a broken
    conversion breakpoint violates first: at the point a non-participating
    class converts, common's slope drops, and if the breakpoint is placed
    wrong the *level* drops with it.
    """
    for rng, classes in _tables(20260804, n=120):
        base = float(rng.randrange(1_000_000, 50_000_000))
        prev = -math.inf
        for factor in (0.25, 0.5, 1.0, 2.0, 5.0, 25.0, 100.0):
            out = allocate_waterfall(base * factor, classes, T, R, SIGMA)
            per_share = out["common_per_share"]
            assert per_share >= prev - 1e-6, (base, factor, classes)
            prev = per_share


def test_segments_partition_the_whole_value_line():
    """Consecutive breakpoints meet exactly, and the last one runs to infinity.

    A gap between segments loses value; an overlap double-counts it. Both would
    still produce a plausible-looking allocation, and neither is visible in a
    single-number assertion.
    """
    for rng, classes in _tables(20260805, n=120):
        equity = float(rng.randrange(100_000, 500_000_000))
        out = allocate_waterfall(equity, classes, T, R, SIGMA)
        bps = out["breakpoints"]
        assert bps[0]["from"] == 0.0, classes
        for lower, upper in zip(bps, bps[1:]):
            assert lower["to"] == pytest.approx(upper["from"], abs=0.01), classes
        assert bps[-1]["to"] is None, classes
        for seg in bps:
            # The reported fractions are rounded to 6dp for display, so the
            # tolerance is the rounding, not the algebra: with a dozen classes
            # the last digit can accumulate a few units of 1e-6.
            assert sum(seg["participants"].values()) == pytest.approx(1.0, abs=1e-4), classes


# ── exit_allocation (the deterministic σ→0 limit) ────────────────────────────


def test_exit_allocation_conserves_value_for_any_cap_table():
    """Σ class values == exit value, exactly — this one is plain arithmetic."""
    for rng, classes in _tables(20260806):
        exit_value = float(rng.randrange(0, 500_000_000))
        out = exit_allocation(exit_value, classes)
        total = sum(c["value"] for c in out["classes"].values())
        assert total == pytest.approx(exit_value, abs=0.5), (exit_value, classes)


def test_exit_allocation_at_zero_pays_nobody():
    """A dissolution scenario worth nothing allocates nothing.

    PWERM models company failure as exactly this, so it is a routine input, not
    a degenerate one — and `exit_value == 0` sits on the boundary of the
    `>= 0` guard, which is precisely where an off-by-one hides.
    """
    for _, classes in _tables(20260807, n=60):
        out = exit_allocation(0.0, classes)
        assert out["common_value"] == 0.0
        assert out["common_per_share"] == 0.0
        assert all(c["value"] == 0.0 for c in out["classes"].values())


def test_opm_waterfall_converges_to_exit_allocation_as_volatility_vanishes():
    """The OPM is the stochastic generalisation of the deterministic waterfall.

    As σ and t → 0 the lognormal collapses onto its mean, so every call spread
    becomes the intrinsic value and the two models must agree. They are
    implemented independently — one in Black-Scholes call spreads, the other in
    tranche widths — so agreement at the limit is a real cross-check of the
    shared breakpoint algebra rather than a tautology.
    """
    for rng, classes in _tables(20260808, n=100):
        equity = float(rng.randrange(1_000_000, 200_000_000))
        opm = allocate_waterfall(equity, classes, 1e-9, 0.0, 1e-9)
        deterministic = exit_allocation(equity, classes)
        for name, data in deterministic["classes"].items():
            assert opm["classes"][name]["value"] == pytest.approx(
                data["value"], rel=1e-4, abs=1.0
            ), (name, equity, classes)


def test_deep_in_the_money_converges_to_as_converted():
    """At a large enough exit everything converts and value is pro-rata.

    Preferences and strikes become rounding error against a billion-dollar
    exit, so each class's share must approach its as-converted share count.
    This is the far end of the value line, where a mis-ordered final segment
    would otherwise go unnoticed.
    """
    for _, classes in _tables(20260809, n=80):
        equity = 5e11
        out = exit_allocation(equity, classes)
        as_converted = {}
        for c in classes:
            if c["kind"] == "preferred":
                as_converted[c["name"]] = c["shares"] * c.get("conversion_ratio", 1.0)
            else:
                as_converted[c["name"]] = c["shares"]
        total_shares = sum(as_converted.values())
        for name, shares in as_converted.items():
            expected_fraction = shares / total_shares
            actual_fraction = out["classes"][name]["value"] / equity
            assert actual_fraction == pytest.approx(expected_fraction, abs=2e-3), (
                name,
                classes,
            )


# ── PWERM ────────────────────────────────────────────────────────────────────


def test_pwerm_single_certain_scenario_is_the_discounted_waterfall():
    """One scenario at probability 1 must reduce to exit_allocation / (1+r)^t.

    PWERM's probability weighting is the only thing between those two, so this
    pins the weighting to an identity rather than to a recomputed expectation.
    """
    for rng, classes in _tables(20260810, n=80):
        equity = float(rng.randrange(1_000_000, 300_000_000))
        t = rng.choice([0.0, 1.0, 3.5])
        rate = rng.choice([0.0, 0.12, 0.30])
        out = allocate_pwerm(
            [{"probability": 1.0, "equity_value": equity, "time_to_exit_years": t}],
            classes,
            default_discount_rate=rate,
        )
        expected = exit_allocation(equity, classes)
        factor = (1.0 + rate) ** t
        for name, data in expected["classes"].items():
            assert out["classes"][name]["present_value"] == pytest.approx(
                data["value"] / factor, rel=1e-6, abs=0.5
            ), (name, classes)
        assert out["expected_time_to_exit_years"] == pytest.approx(t)


def test_pwerm_is_linear_in_scenario_probability():
    """Splitting a scenario in two halves of the same outcome changes nothing.

    Probability weighting must be linear; if a scenario's contribution were
    accumulated with anything other than a plain weighted sum, halving it twice
    would not add back up.
    """
    for rng, classes in _tables(20260811, n=60):
        equity = float(rng.randrange(1_000_000, 300_000_000))
        one = allocate_pwerm(
            [{"probability": 1.0, "equity_value": equity, "time_to_exit_years": 2.0}],
            classes,
            default_discount_rate=0.15,
        )
        split = allocate_pwerm(
            [
                {"probability": 0.5, "equity_value": equity, "time_to_exit_years": 2.0},
                {"probability": 0.25, "equity_value": equity, "time_to_exit_years": 2.0},
                {"probability": 0.25, "equity_value": equity, "time_to_exit_years": 2.0},
            ],
            classes,
            default_discount_rate=0.15,
        )
        assert split["common_per_share"] == pytest.approx(
            one["common_per_share"], rel=1e-9
        ), classes
        assert split["equity_value"] == pytest.approx(one["equity_value"], rel=1e-9)


def test_pwerm_zero_probability_scenario_contributes_nothing():
    """A scenario the analyst has weighted to zero must not move the answer.

    `probability == 0` sits exactly on the `>= 0` guard, and analysts really do
    leave a zeroed-out scenario in the model while they argue about it.
    """
    for rng, classes in _tables(20260812, n=60):
        equity = float(rng.randrange(1_000_000, 300_000_000))
        base = allocate_pwerm(
            [{"probability": 1.0, "equity_value": equity, "time_to_exit_years": 2.0}],
            classes,
            default_discount_rate=0.15,
        )
        with_zero = allocate_pwerm(
            [
                {"probability": 1.0, "equity_value": equity, "time_to_exit_years": 2.0},
                {
                    "probability": 0.0,
                    "equity_value": equity * 1000,
                    "time_to_exit_years": 9.0,
                },
            ],
            classes,
            default_discount_rate=0.15,
        )
        assert with_zero["common_per_share"] == pytest.approx(
            base["common_per_share"], rel=1e-9
        ), classes


def test_pwerm_conserves_value_across_scenarios():
    """Σ class present values == Σ probability-weighted discounted exit values."""
    for _, classes in _tables(20260813, n=80):
        scenarios = [
            {"probability": 0.2, "equity_value": 0.0, "time_to_exit_years": 1.0},
            {"probability": 0.5, "equity_value": 5e7, "time_to_exit_years": 3.0},
            {"probability": 0.3, "equity_value": 4e8, "time_to_exit_years": 5.0},
        ]
        rate = 0.2
        out = allocate_pwerm(scenarios, classes, default_discount_rate=rate)
        expected = sum(
            s["probability"] * s["equity_value"] / (1.0 + rate) ** s["time_to_exit_years"]
            for s in scenarios
        )
        assert out["equity_value"] == pytest.approx(expected, rel=1e-6, abs=1.0), classes


# ── the Black-Scholes primitive the whole allocation rests on ────────────────


def test_bs_call_is_monotone_and_bounded():
    """0 <= C(S,K) <= S, decreasing in K, increasing in S — for every input.

    Every tranche in both waterfalls is a difference of two of these, so a
    violation here is a violation everywhere downstream.
    """
    rng = random.Random(20260814)
    for _ in range(400):
        s = rng.uniform(1e3, 1e9)
        k = rng.uniform(0.0, 2e9)
        t = rng.choice([0.0, 0.25, 1.0, 7.0])
        r = rng.uniform(0.0, 0.12)
        sigma = rng.choice([0.0, 0.15, 0.6, 1.8])
        c = bs_call(s, k, t, r, sigma)
        assert 0.0 <= c <= s + 1e-6, (s, k, t, r, sigma)
        # Strictly speaking non-increasing: a deep out-of-the-money call is
        # numerically flat at zero.
        assert bs_call(s, k * 1.5 + 1.0, t, r, sigma) <= c + 1e-6, (s, k, t, r, sigma)
        assert bs_call(s * 1.5, k, t, r, sigma) >= c - 1e-6, (s, k, t, r, sigma)
