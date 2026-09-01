"""The market-movement adjustment, in isolation and through `compute`.

The legacy 409.ai deliverable gives this its own chapter ("Adjustment Factor:
Market Movement") and N409 had no equivalent at all: a round priced eight
months before the valuation date was weighted into the conclusion at its
closing price, asserting that nothing moved in between.
"""

import pytest

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.market_movement import (
    MAX_MOVEMENT_FACTOR,
    apply_movement,
    market_movement,
)

BASE_PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.0,
    "dlom_method": "finnerty",
    "exit_timeline": "2029-06-30",
    "allocation_method": "opm",
}

BASE_INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "last_round_post_money": 20_000_000,
}


def run(inputs_extra=None, **param_overrides):
    return compute(
        {**BASE_PARAMS, **param_overrides}, {**BASE_INPUTS, **(inputs_extra or {})}
    )["results"]


class TestTheFactorItself:
    def test_levels_give_the_benchmark_return(self):
        got = market_movement({"index_start": 4_000.0, "index_end": 4_400.0})
        assert got["index_return"] == pytest.approx(0.10)
        assert got["factor"] == pytest.approx(1.10)
        assert got["beta"] == 1.0

    def test_beta_gears_the_move(self):
        """A subject twice as sensitive as the benchmark moves twice as far."""
        got = market_movement({"index_start": 100.0, "index_end": 110.0, "beta": 2.0})
        assert got["factor"] == pytest.approx(1.20)

    def test_beta_zero_is_no_adjustment(self):
        """An explicit "this company does not track the index" is a legitimate
        conclusion, and has to survive as a factor of exactly 1."""
        got = market_movement({"index_start": 100.0, "index_end": 60.0, "beta": 0.0})
        assert got["factor"] == pytest.approx(1.0)

    def test_a_drawdown_marks_the_round_down(self):
        got = market_movement({"index_start": 5_000.0, "index_end": 4_000.0})
        assert got["factor"] == pytest.approx(0.80)
        assert apply_movement(50_000_000.0, got) == pytest.approx(40_000_000.0)

    def test_a_return_may_be_supplied_directly(self):
        """Some benchmarks are published as returns, not levels."""
        got = market_movement({"return": -0.12})
        assert got["factor"] == pytest.approx(0.88)
        assert "index_start" not in got

    def test_the_benchmark_is_named_on_the_result(self):
        got = market_movement(
            {
                "index_start": 100.0,
                "index_end": 105.0,
                "index_name": "S&P 500 Software Select",
                "period_start": "2025-10-15",
                "period_end": "2026-06-30",
            }
        )
        assert got["index_name"] == "S&P 500 Software Select"
        assert got["period_start"] == "2025-10-15"
        assert got["period_end"] == "2026-06-30"


class TestItRefusesNonsense:
    def test_a_missing_benchmark_is_an_input_error(self):
        with pytest.raises(EngineInputError, match="index_start and index_end"):
            market_movement({"beta": 1.0})

    def test_half_a_benchmark_names_the_missing_half(self):
        with pytest.raises(EngineInputError, match="index_end"):
            market_movement({"index_start": 100.0})

    def test_a_zero_index_level_is_refused(self):
        with pytest.raises(EngineInputError, match="positive"):
            market_movement({"index_start": 0.0, "index_end": 100.0})

    def test_a_negative_beta_is_refused(self):
        with pytest.raises(EngineInputError, match="beta"):
            market_movement({"index_start": 100.0, "index_end": 110.0, "beta": -1.0})

    def test_a_transposed_decimal_point_is_caught(self):
        """The S&P at 5,600 against a start of 56 is not a 100x market move.

        This is the failure that motivates the band: an engine that silently
        multiplies a $70M round by 100 produces a figure already reconciled to
        itself, so nothing downstream flags it.
        """
        with pytest.raises(EngineInputError, match="decimal point"):
            market_movement({"index_start": 56.0, "index_end": 5_600.0})
        assert MAX_MOVEMENT_FACTOR == 5.0

    def test_a_non_finite_level_is_refused(self):
        with pytest.raises(EngineInputError, match="finite"):
            market_movement({"index_start": float("inf"), "index_end": 100.0})

    def test_a_non_numeric_level_is_an_input_error_not_a_crash(self):
        with pytest.raises(EngineInputError, match="must be a number"):
            market_movement({"index_start": "4,000", "index_end": 4_400.0})


