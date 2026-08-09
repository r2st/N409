"""The simulated allocation, and the two things that make it usable in a 409A.

Correctness here has an unusually strong test available, and it is used: with a
single lognormal scenario the simulation is estimating exactly the quantity
``waterfall.allocate_waterfall`` computes in closed form. So the closed form is
the oracle. Any error in the drift, the discounting, the antithetic pairing or
the payoff evaluation shows up as a gap between the two that the standard error
cannot explain.

The second thing is reproducibility. A 409A that returns a different fair market
value each time it runs is indefensible — the reviewer re-running it must get
the concluded figure back, and so must the analyst defending it in an audit
three years later.
"""

import math

import pytest

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.monte_carlo import DEFAULT_PATHS, DEFAULT_SEED, allocate_monte_carlo

CLASSES = [
    {"name": "Series B", "kind": "preferred", "shares": 4_000_000, "preference": 24_000_000, "seniority": 1},
    {"name": "Series A", "kind": "preferred", "shares": 2_400_000, "preference": 8_000_000, "seniority": 2},
    {"name": "Common", "kind": "common", "shares": 9_250_000},
    {"name": "Options", "kind": "option", "shares": 1_750_000, "strike": 0.55},
]

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.08,
    "dlom": 0.25,
}

INPUTS = {
    "last_round_post_money": 72_000_000,
    "shares_outstanding_common": 9_250_000,
    "options_outstanding": 1_750_000,
    "volatility": 0.62,
    "risk_free_rate": 0.0421,
    "time_to_exit_years": 4,
    "share_classes": CLASSES,
}

EQUITY = 72_000_000.0
T, R, SIGMA = 4.0, 0.0421, 0.62


def mc(**over) -> dict:
    inputs = {**INPUTS, **over}
    return allocate_monte_carlo(EQUITY, inputs, t=T, r=R, sigma=SIGMA)


class TestAgainstTheClosedForm:
    """The oracle. One lognormal scenario is what the OPM already prices."""

    def test_it_lands_on_the_closed_form_within_its_own_error(self):
        opm = compute({**PARAMS, "allocation_method": "opm"}, INPUTS)["results"]
        sim = compute({**PARAMS, "allocation_method": "monte_carlo"}, INPUTS)["results"]

        closed = opm["allocation"]["common_per_share"]
        simulated = sim["allocation"]["common_per_share"]
        se = sim["allocation"]["standard_error_per_share"]

        assert se > 0
        # Two standard errors: a ~95% band under the CLT, and a threshold the
        # seeded sequence either clears deterministically or does not — this
        # test cannot flake, it can only be wrong.
        assert abs(simulated - closed) < 2 * se, (
            f"simulated {simulated} vs closed form {closed}, standard error {se}"
        )

    def test_the_concluded_fmv_agrees_to_the_cent(self):
        # What actually ships. The discounts are identical on both paths, so any
        # disagreement here is the allocation's.
        opm = compute({**PARAMS, "allocation_method": "opm"}, INPUTS)["results"]
        sim = compute({**PARAMS, "allocation_method": "monte_carlo"}, INPUTS)["results"]
        assert sim["fmv_per_share"] == pytest.approx(opm["fmv_per_share"], abs=0.01)

    def test_value_is_conserved_across_the_cap_table(self):
        # The risk-neutral drift is what makes this hold: the present value of
        # every class's payoff sums to the equity value being allocated. A wrong
        # drift or a missing discount factor breaks it long before it breaks the
        # per-share figure visibly.
        out = mc()
        total = sum(c["value"] for c in out["classes"].values())
        assert total == pytest.approx(EQUITY, rel=0.01)

    def test_the_estimate_tightens_as_paths_grow(self):
        # sqrt(n): quadrupling the paths should roughly halve the error. Asserted
        # loosely — the point is that the reported figure tracks the estimator's
        # actual behaviour rather than being decorative.
        coarse = mc(monte_carlo={"paths": 2_000})
        fine = mc(monte_carlo={"paths": 32_000})
        assert fine["standard_error_per_share"] < coarse["standard_error_per_share"] / 2


