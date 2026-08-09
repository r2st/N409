"""Per-class volatility from the breakpoint waterfall.

The 409.ai deliverable carries a "Class Volatility Calculations" schedule
(§10.5) and N409 had none: every DLOM was struck on the *enterprise*
volatility, and the report had nothing to say about the gearing that makes
common's own volatility higher than it.
"""

import math

import pytest

from app.engine.bs import bs_call, bs_call_delta
from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.waterfall import allocate_waterfall, class_volatilities

CLASSES = [
    {"kind": "preferred", "name": "Series B", "shares": 4_000_000, "preference": 12_000_000, "seniority": 1},
    {"kind": "preferred", "name": "Series A", "shares": 2_400_000, "preference": 6_000_000, "seniority": 2},
    {"kind": "common", "name": "Common", "shares": 9_250_000},
    {"kind": "option", "name": "Option pool", "shares": 1_750_000, "strike": 0.55},
]

EQUITY = 42_000_000.0
T, R, SIGMA = 4.0, 0.0421, 0.62


def vols(equity=EQUITY, classes=None, t=T, r=R, sigma=SIGMA):
    return class_volatilities(equity, classes or CLASSES, t, r, sigma)


class TestTheDelta:
    def test_deltas_sum_to_one(self):
        """The waterfall conserves value, so the class values sum to the equity
        value and their derivatives sum to d(S)/dS = 1. If they do not, a
        tranche's delta is being attributed to the wrong participants."""
        assert vols()["delta_total"] == pytest.approx(1.0, abs=1e-6)

    def test_the_delta_is_the_derivative_of_the_value(self):
        """Checked numerically against `allocate_waterfall` itself, because the
        two are computed from separate closed forms and the whole schedule is
        worthless if they describe different functions."""
        h = EQUITY * 1e-5
        up = allocate_waterfall(EQUITY + h, CLASSES, T, R, SIGMA)["classes"]
        down = allocate_waterfall(EQUITY - h, CLASSES, T, R, SIGMA)["classes"]
        got = vols()["classes"]
        for name in got:
            numeric = (up[name]["value"] - down[name]["value"]) / (2 * h)
            assert got[name]["delta"] == pytest.approx(numeric, abs=2e-4), name

    def test_a_senior_preference_is_the_least_geared(self):
        """Series B is first in line: most of its value is the near-certain
        preference, which barely moves with the equity value. Common is last,
        so every dollar of movement reaches it."""
        got = vols()["classes"]
        assert got["Series B"]["elasticity"] < got["Common"]["elasticity"]


class TestTheVolatility:
    def test_common_is_more_volatile_than_the_enterprise(self):
        """The point of the schedule. Common sits behind an $18M preference
        stack, so it is a levered claim and its return volatility exceeds the
        62% the enterprise carries."""
        got = vols()
        assert got["classes"]["Common"]["volatility"] > got["enterprise_volatility"]

    def test_volatility_is_sigma_times_elasticity(self):
        got = vols()
        for c in got["classes"].values():
            if c["volatility"] is not None:
                assert c["volatility"] == pytest.approx(
                    got["enterprise_volatility"] * c["elasticity"], abs=1e-5
                )

    def test_a_cap_table_with_no_preference_gives_every_class_sigma(self):
        """With nothing senior to common there is no gearing, so each class's
        volatility is the enterprise volatility exactly — the sanity check that
        the elasticity is not simply a fudge factor."""
        flat = [
            {"kind": "common", "name": "Common", "shares": 9_000_000},
            {"kind": "common", "name": "Founders", "shares": 1_000_000},
        ]
        got = vols(classes=flat)
        for c in got["classes"].values():
            assert c["volatility"] == pytest.approx(SIGMA, abs=1e-6)

    def test_a_worthless_class_reports_null_rather_than_infinity(self):
        """A deeply out-of-the-money option pool can be valued at zero, and a
        return volatility on a zero value is undefined. Reporting `inf` would
        serialise as null anyway, after `_assert_finite_results` had already
        refused the whole run."""
        deep = [
            {"kind": "preferred", "name": "Series A", "shares": 1_000_000,
             "preference": 500_000_000, "seniority": 1},
            {"kind": "common", "name": "Common", "shares": 1_000_000},
        ]
        got = vols(equity=1_000.0, classes=deep)["classes"]["Common"]
        assert got["value"] == 0.0
        assert got["volatility"] is None
        assert got["elasticity"] is None

    def test_the_schedule_records_what_it_was_struck_on(self):
        got = vols()
        assert got["enterprise_volatility"] == SIGMA
        assert got["time_to_exit_years"] == T
        assert got["risk_free_rate"] == R
        assert got["equity_value"] == pytest.approx(EQUITY)


