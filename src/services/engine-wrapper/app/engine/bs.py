"""Black-Scholes primitives (no scipy — math.erf is enough)."""

from __future__ import annotations

import math

from .errors import EngineInputError


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def discount_factor(r: float, t: float) -> float:
    """``e^{−r·t}``, or an EngineInputError naming the rate that has no answer.

    Every use of the discount factor below multiplies it into a strike, so it is
    the one place in this module where a caller-supplied rate meets an operation
    that leaves the doubles — and Python is inconsistent about how. ``math.exp``
    *raises* OverflowError once ``−r·t`` passes ~709.78, while ``r * t`` itself
    saturates to ``inf`` silently and ``math.exp(inf)`` then returns ``inf``.

    Both are reachable from a payload the pre-flight validator passes. The
    plausible-range check on ``risk_free_rate`` is a `warn`, not an `error` —
    deliberately, since a band is a review opinion rather than a fact about the
    arithmetic — so a rate typed as a whole number instead of a fraction (−1e6
    for "minus a million percent") clears validation with ``ok: true`` and then
    takes ``/engine/v1/compute`` down with a 500 that names nothing. That is the
    exact pairing `test_overflow_guards.py` exists to refuse: told the inputs
    were good, then handed an unhandled error for using them.

    The `inf` half is worse than the raise, because nothing downstream notices:
    ``k · inf`` is ``inf``, and ``inf · norm_cdf(d2)`` is ``nan`` the moment
    ``norm_cdf(d2)`` underflows to 0.0 — which it does for exactly the extreme
    rates that got here. A NaN option value is serialised as ``null``, so the
    allocation comes back as a successful 200 with holes in it.

    Raising rather than clamping is the same judgement `dlom.py` and
    `debt_valuation.py` already make about overflow: a ceiling on a rate is a
    modelling opinion this module has no reason to hold, but a discount factor
    that cannot be represented is not an opinion — there is genuinely no number
    to return.
    """
    try:
        df = math.exp(-r * t)
    except OverflowError as exc:
        raise EngineInputError(
            f"the discount factor e^(-r*T) overflowed a double at risk_free_rate={r:g} "
            f"over T={t:g} years — check the risk-free rate (a rate is a fraction, "
            "so 4.2% is 0.042)"
        ) from exc
    if not math.isfinite(df):
        raise EngineInputError(
            f"the discount factor e^(-r*T) is not a finite number at risk_free_rate={r:g} "
            f"over T={t:g} years — check the risk-free rate and the time to exit"
        )
    return df


def bs_call(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """European call. Degenerates to intrinsic value as t or sigma → 0."""
    if s <= 0:
        return 0.0
    if k <= 0:
        return s
    if t <= 0 or sigma <= 0:
        return max(s - k * discount_factor(r, max(t, 0.0)), 0.0)
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
    return s * norm_cdf(d1) - k * discount_factor(r, t) * norm_cdf(d2)


def bs_call_delta(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """``∂C/∂S`` — ``N(d1)``, degenerating to the intrinsic indicator as t or sigma → 0.

    Every branch mirrors ``bs_call`` above, because the two have to agree: the
    class volatilities in ``waterfall.class_volatilities`` divide a delta by the
    value the same inputs produced, and a delta computed on a different
    degenerate branch than its value is a ratio of two unrelated numbers.

    The ``k <= 0`` case is 1.0 for the same reason ``bs_call`` returns ``s``
    there: a call struck at or below zero *is* the underlying, and the first
    tranche of every breakpoint waterfall is struck at zero.
    """
    if s <= 0:
        return 0.0
    if k <= 0:
        return 1.0
    if t <= 0 or sigma <= 0:
        # Intrinsic: the option is either the underlying or nothing, and its
        # sensitivity to the underlying is 1 or 0 to match.
        return 1.0 if s > k * discount_factor(r, max(t, 0.0)) else 0.0
    sqrt_t = math.sqrt(t)
    d1 = (math.log(s) - math.log(k) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    return norm_cdf(d1)


def bs_put(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """European put via put-call parity."""
    return bs_call(s, k, t, r, sigma) - s + k * discount_factor(r, max(t, 0.0))