class TestReproducibility:
    """A concluded value nobody can re-derive is not a conclusion."""

    def test_two_runs_of_the_same_valuation_agree_exactly(self):
        assert mc()["common_per_share"] == mc()["common_per_share"]

    def test_the_whole_pipeline_is_reproducible_too(self):
        first = compute({**PARAMS, "allocation_method": "monte_carlo"}, INPUTS)["results"]
        second = compute({**PARAMS, "allocation_method": "monte_carlo"}, INPUTS)["results"]
        assert first["fmv_per_share"] == second["fmv_per_share"]

    def test_the_seed_travels_with_the_answer(self):
        # So the run can be reproduced from the stored result alone, without
        # knowing what this module's default happened to be that month.
        out = mc()
        assert out["seed"] == DEFAULT_SEED
        assert out["paths"] == DEFAULT_PATHS

    def test_a_different_seed_gives_a_different_draw(self):
        # It must actually be the seed driving the sequence — a stub that
        # ignored it would pass every test above.
        assert mc(monte_carlo={"seed": 1})["common_per_share"] != mc(monte_carlo={"seed": 2})["common_per_share"]

    def test_two_seeds_still_agree_within_error(self):
        # And the seed must not be *choosing* the answer. Two independent
        # sequences landing far apart would mean the estimator is under-sampled
        # whatever it reports.
        a, b = mc(monte_carlo={"seed": 1}), mc(monte_carlo={"seed": 2})
        pooled = math.hypot(a["standard_error_per_share"], b["standard_error_per_share"])
        assert abs(a["common_per_share"] - b["common_per_share"]) < 3 * pooled

    def test_it_does_not_disturb_the_global_random_stream(self):
        # The module holds its own PRNG. Drawing from the global one would make
        # this valuation's result depend on whatever else the process did first.
        import random

        random.seed(12345)
        expected = random.random()
        random.seed(12345)
        mc()
        assert random.random() == expected


class TestScenarioMixture:
    """The case the closed form cannot price, and the reason this exists."""

    SCENARIOS = [
        {"name": "IPO", "probability": 0.3, "years_to_exit": 5, "volatility": 0.7},
        {"name": "Trade sale", "probability": 0.7, "years_to_exit": 2, "volatility": 0.5},
    ]

    def test_each_scenario_keeps_its_own_horizon_and_volatility(self):
        # The whole point: a trade sale in two years is not the same
        # distribution as an IPO in five, and collapsing them onto one pair of
        # assumptions is what this method exists to avoid.
        out = mc(monte_carlo={"scenarios": self.SCENARIOS})
        by_name = {s["name"]: s for s in out["scenarios"]}
        assert by_name["IPO"]["years_to_exit"] == 5.0
        assert by_name["IPO"]["volatility"] == 0.7
        assert by_name["Trade sale"]["years_to_exit"] == 2.0

    def test_the_mixture_sits_between_its_scenarios(self):
        out = mc(monte_carlo={"scenarios": self.SCENARIOS})
        legs = [s["common_per_share"] for s in out["scenarios"]]
        assert min(legs) <= out["common_per_share"] <= max(legs)

    def test_probabilities_are_normalised_rather_than_refused(self):
        # 0.999 is a rounding artefact of an analyst's spreadsheet, not a
        # modelling error — and `pwerm` already takes the same view.
        out = mc(
            monte_carlo={
                "scenarios": [
                    {"name": "A", "probability": 0.6, "years_to_exit": 3},
                    {"name": "B", "probability": 0.399, "years_to_exit": 3},
                ]
            }
        )
        assert sum(s["probability"] for s in out["scenarios"]) == pytest.approx(1.0)

    def test_a_single_scenario_reproduces_the_default(self):
        explicit = mc(
            monte_carlo={"scenarios": [{"name": "Base", "probability": 1, "years_to_exit": T, "volatility": SIGMA}]}
        )
        assert explicit["common_per_share"] == pytest.approx(mc()["common_per_share"], rel=1e-9)

    def test_scenarios_that_all_have_no_probability_are_refused(self):
        with pytest.raises(EngineInputError, match="positive"):
            mc(monte_carlo={"scenarios": [{"name": "A", "probability": 0}]})


