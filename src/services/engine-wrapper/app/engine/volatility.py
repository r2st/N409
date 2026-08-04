"""Volatility estimation from comparable-company price series.

Replaces the manual volatility input to the OPM/Black-Scholes allocation with
a data-driven estimate derived from the daily prices of guideline public
companies. Three estimators are supported:

- ``historical``  — annualized sample standard deviation of daily log returns.
  The textbook close-to-close estimator (features.md — volatility).
- ``ewma``        — RiskMetrics exponentially weighted moving average; weights
  recent returns more heavily (λ = 0.94 by default), so it tracks regime
  changes faster than the equal-weighted historical estimator.
- ``parkinson``   — Parkinson (1980) high-low range estimator; ~5× more
  efficient than close-to-close when intraday highs/lows are available because
  it uses the whole trading range rather than only the close.

Every estimator returns an *annualized* volatility (σ·√periods_per_year). The
engine aggregates the per-company estimates into a recommended value (the
median, which is robust to a single outlier comp) with a qualitative
confidence grade driven by comp count and cross-sectional dispersion. A manual
override always wins so an analyst can pin a specific assumption.
"""

from __future__ import annotations

import math
import statistics

from .errors import EngineInputError

__all__ = [
    "historical_volatility",
    "ewma_volatility",
    "parkinson_volatility",
    "estimate_volatility",
    "TRADING_DAYS_PER_YEAR",
]

TRADING_DAYS_PER_YEAR = 252
_METHODS = ("historical", "ewma", "parkinson")

# Annualisation factors that make sense: 1 (already annual) through hourly
# trading (252 days × ~7 hours). The cap is not physics, it is a bound that
# keeps a typo from producing a four-digit "volatility" that reads as real.
_MAX_PERIODS_PER_YEAR = 8760

# Below this, a comp's measured volatility is indistinguishable from "the
# series never moved" — 0.01% annualized is far under any traded equity.
_MIN_MEANINGFUL_VOLATILITY = 1e-4


def _check_periods(periods_per_year: int) -> int:
    """Validate the annualisation factor (audit — volatility edge cases).

    ``σ_annual = σ_period · √periods`` is the only use of this number, and it
    arrives straight off the wire as an unbounded ``int``. Left unchecked:

    - a negative value reaches ``math.sqrt`` and raises a bare ``ValueError``,
      which surfaces as a 500 instead of the 422 a bad input deserves;
    - zero annualises every estimate to exactly 0.0 and returns 200, and the
      zero is only rejected much later by the OPM — as "volatility is
      required", an error naming the wrong field entirely.
    """
    if isinstance(periods_per_year, bool) or not isinstance(periods_per_year, int):
        raise EngineInputError("periods_per_year must be an integer")
    if periods_per_year < 1:
        raise EngineInputError("periods_per_year must be a positive integer")
    if periods_per_year > _MAX_PERIODS_PER_YEAR:
        raise EngineInputError(f"periods_per_year must be <= {_MAX_PERIODS_PER_YEAR}")
    return periods_per_year


def _clean_series(values, name: str) -> list[float]:
    if not isinstance(values, (list, tuple)):
        raise EngineInputError(f"{name} must be a list of prices")
    out: list[float] = []
    for v in values:
        try:
            price = float(v)
        except (TypeError, ValueError):
            raise EngineInputError(f"{name} must contain only numbers") from None
        # A NaN price survives the positivity check below (`NaN <= 0` is False)
        # and makes every log return NaN; statistics.stdev then raises a bare
        # ValueError, which reaches the caller as a 500 rather than as the 422
        # a bad price series deserves.
        if not math.isfinite(price):
            raise EngineInputError(f"{name} must contain only finite numbers")
        out.append(price)
    return out


