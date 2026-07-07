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
    d1 = (math.log(s / k) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    return s * norm_cdf(d1) - k * math.exp(-r * t) * norm_cdf(d2)


def bs_put(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """European put via put-call parity."""
    return bs_call(s, k, t, r, sigma) - s + k * math.exp(-r * max(t, 0.0))
