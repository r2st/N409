"""R238 — boundaries where a technically-valid input produces a degenerate answer.

Not overflow and not a refused input: every value below clears the pre-flight
validator and every guard the engine already holds, and the arithmetic completes.
What is wrong is the *conclusion* — a fair market value of zero, a schedule for
an instrument that has already matured, a weighting whose legs disagree about
what they are weighting. Each case here is a payload an analyst could plausibly
send, and each one used to come back as a successful 200.
"""

from __future__ import annotations

import pytest

from app.engine.approaches import income_dcf
from app.engine.compute import compute
from app.engine.debt_valuation import (
    convertible_note,
    coupon_schedule,
    schedule_periods,
    yield_dcf,
)
from app.engine.errors import EngineInputError
from app.engine.validate import split_issues, validate_payload

# The ordinary shape of a 2023-24 down round: $80M of preference stacked over a
# $5M post-money. Common is deeply out of the money but not worthless.
DOWN_ROUND_PARAMS = {
    "weight_asset": 0,
    "weight_opm": 1,
    "weight_income": 0,
    "weight_market": 0,
    "dlom": 0.2,
}
DOWN_ROUND_INPUTS = {
    "last_round_post_money": 5e6,
    "shares_outstanding_common": 8e6,
    "options_outstanding": 1e6,
    "shares_outstanding_preferred": 4e6,
    "liquidation_preference": 8e7,
    "volatility": 0.6,
}


# ── a conclusion of $0.0000 a share is not a conclusion ──────────────────────


def test_a_positive_allocation_below_the_quantum_is_refused_not_rounded_to_zero():
    """`fmv_per_share: 0.0` beside a non-zero `common_equity_value`.

    At 40% volatility this cap table leaves common $1.15e-05 a share — a
    positive number smaller than half the 1e-4 the conclusion is stated at. It
    used to round to 0.0 and be returned as a 200, in the same `results` object
    as a `common_equity_value` of $128.92, which is the same allocation stated
    over the whole class. The document asserted both.
    """
    with pytest.raises(EngineInputError) as exc:
        compute(DOWN_ROUND_PARAMS, {**DOWN_ROUND_INPUTS, "volatility": 0.4})
    message = str(exc.value)
    assert "rounds to $0.0000" in message
    # The unrounded figure, because that is the number to argue with — the
    # rounded one is the same zero the message is complaining about.
    assert "1.15e-05" in message
    assert "0.0001" in message
    assert "positive but below" in message


def test_an_allocation_of_exactly_zero_is_still_reported():
    """The other side of the guard, and deliberately open.

    A $1M equity value against a $500M preference at 20% volatility leaves common
    exactly 0.0 — not a rounding artifact but the model's own answer. Every
    figure in the result agrees with it, `common_equity_value` included, so it is
    a conclusion about the security rather than a quantum erasing one. That is
    also what the current-value method means on any underwater cap table, and
    refusing it would make `allocation_method: cvm` unusable for the tables it
    exists to describe.
    """
    out = compute(
        DOWN_ROUND_PARAMS,
        {
            **DOWN_ROUND_INPUTS,
            "last_round_post_money": 1e6,
            "liquidation_preference": 5e8,
            "volatility": 0.2,
        },
    )
    assert out["results"]["fmv_per_share"] == 0.0
    assert out["results"]["common_equity_value"] == 0.0


def test_the_same_cap_table_one_notch_above_the_quantum_still_concludes():
    """The guard is on the quantum, not on "deeply out of the money".

    Same stack at 50% volatility concludes $0.0003 a share. A discount that
    small is unusual and entirely valid, and refusing it would make the engine
    unable to value the down rounds it exists to value.
    """
    out = compute(DOWN_ROUND_PARAMS, {**DOWN_ROUND_INPUTS, "volatility": 0.5})
    assert out["results"]["fmv_per_share"] == 0.0003
    assert out["results"]["common_equity_value"] > 0
    # The unrounded figure is untouched by the guard: it is not a conclusion.
    assert out["fmv_per_share_unrounded"] == pytest.approx(2.826e-4, rel=1e-3)


# ── a coupon schedule is dated backwards from maturity ───────────────────────


