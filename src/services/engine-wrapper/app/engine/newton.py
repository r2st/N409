"""Newton-Raphson root finding with bisection fallback (remaining-gaps §2 — true backsolve).

Mirrors the R engine's `newton_raphson` helper: numerical derivative, bounded
iterates, and a bracketing bisection fallback so well-posed monotone problems
(the OPM backsolve, implied volatility) always converge.
"""

from __future__ import annotations

from collections.abc import Callable

from .bs import bs_call
from .errors import EngineInputError


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
    if f_lo * f_hi > 0:
        raise EngineInputError("root is not bracketed by the given bounds")
    for i in range(max_iter):
        mid = (lo + hi) / 2.0
        f_mid = f(mid)
        # Converge on the interval width, not |f| — f's scale is unknown here.
        if f_mid == 0.0 or (hi - lo) / 2.0 < tol * max(abs(mid), 1.0):
            return mid, i + 1
        if f_lo * f_mid < 0:
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
