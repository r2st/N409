"""A SAFE conversion price the response reports as zero is not a price.

`_positive_cap` refuses a `valuation_cap` of zero because "a cap of zero
converts the instrument at a price of zero and the note converts into an
unbounded number of shares". `safe_conversion` then made the same guard on the
conversion price itself — and made it on the *unrounded* figure, while the
response published `round(conversion_price, 6)`.

So the whole band below half a microdollar cleared the guard and was reported
as `0.0`. A `valuation_cap` of 4 against a ten-million-share round is $4e-07 a
share: the response stated a conversion price of zero, handed the holder
2.5e+11 shares against the round's 10,000,000, and put its ownership at
99.996%, as a 200. `4` for `$4,000,000` is the ordinary units slip, the one
`anomalies.UNIT_MISMATCH_FACTOR` exists to catch elsewhere in this engine.

The guard is struck at the grid and not above it, so a price that survives
rounding is still priced however thin it is — a cap slipped by *six* orders of
magnitude rather than seven prices at $0.000001 a share and is left alone. This
fixes a figure the document contradicts itself about, not every implausible
one.

Six decimals is the whole grid the price is stated on, so a positive price
below it has nowhere to be reported — the same rule
`compute._concluded_fmv_per_share` applies to the concluded FMV.
"""

from __future__ import annotations

import pytest

from app.engine.debt_valuation import CONVERSION_PRICE_QUANTUM, safe_conversion
from app.engine.errors import EngineInputError

BASE = dict(
    investment=100_000.0,
    valuation_cap=8_000_000.0,
    discount=0.2,
    next_round_pre_money=20_000_000.0,
    next_round_shares=10_000_000.0,
)


class TestAPriceBelowItsOwnGrid:
    def test_a_cap_typed_in_millions_is_refused_rather_than_priced_at_zero(self):
        with pytest.raises(EngineInputError, match="conversion price resolved to"):
            safe_conversion(**{**BASE, "valuation_cap": 4.0})

    def test_the_refusal_names_the_units_slip_that_gets_there(self):
        with pytest.raises(EngineInputError) as excinfo:
            safe_conversion(**{**BASE, "valuation_cap": 4.0})
        message = str(excinfo.value)
        assert "millions" in message
        # Both legs, so the reader can see which one put the price on the floor.
        assert "cap leg is 4e-07" in message
        assert "discount leg is 1.6" in message

    def test_an_mfn_cap_reaches_the_same_guard(self):
        # The MFN terms are put through the same guards as the primary terms
        # they replace, and this one is on the resolved price, so it has to
        # catch a cap that arrived by either road.
        with pytest.raises(EngineInputError, match="conversion price resolved to"):
            safe_conversion(**{**BASE, "mfn_cap": 3.0})

    def test_a_discount_leg_below_the_grid_is_refused_too(self):
        # The other road to a sub-grid price: a round price that is itself
        # microscopic. Nothing about the cap is wrong here.
        with pytest.raises(EngineInputError, match="conversion price resolved to"):
            safe_conversion(
                **{
                    **BASE,
                    "valuation_cap": None,
                    "next_round_pre_money": 3.0,
                    "next_round_shares": 10_000_000.0,
                }
            )

    def test_a_price_exactly_on_the_grid_still_prices(self):
        # The bound is "below what can be reported", not "small". A price that
        # survives the six-decimal grid is a price, however thin.
        out = safe_conversion(
            **{**BASE, "valuation_cap": None, "discount": 0.0, "next_round_pre_money": 50.0}
        )
        assert out["conversion_price"] == pytest.approx(5e-06)
        assert out["conversion_price"] > CONVERSION_PRICE_QUANTUM / 2
        assert out["shares_received"] > 0

    def test_the_ordinary_instrument_is_untouched(self):
        out = safe_conversion(**BASE)
        assert out["conversion_price"] == 0.8
        assert out["shares_received"] == 125_000.0
        assert out["converted_via"] == "cap"