class TestInputGuards:
    def test_it_refuses_to_run_without_a_cap_table(self):
        # There is deliberately no aggregate fallback: a single blended
        # preferred class is precisely the structure the closed form prices
        # exactly, so accepting it would offer a slower, noisier route to an
        # answer the OPM gives outright.
        with pytest.raises(EngineInputError, match="share_classes"):
            allocate_monte_carlo(EQUITY, {k: v for k, v in INPUTS.items() if k != "share_classes"}, t=T, r=R, sigma=SIGMA)

    def test_the_pre_flight_says_so_before_the_run(self):
        from app.engine.validate import split_issues, validate_payload

        errors, _ = split_issues(
            validate_payload(
                {**PARAMS, "allocation_method": "monte_carlo"},
                {k: v for k, v in INPUTS.items() if k != "share_classes"},
            )
        )
        assert any(e.field == "inputs.share_classes" for e in errors)

    def test_volatility_is_required_because_it_is_what_is_being_simulated(self):
        with pytest.raises(EngineInputError, match="volatility"):
            compute(
                {**PARAMS, "allocation_method": "monte_carlo"},
                {k: v for k, v in INPUTS.items() if k != "volatility"},
            )

    def test_a_path_count_beyond_the_ceiling_is_refused(self):
        with pytest.raises(EngineInputError, match="at most"):
            mc(monte_carlo={"paths": 10_000_000})

    def test_a_zero_equity_value_is_refused(self):
        with pytest.raises(EngineInputError, match="positive"):
            allocate_monte_carlo(0.0, INPUTS, t=T, r=R, sigma=SIGMA)


class TestPipelineIntegration:
    def test_it_is_an_allocation_method_like_the_others(self):
        out = compute({**PARAMS, "allocation_method": "monte_carlo"}, INPUTS)["results"]
        assert out["allocation_method"] == "monte_carlo"
        assert out["allocation"]["method"] == "monte_carlo"

    def test_the_per_share_basis_is_the_cap_table_common(self):
        # The simulation values the option pool as its own class holding its own
        # value, so the concluded per-share figure is over the common classes
        # alone — the same rule the breakpoint waterfall follows, and the one
        # whose absence once made the summary page contradict itself.
        out = compute({**PARAMS, "allocation_method": "monte_carlo"}, INPUTS)["results"]
        assert out["fully_diluted_basis"] == "cap_table_common"
        assert out["fully_diluted_common"] == 9_250_000

    def test_the_discounts_are_applied_the_same_way(self):
        out = compute({**PARAMS, "allocation_method": "monte_carlo"}, INPUTS)["results"]
        expected = out["allocation"]["common_per_share"] * (1 - 0.08) * (1 - 0.25)
        assert out["fmv_per_share"] == pytest.approx(expected, abs=1e-4)

    def test_the_trace_records_the_simulated_allocation(self):
        out = compute({**PARAMS, "allocation_method": "monte_carlo"}, INPUTS, trace=True)
        steps = {s["key"]: s for s in out["trace"]}
        assert steps["allocation"]["outputs"]["method"] == "monte_carlo"
        assert "discounts" in steps

    def test_the_endpoint_accepts_it(self):
        from fastapi.testclient import TestClient

        from app.main import app

        res = TestClient(app).post(
            "/engine/v1/compute",
            json={"params": {**PARAMS, "allocation_method": "monte_carlo"}, "inputs": INPUTS},
        )
        assert res.status_code == 200
        assert res.json()["results"]["allocation_method"] == "monte_carlo"
