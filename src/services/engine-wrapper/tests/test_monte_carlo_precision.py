"""The reported standard error, and the scenario inputs that never reach one.

`test_monte_carlo.py` checks the simulated *figure* against the closed form,
which is the right oracle for the figure and is blind to the thing this file is
about: the precision claim that travels beside it. Every assertion there is
single-scenario, and single-scenario is exactly the case the estimator's
variance arithmetic got right.

That matters because `standard_error_per_share` is not decoration. It is what
`test_it_lands_on_the_closed_form_within_its_own_error` measures the answer
against, what a reviewer reads to decide whether a simulated FMV is tight enough
to conclude on, and — under a multi-scenario model, which is the whole reason
this module exists rather than deferring to the OPM — it was wrong.

The property that catches it needs no oracle and no statistics: **splitting one
scenario into N identical copies models the same distribution.** The estimator
sees N times as many draws, so its standard error must fall as 1/sqrt(N). It
fell as 1/N, and on a payoff with no randomness left in it at all the reported
error was not zero.

The second half of the file is the scenario list's input contract. It is
reachable only through a hand-built `inputs.monte_carlo`, so nothing upstream
validates it first.
"""

import math

import pytest

from app.engine.errors import EngineInputError
from app.engine.monte_carlo import (
    DEFAULT_SEED,
    MAX_PATHS,
    MAX_SCENARIOS,
    NORMAL_95,
    allocate_monte_carlo,
)
from app.engine.waterfall import allocate_waterfall

# One common class, so `common_per_share` is the whole equity value per share
# and any error in the estimator shows up undiluted by a preference stack.
COMMON_ONLY = [{"name": "Common", "kind": "common", "shares": 1_000_000}]

STACKED = [
    {"name": "Series A", "kind": "preferred", "shares": 1_000_000, "preference": 4_000_000, "seniority": 1},
    {"name": "Common", "kind": "common", "shares": 4_000_000},
]

EQUITY = 10_000_000.0


def mc(*, classes=None, scenarios=None, paths=4_000, seed=409, t=2.0, r=0.03, sigma=0.55, **config):
    inputs = {
        "share_classes": classes if classes is not None else COMMON_ONLY,
        "monte_carlo": {"paths": paths, "seed": seed, **config},
    }
    if scenarios is not None:
        inputs["monte_carlo"]["scenarios"] = scenarios
    return allocate_monte_carlo(EQUITY, inputs, t=t, r=r, sigma=sigma)


def identical(n, *, t=2.0, sigma=0.55):
    """`n` copies of one scenario — the same distribution, split `n` ways."""
    return [
        {"name": f"Copy {i + 1}", "probability": 1.0 / n, "years_to_exit": t, "volatility": sigma}
        for i in range(n)
    ]


