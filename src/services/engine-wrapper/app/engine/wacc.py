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
    if positive and out <= 0:
        raise EngineInputError(f"{name} must be positive")
    if nonneg and out < 0:
        raise EngineInputError(f"{name} must be >= 0")
    return out


def unlever_beta(levered_beta: float, debt_to_equity: float, tax_rate: float) -> float:
    """Hamada unlevering: βu = βl / (1 + (1 − tax)·D/E)."""
    if debt_to_equity < 0:
        raise EngineInputError("debt_to_equity must be >= 0")
    return levered_beta / (1.0 + (1.0 - tax_rate) * debt_to_equity)


def relever_beta(unlevered_beta: float, debt_to_equity: float, tax_rate: float) -> float:
    """Hamada relevering: βl = βu · (1 + (1 − tax)·D/E)."""
    if debt_to_equity < 0:
        raise EngineInputError("debt_to_equity must be >= 0")
    return unlevered_beta * (1.0 + (1.0 - tax_rate) * debt_to_equity)


def risk_free_rate(
    maturity_years: float,
    curve: dict[float, float] | None = None,
) -> float:
    """Linearly interpolate the Treasury yield for ``maturity_years``.

    Clamps to the nearest endpoint outside the curve's range.
    """
    if maturity_years <= 0:
        raise EngineInputError("maturity_years must be positive")
    points = sorted((curve or DEFAULT_TREASURY_CURVE).items())
    if not points:
        raise EngineInputError("treasury curve is empty")
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
        comp_tax = _num(c.get("tax_rate", tax_rate), "comparable.tax_rate", nonneg=True)
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
    treasury_curve: dict[float, float] | None = None,
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
    tax_rate = _num(tax_rate, "tax_rate", nonneg=True)
    if not 0.0 <= tax_rate < 1.0:
        raise EngineInputError("tax_rate must be in [0, 1)")
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
