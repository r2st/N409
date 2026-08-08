"""The DLOM models added alongside Chaffee/Finnerty: Ghaidarov, Longstaff and
the restricted-stock study blend.

`test_dlom.py` covers the original two. What matters here is mostly the
*relationships* between them — the models exist as alternatives to each other,
so the reason to offer a fifth is that it disagrees with the fourth somewhere
specific, and that disagreement is the thing worth pinning down.
"""

import math

import pytest

from app.engine.dlom import (
    DEFAULT_STUDY_SET,
    MODEL_DLOM_METHODS,
    RESTRICTED_STOCK_STUDIES,
    RULE_144_AMENDMENT_YEAR,
    chaffee_dlom,
    finnerty_dlom,
    ghaidarov_dlom,
    is_post_amendment,
    longstaff_bound,
    longstaff_dlom,
    restricted_stock_dlom,
)
from app.engine.errors import EngineInputError


class TestGhaidarovDlom:
    def test_basic_range(self):
        assert 0 < ghaidarov_dlom(sigma=0.5, t=2.0) < 1

    def test_zero_volatility_or_time(self):
        assert ghaidarov_dlom(sigma=0.0, t=2.0) == pytest.approx(0.0, abs=1e-12)
        assert ghaidarov_dlom(sigma=0.5, t=0.0) == pytest.approx(0.0, abs=1e-12)

    def test_monotone_in_vol_and_time(self):
        assert ghaidarov_dlom(0.8, 2.0) > ghaidarov_dlom(0.3, 2.0)
        assert ghaidarov_dlom(0.5, 5.0) > ghaidarov_dlom(0.5, 0.5)

    @pytest.mark.parametrize("sigma,t", [(0.01, 0.25), (0.02, 0.5), (0.05, 0.1)])
    def test_agrees_with_finnerty_at_small_variance(self, sigma, t):
        """Both expand to σ²T/3 as σ²T → 0, so they must agree in the small
        limit. This is the claim that makes them the *same option* rather than
        two unrelated formulas. They part at second order — around 3e-5
        relative at σ²T = 2e-4 — so the tolerance bounds the disagreement well
        below anything a discount is quoted to, rather than denying it."""
        assert ghaidarov_dlom(sigma, t) == pytest.approx(finnerty_dlom(sigma, t), rel=1e-3)

    def test_diverges_from_finnerty_faster_than_first_order(self):
        """The corollary: the gap is not uniform. It is invisible at σ²T ~ 1e-4
        and decisive at σ²T ~ 10."""
        small = abs(ghaidarov_dlom(0.02, 0.5) / finnerty_dlom(0.02, 0.5) - 1.0)
        large = abs(ghaidarov_dlom(1.0, 10.0) / finnerty_dlom(1.0, 10.0) - 1.0)
        assert small < 1e-3 < 1.0 < large

    def test_exceeds_finnerty_at_large_variance(self):
        """And part company above it — the whole reason to offer both."""
        assert ghaidarov_dlom(0.8, 5.0) > finnerty_dlom(0.8, 5.0)
        assert ghaidarov_dlom(1.0, 10.0) > finnerty_dlom(1.0, 10.0)

    def test_passes_finnerty_ceiling(self):
        """Finnerty saturates near 32.3% by construction; Ghaidarov does not.
        On a long restriction that is the difference between a 32% discount
        and a 78% one, which is the substantive point of the model."""
        assert finnerty_dlom(1.0, 10.0) == pytest.approx(0.3228, abs=5e-4)
        assert ghaidarov_dlom(1.0, 10.0) > 0.75

    def test_capped(self):
        assert ghaidarov_dlom(5.0, 50.0) <= 0.99

    def test_no_overflow_at_extreme_variance(self):
        """σ²T past ~709 overflows e^{σ²T} in a naive form; the factored one
        must survive it."""
        d = ghaidarov_dlom(10.0, 100.0)
        assert math.isfinite(d) and 0 < d <= 0.99

    def test_continuous_across_small_variance_threshold(self):
        """The series expansion and the closed form meet at σ²T = 1e-4.

        Straddling the threshold by a hair, not by a percent: the discount
        goes as √(σ²T), so evaluating 1% either side would show a 0.5% output
        gap from the input spacing alone and prove nothing about the branch.

        Of the ~1.4e-5 that remains, ~1e-5 is that input spacing and ~4e-6 is
        the expansion dropping its (σ²T)²/36 term — which is the error the
        expansion is allowed to have, four orders below the rounding the
        discount is reported at.
        """
        below = ghaidarov_dlom(math.sqrt(0.99999e-4), 1.0)
        above = ghaidarov_dlom(math.sqrt(1.00001e-4), 1.0)
        assert below == pytest.approx(above, rel=1e-4)


class TestLongstaff:
    def test_bound_is_zero_without_vol_or_time(self):
        assert longstaff_bound(0.0, 2.0) == 0.0
        assert longstaff_dlom(0.5, 0.0) == 0.0

    def test_bound_exceeds_one_for_moderate_variance(self):
        """The lookback is worth more than the security it looks back on, so
        the raw bound is not a discount and must not be used as one."""
        assert longstaff_bound(0.6, 2.0) > 0.5
        assert longstaff_bound(1.0, 10.0) > 1.0

    def test_dlom_stays_a_fraction(self):
        """L/(1+L) keeps it inside [0, 1) however large the bound gets."""
        for sigma, t in [(0.5, 2.0), (1.0, 10.0), (3.0, 30.0)]:
            d = longstaff_dlom(sigma, t)
            assert 0 <= d < 1

    def test_dlom_monotone_in_bound(self):
        assert longstaff_dlom(0.8, 5.0) > longstaff_dlom(0.3, 5.0)

    def test_is_an_upper_bound_on_the_option_models(self):
        """Longstaff prices perfect timing, so it must dominate models that
        price a single put — that is what makes it a bound."""
        for sigma, t in [(0.3, 1.0), (0.5, 2.0), (0.8, 5.0)]:
            assert longstaff_dlom(sigma, t) > finnerty_dlom(sigma, t)
            assert longstaff_dlom(sigma, t) > chaffee_dlom(sigma, t, 0.04)