class TestScheduleDating:
    """A maturity that is not a whole number of coupon periods.

    Entirely ordinary: the UI collects "Maturity (y)" as free text, and a note
    maturing 2027-06-30 valued at 2026-08-30 is 1.83 years. The schedule used to
    be dated forwards from today onto a whole-period grid, which is the same
    schedule only when the maturity happens to land on it.
    """

    BOND = {"face": 1000, "coupon_rate": 0.05, "frequency": 2}

    def test_the_last_flow_lands_on_the_maturity_date(self):
        schedule = coupon_schedule(**self.BOND, maturity_years=1.83)
        assert [r["t_years"] for r in schedule] == [0.33, 0.83, 1.33, 1.83]
        # The redemption is on the maturity date, not two months after it.
        assert schedule[-1]["principal"] == 1000.0

    def test_a_quarter_year_either_side_of_the_midpoint_prices_half_a_year_apart(self):
        """`round` is half-to-even: 8.5 periods went to 8 and 9.5 went to 10.

        So 4.25 years and 4.75 years — a quarter-year either side of 4.5 — were
        priced a whole year apart, at 868.08 and 841.75. The gap is now the six
        months of maturity that actually separates them.
        """
        short = yield_dcf(**self.BOND, maturity_years=4.25, market_yield=0.09)["dirty_price"]
        long = yield_dcf(**self.BOND, maturity_years=4.75, market_yield=0.09)["dirty_price"]
        assert short == pytest.approx(873.64, abs=0.01)
        assert long == pytest.approx(860.48, abs=0.01)
        # Discounted below par, so a longer note is worth less — and by roughly
        # one half-year's worth, not one whole year's.
        assert short > long
        assert short - long == pytest.approx(13.17, abs=0.05)

    def test_a_maturity_inside_the_first_period_is_not_floored_to_a_whole_one(self):
        """`max(1, round(...))` fabricated a period that was not there.

        A note with 0.3 years left had its single remaining flow dated at 0.5,
        and an instrument at maturity was priced as a half-year note.
        """
        assert [r["t_years"] for r in coupon_schedule(**self.BOND, maturity_years=0.3)] == [0.3]
        matured = coupon_schedule(**self.BOND, maturity_years=0.0)
        assert [r["t_years"] for r in matured] == [0.0]
        # Face plus the final coupon, undiscounted: that is what is due today.
        assert yield_dcf(**self.BOND, maturity_years=0.0, market_yield=0.09)["dirty_price"] == 1025.0

    def test_a_whole_number_of_periods_is_unchanged(self):
        """The aligned case — every schedule built from a tenor rather than two
        dates — keeps the dates it had, exactly."""
        assert [r["t_years"] for r in coupon_schedule(**self.BOND, maturity_years=3.0)] == [
            0.5,
            1.0,
            1.5,
            2.0,
            2.5,
            3.0,
        ]
        n, offset = schedule_periods(3.0, 2)
        assert (n, offset) == (6, 0.0)

    def test_the_convertible_tree_dates_its_coupons_off_the_same_schedule(self):
        """The tree kept a second copy of the old grid.

        Its comment says the coupon dates "come from the same schedule
        `yield_dcf` discounts, so the tree and the DCF price the same
        instrument's cash flows" — which on a 1.83-year note it did not: the
        tree paid a coupon at 2.0, after the note had been redeemed.
        """
        assert schedule_periods(1.83, 2) == (4, pytest.approx(-0.17))
        priced = convertible_note(
            face=1000,
            coupon_rate=0.05,
            frequency=2,
            maturity_years=1.83,
            conversion_ratio=20.0,
            stock_price=40.0,
            volatility=0.4,
            risk_free_rate=0.04,
            credit_spread=0.03,
        )
        # Above parity (the conversion option still has time value) and above
        # the note's straight-debt floor.
        assert priced["fair_value"] > priced["parity"] > 0
        assert priced["option_value"] > 0


# ── the one flow the Gordon perpetuity actually reads ────────────────────────


class TestTerminalFlow:
    """`all_negative_fcf` warns on "every projected cash flow"; the Gordon
    terminal value reads exactly one of them."""

    BASE = {
        "weight_asset": 0,
        "weight_opm": 0,
        "weight_income": 1,
        "weight_market": 0,
        "dlom": 0.2,
    }

    @staticmethod
    def _payload(flows):
        return {
            "income": {
                "free_cash_flows": flows,
                "discount_rate": 0.15,
                "terminal_growth": 0.02,
            }
        }

    @classmethod
    def _warn_codes(cls, payload):
        _, warnings = split_issues(validate_payload(cls.BASE, payload))
        return [w.code for w in warnings]

    def test_a_negative_terminal_year_is_warned_about(self):
        """Four good years and one bad one is not "every projected cash flow",
        so nothing used to be said — and the approach comes back negative."""
        warn_codes = self._warn_codes(self._payload([1e6, 1e6, 1e6, 1e6, -1e6]))
        assert "terminal_flow_not_positive" in warn_codes
        assert "all_negative_fcf" not in warn_codes

        # What the warning is about: the terminal leg alone is -$3.90M against a
        # +$2.36M explicit period, so the whole approach inverts.
        priced = income_dcf([1e6, 1e6, 1e6, 1e6, -1e6], 0.15, 0.02)
        assert priced["pv_explicit"] > 0
        assert priced["pv_terminal"] < 0
        assert priced["enterprise_value"] < 0

    def test_a_zero_terminal_year_is_the_quieter_half(self):
        """`FCF·(1+g)/(r−g)` is exactly 0.00, so the terminal value disappears
        and the DCF silently becomes its explicit period alone."""
        assert "terminal_flow_not_positive" in self._warn_codes(
            self._payload([1e6, 1e6, 1e6, 1e6, 0.0])
        )

        priced = income_dcf([1e6, 1e6, 1e6, 1e6, 0.0], 0.15, 0.02)
        assert priced["terminal_value"] == 0.0
        assert priced["enterprise_value"] == priced["pv_explicit"]

    def test_an_ordinary_forecast_is_not_warned_about(self):
        assert "terminal_flow_not_positive" not in self._warn_codes(
            self._payload([1e6, 1.1e6, 1.2e6, 1.3e6, 1.4e6])
        )

    def test_an_exit_multiple_terminal_value_is_not_warned_about(self):
        """It capitalises nothing — the multiple is struck on `terminal_metric`,
        which `income_dcf` already refuses when it is not positive."""
        payload = self._payload([1e6, 1e6, 1e6, 1e6, -1e6])
        payload["income"].update(
            {"terminal_method": "exit_multiple", "exit_multiple": 8.0, "terminal_metric": 2e6}
        )
        payload["income"].pop("terminal_growth")
        assert "terminal_flow_not_positive" not in self._warn_codes(payload)
