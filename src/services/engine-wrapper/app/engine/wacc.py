"""WACC via CAPM for the income (DCF) approach.

Cost of equity is built up from the modified CAPM used in private-company
valuation (features.md — income approach):

    Ke = Rf + β·ERP + size_premium + company_specific_premium

- **Rf** — risk-free rate, looked up from a static Treasury yield curve by the
  maturity that best matches the forecast horizon (a live curve can be injected
  via ``treasury_curve``; the defaults are a placeholder mid-2026 curve).
- **β** — re-levered from the comparable companies: each comp's observed
  (levered) equity beta is unlevered with Hamada, the median unlevered beta is
  taken (robust to one mis-estimated comp), then re-levered to the subject's
  own capital structure.
- **ERP** — equity risk premium (Damodaran / Kroll-Duff & Phelps supply ~5%);
  configurable.
- **size_premium** — CRSP-decile style premium keyed off the subject's equity
  market-cap tier; small private companies sit in the smallest tier.
- **company_specific_premium (CSRP)** — analyst judgment for idiosyncratic risk
  not captured by the comps.

WACC then blends the cost of equity with the after-tax cost of debt at the
target capital-structure weights:

    WACC = We·Ke + Wd·Kd·(1 − tax)
"""

from __future__ import annotations

import math
import statistics

from .errors import EngineInputError

__all__ = [
    "unlever_beta",
    "relever_beta",
    "risk_free_rate",
    "size_premium",
    "compute_wacc",
    "DEFAULT_TREASURY_CURVE",
    "DEFAULT_EQUITY_RISK_PREMIUM",
    "SIZE_PREMIUM_TIERS",
]

# Static Treasury par-yield curve (maturity years → yield). Placeholder curve
# standing in for a live Treasury feed; override via ``treasury_curve``.
DEFAULT_TREASURY_CURVE: dict[float, float] = {
    0.25: 0.0525,
    0.5: 0.0510,
    1.0: 0.0475,
    2.0: 0.0440,
    3.0: 0.0425,
    5.0: 0.0420,
    7.0: 0.0425,
    10.0: 0.0435,
    20.0: 0.0465,
    30.0: 0.0470,
}

# Damodaran / Kroll implied US equity risk premium (mid-2020s ~5%).
DEFAULT_EQUITY_RISK_PREMIUM = 0.05

# CRSP-decile style size premium by equity market-cap tier (USD). Smallest
# private companies land in the micro tier. Ordered low→high cap.
# Each tuple is (min_cap, max_cap, premium).
SIZE_PREMIUM_TIERS: list[tuple[float, float, float]] = [
    (0.0, 2.5e8, 0.0550),          # micro-cap (< $250M)
    (2.5e8, 7.0e8, 0.0350),        # small-cap
    (7.0e8, 2.0e9, 0.0200),        # low-mid cap
    (2.0e9, 1.0e10, 0.0100),       # mid cap
    (1.0e10, float("inf"), 0.0),   # large cap — no premium
]

DEFAULT_TAX_RATE = 0.21  # US federal corporate rate


def _num(value, name: str, *, positive: bool = False, nonneg: bool = False) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be a number") from None
    # float('nan') passes every comparison below, so without this a NaN walks
    # through the whole build-up and comes back out as a null WACC on a 200 —
    # a broken number the caller is told nothing about. `float("nan")` and
    # `float("inf")` both accept those strings, so a JSON payload can reach it.
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be a finite number")
    if positive and out <= 0:
        raise EngineInputError(f"{name} must be positive")
    if nonneg and out < 0:
        raise EngineInputError(f"{name} must be >= 0")
    return out


def _tax_rate(value, name: str) -> float:
    """A corporate tax rate, held to [0, 1).

    Both the subject's rate and each comparable's feed the same Hamada factor,
    so they need the same band — and only the subject's had one. `_levering_
    factor` catches an out-of-band comparable rate only where the factor lands
    at or below zero; a rate above 1 paired with a small enough D/E leaves it
    positive and the estimate simply comes out wrong. A comparable taxed at
    200% with D/E 0.5 gives a factor of 0.5, so the comp's beta is *divided* by
    a half: an unlevered beta of 2.4 where 0.86 was right, and a cost of equity
    of 16% where 8.3% was — returned as a successful 200 with nothing on it to
    say the number is impossible.
    """
    out = _num(value, name, nonneg=True)
    if out >= 1.0:
        raise EngineInputError(f"{name} must be in [0, 1)")
    return out


def _levering_factor(debt_to_equity: float, tax_rate: float) -> float:
    """Hamada factor 1 + (1 − tax)·D/E, rejected unless it is positive.

    A tax rate at or above 1 makes (1 − tax) non-positive, and the factor then
    reaches zero — a division by zero out of ``unlever_beta``, which surfaced
    as a 500 — or turns negative, which is worse: the beta comes back with its
    sign flipped and the cost of equity is quietly built on it.
    """
    if debt_to_equity < 0:
        raise EngineInputError("debt_to_equity must be >= 0")
    factor = 1.0 + (1.0 - tax_rate) * debt_to_equity
    if factor <= 0:
        raise EngineInputError(
            f"tax_rate {tax_rate:g} with debt_to_equity {debt_to_equity:g} "
            "gives a non-positive Hamada levering factor"
        )
    return factor


