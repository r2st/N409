"""The four valuation approaches (features.md §engine; requirements FR-14).

Each returns an EQUITY value in currency units. Enterprise-value approaches
bridge with + cash − debt.
"""

from __future__ import annotations

import statistics


class EngineInputError(ValueError):
    """A required input for a weighted approach is missing/invalid."""


def income_dcf(
    free_cash_flows: list[float],
    discount_rate: float,
    terminal_growth: float = 0.0,
    cash: float = 0.0,
    debt: float = 0.0,
) -> dict:
    if not free_cash_flows:
        raise EngineInputError("income.free_cash_flows must be a non-empty list")
    if discount_rate <= terminal_growth:
        raise EngineInputError("income.discount_rate must exceed terminal_growth")

    pv_fcf = sum(fcf / (1.0 + discount_rate) ** (year + 1) for year, fcf in enumerate(free_cash_flows))
    horizon = len(free_cash_flows)
    terminal_fcf = free_cash_flows[-1] * (1.0 + terminal_growth)
    terminal_value = terminal_fcf / (discount_rate - terminal_growth)
    pv_terminal = terminal_value / (1.0 + discount_rate) ** horizon
    enterprise = pv_fcf + pv_terminal
    return {
        "pv_explicit": pv_fcf,
        "pv_terminal": pv_terminal,
        "enterprise_value": enterprise,
        "equity_value": enterprise + cash - debt,
    }


def market_multiples(
    metric: float,
    multiples: list[float],
    cash: float = 0.0,
    debt: float = 0.0,
) -> dict:
    clean = [m for m in multiples if isinstance(m, (int, float)) and m > 0]
    if not clean:
        raise EngineInputError("market.multiples must contain at least one positive multiple")
    if metric <= 0:
        raise EngineInputError("market.metric must be positive")
    selected = statistics.median(clean)
    enterprise = selected * metric
    return {
        "metric": metric,
        "multiples": clean,
        "selected_multiple": selected,
        "enterprise_value": enterprise,
        "equity_value": enterprise + cash - debt,
    }


def asset_value(
    total_assets: float | None = None,
    total_liabilities: float | None = None,
    cost_to_replicate: float | None = None,
    method: str | None = None,
) -> dict:
    if method == "cost_to_replicate" or (method is None and cost_to_replicate is not None):
        if cost_to_replicate is None or cost_to_replicate < 0:
            raise EngineInputError("asset.cost_to_replicate is required for the cost-to-replicate method")
        return {"method": "cost_to_replicate", "equity_value": cost_to_replicate}
    if total_assets is None or total_liabilities is None:
        raise EngineInputError("asset.total_assets and asset.total_liabilities are required for NAV")
    return {
        "method": "nav",
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "equity_value": total_assets - total_liabilities,
    }


def opm_backsolve(last_round_post_money: float) -> dict:
    """Market-calibrated equity value from the last priced round.

    The full backsolve (iterating equity value until the preferred tranche
    reprices to the round PPS) collapses to the post-money when the round is
    recent — the documented M1 simplification; refinement lands with #17.
    """
    if last_round_post_money <= 0:
        raise EngineInputError("last_round_post_money must be positive for the OPM approach")
    return {"equity_value": last_round_post_money}
