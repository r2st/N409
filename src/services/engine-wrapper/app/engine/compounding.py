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

Both are input problems, so both raise ``EngineInputError`` and become a 422
carrying the offending field name.
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
    return factor
