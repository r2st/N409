"""Unit tests for hybrid OPM+PWERM blending."""

import pytest
from app.engine.errors import EngineInputError
from app.engine.hybrid import resolve_hybrid_weights, blend_hybrid


class TestResolveHybridWeights:
    def test_default_50_50(self):
        w = resolve_hybrid_weights({})
        assert w == {"opm": 0.5, "pwerm": 0.5}

    def test_custom_weights(self):
        w = resolve_hybrid_weights({"hybrid": {"opm_weight": 0.3, "pwerm_weight": 0.7}})
        assert w["opm"] == pytest.approx(0.3)
        assert w["pwerm"] == pytest.approx(0.7)

    def test_100_0_weights(self):
        w = resolve_hybrid_weights({"hybrid": {"opm_weight": 1.0, "pwerm_weight": 0.0}})
        assert w["opm"] == 1.0
        assert w["pwerm"] == 0.0

    def test_rejects_negative(self):
        with pytest.raises(EngineInputError, match="non-negative"):
            resolve_hybrid_weights({"hybrid": {"opm_weight": -0.1, "pwerm_weight": 1.1}})

    def test_rejects_both_zero(self):
        with pytest.raises(EngineInputError, match="both be zero"):
            resolve_hybrid_weights({"hybrid": {"opm_weight": 0.0, "pwerm_weight": 0.0}})

    def test_rejects_non_unity_sum(self):
        with pytest.raises(EngineInputError, match="sum to 1.0"):
            resolve_hybrid_weights({"hybrid": {"opm_weight": 0.3, "pwerm_weight": 0.3}})

    def test_rejects_non_dict_hybrid(self):
        with pytest.raises(EngineInputError, match="must be an object"):
            resolve_hybrid_weights({"hybrid": "bad"})

    def test_rejects_non_numeric(self):
        with pytest.raises(EngineInputError, match="must be a number"):
            resolve_hybrid_weights({"hybrid": {"opm_weight": "abc", "pwerm_weight": 0.5}})

    def test_rejects_infinity(self):
        with pytest.raises(EngineInputError, match="finite"):
            resolve_hybrid_weights({"hybrid": {"opm_weight": float("inf"), "pwerm_weight": 0.5}})

    # ── A weight nobody set ──────────────────────────────────────────────────
    #
    # `EngineInputsBody` marks both weights `nullable()`, so clearing the field
    # in the financial-model form stores an explicit null and the AI extraction
    # path writes it the same way. `raw.get(key, 0.5)` only reaches its default
    # for an *absent* key, so the two spellings of an unset weight disagreed:
    # `{}` was an even split and `{"opm_weight": null}` was
    # "hybrid.opm_weight must be a number" — raised on Calculate, against a
    # document into which nobody had typed a bad weight.

    @pytest.mark.parametrize(
        "hybrid",
        [
            {"opm_weight": None, "pwerm_weight": None},
            {"opm_weight": None},
            {"pwerm_weight": None},
            {},
        ],
        ids=["both-null", "opm-null", "pwerm-null", "absent"],
    )
    def test_an_unset_weight_is_the_even_split_however_it_is_spelled(self, hybrid):
        assert resolve_hybrid_weights({"hybrid": hybrid}) == {"opm": 0.5, "pwerm": 0.5}

    def test_a_null_weight_beside_a_set_one_is_reported_as_the_sum_it_makes(self):
        # Not silently completed to the complement: 0.6 with the other weight
        # unset is 0.6 + 0.5, and saying so names the figure the analyst has to
        # fix. Inferring 0.4 would put a weight in the valuation that nobody
        # chose.
        with pytest.raises(EngineInputError, match="sum to 1.0"):
            resolve_hybrid_weights({"hybrid": {"opm_weight": 0.6, "pwerm_weight": None}})

    def test_null_is_absent_and_a_bad_value_is_still_a_bad_value(self):
        # The fix must not turn every unreadable weight into the default.
        with pytest.raises(EngineInputError, match="must be a number"):
            resolve_hybrid_weights({"hybrid": {"opm_weight": "abc", "pwerm_weight": 0.5}})


class TestPreflightAgreesWithTheAllocator:
    """The pre-flight validator and the allocator must read a weight alike.

    `/compute` pre-flights with `validate_payload` and then computes. Two
    readings of the same field is two chances to disagree, and they did: both
    refused a cleared weight, one with "hybrid weights must be finite numbers"
    and the other with "hybrid.opm_weight must be a number", on a document the
    form had accepted.
    """

    @staticmethod
    def _preflight(hybrid) -> list[str]:
        from app.engine.validate import _Collector, _check_hybrid

        collector = _Collector()
        _check_hybrid(collector, {"hybrid": hybrid})
        return [issue.message for issue in collector.issues]

    @pytest.mark.parametrize(
        "hybrid",
        [
            {},
            {"opm_weight": None, "pwerm_weight": None},
            {"opm_weight": None},
            {"opm_weight": 0.65, "pwerm_weight": 0.35},
            {"opm_weight": 1, "pwerm_weight": 0},
        ],
        ids=["absent", "both-null", "one-null", "custom", "all-opm"],
    )
    def test_what_the_allocator_accepts_the_preflight_passes(self, hybrid):
        resolve_hybrid_weights({"hybrid": hybrid})  # does not raise
        assert self._preflight(hybrid) == []

    @pytest.mark.parametrize(
        "hybrid",
        [
            {"opm_weight": 0.6, "pwerm_weight": None},
            {"opm_weight": -0.1, "pwerm_weight": 1.1},
            {"opm_weight": "abc", "pwerm_weight": 0.5},
            {"opm_weight": 0.3, "pwerm_weight": 0.3},
        ],
        ids=["null-makes-1.1", "negative", "unreadable", "sums-low"],
    )
    def test_what_the_allocator_refuses_the_preflight_reports(self, hybrid):
        with pytest.raises(EngineInputError):
            resolve_hybrid_weights({"hybrid": hybrid})
        assert self._preflight(hybrid) != []