class TestTheDeltaPrimitive:
    def test_it_matches_a_numeric_derivative_of_bs_call(self):
        s, k = 100.0, 90.0
        h = 1e-4
        numeric = (bs_call(s + h, k, 1.0, 0.04, 0.4) - bs_call(s - h, k, 1.0, 0.04, 0.4)) / (2 * h)
        assert bs_call_delta(s, k, 1.0, 0.04, 0.4) == pytest.approx(numeric, abs=1e-6)

    def test_a_zero_strike_call_is_the_underlying(self):
        """The first tranche of every waterfall is struck at zero, so this
        branch runs on every allocation."""
        assert bs_call_delta(100.0, 0.0, 1.0, 0.04, 0.4) == 1.0

    def test_it_degenerates_with_bs_call(self):
        """Both have to take the same degenerate branch — the elasticity
        divides one by the other."""
        assert bs_call_delta(100.0, 90.0, 0.0, 0.04, 0.4) == 1.0
        assert bs_call_delta(80.0, 90.0, 0.0, 0.04, 0.4) == 0.0
        assert bs_call(80.0, 90.0, 0.0, 0.04, 0.4) == 0.0

    def test_it_is_bounded_in_zero_one(self):
        for k in (1.0, 50.0, 100.0, 1e6):
            d = bs_call_delta(100.0, k, 2.0, 0.04, 0.8)
            assert 0.0 <= d <= 1.0
            assert math.isfinite(d)


class TestThroughCompute:
    PARAMS = {
        "weight_asset": 0.0,
        "weight_opm": 0.0,
        "weight_income": 0.0,
        "weight_market": 1.0,
        "dloc": 0.0,
        "dlom_method": "finnerty",
        "exit_timeline": "2030-06-30",
        "allocation_method": "opm",
    }
    INPUTS = {
        "valuation_date": "2026-06-30",
        "shares_outstanding_common": 9_250_000,
        "options_outstanding": 1_750_000,
        "volatility": SIGMA,
        "risk_free_rate": R,
        "market": {"metric": 9_400_000, "multiples": [4.5]},
        "share_classes": CLASSES,
    }

    def test_the_schedule_reaches_the_result(self):
        res = compute(dict(self.PARAMS), dict(self.INPUTS))["results"]
        schedule = res["class_volatility"]
        assert set(schedule["classes"]) == {c["name"] for c in CLASSES}
        assert schedule["classes"]["Common"]["volatility"] > SIGMA

    def test_it_is_absent_without_a_cap_table(self):
        """The aggregate branches do not decompose the payoff into tranches, so
        there is no per-class delta to take. Printing the enterprise figure
        against every class would assert something false, so nothing is
        reported at all."""
        inputs = {k: v for k, v in self.INPUTS.items() if k != "share_classes"}
        inputs["shares_outstanding_preferred"] = 6_400_000
        inputs["liquidation_preference"] = 18_000_000
        res = compute(dict(self.PARAMS), inputs)["results"]
        assert "class_volatility" not in res

    def test_it_is_struck_on_the_concluded_equity_value(self):
        """Not on some earlier indication — the gearing depends on where the
        equity value sits relative to the breakpoints, so a schedule computed
        against a different value describes a different cap table."""
        res = compute(dict(self.PARAMS), dict(self.INPUTS))["results"]
        assert res["class_volatility"]["equity_value"] == pytest.approx(
            res["equity_value"], abs=0.01
        )

    def test_a_zero_volatility_run_is_refused_not_silently_wrong(self):
        with pytest.raises(EngineInputError):
            compute(dict(self.PARAMS), {**self.INPUTS, "volatility": 0.0})