class TestTheReportedErrorIsAStandardError:
    """Properties of the estimator's own precision, not of the figure."""

    def test_a_payoff_with_no_randomness_left_reports_no_error(self):
        # The decisive case, and the one the old arithmetic failed outright.
        # With sigma at the vanishing point every draw lands on the same exit
        # value, so every scenario's mean is that value exactly and the
        # estimator has nothing left to be uncertain about. One scenario
        # correctly reported zero; two identical ones reported an error of
        # roughly half the per-share value itself, because the pooled mean came
        # out at 1/len(scenarios) of the true one and the variance formula then
        # subtracted that squared instead.
        flat = 1e-9
        one = mc(scenarios=None, sigma=flat)
        two = mc(scenarios=identical(2, sigma=flat), sigma=flat)

        assert one["standard_error_per_share"] == 0.0
        assert two["standard_error_per_share"] == pytest.approx(0.0, abs=1e-8)
        # And the figure itself was never in doubt — which is what made the
        # error claim beside it wrong rather than merely noisy.
        assert two["common_per_share"] == pytest.approx(one["common_per_share"], rel=1e-6)

    @pytest.mark.parametrize("copies", [2, 3, 4])
    def test_splitting_one_scenario_into_copies_tightens_it_as_sqrt_n(self, copies):
        # Same distribution, `copies` times as many draws. The standard error of
        # a mean falls as 1/sqrt(n) and by no other law; it used to fall as 1/n,
        # which is the signature of a weighting applied once too often.
        one = mc(scenarios=None)
        many = mc(scenarios=identical(copies))

        ratio = many["standard_error_per_share"] / one["standard_error_per_share"]
        assert ratio == pytest.approx(1.0 / math.sqrt(copies), rel=0.08), (
            f"{copies} identical scenarios moved the standard error by {ratio:.4f}; "
            f"1/sqrt({copies}) = {1 / math.sqrt(copies):.4f}"
        )

    def test_it_stays_an_honest_band_around_the_single_scenario_answer(self):
        # The point of the figure: the answer has to sit inside the error it
        # reports. Identical scenarios and the single scenario estimate the same
        # quantity, so the gap between them is bounded by their pooled error.
        one = mc(scenarios=None, classes=STACKED)
        two = mc(scenarios=identical(2), classes=STACKED)

        pooled = math.hypot(one["standard_error_per_share"], two["standard_error_per_share"])
        assert abs(one["common_per_share"] - two["common_per_share"]) < 3 * pooled

    def test_a_wider_scenario_is_less_certain_than_a_narrow_one(self):
        # The error has to respond to the modelling, not just to the draw count.
        # Two scenarios differing only in volatility, same weights, same paths.
        narrow = mc(scenarios=identical(2, sigma=0.15), sigma=0.15)
        wide = mc(scenarios=identical(2, sigma=1.2), sigma=1.2)
        assert wide["standard_error_per_share"] > narrow["standard_error_per_share"]

    def test_the_weights_reach_the_error_and_not_only_the_answer(self):
        # A scenario carrying almost no probability contributes almost nothing
        # to the estimator, and so almost nothing to its variance. Two exits
        # that genuinely differ (2 vs 8 years), weighted evenly and then
        # lopsidedly: the lopsided one is dominated by a single scenario and is
        # tighter than the even blend of two.
        spread = [
            {"name": "Trade sale", "probability": 0.5, "years_to_exit": 2.0, "volatility": 0.5},
            {"name": "IPO", "probability": 0.5, "years_to_exit": 8.0, "volatility": 0.9},
        ]
        lopsided = [{**spread[0], "probability": 0.999}, {**spread[1], "probability": 0.001}]
        assert mc(scenarios=lopsided)["standard_error_per_share"] < mc(scenarios=spread)["standard_error_per_share"]


