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