class TestBlendHybrid:
    @pytest.fixture
    def opm_leg(self):
        return {
            "equity_value": 10_000_000,
            "common_per_share": 5.0,
            "time_to_exit_years": 3.0,
            "allocation": {"Common": {"value": 5_000_000}},
        }

    @pytest.fixture
    def pwerm_leg(self):
        return {
            "equity_value": 12_000_000,
            "common_per_share": 6.0,
            "expected_time_to_exit_years": 2.0,
            # The substance of a PWERM: which exits were modelled, at what value,
            # with what probability, and how each split across the stack.
            "scenarios": [
                {
                    "name": "IPO",
                    "probability": 0.3,
                    "exit_equity_value": 30_000_000,
                    "time_to_exit_years": 3.0,
                    "common_present_value": 9_000_000,
                },
                {
                    "name": "Acquisition",
                    "probability": 0.7,
                    "exit_equity_value": 4_285_714,
                    "time_to_exit_years": 1.57,
                    "common_present_value": 1_714_286,
                },
            ],
            "classes": {"Common": {"value": 6_000_000}},
        }

    def test_equal_weights(self, opm_leg, pwerm_leg):
        result = blend_hybrid(opm_leg, pwerm_leg, {"opm": 0.5, "pwerm": 0.5})
        assert result["method"] == "hybrid"
        assert result["equity_value"] == 11_000_000.0
        assert result["common_per_share"] == pytest.approx(5.5)
        assert result["blended_time_to_exit_years"] == pytest.approx(2.5)

    def test_all_opm(self, opm_leg, pwerm_leg):
        result = blend_hybrid(opm_leg, pwerm_leg, {"opm": 1.0, "pwerm": 0.0})
        assert result["equity_value"] == 10_000_000.0
        assert result["common_per_share"] == pytest.approx(5.0)

    def test_all_pwerm(self, opm_leg, pwerm_leg):
        result = blend_hybrid(opm_leg, pwerm_leg, {"opm": 0.0, "pwerm": 1.0})
        assert result["equity_value"] == 12_000_000.0
        assert result["common_per_share"] == pytest.approx(6.0)

    def test_preserves_sub_legs(self, opm_leg, pwerm_leg):
        result = blend_hybrid(opm_leg, pwerm_leg, {"opm": 0.6, "pwerm": 0.4})
        assert result["opm"]["equity_value"] == 10_000_000.0
        assert result["pwerm"]["equity_value"] == 12_000_000.0
        assert result["weights"] == {"opm": 0.6, "pwerm": 0.4}

    def test_carries_the_pwerm_scenarios_through(self, opm_leg, pwerm_leg):
        """The blend used to report three summary numbers for the PWERM leg.

        The OPM leg kept its full ``allocation`` while the PWERM leg was cut
        down to equity value, per-share and expected time — so a hybrid that
        put the majority of its weight on a scenario analysis could not show
        the scenarios. Exhibit G reads ``scenarios`` and could not be built at
        all, on precisely the reports whose body sends the reader to it.
        """
        result = blend_hybrid(opm_leg, pwerm_leg, {"opm": 0.35, "pwerm": 0.65})
        scenarios = result["pwerm"]["scenarios"]
        assert [s["name"] for s in scenarios] == ["IPO", "Acquisition"]
        assert sum(s["probability"] for s in scenarios) == pytest.approx(1.0)
        assert result["pwerm"]["classes"] == {"Common": {"value": 6_000_000}}

    def test_reports_a_pwerm_leg_that_carried_no_scenarios(self, opm_leg):
        """A leg with nothing to carry reports the keys, not a KeyError.

        ``blend_hybrid`` is called with whatever the PWERM allocator produced;
        a leg without scenarios is a degenerate input, not a crash, and the
        exhibit builder already treats an absent list as "no Exhibit G".
        """
        bare = {
            "equity_value": 12_000_000,
            "common_per_share": 6.0,
            "expected_time_to_exit_years": 2.0,
        }
        result = blend_hybrid(opm_leg, bare, {"opm": 0.5, "pwerm": 0.5})
        assert result["pwerm"]["scenarios"] is None
        assert result["pwerm"]["classes"] is None