def unlever_beta(levered_beta: float, debt_to_equity: float, tax_rate: float) -> float:
    """Hamada unlevering: βu = βl / (1 + (1 − tax)·D/E)."""
    return levered_beta / _levering_factor(debt_to_equity, tax_rate)


def relever_beta(unlevered_beta: float, debt_to_equity: float, tax_rate: float) -> float:
    """Hamada relevering: βl = βu · (1 + (1 − tax)·D/E)."""
    return unlevered_beta * _levering_factor(debt_to_equity, tax_rate)


def _normalize_curve(curve) -> list[tuple[float, float]]:
    """Coerce a treasury curve into sorted, validated (maturity, yield) points.

    The ``dict[float, float]`` this parameter advertises is not a shape any HTTP
    caller can send: JSON object keys are always strings. A curve posted as
    ``{"5": 0.041, "10": 0.045}`` therefore arrived with *string* maturities,
    the maturities sorted lexically ("10" before "5"), and the first
    ``maturity_years <= points[0][0]`` compared a float to a str — a bare
    TypeError that ``/compute`` (which catches only ``EngineInputError``)
    returned as a 500. A non-dict fared worse still: ``[].items()`` raised
    AttributeError before any guard could run. The documented override was
    unreachable from the API by either route, and the failure named nothing the
    caller could act on.

    Coercing the keys is the fix, and it brings the checks a hand-built curve
    also lacked: a non-numeric or non-finite entry, and duplicate maturities —
    ``{"5": 0.04, "5.0": 0.05}`` collapses to two points at 5.0, and
    interpolating strictly between them divides by ``m1 - m0`` == 0.
    """
    if not isinstance(curve, dict):
        raise EngineInputError(
            "treasury_curve must be an object of {maturity_years: yield}"
        )
    points: list[tuple[float, float]] = []
    seen: set[float] = set()
    for maturity, yield_ in curve.items():
        m = _num(maturity, f"treasury_curve maturity {maturity!r}", positive=True)
        y = _num(yield_, f"treasury_curve[{maturity!r}]")
        if m in seen:
            raise EngineInputError(f"treasury_curve has duplicate maturity {m:g}")
        seen.add(m)
        points.append((m, y))
    if not points:
        raise EngineInputError("treasury curve is empty")
    points.sort()
    return points


def risk_free_rate(
    maturity_years,
    # Deliberately an untyped dict, not `dict[float, float]`: the maturities
    # arrive as JSON object keys, so they are strings as often as they are
    # numbers, and the old annotation described a call no client could make.
    # `_normalize_curve` is what actually establishes the shape.
    curve: dict | None = None,
) -> float:
    """Linearly interpolate the Treasury yield for ``maturity_years``.

    Clamps to the nearest endpoint outside the curve's range.
    """
    # Through `_num`, not a bare comparison: `forecast_horizon_years` reaches
    # here straight off the wire, and `"abc" <= 0` is a TypeError, not a 422.
    maturity_years = _num(maturity_years, "maturity_years", positive=True)
    # `curve or DEFAULT` would treat an explicitly empty curve as "not given"
    # and quietly answer from the placeholder curve instead — a discount rate
    # built on figures the caller did not supply, and it made the emptiness
    # guard unreachable. Only an absent curve falls back.
    points = _normalize_curve(DEFAULT_TREASURY_CURVE if curve is None else curve)
    if maturity_years <= points[0][0]:
        return points[0][1]
    if maturity_years >= points[-1][0]:
        return points[-1][1]
    for (m0, y0), (m1, y1) in zip(points, points[1:]):
        if m0 <= maturity_years <= m1:
            w = (maturity_years - m0) / (m1 - m0)
            return y0 + w * (y1 - y0)
    return points[-1][1]  # unreachable, defensive


def size_premium(
    market_cap: float,
    tiers: list[tuple[float, float, float]] | None = None,
) -> tuple[float, str]:
    """Return (premium, tier_label) for an equity market cap."""
    if market_cap < 0:
        raise EngineInputError("market_cap must be >= 0")
    for lo, hi, prem in tiers or SIZE_PREMIUM_TIERS:
        if lo <= market_cap < hi:
            return prem, f"[{lo:,.0f}, {hi:,.0f})"
    return 0.0, "large"