class TestThroughCompute:
    def test_absent_by_default(self):
        """No benchmark supplied means no adjustment made *and none claimed* —
        a valuation dated days after its round should not carry a factor of
        1.0000 implying somebody measured one."""
        res = run()
        assert "market_movement" not in res
        assert "unadjusted_equity_value" not in res["approaches"]["opm_backsolve"]

    def test_the_backsolve_indication_moves(self):
        base = run()["approaches"]["opm_backsolve"]["equity_value"]
        adjusted = run(
            inputs_extra={"market_movement": {"index_start": 100.0, "index_end": 115.0}}
        )["approaches"]["opm_backsolve"]
        assert adjusted["equity_value"] == pytest.approx(base * 1.15)
        assert adjusted["unadjusted_equity_value"] == pytest.approx(base)

    def test_both_figures_survive_to_the_result(self):
        """"What the round said" and "what we conclude it implies today" are
        two assertions, and the reconciliation exhibit prints both."""
        res = run(inputs_extra={"market_movement": {"return": 0.2, "index_name": "NASDAQ"}})
        assert res["market_movement"]["factor"] == pytest.approx(1.2)
        assert res["market_movement"]["index_name"] == "NASDAQ"
        approach = res["approaches"]["opm_backsolve"]
        assert approach["market_movement"]["factor"] == pytest.approx(1.2)

    def test_it_reaches_the_concluded_value(self):
        """The whole point: a marked-down round lowers the FMV."""
        flat = run()["fmv_per_share"]
        down = run(inputs_extra={"market_movement": {"return": -0.25}})["fmv_per_share"]
        assert down < flat

    def test_it_is_recorded_as_a_step(self):
        out = compute(
            dict(BASE_PARAMS),
            {**BASE_INPUTS, "market_movement": {"index_start": 100.0, "index_end": 90.0}},
            trace=True,
        )
        steps = {s["key"]: s for s in out["trace"]}
        assert "market_movement" in steps
        assert "-10.0%" in steps["market_movement"]["note"]
        assert steps["market_movement"]["outputs"]["equity_value"] < steps[
            "market_movement"
        ]["inputs"]["unadjusted_equity_value"]

    def test_a_bad_benchmark_fails_the_run_rather_than_being_ignored(self):
        with pytest.raises(EngineInputError):
            run(inputs_extra={"market_movement": {"index_start": 1.0, "index_end": 100.0}})