def _log_returns(prices: list[float], name: str) -> list[float]:
    """Close-to-close log returns of a positive price series.

    Taken as `log(cur) - log(prev)` rather than `log(cur / prev)`. The two agree
    in exact arithmetic; in floating point the quotient of two positive doubles
    far apart in magnitude is not representable, so it flushes to 0.0 (or
    saturates to inf) and `math.log` raises "expected a positive input" on a
    series whose every entry passed the positivity check immediately above.
    That ValueError is not an EngineInputError, so it surfaced as a 500 rather
    than the 422 a bad price series deserves — the same failure the finiteness
    check in `_clean_series` was added for, one operation later.

    The difference of logs is defined for every positive finite pair, and is the
    numerically better form for near-equal prices as well.
    """
    if len(prices) < 2:
        raise EngineInputError(f"{name} needs at least 2 prices to compute a return")
    returns: list[float] = []
    for i in range(1, len(prices)):
        prev, cur = prices[i - 1], prices[i]
        if prev <= 0 or cur <= 0:
            raise EngineInputError(f"{name} prices must be positive to take log returns")
        returns.append(math.log(cur) - math.log(prev))
    return returns


def historical_volatility(
    prices,
    *,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
) -> float:
    """Annualized close-to-close volatility: stdev(log returns)·√periods."""
    _check_periods(periods_per_year)
    returns = _log_returns(_clean_series(prices, "prices"), "prices")
    if len(returns) < 2:
        raise EngineInputError("historical volatility needs at least 3 prices")
    daily = statistics.stdev(returns)  # sample std (ddof=1)
    return daily * math.sqrt(periods_per_year)


def ewma_volatility(
    prices,
    *,
    lambda_: float = 0.94,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
) -> float:
    """Annualized RiskMetrics EWMA volatility.

    σ²_t = λ·σ²_{t-1} + (1−λ)·r²_t, seeded with the sample variance so the
    recursion starts from a sensible level rather than a single squared return.
    """
    _check_periods(periods_per_year)
    if not 0.0 < lambda_ < 1.0:
        raise EngineInputError("ewma lambda_ must be in (0, 1)")
    returns = _log_returns(_clean_series(prices, "prices"), "prices")
    if len(returns) < 2:
        raise EngineInputError("ewma volatility needs at least 3 prices")
    var = statistics.pvariance(returns)  # seed
    for r in returns:
        var = lambda_ * var + (1.0 - lambda_) * r * r
    return math.sqrt(var) * math.sqrt(periods_per_year)


def parkinson_volatility(
    highs,
    lows,
    *,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
) -> float:
    """Annualized Parkinson high-low range volatility.

    σ²_daily = (1 / 4ln2)·mean( ln(High/Low)² ).  Annualized as σ·√periods.
    """
    _check_periods(periods_per_year)
    high_series = _clean_series(highs, "highs")
    low_series = _clean_series(lows, "lows")
    if len(high_series) != len(low_series):
        raise EngineInputError("highs and lows must be the same length")
    if len(high_series) < 1:
        raise EngineInputError("parkinson volatility needs at least 1 high/low pair")
    factor = 1.0 / (4.0 * math.log(2.0))
    squared: list[float] = []
    for h, low in zip(high_series, low_series):
        if h <= 0 or low <= 0:
            raise EngineInputError("parkinson highs/lows must be positive")
        if h < low:
            raise EngineInputError("parkinson high must be >= low")
        # Differenced for the reason `_log_returns` documents. Here the ratio
        # saturates upward rather than down — `h / low` for a high far above the
        # low is inf, which squares to inf and carries an infinite volatility
        # all the way out of the estimator instead of raising.
        squared.append((math.log(h) - math.log(low)) ** 2)
    daily_var = factor * (sum(squared) / len(squared))
    return math.sqrt(daily_var) * math.sqrt(periods_per_year)


def _company_volatility(company: dict, method: str, periods_per_year: int) -> float:
    if method == "parkinson":
        highs = company.get("highs")
        lows = company.get("lows")
        if highs is None or lows is None:
            raise EngineInputError(
                f"comparable '{company.get('ticker', '?')}' needs highs/lows for the parkinson method"
            )
        return parkinson_volatility(highs, lows, periods_per_year=periods_per_year)
    prices = company.get("prices")
    if prices is None:
        raise EngineInputError(f"comparable '{company.get('ticker', '?')}' needs a prices series")
    if method == "ewma":
        return ewma_volatility(prices, periods_per_year=periods_per_year)
    return historical_volatility(prices, periods_per_year=periods_per_year)


