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
    #
    # Evaluated literally, e^{σ²T} overflows a float once σ²T passes ~709 and
    # the engine raises OverflowError instead of returning a discount. That is
    # reachable: the volatility band is a warning rather than a hard limit, so
    # a mistyped 3000% vol over a ten-year horizon takes the whole calculation
    # down with a 500. Factoring e^{σ²T} out of both logarithms removes it:
    #
    #   ln(2(e^v − v − 1)) − 2 ln(e^v − 1)
    #     = ln2 + v + ln(1 − (v+1)e^{−v}) − 2(v + ln(1 − e^{−v}))
    #
    # so  v²T = ln2 + ln(1 − (v+1)e^{−v}) − 2 ln(1 − e^{−v}),
    # which is bounded for every σ²T and tends to ln2 — the ~32.3% ceiling the
    # model is known for — instead of exploding. expm1 keeps the small-σ²T end
    # accurate, where both logarithm arguments approach zero.
    # The other end needs care too. Both logarithm arguments collapse toward
    # zero as σ²T does, and their difference is the whole answer, so floating
    # point loses it to cancellation long before the maths does — the literal
    # form reported a 0.9% discount for a σ²T of 1e-6 whose true value is
    # 0.03%. Below the threshold the expansion v²T = σ²T/3 + O((σ²T)²) is both
    # exact in the limit and free of subtraction.
    if var_t < 1e-4:
        v_sq_t = var_t / 3.0
    else:
        decay = math.exp(-var_t)
        one_minus_exp = -math.expm1(-var_t)  # 1 − e^{−σ²T}
        inner = one_minus_exp - var_t * decay  # 1 − (σ²T + 1)·e^{−σ²T}
        if inner <= 0 or one_minus_exp <= 0:
            return 0.0
        v_sq_t = math.log(2.0) + math.log(inner) - 2.0 * math.log(one_minus_exp)
    if v_sq_t <= 0:
        return 0.0
    half_v = math.sqrt(v_sq_t) / 2.0
    return min(max(norm_cdf(half_v) - norm_cdf(-half_v), 0.0), 0.99)