class TestRestrictedStockStudies:
    def test_default_set_excludes_the_pre_amendment_study(self):
        """The default set is keyed on when a study *started* observing. The
        table holds a study named '(pre-amendment)' whose window closes in
        1997; keying on period_end swept it in, blending its 21% with the
        post-amendment 13% into a 17% default describing neither regime."""
        assert "Columbia Financial Advisors (pre-amendment)" not in DEFAULT_STUDY_SET
        assert "Columbia Financial Advisors (post-amendment)" in DEFAULT_STUDY_SET
        assert restricted_stock_dlom()["dlom"] == pytest.approx(0.13)

    def test_every_default_study_starts_after_the_amendment(self):
        by_name = {r["study"]: r for r in RESTRICTED_STOCK_STUDIES}
        for name in DEFAULT_STUDY_SET:
            assert by_name[name]["period_start"] >= RULE_144_AMENDMENT_YEAR

    def test_is_post_amendment_classifies_on_start(self):
        assert is_post_amendment({"period_start": 1997})
        assert not is_post_amendment({"period_start": 1996, "period_end": 1997})
        assert not is_post_amendment({"period_end": 2000})  # undated → not claimable

    def test_default_set_is_flagged_thin(self):
        """Only one built-in study observes the current regime end to end. The
        result says so rather than implying more support than it has."""
        assert restricted_stock_dlom()["thin_study_set"] is True

    def test_median_and_mean_differ_on_a_skewed_set(self):
        names = ["Gelman", "Johnson", "Silber"]  # 0.33, 0.20, 0.338
        med = restricted_stock_dlom(selected=names, statistic="median")
        avg = restricted_stock_dlom(selected=names, statistic="mean")
        assert med["dlom"] == pytest.approx(0.33)
        assert avg["dlom"] == pytest.approx(0.2893, abs=1e-4)

    def test_reports_the_set_it_concluded_from(self):
        out = restricted_stock_dlom(selected=["Gelman", "Johnson"])
        assert out["study_count"] == 2
        assert [r["study"] for r in out["studies"]] == ["Gelman", "Johnson"]
        assert out["low"] == pytest.approx(0.20)
        assert out["high"] == pytest.approx(0.33)

    def test_duplicate_selections_count_once(self):
        out = restricted_stock_dlom(selected=["Gelman", "Gelman", "Johnson"])
        assert out["study_count"] == 2

    def test_straddling_set_is_flagged(self):
        out = restricted_stock_dlom(
            selected=[
                "Columbia Financial Advisors (pre-amendment)",
                "Columbia Financial Advisors (post-amendment)",
            ]
        )
        assert out["straddles_rule_144_amendment"] is True

    def test_single_regime_set_is_not_flagged(self):
        out = restricted_stock_dlom(selected=["Gelman", "Moroney", "Maher"])
        assert out["straddles_rule_144_amendment"] is False

    def test_unknown_study_is_an_input_error(self):
        with pytest.raises(EngineInputError, match="unknown restricted-stock studies"):
            restricted_stock_dlom(selected=["Nonexistent Study"])

    def test_bad_statistic_is_an_input_error(self):
        with pytest.raises(EngineInputError, match="median.*mean"):
            restricted_stock_dlom(selected=["Gelman"], statistic="mode")

    def test_caller_table_replaces_the_builtins(self):
        table = [
            {"study": "Firm internal 2020", "discount": 0.155, "period_start": 2015},
            {"study": "Firm internal 2023", "discount": 0.185, "period_start": 2020},
        ]
        out = restricted_stock_dlom(studies=table)
        assert out["dlom"] == pytest.approx(0.17)
        assert {r["study"] for r in out["studies"]} == {"Firm internal 2020", "Firm internal 2023"}

    def test_caller_table_rejects_a_selection_it_does_not_contain(self):
        table = [{"study": "Firm internal", "discount": 0.2}]
        with pytest.raises(EngineInputError, match="unknown"):
            restricted_stock_dlom(selected=["Gelman"], studies=table)

    @pytest.mark.parametrize(
        "bad",
        [
            [{"discount": 0.2}],  # no name
            [{"study": "  ", "discount": 0.2}],  # blank name
            [{"study": "X"}],  # no discount
            [{"study": "X", "discount": "0.2"}],  # not a number
            [{"study": "X", "discount": True}],  # bool is not a discount
            [{"study": "X", "discount": 1.0}],  # not a fraction below 1
            [{"study": "X", "discount": -0.1}],
            [{"study": "X", "discount": float("nan")}],
            ["Gelman"],  # not an object
            [],  # empty
        ],
    )
    def test_malformed_caller_table_is_an_input_error(self, bad):
        with pytest.raises(EngineInputError):
            restricted_stock_dlom(studies=bad)


class TestMethodVocabulary:
    def test_model_methods_need_a_volatility(self):
        assert MODEL_DLOM_METHODS == {"chaffee", "finnerty", "ghaidarov", "longstaff"}

    def test_restricted_stock_is_not_a_model_method(self):
        """It takes no market inputs at all — requiring a volatility for it
        would reject a perfectly valid valuation."""
        assert "restricted_stock" not in MODEL_DLOM_METHODS
