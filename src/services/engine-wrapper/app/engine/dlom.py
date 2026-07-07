"""Discount for lack of marketability models (features.md — DLOM).

- Chaffee (1993): cost of an at-the-money European protective put as a
  fraction of the marketable price.
- Finnerty (2012): average-strike Asian put approximation; no interest-rate
  input, capped by construction around ~32% for extreme vol·time.
"""

from __future__ import annotations

import math

from .bs import bs_put, norm_cdf


def chaffee_dlom(sigma: float, t: float, r: float) -> float:
    if sigma <= 0 or t <= 0:
        return 0.0
    return min(max(bs_put(1.0, 1.0, t, r, sigma), 0.0), 0.99)


def finnerty_dlom(sigma: float, t: float) -> float:
    if sigma <= 0 or t <= 0:
        return 0.0
    var_t = sigma * sigma * t
    # v²T = σ²T + ln(2(e^{σ²T} − σ²T − 1)) − 2 ln(e^{σ²T} − 1)
    exp_vt = math.exp(var_t)
    inner = 2.0 * (exp_vt - var_t - 1.0)
    if inner <= 0:  # numerically zero for tiny σ²T
        return 0.0
    v_sq_t = var_t + math.log(inner) - 2.0 * math.log(exp_vt - 1.0)
    if v_sq_t <= 0:
        return 0.0
    half_v = math.sqrt(v_sq_t) / 2.0
    return min(max(norm_cdf(half_v) - norm_cdf(-half_v), 0.0), 0.99)