class TestTheScenarioListsInputContract:
    """Reachable only through a hand-built `inputs.monte_carlo`."""

    def test_the_config_block_must_be_an_object(self):
        with pytest.raises(EngineInputError, match="inputs.monte_carlo must be an object"):
            allocate_monte_carlo(
                EQUITY, {"share_classes": COMMON_ONLY, "monte_carlo": "fast"}, t=2.0, r=0.03, sigma=0.5
            )

    def test_an_empty_scenario_list_is_refused_rather_than_defaulted(self):
        # Absent means "the single lognormal the OPM assumes" and is ordinary.
        # Present-but-empty is a caller that meant to say something and did not,
        # and silently substituting the default would bury that.
        with pytest.raises(EngineInputError, match="non-empty list"):
            mc(scenarios=[])

    def test_a_scenario_list_that_is_not_a_list_is_refused(self):
        with pytest.raises(EngineInputError, match="non-empty list"):
            mc(scenarios={"name": "Base", "probability": 1.0})

    def test_more_scenarios_than_anyone_has_a_story_for_are_refused(self):
        with pytest.raises(EngineInputError, match=f"at most {MAX_SCENARIOS}"):
            mc(scenarios=identical(MAX_SCENARIOS + 1))

    def test_the_ceiling_itself_is_allowed(self):
        assert mc(scenarios=identical(MAX_SCENARIOS), paths=200)["scenarios"].__len__() == MAX_SCENARIOS

    def test_each_entry_must_be_an_object(self):
        with pytest.raises(EngineInputError, match=r"scenarios\[1\] must be an object"):
            mc(scenarios=[{"probability": 0.5}, "IPO"])

    def test_a_scenario_without_a_probability_is_refused(self):
        # Not defaulted to an equal share: which scenarios an analyst weighted
        # and which they forgot to is not something to guess at.
        with pytest.raises(EngineInputError, match=r"scenarios\[1\].probability is required"):
            mc(scenarios=[{"name": "A", "probability": 0.5}, {"name": "B"}])

    def test_a_probability_that_is_not_a_number_names_its_own_index(self):
        with pytest.raises(EngineInputError, match=r"scenarios\[0\].probability must be a number"):
            mc(scenarios=[{"name": "A", "probability": "half"}])

    def test_a_non_finite_probability_is_refused(self):
        # `json.loads` accepts the `Infinity` literal, so this arrives over the
        # wire; unguarded it normalises every other scenario's weight to zero.
        with pytest.raises(EngineInputError, match=r"scenarios\[0\].probability must be finite"):
            mc(scenarios=[{"name": "A", "probability": float("inf")}])

    def test_a_negative_probability_is_refused(self):
        with pytest.raises(EngineInputError, match=r"scenarios\[0\].probability must be >= 0"):
            mc(scenarios=[{"name": "A", "probability": -0.25}])

    def test_probabilities_that_all_sum_to_zero_are_refused(self):
        with pytest.raises(EngineInputError, match="sum to a positive number"):
            mc(scenarios=[{"name": "A", "probability": 0.0}, {"name": "B", "probability": 0.0}])

    def test_a_non_positive_horizon_is_refused(self):
        with pytest.raises(EngineInputError, match=r"scenarios\[0\].years_to_exit must be positive"):
            mc(scenarios=[{"name": "A", "probability": 1.0, "years_to_exit": -2.0}])

    def test_a_non_positive_volatility_is_refused(self):
        with pytest.raises(EngineInputError, match=r"scenarios\[0\].volatility must be positive"):
            mc(scenarios=[{"name": "A", "probability": 1.0, "volatility": 0.0}])

    def test_an_unnamed_scenario_is_numbered_rather_than_refused(self):
        # The name is a label on a table row, not an input to the arithmetic.
        out = mc(scenarios=[{"probability": 1.0}])
        assert out["scenarios"][0]["name"] == "Scenario 1"

    def test_probabilities_are_normalised_rather_than_refused(self):
        # 0.999 is a spreadsheet's rounding, not a modelling error — and `pwerm`
        # already takes the same view of the same input.
        out = mc(scenarios=[{"name": "A", "probability": 0.6}, {"name": "B", "probability": 0.399}])
        assert sum(s["probability"] for s in out["scenarios"]) == pytest.approx(1.0)


class TestThePathCount:
    def test_a_non_positive_path_count_is_refused(self):
        with pytest.raises(EngineInputError, match="monte_carlo.paths must be positive"):
            mc(paths=0)

    def test_a_path_count_past_the_latency_ceiling_is_refused(self):
        with pytest.raises(EngineInputError, match=f"at most {MAX_PATHS}"):
            mc(paths=MAX_PATHS + 2)

    def test_the_reported_count_is_what_was_actually_run(self):
        # Antithetic pairs, so an odd request is rounded down to the even count
        # the estimator really used rather than echoed back.
        assert mc(paths=1_001)["paths"] == 1_000

    def test_a_seed_that_is_not_a_number_is_refused(self):
        inputs = {"share_classes": COMMON_ONLY, "monte_carlo": {"paths": 200, "seed": "lucky"}}
        with pytest.raises(EngineInputError, match="monte_carlo.seed must be a number"):
            allocate_monte_carlo(EQUITY, inputs, t=2.0, r=0.03, sigma=0.5)


class TestTheCapTableItNeeds:
    def test_a_cap_table_is_required(self):
        with pytest.raises(EngineInputError, match="requires inputs.share_classes"):
            allocate_monte_carlo(EQUITY, {}, t=2.0, r=0.03, sigma=0.5)

    def test_a_cap_table_with_no_common_class_is_refused(self):
        # Every figure this method concludes on is per *common* share, so a
        # stack with nothing to divide by has no answer to return. The refusal
        # comes from `_normalize`, which is why `allocate_monte_carlo`'s own
        # `common_shares <= 0` guard behind it is marked unreachable.
        with pytest.raises(EngineInputError, match="at least one 'common' class"):
            mc(
                classes=[
                    {
                        "name": "Series A",
                        "kind": "preferred",
                        "shares": 1_000_000,
                        "preference": 4_000_000,
                        "seniority": 1,
                    }
                ]
            )

    def test_a_common_class_holding_no_shares_is_refused_too(self):
        # The other way to reach a zero divisor: a common class that exists but
        # is empty. `_normalize` closes this one as well.
        with pytest.raises(EngineInputError, match="shares must be positive"):
            mc(classes=[{"name": "Common", "kind": "common", "shares": 0}])

    def test_a_non_positive_equity_value_is_refused(self):
        with pytest.raises(EngineInputError, match="equity_value must be positive"):
            allocate_monte_carlo(0.0, {"share_classes": COMMON_ONLY}, t=2.0, r=0.03, sigma=0.5)


