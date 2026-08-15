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


def d1_d2(s: float, k: float, t: float, r: float, sigma: float) -> tuple[float, float]:
    """``d1`` and ``d2``, or an EngineInputError naming the volatility.

    Shared by the three non-degenerate branches below for the reason
    ``bs_call_terms`` and ``bs_call_delta`` already give for mirroring each
    other: a value, a delta and a printed schedule computed from three separately
    written copies of this algebra are three opinions about one number.

    The guard is the volatility's half of what ``discount_factor`` does for the
    rate, and it is needed for the same documented reason. The plausible-range
    check on ``volatility`` is a `warn`, not an `error` — ``VOLATILITY_BAND`` is
    a review opinion rather than a fact about the arithmetic — so any finite
    positive sigma clears validation with ``ok: true`` and arrives here. The
    variance term ``0.5·sigma²·t`` then leaves the doubles long before sigma
    itself does, and it does so *silently*, in two regimes that are both worse
    than a raise:

    - Past sigma ≈ 1.3e154, ``sigma * sigma`` saturates to ``inf`` while
      ``sigma * sqrt(t)`` is still finite. So ``d1`` is ``inf`` and ``d2`` is
      ``inf`` too — and ``N(d2) = 1`` where the limit it is standing in for is
      ``0``. The call collapses to its *intrinsic* value: on a $10M equity
      against a $5M breakpoint over four years the answer goes from the correct
      $10.0M to $5.74M, a 43% understatement returned as a successful 200.
    - Past sigma ≈ 1.8e308/sqrt(t), ``sigma * sqrt(t)`` saturates too, ``d1`` is
      ``inf/inf`` — a NaN — and every class value in the allocation is NaN. That
      is serialised as ``null``, so a cap table nobody could allocate comes back
      as a 200 with holes in it, which is precisely the failure ``_finite`` in
      ``waterfall.py`` exists to refuse one layer up.

    Both are caught by checking the pair rather than the ingredients, because
    that is the condition actually required and it stays true however the
    intermediate overflows: an infinite variance term, an infinite diffusion
    term, and the NaN their ratio produces all leave ``d1``/``d2`` non-finite.
    The healthy path is bit-identical to the expression this replaced.

    The moneyness term is checked first and separately, because it fails for a
    reason that has nothing to do with the volatility and must not be reported
    as though it had. A waterfall breakpoint is a *sum* of a preference stack,
    so it reaches this function already infinite on a cap table whose stack
    overflowed — ``s`` finite against ``k = inf`` — and blaming that on a
    volatility of 0.6 would send the reader to the one input that was fine.
    """
    if s > 0 and k > 0:
        log_moneyness = math.log(s) - math.log(k)
        if not math.isfinite(log_moneyness):
            raise EngineInputError(
                f"a non-finite Black-Scholes moneyness (spot={s:g}, strike={k:g}) — "
                "on the waterfall the strike is a breakpoint, so check the share "
                "counts and the preference stack"
            )
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
    if not math.isfinite(d1) or not math.isfinite(d2):
        raise EngineInputError(
            f"the Black-Scholes d1/d2 pair is not representable at volatility={sigma:g} "
            f"over T={t:g} years — check the volatility (a volatility is a fraction, "
            "so 60% is 0.6)"
        )
    return d1, d2


def bs_call(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """European call. Degenerates to intrinsic value as t or sigma → 0."""
    if s <= 0:
        return 0.0
    if k <= 0:
        return s
    if t <= 0 or sigma <= 0:
        return max(s - k * discount_factor(r, max(t, 0.0)), 0.0)
    d1, d2 = d1_d2(s, k, t, r, sigma)
    return s * norm_cdf(d1) - k * discount_factor(r, t) * norm_cdf(d2)


def bs_call_terms(s: float, k: float, t: float, r: float, sigma: float) -> dict:
    """``bs_call``'s answer with the working shown: ``d1``, ``d2``, ``N(d1)``,
    ``N(d2)``, the discount factor, and the call value they produce.

    Exists so the report can print the option-pricing schedule a reviewer checks
    by hand — the appendix the legacy deliverable devotes a page to — without
    re-deriving it. A second implementation in the renderer would be a page
    asserting arithmetic that is only *probably* the arithmetic the conclusion
    came from, and the first time the two disagreed the document would be wrong
    in the most expensive possible way: internally consistent, externally
    unfounded, and signed.

    Every branch mirrors ``bs_call``, for the same reason ``bs_call_delta``'s do:
    a schedule whose ``call`` came off a different degenerate branch than the
    allocation's would tabulate a number that never entered the conclusion.
    ``d1``/``d2`` are None on the degenerate branches because they genuinely do
    not exist there — a zero-volatility call is intrinsic value, not a
    probability-weighted one — and printing a fabricated 0.0 in a column a
    reviewer recomputes is worse than printing nothing.
    """
    terms: dict = {"strike": k, "d1": None, "d2": None, "n_d1": None, "n_d2": None}
    if s <= 0:
        return {**terms, "discount_factor": None, "call": 0.0}
    if k <= 0:
        # A call struck at or below zero is the underlying. N(d1) = 1 is the
        # limit rather than a convention, and stating it keeps the first tranche
        # of every waterfall — always struck at zero — from printing a row of
        # dashes where the reader expects the whole equity value.
        return {**terms, "n_d1": 1.0, "n_d2": 1.0, "discount_factor": None, "call": s}
    if t <= 0 or sigma <= 0:
        df = discount_factor(r, max(t, 0.0))
        return {**terms, "discount_factor": df, "call": max(s - k * df, 0.0)}
    d1, d2 = d1_d2(s, k, t, r, sigma)
    df = discount_factor(r, t)
    n_d1, n_d2 = norm_cdf(d1), norm_cdf(d2)
    return {
        "strike": k,
        "d1": d1,
        "d2": d2,
        "n_d1": n_d1,
        "n_d2": n_d2,
        "discount_factor": df,
        "call": s * n_d1 - k * df * n_d2,
    }


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
    d1, _ = d1_d2(s, k, t, r, sigma)
    return norm_cdf(d1)


def bs_put(s: float, k: float, t: float, r: float, sigma: float) -> float:
    """European put via put-call parity."""
    return bs_call(s, k, t, r, sigma) - s + k * discount_factor(r, max(t, 0.0))
