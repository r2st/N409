"""The calculation step inspector's data: what `compute(trace=True)` records.

The trace exists to answer questions a finished result document cannot. Three
of them, and every test here is really one of these:

  * *Which stages ran at all?* A zero-weight approach and an approach carried
    over from an earlier run are both simply absent from `results.approaches`,
    and they mean opposite things.
  * *What did a stage consume?* The weighted mean is four multiplications the
    reader currently has to redo by hand to find which term they disagree with.
  * *Did looking change anything?* A debug view that perturbs the number it is
    describing is worse than no debug view, so the invariant is asserted
    directly rather than assumed.
"""

import math

import pytest
from fastapi.testclient import TestClient

from app.engine.compute import compute
from app.engine.trace import MAX_ITEMS, Trace, _plain
from app.main import app

client = TestClient(app)

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.6,
    "weight_income": 0.15,
    "weight_market": 0.25,
    "dloc": 0.1,
    "dlom": 0.25,
    "allocation_method": "opm",
}

INPUTS = {
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "last_round_post_money": 20_000_000,
    "income": {
        "free_cash_flows": [-500_000, 250_000, 1_200_000],
        "discount_rate": 0.3,
        "terminal_growth": 0.03,
    },
    "market": {"metric": 4_000_000, "multiples": [6.0, 4.0]},
}


def steps(out: dict) -> dict[str, dict]:
    return {s["key"]: s for s in out["trace"]}


@pytest.fixture
def traced() -> dict:
    return compute(PARAMS, INPUTS, trace=True)


class TestOptIn:
    """Tracing is off unless asked for, and never touches the answer."""

    def test_no_trace_unless_requested(self):
        assert "trace" not in compute(PARAMS, INPUTS)

    def test_the_numbers_are_identical_either_way(self, traced):
        """The invariant the whole feature rests on. `Trace` copies what it is
        handed and returns nothing to the arithmetic, so a traced run and an
        untraced one must agree to the last decimal — otherwise inspecting a
        disputed calculation would change the thing under dispute."""
        assert traced["results"] == compute(PARAMS, INPUTS)["results"]

    def test_the_trace_stays_outside_results(self, traced):
        """`results` is persisted as the answer, rendered into the report and
        diffed run-to-run. A debug record living inside it would read as the
        valuation having changed the day a step was added."""
        assert "trace" not in traced["results"]

    def test_a_disabled_recorder_keeps_nothing(self):
        off = Trace.off()
        off.record("x", "X", outputs={"big": list(range(1000))})
        assert off.as_list() == []
        assert off.enabled is False


class TestStagesRecorded:
    def test_every_pipeline_stage_appears_in_order(self, traced):
        assert [s["key"] for s in traced["trace"]] == [
            "approach.asset",
            "approach.opm_backsolve",
            "approach.income",
            "approach.market",
            "weighting",
            "allocation",
            "discounts",
        ]

    def test_steps_are_numbered_from_one(self, traced):
        assert [s["seq"] for s in traced["trace"]] == list(range(1, len(traced["trace"]) + 1))

    def test_elapsed_time_never_goes_backwards(self, traced):
        elapsed = [s["elapsed_ms"] for s in traced["trace"]]
        assert elapsed == sorted(elapsed)


class TestWhyAStageProducedNothing:
    """The distinction a results document structurally cannot make."""

    def test_a_zero_weight_approach_is_skipped_and_says_so(self, traced):
        asset = steps(traced)["approach.asset"]
        assert asset["status"] == "skipped"
        assert "zero weight" in asset["note"]
        assert asset["outputs"] is None
        # And it really is absent from the answer, which is the whole reason
        # the trace has to speak for it.
        assert "asset" not in traced["results"]["approaches"]

    def test_a_reused_approach_is_marked_reused_with_its_value(self):
        """A per-approach recalculation carries the untouched approaches over
        from the previous run. Their numbers are real and they are *older than
        the inputs above them* — the one fact an analyst reading a fresh FMV
        needs and cannot otherwise get."""
        baseline = compute(PARAMS, INPUTS)
        out = compute(
            PARAMS,
            INPUTS,
            recompute=["market"],
            prior_approaches=baseline["results"]["approaches"],
            trace=True,
        )
        income = steps(out)["approach.income"]
        assert income["status"] == "reused"
        assert "previous run" in income["note"]
        assert income["outputs"]["equity_value"] == pytest.approx(
            baseline["results"]["approaches"]["income"]["equity_value"]
        )
        # The approach that was named ran fresh.
        assert steps(out)["approach.market"]["status"] == "computed"

    def test_pwerm_says_the_weighting_did_not_apply(self):
        """Rather than silently omitting the step. A trace whose shape differs
        by allocation method leaves the reader unable to tell "missing" from
        "inapplicable", and that is the single most load-bearing difference
        between PWERM and the rest of the engine."""
        out = compute(
            {**PARAMS, "allocation_method": "pwerm"},
            {
                **INPUTS,
                "share_classes": [
                    {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000},
                    {"name": "Common", "kind": "common", "shares": 7_000_000},
                ],
                "pwerm": {
                    "scenarios": [
                        {"name": "IPO", "probability": 0.3, "equity_value": 80_000_000, "years_to_exit": 4},
                        {"name": "M&A", "probability": 0.7, "equity_value": 25_000_000, "years_to_exit": 2},
                    ]
                },
            },
            trace=True,
        )
        weighting = steps(out)["weighting"]
        assert weighting["status"] == "skipped"
        assert "scenarios" in weighting["note"]


