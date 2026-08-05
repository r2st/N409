"""One safe way to raise ``(1 + rate)`` to a number of periods.

Every discounting and accretion path in the engine computes a compounding
factor, and the bare `**` operator has two failure modes that both surface as a
500 rather than a 422:

* **A base at or below zero.** ``(-1.0) ** 0.5`` is a *complex* number in
  Python, not a domain error, so the bad value keeps flowing: it reaches
  ``max(value, 0.0)`` or ``round(value, 4)`` several frames later and dies
  there with a TypeError that names neither the input nor the caller.
  ``rollforward`` already learned this the hard way and guards its own rate;
  this puts the same guard everywhere the factor is built.

* **Overflow.** Unlike multiplication, Python's float ``**`` raises
  ``OverflowError`` instead of returning ``inf`` — so a discount rate typed as
  ``25`` (meaning 25%) over a long horizon takes the whole request down with an
  unhandled exception. A rate that large is a typo, and the caller deserves to
  be told which field it was in.

* **Underflow.** The mirror image, and the one an ``isfinite`` check cannot
  see: ``0.0`` is a perfectly finite float. A base below 1 raised to a large
  enough exponent flushes the whole factor to zero — ``(1 - 0.99) ** 200`` is
  ``0.0``, not ``1e-400`` — and zero is not a compounding factor, it is the
  absence of one. Every caller then does one of two things with it, and both
  are worse than an error:

  - **Divides.** ``pwerm`` discounts each scenario's allocated value by the
    factor, so a zero divisor is a ``ZeroDivisionError`` — a 500 naming
    nothing, for a payload the pre-flight validator had just cleared. (One
    exponent lower the factor is merely *denormal*, the quotient saturates to
    ``inf``, and the finite-result guard answers 422; the caller therefore got
    a clean error for the smaller mistake and a crash for the larger one.)
  - **Multiplies.** ``fund_valuation`` accretes a mark by the factor, so a zero
    factor silently rewrites the position's fair value to 0 and reports it as a
    mark that was rolled forward normally. Nothing downstream can tell it from
    a position that genuinely went to zero — the same objection the index leg
    two lines below already raises about a return at or under -100%.

All three are input problems, so all three raise ``EngineInputError`` and
become a 422 carrying the offending field name.
"""

from __future__ import annotations

import math

from .errors import EngineInputError

__all__ = ["compound_factor"]


def compound_factor(rate: float, periods: float, name: str) -> float:
    """``(1 + rate) ** periods``, or an EngineInputError naming ``name``.

    ``name`` is the caller's field for the *rate*, so the message points at the
    input the user can actually change.
    """
    if not math.isfinite(rate):
        raise EngineInputError(f"{name} must be a finite number")
    if not math.isfinite(periods):
        raise EngineInputError(f"{name}: the compounding period must be a finite number")
    base = 1.0 + rate
    # A whole number of periods is well-defined for a negative base, but no
    # valuation input means it: it would flip the sign of the value every other
    # period. Treat the whole range as the typo it is.
    if base <= 0.0:
        raise EngineInputError(f"{name} must be greater than -1 (i.e. > -100%)")
    try:
        factor = base**periods
    except OverflowError:
        raise EngineInputError(
            f"{name} is too large to compound over {periods:g} periods — check the rate is a "
            "fraction (0.25), not a percentage (25)"
        ) from None
    if not math.isfinite(factor):
        raise EngineInputError(
            f"{name} is too large to compound over {periods:g} periods — check the rate is a "
            "fraction (0.25), not a percentage (25)"
        )
    # `isfinite` is true of 0.0, so the underflow has to be named separately.
    if factor == 0.0:
        raise EngineInputError(
            f"{name} compounds to zero over {periods:g} periods — the factor is too small to "
            "represent, so there is no value to discount or accrete by it; check the rate is a "
            "fraction (-0.25), not a percentage (-25), and that the period count is in years"
        )
    return factor
