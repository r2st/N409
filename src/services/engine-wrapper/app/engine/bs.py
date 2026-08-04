"""Black-Scholes primitives (no scipy — math.erf is enough)."""

from __future__ import annotations

import math


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_call(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """European call. Degenerates to intrinsic value as t or sigma → 0."""
    if s <= 0:
        return 0.0
    if k <= 0:
        return s
    if t <= 0 or sigma <= 0:
        return max(s - k * math.exp(-r * max(t, 0.0)), 0.0)
    sqrt_t = math.sqrt(t)
    # log(s) - log(k), not log(s / k). The two are equal in exact arithmetic and
    # not in floating point: the quotient of two positive doubles far apart in
    # magnitude is not itself representable, so it flushes to 0.0 or saturates to
    # inf, and `math.log` *raises* on the former ("expected a positive input").
    # Both arguments here are figures the caller and the allocation supply — an
    # equity value against a liquidation preference, or against a waterfall
    # breakpoint that is the sum of a preference stack — so nothing stops them
    # being 1e7 and 1e308 apart. That raised a bare ValueError, which is not an
    # EngineInputError, so it left /engine/v1/compute as a 500 for a cap table
    # every input check had passed. The difference of logs is defined for every
    # positive finite pair and is the more accurate form besides.
    d1 = (math.log(s) - math.log(k) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    return s * norm_cdf(d1) - k * math.exp(-r * t) * norm_cdf(d2)


def bs_put(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """European put via put-call parity."""
    return bs_call(s, k, t, r, sigma) - s + k * math.exp(-r * max(t, 0.0))
