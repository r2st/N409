"""The four valuation approaches (features.md §engine; requirements FR-14).

Each returns an EQUITY value in currency units. Enterprise-value approaches
bridge with + cash − debt.
"""

from __future__ import annotations

import math
import statistics

from .compounding import compound_factor
from .errors import EngineInputError
from .projection import MAX_FORECAST_YEARS

__all__ = [
    "EngineInputError",
    "asset_value",
    "income_dcf",
    "market_multiples",
    "opm_backsolve",
]


def _finite_result(value: float, name: str, hint: str) -> float:
    """A computed approach figure, or an EngineInputError explaining the overflow.

    Every scalar reaching these functions is finite — `compute._num` refuses
    NaN/Inf at the boundary — but the arithmetic between them is not closed over
    the finite floats. Multiplication and division saturate to ``inf`` in Python
    rather than raising, so a cash flow near the top of the double range, a
    multiple applied to a huge metric, or a bridge that adds two of them produce
    an ``inf`` equity value out of inputs that each passed every check.

    Nothing downstream notices: ``inf <= 0`` is False, so the weighted-value
    guard lets it through, ``round(inf, 2)`` is ``inf``, and the figure travels
    the whole way to Starlette's JSON encoder — which is the first thing to
    object, with ``allow_nan=False``, as a 500 naming nothing. Worse, the
    pre-flight validator clears the same payload: it checks that each figure is
    finite, which they all are, so the caller is told the inputs are good and
    then handed an unhandled error for using them.

    So the overflow is caught where it happens and named there. The sibling
    engines already answer this way — `fund_valuation`, `rollforward` and `wacc`
    each refuse a non-finite result rather than returning one — and this is the
    approach layer catching up with them.
    """
    if not math.isfinite(value):
        raise EngineInputError(f"{name} overflowed to a non-finite value — {hint}")
    return value


def income_dcf(
    free_cash_flows: list[float],
    discount_rate: float,
    terminal_growth: float = 0.0,
    cash: float = 0.0,
    debt: float = 0.0,
) -> dict:
    if not free_cash_flows:
        raise EngineInputError("income.free_cash_flows must be a non-empty list")
    # The explicit forecast period is the exponent every discount factor below
    # is raised to, and it arrived as a list of whatever length the caller sent.
    # Python's float `**` raises OverflowError rather than returning inf, so a
    # plausible 30% discount rate over ~3,200 years — a 20 KB body, well inside
    # the request cap — took the whole request down with an unhandled exception
    # and a 500. `projection.py` already refuses the same horizon when it
    # *builds* the flows; a caller supplying them directly bypassed that, so the
    # bound belongs here too and is deliberately the same number.
    if len(free_cash_flows) > MAX_FORECAST_YEARS:
        raise EngineInputError(
            f"income.free_cash_flows accepts at most {MAX_FORECAST_YEARS} years "
            f"(a DCF forecast period is 5-10 years); got {len(free_cash_flows)}"
        )
    if discount_rate <= terminal_growth:
        raise EngineInputError("income.discount_rate must exceed terminal_growth")

    # compound_factor rather than a bare `**`: it turns an overflow or a base at
    # or below zero into a 422 naming the rate, instead of an OverflowError or a
    # complex number that dies several frames later.
    horizon = len(free_cash_flows)
    factors = [
        compound_factor(discount_rate, year + 1, "income.discount_rate") for year in range(horizon)
    ]
    pv_fcf = sum(fcf / factor for fcf, factor in zip(free_cash_flows, factors))
    terminal_fcf = free_cash_flows[-1] * (1.0 + terminal_growth)
    terminal_value = terminal_fcf / (discount_rate - terminal_growth)
    pv_terminal = terminal_value / factors[-1]
    enterprise = pv_fcf + pv_terminal
    hint = (
        "check the cash-flow magnitudes, and that the discount rate is far "
        "enough above the terminal growth rate"
    )
    return {
        "pv_explicit": _finite_result(pv_fcf, "income.pv_explicit", hint),
        "pv_terminal": _finite_result(pv_terminal, "income.pv_terminal", hint),
        "enterprise_value": _finite_result(enterprise, "income.enterprise_value", hint),
        "equity_value": _finite_result(enterprise + cash - debt, "income.equity_value", hint),
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
    hint = "check the metric and multiple magnitudes"
    return {
        "metric": metric,
        "multiples": clean,
        "selected_multiple": selected,
        "enterprise_value": _finite_result(enterprise, "market.enterprise_value", hint),
        "equity_value": _finite_result(enterprise + cash - debt, "market.equity_value", hint),
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
        "equity_value": _finite_result(
            total_assets - total_liabilities,
            "asset.equity_value",
            "check the balance-sheet magnitudes",
        ),
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
            from .waterfall import class_per_share, normalize_share_classes

            target = float(last_round_pps)
            # Normalised before anything reads it. `sum(float(c.get("shares")))`
            # over the *raw* list was the first thing to touch a cap table on
            # this path, and it assumed every entry was a dict with a numeric
            # `shares` — an assumption only `_normalize` actually enforces, and
            # it does not run until `class_per_share` a few lines below. So a
            # single malformed entry — `share_classes: [{...}, 1.5]`, a null
            # left by a client-side filter, `"shares": "1,000,000"` — raised a
            # bare AttributeError/TypeError/ValueError out of a generator
            # expression, and a cap table the waterfall was about to refuse
            # with a 422 naming the offending class came back as a 500 naming
            # nothing. Reachable on /compute and, since it skips the pre-flight
            # validator entirely, on every /sensitivity run as well.
            #
            # The normaliser is the one authority on this shape and it runs on
            # this list anyway, once per Newton iteration; running it once up
            # front costs nothing and makes the error the same one the
            # allocation itself would have given.
            normalized = normalize_share_classes(share_classes)
            total_shares = sum(c["shares"] for c in normalized)
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
                    # `1 − f_p` is a subtraction of two nearby doubles and it
                    # reaches exactly zero well before the *shares* do. Any cap
                    # table where the common count is more than ~2^53 times
                    # smaller than the preferred — 1e308 preferred against 7e6
                    # common, or a common count that underflowed to 1e-320 —
                    # rounds `f_p` to 1.0, and the division below is then a
                    # ZeroDivisionError escaping as a 500.
                    #
                    # Skipping is the right answer rather than raising: the
                    # inversion is a disclosure extra, and the `except
                    # EngineInputError: pass` immediately below already
                    # establishes that an ill-posed implied vol is reported as
                    # nothing rather than allowed to fail a run whose equity
                    # value solved fine.
                    if 1.0 - pref_fraction <= 0.0:
                        return result
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
