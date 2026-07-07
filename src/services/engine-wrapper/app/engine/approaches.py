"""The four valuation approaches (features.md §engine; requirements FR-14).

Each returns an EQUITY value in currency units. Enterprise-value approaches
bridge with + cash − debt.
"""

from __future__ import annotations

import statistics

from .errors import EngineInputError

__all__ = [
    "EngineInputError",
    "asset_value",
    "income_dcf",
    "market_multiples",
    "opm_backsolve",
]


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


def opm_backsolve(
    last_round_post_money: float | None = None,
    *,
    last_round_pps: float | None = None,
    share_classes: list[dict] | None = None,
    last_round_class: str | None = None,
    preferred_shares: float | None = None,
    liquidation_preference: float | None = None,
    common_shares: float | None = None,
    t: float | None = None,
    r: float | None = None,
    sigma: float | None = None,
) -> dict:
    """Market-calibrated equity value from the last priced round.

    Full backsolve (remaining-gaps §2): Newton-Raphson iterates the equity
    value until the last round's preferred reprices to the round PPS —
    against the full cap-table waterfall when share_classes is provided,
    else against the aggregate single-breakpoint model. Falls back to the
    post-money passthrough when the PPS inputs are absent (the M1 behavior).
    """
    # Lazy imports: newton/waterfall depend on this module's sibling `errors`.
    from .newton import implied_volatility, newton_raphson

    have_model = t is not None and r is not None and sigma is not None and sigma > 0

    def _bounds(total_claim: float) -> tuple[float, float]:
        hi = max(total_claim * 1000.0, 1e6)
        if last_round_post_money and last_round_post_money > 0:
            hi = max(hi, last_round_post_money * 1000.0)
        return 1e-3, hi

    if last_round_pps is not None and last_round_pps > 0 and have_model:
        if share_classes and last_round_class:
            from .waterfall import class_per_share

            target = float(last_round_pps)
            total_shares = sum(float(c.get("shares") or 0) for c in share_classes)
            lo, hi = _bounds(target * max(total_shares, 1.0))
            x0 = last_round_post_money if last_round_post_money and last_round_post_money > 0 else target * total_shares

            def objective(equity: float) -> float:
                return class_per_share(equity, share_classes, last_round_class, t, r, sigma) - target

            equity, iterations = newton_raphson(objective, x0, tol=1e-7, min_x=lo, max_x=hi)
            result = {
                "equity_value": equity,
                "method": "backsolve_waterfall",
                "iterations": iterations,
                "target_pps": target,
                "solved_pps": class_per_share(equity, share_classes, last_round_class, t, r, sigma),
            }
        elif (
            preferred_shares is not None
            and preferred_shares > 0
            and liquidation_preference is not None
            and liquidation_preference > 0
            and common_shares is not None
            and common_shares > 0
        ):
            from .bs import bs_call

            target = float(last_round_pps)
            pref_fraction = preferred_shares / (preferred_shares + common_shares)

            def preferred_per_share(equity: float) -> float:
                upside = bs_call(equity, liquidation_preference, t, r, sigma)
                return ((equity - upside) + pref_fraction * upside) / preferred_shares

            lo, hi = _bounds(target * (preferred_shares + common_shares))
            x0 = last_round_post_money if last_round_post_money and last_round_post_money > 0 else target * (preferred_shares + common_shares)
            equity, iterations = newton_raphson(
                lambda e: preferred_per_share(e) - target, x0, tol=1e-7, min_x=lo, max_x=hi
            )
            result = {
                "equity_value": equity,
                "method": "backsolve_single",
                "iterations": iterations,
                "target_pps": target,
                "solved_pps": preferred_per_share(equity),
            }
        else:
            result = None
        if result is not None:
            if last_round_post_money and last_round_post_money > 0:
                result["last_round_post_money"] = last_round_post_money
                if (
                    liquidation_preference
                    and liquidation_preference > 0
                    and preferred_shares
                    and common_shares
                ):
                    # Preferred value = (E − C) + f_p·C, so the implied common-
                    # side call value is C = (E − preferred_value) / (1 − f_p);
                    # invert Black-Scholes on that for the round's implied vol.
                    pref_fraction = preferred_shares / (preferred_shares + common_shares)
                    call_value = (
                        last_round_post_money - last_round_pps * preferred_shares
                    ) / (1.0 - pref_fraction)
                    try:
                        result["implied_volatility"] = implied_volatility(
                            call_value, last_round_post_money, liquidation_preference, t, r
                        )
                    except EngineInputError:
                        pass  # ill-posed — report nothing rather than fail the run
            return result

    if last_round_post_money is None or last_round_post_money <= 0:
        raise EngineInputError("last_round_post_money must be positive for the OPM approach")
    return {"equity_value": last_round_post_money, "method": "post_money"}
