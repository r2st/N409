"""An implied-volatility solve is bounded by a window nobody could see.

`newton.implied_volatility` bisects over a fixed volatility window and checked
the price against the *no-arbitrage* range `[intrinsic, spot]` — the set of
prices a call can have, which is far wider than the set this solver can
reproduce. A price in the gap cleared that check and then came back as
`_bisect`'s `root is not bracketed by the given bounds`: an error naming a
bracket the caller never set, cannot see, and has no field for.

On `fund_valuation.calibrate_implied_volatility` that is a round price implying
a volatility under 1% or over 500% — an ordinary slip on the term, the strike
or the share counts — answered with a message naming none of them.

The other side of the same window is quieter. Below about 1% the call is flat
in sigma to double precision on any strike the round sits well above, which is
the ordinary shape for a preference stack, so the bisection returns its floor
and the response reported `implied_volatility: 0.010000` with nothing to say it
had been pinned there rather than found. "At or below 1%, this method cannot
say" is a different assumption from a 1% somebody measured, and it is carried
downstream into the mark.
"""

from __future__ import annotations

import pytest

from app.engine.bs import bs_call
from app.engine.errors import EngineInputError
from app.engine.fund_valuation import calibrate_implied_volatility
from app.engine.newton import IMPLIED_VOL_MAX, IMPLIED_VOL_MIN, implied_volatility

# Struck at the forward, so the call is genuinely sensitive to sigma and a
# sub-floor volatility is distinguishable rather than lost in the doubles.
S = 100_000_000.0
T, R = 4.0, 0.04
K_FORWARD = S * 2.718281828459045**0.16
PREFERRED, FULLY_DILUTED = 10_000_000.0, 50_000_000.0
FRAC = PREFERRED / FULLY_DILUTED


def price_at(sigma: float, *, k: float = K_FORWARD) -> float:
    """The per-share round price a given volatility implies."""
    return bs_call(S, k, T, R, sigma) * FRAC / PREFERRED


def calibrate(price: float, *, k: float = K_FORWARD) -> dict:
    return calibrate_implied_volatility(
        round_price_per_share=price,
        total_equity_value=S,
        strike=k,
        time_to_exit_years=T,
        risk_free_rate=R,
        preferred_shares=PREFERRED,
        fully_diluted_shares=FULLY_DILUTED,
    )


class TestTheGapBetweenTheTwoRanges:
    @pytest.mark.parametrize("sigma", [0.001, 0.005, 0.0099])
    def test_a_price_under_the_search_floor_is_refused_in_this_endpoints_words(self, sigma):
        with pytest.raises(EngineInputError) as excinfo:
            calibrate(price_at(sigma))
        message = str(excinfo.value)
        assert "root is not bracketed" not in message
        assert "1%-500%" in message
        assert "below what this calibration can solve" in message

    @pytest.mark.parametrize("sigma", [5.01, 6.0, 8.0])
    def test_a_price_over_the_search_ceiling_is_refused_the_same_way(self, sigma):
        with pytest.raises(EngineInputError) as excinfo:
            calibrate(price_at(sigma))
        message = str(excinfo.value)
        assert "root is not bracketed" not in message
        assert "above what this calibration can solve" in message

    def test_the_refusal_says_which_figure_is_out_of_range(self):
        # The price is legal; it is the volatility it implies that is not. A
        # message blaming the price sends the analyst to change the one input
        # they observed.
        with pytest.raises(EngineInputError, match="inside the no-arbitrage range"):
            calibrate(price_at(0.001))

    def test_the_solver_itself_refuses_the_same_band(self):
        # Restated in the fund's units upstream, but the window lives here, so
        # this is where the rule is. Not two rules: one, said twice.
        target = bs_call(S, K_FORWARD, T, R, 0.001)
        with pytest.raises(EngineInputError, match="anything this solver can reach"):
            implied_volatility(target, S, K_FORWARD, T, R)

    def test_the_no_arbitrage_refusal_still_has_its_own_words(self):
        # The wider check is not replaced. A price above the pro-rata share is
        # not a volatility problem and must not be described as one.
        with pytest.raises(EngineInputError, match="no-arbitrage"):
            calibrate(S / FULLY_DILUTED)


class TestWhichAnswersAreTheEndOfTheWindow:
    def test_a_pinned_floor_says_so(self):
        # Deep in the money against the preference stack: the call is flat in
        # sigma below 1%, so the bisection returns its floor. That is a legal
        # answer — it reproduces the price — but it is the bound, not a solve.
        deep = 40_000_000.0
        out = calibrate(price_at(0.001, k=deep), k=deep)
        assert out["implied_volatility"] == IMPLIED_VOL_MIN
        assert out["at_search_bound"] == "floor"

    def test_an_ordinary_calibration_is_not_at_a_bound(self):
        out = calibrate(price_at(0.45))
        assert out["at_search_bound"] is None
        assert out["implied_volatility"] == pytest.approx(0.45, abs=1e-4)

    def test_the_window_travels_with_the_answer(self):
        # A reader judging "1.0%" has to know what it was searched over.
        assert calibrate(price_at(0.45))["search_range"] == [IMPLIED_VOL_MIN, IMPLIED_VOL_MAX]
