"""Unit tests for Current Value Method (CVM) equity allocation."""

import pytest
from app.engine.errors import EngineInputError
from app.engine.current_value import allocate_cvm


COMMON_SHARES = 1_000_000
PREFERRED_SHARES = 500_000
LIQ_PREF = 2_000_000  # M liquidation preference


class TestCvmCommonOnly:
    def test_all_value_to_common(self):
        result = allocate_cvm(
            5_000_000,
            {"shares_outstanding_common": COMMON_SHARES},
        )
        assert result["method"] == "cvm_common_only"
        assert result["common_value"] == 5_000_000.0
        assert result["common_per_share"] == pytest.approx(5.0)
        assert result["common_shares"] == COMMON_SHARES

    def test_includes_options_in_diluted(self):
        result = allocate_cvm(
            5_000_000,
            {"shares_outstanding_common": 800_000, "options_outstanding": 200_000},
        )
        assert result["fully_diluted_common"] == 1_000_000
        assert result["common_per_share"] == pytest.approx(5.0)


class TestCvmProRata:
    def test_preferred_no_preference(self):
        result = allocate_cvm(
            3_000_000,
            {
                "shares_outstanding_common": COMMON_SHARES,
                "shares_outstanding_preferred": PREFERRED_SHARES,
            },
        )
        assert result["method"] == "cvm_pro_rata"
        expected_fraction = COMMON_SHARES / (COMMON_SHARES + PREFERRED_SHARES)
        assert result["common_value"] == pytest.approx(
            3_000_000 * expected_fraction, abs=1
        )


class TestCvmSinglePreference:
    def test_equity_below_preference(self):
        # Equity < liquidation preference → common gets nothing (or near zero)
        result = allocate_cvm(
            1_000_000,
            {
                "shares_outstanding_common": COMMON_SHARES,
                "shares_outstanding_preferred": PREFERRED_SHARES,
                "liquidation_preference": LIQ_PREF,
            },
        )
        assert result["method"] == "cvm_single_preference"
        assert result["common_value"] < 100  # essentially zero

    def test_equity_above_preference_conversion(self):
        # Equity high enough that preferred converts
        result = allocate_cvm(
            20_000_000,
            {
                "shares_outstanding_common": COMMON_SHARES,
                "shares_outstanding_preferred": PREFERRED_SHARES,
                "liquidation_preference": LIQ_PREF,
            },
        )
        assert result["method"] == "cvm_single_preference"
        assert result["common_value"] > 0
        assert result["equity_value"] == 20_000_000.0


class TestCvmWaterfall:
    def test_with_share_classes(self):
        classes = [
            {"name": "Common", "kind": "common", "shares": 1_000_000},
            {
                "name": "Series A",
                "kind": "preferred",
                "shares": 500_000,
                "preference": 2_000_000,
                "seniority": 1,
                "participating": False,
                "conversion_ratio": 1.0,
            },
        ]
        result = allocate_cvm(10_000_000, {"share_classes": classes})
        assert result["method"] == "cvm_waterfall"
        assert result["equity_value"] == 10_000_000.0
        assert result["common_value"] > 0
        assert result["common_per_share"] > 0


class TestCvmErrors:
    def test_negative_equity(self):
        with pytest.raises(EngineInputError, match="not positive"):
            allocate_cvm(-100, {"shares_outstanding_common": 1000})

    def test_zero_equity(self):
        with pytest.raises(EngineInputError, match="not positive"):
            allocate_cvm(0, {"shares_outstanding_common": 1000})

    def test_missing_common_shares(self):
        with pytest.raises(EngineInputError, match="shares_outstanding_common"):
            allocate_cvm(1_000_000, {})