class TestReusedAcrossARecalculation:
    """A per-approach recalculation quotes the OPM approach from the prior run.

    `routes/calculations.ts` ships that run's `results.approaches` to the engine
    as `prior_approaches` whenever the analyst recalculates one approach, and
    the OPM entry it quotes already carries the adjustment. Re-striking this
    run's factor against it compounds the benchmark move once per press.
    """

    RECALC_PARAMS = {**BASE_PARAMS, "weight_opm": 0.6, "weight_income": 0.4}
    INCOME = {"free_cash_flows": [1_000_000.0, 2_000_000.0, 3_000_000.0], "discount_rate": 0.25}

    def _full(self, movement):
        inputs = {**BASE_INPUTS, "income": self.INCOME}
        if movement is not None:
            inputs["market_movement"] = movement
        return compute(dict(self.RECALC_PARAMS), inputs)["results"]

    def _recalc(self, prior, movement):
        inputs = {**BASE_INPUTS, "income": self.INCOME}
        if movement is not None:
            inputs["market_movement"] = movement
        return compute(
            dict(self.RECALC_PARAMS),
            inputs,
            recompute=["income"],
            prior_approaches=prior["approaches"],
        )["results"]

    def test_recalculating_another_approach_does_not_move_the_round_again(self):
        movement = {"index_start": 100.0, "index_end": 130.0}
        first = self._full(movement)
        second = self._recalc(first, movement)
        third = self._recalc(second, movement)
        for res in (second, third):
            opm = res["approaches"]["opm_backsolve"]
            assert opm["equity_value"] == pytest.approx(
                first["approaches"]["opm_backsolve"]["equity_value"]
            )
            assert opm["unadjusted_equity_value"] == pytest.approx(
                first["approaches"]["opm_backsolve"]["unadjusted_equity_value"]
            )
        assert third["equity_value"] == pytest.approx(first["equity_value"])
        assert third["fmv_per_share"] == pytest.approx(first["fmv_per_share"])

    def test_an_edited_benchmark_replaces_the_old_factor(self):
        first = self._full({"index_start": 100.0, "index_end": 130.0})
        indication = first["approaches"]["opm_backsolve"]["unadjusted_equity_value"]
        again = self._recalc(first, {"index_start": 100.0, "index_end": 110.0})
        opm = again["approaches"]["opm_backsolve"]
        assert opm["market_movement"]["factor"] == pytest.approx(1.1)
        assert opm["equity_value"] == pytest.approx(indication * 1.1)

    def test_a_removed_benchmark_restores_the_round_indication(self):
        first = self._full({"index_start": 100.0, "index_end": 130.0})
        indication = first["approaches"]["opm_backsolve"]["unadjusted_equity_value"]
        again = self._recalc(first, None)
        opm = again["approaches"]["opm_backsolve"]
        assert opm["equity_value"] == pytest.approx(indication)
        assert "market_movement" not in opm
        assert "unadjusted_equity_value" not in opm
        assert "market_movement" not in again

    def test_an_unadjusted_run_reused_is_untouched(self):
        first = self._full(None)
        again = self._recalc(first, None)
        assert again["approaches"]["opm_backsolve"]["equity_value"] == pytest.approx(
            first["approaches"]["opm_backsolve"]["equity_value"]
        )
        assert again["equity_value"] == pytest.approx(first["equity_value"])


class TestMovementPeriod:
    """The two period fields are printed verbatim onto the deliverable.

    Exhibit C's market-movement block states them as the window the benchmark
    levels were read over ("2025-10-15 to 2026-06-30"), so they are a claim
    about a measurement rather than free text beside one. They were taken as
    given and truncated to ten characters.
    """

    def _block(self, **over):
        return {"index_start": 100.0, "index_end": 110.0, **over}

    def test_accepts_and_normalises_an_iso_instant(self):
        got = market_movement(
            self._block(period_start="2025-10-15T00:00:00Z", period_end="2026-06-30")
        )
        assert got["period_start"] == "2025-10-15"
        assert got["period_end"] == "2026-06-30"

    def test_a_day_that_does_not_exist_is_refused(self):
        with pytest.raises(EngineInputError) as exc:
            market_movement(self._block(period_start="2026-02-31", period_end="2026-06-30"))
        assert "period_start" in str(exc.value)

    def test_free_text_is_refused_rather_than_printed(self):
        with pytest.raises(EngineInputError) as exc:
            market_movement(self._block(period_start="2025-10-15", period_end="last autumn"))
        assert "period_end" in str(exc.value)

    def test_a_window_running_backwards_is_refused(self):
        with pytest.raises(EngineInputError) as exc:
            market_movement(self._block(period_start="2026-06-30", period_end="2025-10-15"))
        assert "precedes" in str(exc.value)

    def test_an_absent_period_is_still_fine(self):
        got = market_movement(self._block())
        assert "period_start" not in got and "period_end" not in got