def _median_unlevered_beta(
    comparables: list[dict],
    tax_rate: float,
) -> tuple[float, list[dict]]:
    if not isinstance(comparables, list) or not comparables:
        raise EngineInputError("comparable_betas must be a non-empty list")
    detail: list[dict] = []
    unlevered: list[float] = []
    for c in comparables:
        if not isinstance(c, dict):
            raise EngineInputError("each comparable beta must be an object")
        beta = _num(c.get("beta"), "comparable.beta")
        de = _num(c.get("debt_to_equity", 0.0), "comparable.debt_to_equity", nonneg=True)
        comp_tax = _tax_rate(c.get("tax_rate", tax_rate), "comparable.tax_rate")
        bu = unlever_beta(beta, de, comp_tax)
        unlevered.append(bu)
        detail.append(
            {
                "ticker": str(c.get("ticker") or f"comp{len(detail) + 1}"),
                "levered_beta": round(beta, 4),
                "debt_to_equity": round(de, 4),
                "unlevered_beta": round(bu, 4),
            }
        )
    return statistics.median(unlevered), detail


def compute_wacc(
    *,
    comparable_betas: list[dict] | None = None,
    unlevered_beta_input: float | None = None,
    target_debt_to_equity: float = 0.0,
    market_cap: float | None = None,
    tax_rate: float = DEFAULT_TAX_RATE,
    equity_risk_premium: float = DEFAULT_EQUITY_RISK_PREMIUM,
    forecast_horizon_years: float = 5.0,
    risk_free_rate_override: float | None = None,
    treasury_curve: dict | None = None,  # {maturity_years: yield}, keys may be strings
    company_specific_premium: float = 0.0,
    size_premium_override: float | None = None,
    cost_of_debt: float = 0.0,
    debt_weight: float | None = None,
) -> dict:
    """Build the cost of equity via modified CAPM and blend into WACC.

    Supply either ``comparable_betas`` (each ``{ticker, beta, debt_to_equity,
    tax_rate?}``) or a pre-computed ``unlevered_beta_input``. The beta is
    re-levered to ``target_debt_to_equity`` for the subject.

    ``debt_weight`` (Wd = D/(D+E)) sets the WACC blend; if omitted it is
    derived from ``target_debt_to_equity``.
    """
    tax_rate = _tax_rate(tax_rate, "tax_rate")
    target_de = _num(target_debt_to_equity, "target_debt_to_equity", nonneg=True)
    erp = _num(equity_risk_premium, "equity_risk_premium")

    # ── Beta ────────────────────────────────────────────────────────────────
    beta_detail: list[dict] = []
    if unlevered_beta_input is not None:
        unlevered = _num(unlevered_beta_input, "unlevered_beta_input")
    elif comparable_betas is not None:
        unlevered, beta_detail = _median_unlevered_beta(comparable_betas, tax_rate)
    else:
        raise EngineInputError("provide comparable_betas or unlevered_beta_input")
    relevered = relever_beta(unlevered, target_de, tax_rate)

    # ── Risk-free ─────────────────────────────────────────────────────────────
    if risk_free_rate_override is not None:
        rf = _num(risk_free_rate_override, "risk_free_rate_override", nonneg=True)
    else:
        rf = risk_free_rate(forecast_horizon_years, treasury_curve)

    # ── Size premium ──────────────────────────────────────────────────────────
    if size_premium_override is not None:
        sp = _num(size_premium_override, "size_premium_override")
        sp_tier = "override"
    elif market_cap is not None:
        sp, sp_tier = size_premium(_num(market_cap, "market_cap", nonneg=True))
    else:
        sp, sp_tier = 0.0, "n/a"

    csrp = _num(company_specific_premium, "company_specific_premium")

    cost_of_equity = rf + relevered * erp + sp + csrp

    # ── WACC blend ────────────────────────────────────────────────────────────
    if debt_weight is not None:
        wd = _num(debt_weight, "debt_weight", nonneg=True)
        if not 0.0 <= wd <= 1.0:
            raise EngineInputError("debt_weight must be in [0, 1]")
    else:
        wd = target_de / (1.0 + target_de) if target_de > 0 else 0.0
    we = 1.0 - wd
    kd = _num(cost_of_debt, "cost_of_debt", nonneg=True)
    after_tax_kd = kd * (1.0 - tax_rate)
    wacc = we * cost_of_equity + wd * after_tax_kd

    return {
        "wacc": round(wacc, 6),
        "cost_of_equity": round(cost_of_equity, 6),
        "cost_of_debt": round(kd, 6),
        "after_tax_cost_of_debt": round(after_tax_kd, 6),
        "capm": {
            "risk_free_rate": round(rf, 6),
            "beta_unlevered": round(unlevered, 4),
            "beta_relevered": round(relevered, 4),
            "equity_risk_premium": round(erp, 6),
            "size_premium": round(sp, 6),
            "size_tier": sp_tier,
            "company_specific_premium": round(csrp, 6),
        },
        "weights": {"equity": round(we, 4), "debt": round(wd, 4)},
        "tax_rate": round(tax_rate, 4),
        "target_debt_to_equity": round(target_de, 4),
        "forecast_horizon_years": forecast_horizon_years,
        "comparables": beta_detail,
    }