class TestWhatAStageConsumed:
    def test_the_weighted_mean_is_shown_term_by_term(self, traced):
        """A reviewer almost never disagrees with a weighted total — they
        disagree with one contribution to it. Reading that off the result means
        multiplying four pairs by hand."""
        w = steps(traced)["weighting"]
        terms = {t["approach"]: t for t in w["inputs"]["terms"]}
        assert set(terms) == {"opm_backsolve", "income", "market"}
        for t in terms.values():
            assert t["contribution"] == pytest.approx(t["equity_value"] * t["weight"])
        assert sum(t["contribution"] for t in terms.values()) == pytest.approx(
            w["outputs"]["equity_value"]
        )

    def test_the_allocation_names_the_mechanism_it_chose(self, traced):
        """Waterfall vs single breakpoint vs as-converted is decided from the
        *shape of the cap table*, not from any parameter — so it is a decision
        nobody made explicitly."""
        alloc = steps(traced)["allocation"]
        assert alloc["outputs"]["method"] == "opm_single_breakpoint"
        assert alloc["inputs"]["liquidation_preference"] == 5_000_000
        assert alloc["inputs"]["shares_outstanding_preferred"] == 2_000_000

    def test_the_discounts_are_shown_applied_in_sequence(self, traced):
        """The common hand-check error here is subtracting the two discounts
        rather than compounding them. At 10% and 25% that is 65% of the
        marketable value against a true 67.5%, and on a per-share conclusion
        that gap is two defensible answers."""
        d = steps(traced)["discounts"]
        marketable = d["inputs"]["marketable_common_per_share"]
        assert d["outputs"]["after_dloc"] == pytest.approx(marketable * 0.9)
        assert d["outputs"]["after_dlom"] == pytest.approx(marketable * 0.9 * 0.75)
        assert d["outputs"]["combined_discount"] == pytest.approx(1 - 0.9 * 0.75)
        # And it lands on the figure the report actually publishes.
        assert d["outputs"]["fmv_per_share"] == pytest.approx(
            traced["results"]["fmv_per_share"], abs=1e-4
        )

    def test_autopilot_is_recorded_only_when_it_ran(self, traced):
        assert "autopilot" not in steps(traced)


class TestPayloadHandling:
    """`_plain` is what keeps a trace JSON-safe, bounded and detached."""

    def test_a_later_mutation_cannot_rewrite_history(self):
        live = {"multiples": [6.0]}
        tr = Trace()
        tr.record("k", "K", inputs=live)
        live["multiples"].append(999.0)
        assert tr.as_list()[0]["inputs"] == {"multiples": [6.0]}

    def test_a_long_list_is_headed_and_counted(self):
        """A projection can carry hundreds of periods. The head is what a
        reviewer scans; the count is what tells them the tail exists, which a
        silent truncation would not."""
        out = _plain(list(range(MAX_ITEMS + 10)))
        assert len(out) == MAX_ITEMS + 1
        assert out[-1] == {"__truncated__": "10 more items"}

    def test_a_non_finite_float_is_recorded_as_null_not_raised(self):
        """A run that overflowed is precisely the run worth a trace.
        `_assert_finite_results` is what refuses the *result*; serialising the
        debug record must not turn a diagnosable failure into a 500."""
        assert _plain(math.inf) is None
        assert _plain({"x": math.nan}) == {"x": None}

    def test_deep_nesting_is_summarised_rather_than_copied(self):
        deep: dict = {"leaf": 1}
        for _ in range(12):
            deep = {"down": deep}
        assert "__truncated__" in repr(_plain(deep))


class TestApiContract:
    def test_the_endpoint_returns_no_trace_by_default(self):
        res = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": INPUTS})
        assert res.status_code == 200
        assert "trace" not in res.json()

    def test_the_endpoint_returns_the_trace_when_asked(self):
        res = client.post(
            "/engine/v1/compute", json={"params": PARAMS, "inputs": INPUTS, "trace": True}
        )
        assert res.status_code == 200
        body = res.json()
        assert [s["key"] for s in body["trace"]][-1] == "discounts"
        # Every step is JSON — which it had to be to arrive here at all, but the
        # assertion is what will fail loudly if a payload ever carries an object
        # `_plain` does not flatten.
        assert all(isinstance(s["seq"], int) for s in body["trace"])

    def test_a_rejected_payload_still_reports_its_input_problems(self):
        """Tracing must not change what a 422 says. The validator runs before
        `compute` is called at all, so a traced request with a bad payload gets
        the same issue list as an untraced one."""
        bad = {"params": PARAMS, "inputs": {**INPUTS, "shares_outstanding_common": 0}}
        plain = client.post("/engine/v1/compute", json=bad)
        traced = client.post("/engine/v1/compute", json={**bad, "trace": True})
        assert plain.status_code == traced.status_code == 422
        assert plain.json()["issues"] == traced.json()["issues"]
