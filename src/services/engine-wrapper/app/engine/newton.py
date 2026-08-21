"""Newton-Raphson root finding with bisection fallback (remaining-gaps §2 — true backsolve).

Mirrors the R engine's `newton_raphson` helper: numerical derivative, bounded
iterates, and a bracketing bisection fallback so well-posed monotone problems
(the OPM backsolve, implied volatility) always converge.
"""

from __future__ import annotations

from collections.abc import Callable

from .bs import bs_call
from .errors import EngineInputError


def _opposite_signs(a: float, b: float) -> bool:
    """Do `a` and `b` straddle zero?

    Asked directly rather than as `a * b < 0`, which is how both of this
    module's bracket decisions used to be written and which is wrong twice over
    for small values. Two numbers around 1e-171 have a product around 1e-342,
    below the smallest subnormal double — so it underflows to a signed zero, and
    `-0.0 < 0.0` is False. The comparison then reports two opposite-signed
    values as same-signed.

    That is not academic once you look at what it does: bisection told that the
    root lies in the wrong half discards the half containing it and converges,
    silently and with no error, on an endpoint. For `f(x) = (x - 0.3) * 1e-170`
    bracketed on [0, 1] the old code returned 0.9999999990686774.

    Neither caller can pass an exact zero — both check for one first — so
    `> 0.0` partitions cleanly and there is no third case to think about.

    A NaN now compares same-signed with everything, which makes the bracket
    check below reject it. That is a change, and the right way round: the old
    product comparison let a NaN through to produce a number nobody could
    attribute.
    """
    return (a > 0.0) != (b > 0.0)


def _bisect(
    f: Callable[[float], float],
    lo: float,
    hi: float,
    *,
    tol: float,
    max_iter: int,
) -> tuple[float, int]:
    f_lo, f_hi = f(lo), f(hi)
    if f_lo == 0.0:
        return lo, 0
    if f_hi == 0.0:
        return hi, 0
    if not _opposite_signs(f_lo, f_hi):
        raise EngineInputError("root is not bracketed by the given bounds")
    for i in range(max_iter):
        mid = (lo + hi) / 2.0
        f_mid = f(mid)
        # Converge on the interval width, not |f| — f's scale is unknown here.
        if f_mid == 0.0 or (hi - lo) / 2.0 < tol * max(abs(mid), 1.0):
            return mid, i + 1
        if _opposite_signs(f_lo, f_mid):
            hi = mid
        else:
            lo, f_lo = mid, f_mid
    raise EngineInputError("bisection did not converge")


def newton_raphson(
    f: Callable[[float], float],
    x0: float,
    *,
    tol: float = 1e-7,
    max_iter: int = 100,
    min_x: float | None = None,
    max_x: float | None = None,
) -> tuple[float, int]:
    """Solve f(x) = 0. Returns (root, iterations).

    Central-difference derivative; when the derivative vanishes or an iterate
    escapes [min_x, max_x], falls back to bisection over the bounds.
    """
    x = x0
    for i in range(max_iter):
        fx = f(x)
        if fx == 0.0:
            return x, i
        h = max(abs(x), 1.0) * 1e-6
        dfx = (f(x + h) - f(x - h)) / (2.0 * h)
        if dfx == 0.0:
            break  # flat — Newton can't move; bisect instead
        nxt = x - fx / dfx
        if (min_x is not None and nxt < min_x) or (max_x is not None and nxt > max_x):
            break  # escaped the trust region; bisect instead
        # Converge on the step size — f's units are the caller's business.
        if abs(nxt - x) < tol * max(abs(nxt), 1.0):
            return nxt, i + 1
        x = nxt
    if min_x is not None and max_x is not None:
        return _bisect(f, min_x, max_x, tol=tol, max_iter=200)
    raise EngineInputError("newton_raphson did not converge")


def implied_volatility(
    price: float,
    s: float,
    k: float,
    t: float,
    r: float,
    *,
    lo: float = 0.01,
    hi: float = 5.0,
) -> float:
    """Volatility for which bs_call(s, k, t, r, sigma) == price."""
    if s <= 0 or t <= 0:
        raise EngineInputError("implied_volatility needs positive spot and term")
    import math

    intrinsic = max(s - k * math.exp(-r * t), 0.0)
    if not intrinsic <= price <= s:
        raise EngineInputError(
            f"price {price:.4f} outside the no-arbitrage range [{intrinsic:.4f}, {s:.4f}]"
        )
    sigma, _ = newton_raphson(
        lambda sig: bs_call(s, k, t, r, sig) - price,
        0.5,
        min_x=lo,
        max_x=hi,
    )
    return sigma
