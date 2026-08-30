"""The Monte Carlo allocation must add up to the value it is allocating.

`monte_carlo.allocate_monte_carlo` documents `Sigma class values ==
equity_value` as the property that makes it correct, that makes its
single-scenario case checkable against the closed form, and that a reader
reconciling the allocation exhibit relies on. It is an identity in expectation:
the segment slopes sum to one over a partition of the exit value, so one path
allocates that path's exit value, and the risk-neutral discounted mean of the
exit value is the equity value.

It did not hold, and nothing said so. The terminal lognormal's mean sits in a
right tail whose weight grows as `exp(sigma^2 t)`, so the draw needs paths in
proportion; at the default count a volatility of 1.0 over a seven-year horizon
— both inside `validate.VOLATILITY_BAND`, neither warned about anywhere —
allocated 113% of the equity value across the classes, concluded a per-share
figure 13% high, and reported a standard error struck from the same starved
draw, so the interval was as narrow as if the figure were sound. At a
volatility of 5 every exit value underflows and the run returns `$0.0000 per
share` with a standard error of exactly zero and a `[0, 0]` interval, against a
closed form that puts common at essentially the whole equity value.

These tests pin the measured residual, its disclosure, and the refusal.
"""

from __future__ import annotations

import math

import pytest

from app.engine.errors import EngineInputError
from app.engine.monte_carlo import MAX_CONSERVATION_ERROR, allocate_monte_carlo
from app.engine.waterfall import allocate_waterfall

EQUITY = 10_000_000.0

CAP = [
    {"name": "Common", "kind": "common", "shares": 8_000_000},
    {
        "name": "Series A",
        "kind": "preferred",
        "shares": 2_000_000,
        "preference": 2_000_000,
        "seniority": 1,
    },
]


def mc(*, t=4.0, r=0.04, sigma=0.6, paths=None, seed=409):
    config: dict = {"seed": seed}
    if paths is not None:
        config["paths"] = paths
    return allocate_monte_carlo(
        EQUITY, {"share_classes": CAP, "monte_carlo": config}, t=t, r=r, sigma=sigma
    )


def allocated(out: dict) -> float:
    return sum(c["value"] for c in out["classes"].values())


class TestTheResidualIsMeasuredAndDisclosed:
    def test_an_ordinary_run_conserves_value_and_says_by_how_much(self):
        out = mc()
        block = out["value_conservation"]
        assert block["equity_value"] == pytest.approx(EQUITY)
        assert block["allocated_total"] == pytest.approx(allocated(out), abs=0.02)
        assert block["relative_error"] == pytest.approx(
            (block["allocated_total"] - EQUITY) / EQUITY, abs=1e-6
        )
        # An ordinary engagement is loose in the third decimal, not the first.
        assert abs(block["relative_error"]) < 0.01

    def test_the_disclosed_tolerance_is_the_one_the_refusal_uses(self):
        assert mc()["value_conservation"]["tolerance"] == MAX_CONSERVATION_ERROR

    def test_more_paths_shrink_the_residual(self):
        # The residual is sampling error in a mean, so it falls as 1/sqrt(n).
        coarse = abs(mc(paths=1_000)["value_conservation"]["relative_error"])
        fine = abs(mc(paths=100_000)["value_conservation"]["relative_error"])
        assert fine < coarse

    def test_the_residual_is_disclosed_on_the_noisy_runs_too(self):
        # Between exact and refused there is a wide band where the allocation
        # is usable and several percent loose. That is exactly the band a
        # reader adding up an exhibit needs the figure for, so it is reported
        # rather than reserved for the failures.
        out = mc(paths=400)
        assert abs(out["value_conservation"]["relative_error"]) > 1e-4


class TestTheStarvedTailIsRefused:
    def test_an_in_band_volatility_over_a_long_horizon_no_longer_overallocates(self):
        # sigma 1.0 is inside VOLATILITY_BAND and seven years is an ordinary
        # horizon, so nothing upstream refuses or warns. The draw allocated
        # $11.3M of a $10.0M equity value and concluded on it.
        with pytest.raises(EngineInputError, match="did not conserve value"):
            mc(sigma=1.0, t=7.0)

    def test_the_refusal_names_the_two_figures_and_the_way_out(self):
        with pytest.raises(EngineInputError) as excinfo:
            mc(sigma=1.5, t=5.0)
        message = str(excinfo.value)
        assert "10,000,000.00" in message
        assert "monte_carlo.paths" in message
        # The closed form has no such regime, and the analyst needs to be told
        # which method does work rather than only that this one did not.
        assert "'opm'" in message

    def test_the_underflow_regime_is_refused_rather_than_concluded_as_zero(self):
        # Every exit value underflows, so the cap table is allocated $0.00 and
        # the run used to report `$0.0000 per share` with a standard error of
        # exactly zero — certainty about a figure the closed form puts at
        # essentially the whole equity value.
        exact = allocate_waterfall(EQUITY, CAP, 4.0, 0.04, 5.0)
        assert exact["common_per_share"] > 0.9
        with pytest.raises(EngineInputError, match="did not conserve value"):
            mc(sigma=5.0)

    def test_a_two_path_run_is_refused_rather_than_averaged(self):
        # `paths` below the low hundreds is a draw, not an estimate: two paths
        # put the conclusion 43% below the closed form with an allocation that
        # was three quarters of the equity value.
        with pytest.raises(EngineInputError, match="did not conserve value"):
            mc(paths=2)

    def test_the_bound_holds_across_seeds_at_the_ordinary_assumptions(self):
        # The refusal is struck on a measured residual, so it is seed-dependent
        # by construction. At assumptions anyone would actually run it must not
        # fire on any of them.
        for seed in range(409, 429):
            out = mc(seed=seed)
            assert abs(out["value_conservation"]["relative_error"]) < MAX_CONSERVATION_ERROR


class TestWhatTheResidualIsMadeOf:
    def test_the_allocated_total_is_the_discounted_mean_exit_value(self):
        # Not a separate quantity to trust: the per-path payoff over all classes
        # is that path's exit value, so the total is the simulation's own
        # estimate of exp(-rt)*E[S_T], whose true value is the equity value.
        # Checking it against a hand-rolled draw of the same seeded stream would
        # duplicate the module; checking that it lands within the closed-form
        # estimator's own error is the property that matters.
        out = mc(paths=100_000)
        rel = out["value_conservation"]["relative_error"]
        analytic_rse = math.sqrt(math.expm1(0.6 * 0.6 * 4.0)) / math.sqrt(100_000)
        assert abs(rel) < analytic_rse
