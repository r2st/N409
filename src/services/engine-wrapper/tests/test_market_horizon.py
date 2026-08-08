"""LTM vs NTM guideline-company multiples.

The horizon does not change the arithmetic — median multiple × metric either
way — so the tests that matter are about *which metric got picked* and whether
the answer says so. The failure this guards against is silent: extraction has
always pulled `revenue_ntm` and nothing read it, so a valuation configured for
forward multiples was struck on trailing revenue and looked entirely normal.
"""

import pytest

from app.engine.approaches import MARKET_HORIZONS, market_multiples
from app.engine.compute import _market_metric
from app.engine.errors import EngineInputError


class TestMarketMultiples:
    def test_horizon_and_basis_label_the_multiple(self):
        out = market_multiples(1_000_000, [8.0, 10.0, 12.0], horizon="ntm", basis="revenue")
        assert out["horizon"] == "ntm"
        assert out["basis"] == "revenue"
        assert out["multiple_label"] == "EV/NTM Revenue"

    def test_label_without_a_basis(self):
        out = market_multiples(1_000_000, [8.0], horizon="ltm")
        assert out["multiple_label"] == "EV/LTM"

    def test_defaults_to_ltm(self):
        assert market_multiples(1_000_000, [8.0])["horizon"] == "ltm"

    def test_horizon_does_not_change_the_arithmetic(self):
        ltm = market_multiples(1_000_000, [8.0, 12.0], horizon="ltm")
        ntm = market_multiples(1_000_000, [8.0, 12.0], horizon="ntm")
        assert ltm["enterprise_value"] == ntm["enterprise_value"] == 10_000_000

    def test_unknown_horizon_is_an_input_error(self):
        with pytest.raises(EngineInputError, match="market.horizon"):
            market_multiples(1_000_000, [8.0], horizon="forward")

    def test_booleans_are_not_multiples(self):
        """`True` is an int that is > 0, so a bare isinstance check let it
        through as a 1.0× multiple."""
        with pytest.raises(EngineInputError, match="at least one positive multiple"):
            market_multiples(1_000_000, [True, False])

    def test_cash_and_debt_bridge_to_equity(self):
        out = market_multiples(1_000_000, [10.0], cash=500_000, debt=2_000_000)
        assert out["equity_value"] == 10_000_000 + 500_000 - 2_000_000


class TestMarketMetricResolution:
    """`params.market_method` × `params.market_horizon` → which input is read."""

    INPUTS = {
        "revenue_ltm": 4_000_000,
        "revenue_ntm": 6_000_000,
        "ebitda_ltm": 500_000,
        "ebitda_ntm": 900_000,
    }

    @pytest.mark.parametrize(
        "method,horizon,expected",
        [
            ("revenue", "ltm", 4_000_000),
            ("revenue", "ntm", 6_000_000),
            ("ebitda", "ltm", 500_000),
            ("ebitda", "ntm", 900_000),
        ],
    )
    def test_each_pair_selects_its_own_figure(self, method, horizon, expected):
        params = {"market_method": method, "market_horizon": horizon}
        got_horizon, basis, metric = _market_metric(params, self.INPUTS, {})
        assert (got_horizon, basis, metric) == (horizon, method, expected)

    def test_ntm_is_not_silently_struck_on_ltm(self):
        """The regression this whole feature exists for: a forward multiple
        against trailing revenue understates a growing company by its growth
        rate, with nothing on the result saying so."""
        _, _, ntm = _market_metric(
            {"market_method": "revenue", "market_horizon": "ntm"}, self.INPUTS, {}
        )
        _, _, ltm = _market_metric(
            {"market_method": "revenue", "market_horizon": "ltm"}, self.INPUTS, {}
        )
        assert ntm == 6_000_000 and ltm == 4_000_000

    def test_horizon_defaults_to_ltm(self):
        horizon, _, metric = _market_metric({"market_method": "revenue"}, self.INPUTS, {})
        assert horizon == "ltm" and metric == 4_000_000

    def test_explicit_metric_wins(self):
        """An analyst who typed a figure means that figure."""
        _, _, metric = _market_metric(
            {"market_method": "revenue", "market_horizon": "ntm"},
            self.INPUTS,
            {"metric": 12_345.0},
        )
        assert metric == 12_345.0

    def test_explicit_metric_must_be_positive(self):
        with pytest.raises(EngineInputError, match="market.metric must be positive"):
            _market_metric({"market_method": "revenue"}, self.INPUTS, {"metric": -1.0})

    def test_missing_horizon_figure_names_both_sides(self):
        """The error has to say which input to fill in *and* that the other
        horizon is not a substitute for it."""
        with pytest.raises(EngineInputError) as exc:
            _market_metric(
                {"market_method": "ebitda", "market_horizon": "ntm"},
                {"ebitda_ltm": 500_000},
                {},
            )
        msg = str(exc.value)
        assert "ebitda_ntm" in msg and "ebitda_ltm" in msg and "not" in msg

    def test_negative_ebitda_is_refused_rather_than_multiplied(self):
        """A negative denominator makes a multiple meaningless, not small —
        and this is routine for a venture-backed company."""
        with pytest.raises(EngineInputError, match="must be positive to strike a multiple"):
            _market_metric(
                {"market_method": "ebitda", "market_horizon": "ltm"},
                {"ebitda_ltm": -250_000},
                {},
            )

    def test_no_method_and_no_metric_explains_both_ways_out(self):
        with pytest.raises(EngineInputError) as exc:
            _market_metric({}, self.INPUTS, {})
        assert "market_method" in str(exc.value)

    def test_unknown_horizon_is_an_input_error(self):
        with pytest.raises(EngineInputError, match="market_horizon"):
            _market_metric(
                {"market_method": "revenue", "market_horizon": "trailing"}, self.INPUTS, {}
            )

    def test_horizons_are_the_two_the_params_column_allows(self):
        assert MARKET_HORIZONS == ("ltm", "ntm")