def _confidence(vols: list[float]) -> tuple[str, float]:
    """Grade the estimate by comp count and cross-sectional dispersion.

    Returns (label, coefficient_of_variation). Fewer comps or a wider spread of
    per-company vols → lower confidence in the median.
    """
    n = len(vols)
    mean = statistics.fmean(vols)
    cv = (statistics.stdev(vols) / mean) if n >= 2 and mean > 0 else 0.0
    if n >= 5 and cv < 0.30:
        label = "high"
    elif n >= 3 and cv < 0.50:
        label = "medium"
    else:
        label = "low"
    return label, cv


def estimate_volatility(
    comparables: list[dict],
    *,
    method: str = "historical",
    time_to_exit_years: float | None = None,
    periods_per_year: int = TRADING_DAYS_PER_YEAR,
    manual_override: float | None = None,
) -> dict:
    """Estimate equity volatility from comparable-company price series.

    ``comparables`` is a list of ``{"ticker", "prices"[, "highs", "lows"]}``.
    Returns the median/mean vols, the per-company breakdown, and a recommended
    value with a confidence grade. A ``manual_override`` (a fraction, e.g.
    0.60) short-circuits the estimation and is echoed as the recommendation.
    """
    if method not in _METHODS:
        raise EngineInputError(f"method must be one of {_METHODS}")

    if manual_override is not None:
        try:
            override = float(manual_override)
        except (TypeError, ValueError):
            raise EngineInputError("manual_override must be a number") from None
        if not 0.0 < override < 5.0:
            raise EngineInputError("manual_override must be a fraction in (0, 5)")

    if not isinstance(comparables, list) or not comparables:
        if manual_override is not None:
            return {
                "method": "manual",
                "recommended_volatility": round(float(manual_override), 4),
                "manual_override": round(float(manual_override), 4),
                "confidence": "manual",
                "companies": [],
                "time_to_exit_years": time_to_exit_years,
            }
        raise EngineInputError("comparables must be a non-empty list (or provide manual_override)")

    companies: list[dict] = []
    vols: list[float] = []
    excluded: list[dict] = []
    for company in comparables:
        if not isinstance(company, dict):
            raise EngineInputError("each comparable must be an object")
        vol = _company_volatility(company, method, periods_per_year)
        ticker = str(company.get("ticker") or f"comp{len(companies) + 1}")
        degenerate = vol <= _MIN_MEANINGFUL_VOLATILITY
        companies.append(
            {"ticker": ticker, "volatility": round(vol, 4), "used": not degenerate}
        )
        if degenerate:
            # A comp whose whole window has no measurable movement is a data
            # problem, not a company with no risk — a stale feed, a padded
            # series, a suspended listing. Left in, it drags the median toward
            # zero (three flat comps out of five put the median *exactly* on
            # zero), and the dispersion grade stays quiet about it because a
            # tight cluster of zeros looks like agreement. Excluded and named.
            excluded.append({"ticker": ticker, "reason": "no measurable price movement"})
            continue
        vols.append(vol)

    if not vols:
        if manual_override is not None:
            # The analyst pinned a value; the dead comps cost nothing.
            vols = [float(manual_override)]
        else:
            raise EngineInputError(
                "no comparable had measurable price movement — check the price series "
                "or provide manual_override"
            )

    median_vol = statistics.median(vols)
    mean_vol = statistics.fmean(vols)
    confidence, cv = _confidence(vols)

    recommended = float(manual_override) if manual_override is not None else median_vol
    return {
        "method": method if manual_override is None else "manual",
        "recommended_volatility": round(recommended, 4),
        "median_volatility": round(median_vol, 4),
        "mean_volatility": round(mean_vol, 4),
        "min_volatility": round(min(vols), 4),
        "max_volatility": round(max(vols), 4),
        "coefficient_of_variation": round(cv, 4),
        "confidence": "manual" if manual_override is not None else confidence,
        "manual_override": round(float(manual_override), 4) if manual_override is not None else None,
        # Counts the comps the recommendation actually rests on. `companies`
        # still lists every one, each flagged `used`, so the exclusion is
        # auditable rather than silent.
        "company_count": len(vols),
        "companies": companies,
        "excluded_companies": excluded,
        "time_to_exit_years": time_to_exit_years,
        "periods_per_year": periods_per_year,
    }