class TestTheIntervalBesideTheFigure:
    """The precision as a reader judges it, rather than as a number to convert."""

    def test_the_interval_is_the_mean_plus_and_minus_1_96_standard_errors(self):
        out = mc()
        lo, hi = out["common_per_share_ci95"]
        se = out["standard_error_per_share"]
        mean = out["common_per_share"]
        assert out["confidence_level"] == 0.95
        assert lo == pytest.approx(mean - NORMAL_95 * se, abs=1e-6)
        assert hi == pytest.approx(mean + NORMAL_95 * se, abs=1e-6)

    def test_the_interval_narrows_as_the_square_root_of_the_path_count(self):
        # The same 1/sqrt(n) the standard error obeys, since the interval is a
        # fixed multiple of it. Four times the paths, half the width.
        def width(paths):
            lo, hi = mc(paths=paths)["common_per_share_ci95"]
            return hi - lo

        assert width(16_000) == pytest.approx(width(4_000) / 2, rel=0.15)

    def test_a_payoff_with_no_randomness_left_reports_a_point_interval(self):
        # sigma at the vanishing point: every draw lands on the same exit value,
        # so there is nothing for the interval to be wide about.
        out = mc(sigma=1e-9, scenarios=identical(3, sigma=1e-9))
        lo, hi = out["common_per_share_ci95"]
        assert hi - lo == pytest.approx(0.0, abs=1e-6)

    def test_the_interval_does_not_reach_below_zero(self):
        # The payoff is a sum of call spreads and cannot be negative, so an
        # interval crossing zero would report a value the model cannot produce.
        # Reachable on a thin common slice: a preference stack that swallows the
        # equity leaves common worth almost nothing with an error beside it that
        # is not almost nothing.
        out = mc(
            classes=[
                {
                    "name": "Series A",
                    "kind": "preferred",
                    "shares": 1_000_000,
                    "preference": 40_000_000,
                    "seniority": 1,
                },
                {"name": "Common", "kind": "common", "shares": 4_000_000},
            ],
            paths=2_000,
            sigma=1.5,
        )
        lo, _ = out["common_per_share_ci95"]
        assert lo >= 0.0

    def test_the_interval_brackets_the_closed_form_it_generalises(self):
        # The single-scenario case reduces to the OPM, so the exact answer must
        # sit inside the interval the simulation claims for itself. This is the
        # property that makes the interval worth printing: it is checkable.
        out = mc(classes=STACKED, paths=20_000)
        exact = allocate_waterfall(EQUITY, STACKED, 2.0, 0.03, 0.55)
        common = next(c for c in exact["classes"].values() if c["kind"] == "common")
        lo, hi = out["common_per_share_ci95"]
        assert lo <= common["per_share"] <= hi


class TestTheSeedTheCallerChose:
    def test_a_seed_of_zero_is_the_callers_seed_and_not_the_default(self):
        # `_num(...) or DEFAULT_SEED` turned an explicit 0 into 409 and ran a
        # stream nobody asked for. The run stayed reproducible — the seed it
        # reported was the one it used — but an engagement pinned to seed 0 and
        # re-derived under seed 0 anywhere else would not have reconciled.
        zero = mc(seed=0)
        assert zero["seed"] == 0
        assert zero["common_per_share"] != mc(seed=DEFAULT_SEED)["common_per_share"]

    def test_an_absent_seed_still_defaults(self):
        inputs = {"share_classes": COMMON_ONLY, "monte_carlo": {"paths": 2_000}}
        assert allocate_monte_carlo(EQUITY, inputs, t=2.0, r=0.03, sigma=0.55)["seed"] == DEFAULT_SEED
