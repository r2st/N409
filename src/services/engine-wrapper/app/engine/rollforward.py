"""Roll-forward / calibration engine — update a prior valuation to a new date.

When a company re-values without a new priced round, the prior 409A's
OPM-backsolve equity value is the best market-calibrated anchor. Rolling it
forward:

1. **Calibrate / time-decay.** Carry the prior calibrated equity value forward,
   accreting it at an annual rate (the prior required return by default) over
   the elapsed time between the two valuation dates. This is the standard
   calibration roll-forward: absent new information the enterprise is assumed
   to appreciate at its cost of capital.
2. **Apply material events.** A new priced round replaces the anchor with the
   new post-money; explicit ``value_adjustments`` (up/down rounds, secondary
   marks, impairments) shift it further.
3. **Detect what changed.** Compare the prior and updated inputs and flag
   material changes — a new round, a revenue move beyond a threshold, cap-table
   changes, a large time gap — so the analyst knows what to review.
4. **Pre-populate.** Emit engine inputs for the new valuation with the rolled
   equity value seeded as ``last_round_post_money`` and the new date set, ready
   to hand to ``compute``.
"""

from __future__ import annotations

import math
from datetime import date

from .errors import EngineInputError

__all__ = ["roll_forward", "DEFAULT_REVENUE_MATERIALITY", "DEFAULT_TIME_MATERIALITY_YEARS"]

DEFAULT_REVENUE_MATERIALITY = 0.20  # 20% revenue move is material
DEFAULT_TIME_MATERIALITY_YEARS = 1.0  # a >1y gap warrants a fresh look
DEFAULT_ANNUAL_ACCRETION = 0.20  # fallback appreciation if no required return given


def _parse_date(value, name: str) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be an ISO date (YYYY-MM-DD)") from None


def _num(value, name: str):
    """Coerce to a finite float, or None when absent.

    The finiteness check is not optional politeness: every figure here is
    multiplied or added into the rolling equity value, and NaN defeats the
    range guards that follow it — ``NaN <= 0`` is False, so a NaN accretion
    rate satisfies "rolled equity value is not positive" and rolls all the way
    out to the client as a 200 whose ``rolled_equity_value`` is ``null``.
    Same guard, same reason, as ``debt_valuation._num`` and ``waterfall._finite``.
    """
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be a number") from None
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be finite")
    return out


def _prior_equity_value(prior_results: dict) -> float:
    """Pull the calibrated equity value out of a prior ``compute`` result."""
    if not isinstance(prior_results, dict):
        raise EngineInputError("prior_results must be an object")
    # Accept either the full {engine_version, results} envelope or the inner results.
    results = prior_results.get("results") if "results" in prior_results else prior_results
    if not isinstance(results, dict):
        raise EngineInputError("prior_results.results must be an object")
    equity = _num(results.get("equity_value"), "prior_results.equity_value")
    if equity is None or equity <= 0:
        raise EngineInputError("prior_results.equity_value (positive) is required")
    return equity


def roll_forward(
    prior_results: dict,
    *,
    prior_valuation_date,
    new_valuation_date,
    prior_inputs: dict | None = None,
    updated_inputs: dict | None = None,
    annual_accretion: float | None = None,
    value_adjustments: list[dict] | None = None,
    new_round_post_money: float | None = None,
    revenue_materiality: float = DEFAULT_REVENUE_MATERIALITY,
    time_materiality_years: float = DEFAULT_TIME_MATERIALITY_YEARS,
) -> dict:
    """Roll a prior valuation forward to ``new_valuation_date``.

    Returns the rolled equity value, a step-by-step calibration trail, a list of
    detected material changes, and ``pre_populated_inputs`` ready for a fresh
    ``compute`` run.
    """
    prior_inputs = prior_inputs or {}
    updated_inputs = updated_inputs or {}

    d0 = _parse_date(prior_valuation_date, "prior_valuation_date")
    d1 = _parse_date(new_valuation_date, "new_valuation_date")
    if d1 < d0:
        raise EngineInputError("new_valuation_date must be on or after prior_valuation_date")
    years_elapsed = (d1 - d0).days / 365.25

    base_equity = _prior_equity_value(prior_results)

    # ── Calibration trail ─────────────────────────────────────────────────────
    steps: list[dict] = []
    equity = base_equity
    steps.append({"step": "prior_equity_value", "value": round(equity, 2)})

    if new_round_post_money is not None:
        # A new priced round supersedes the time-decay anchor entirely.
        new_pm = _num(new_round_post_money, "new_round_post_money")
        if new_pm is None or new_pm <= 0:
            raise EngineInputError("new_round_post_money must be positive")
        equity = new_pm
        steps.append({"step": "new_round_post_money", "value": round(equity, 2)})
        accretion_rate = 0.0
    else:
        rate = _num(annual_accretion, "annual_accretion")
        if rate is None:
            rate = _prior_required_return(prior_results, prior_inputs)
        accretion_rate = float(rate)
        # A rate of -100% or worse is not a valuation input, it is a typo — and
        # left alone it is worse than wrong: `(1 + rate) ** years` with a
        # negative base and a fractional exponent returns a *complex* number in
        # Python, which then blows up in `round()` as a 500 rather than telling
        # the caller their rate was out of range.
        if accretion_rate <= -1.0:
            raise EngineInputError("annual_accretion must be greater than -1 (i.e. > -100%)")
        factor = (1.0 + accretion_rate) ** years_elapsed
        equity = equity * factor
        steps.append(
            {
                "step": "time_accretion",
                "annual_rate": round(accretion_rate, 6),
                "years": round(years_elapsed, 4),
                "factor": round(factor, 6),
                "value": round(equity, 2),
            }
        )

    for adj in value_adjustments or []:
        if not isinstance(adj, dict):
            raise EngineInputError("each value_adjustment must be an object")
        label = str(adj.get("label") or "adjustment")
        pct = _num(adj.get("pct"), f"{label}.pct")
        amount = _num(adj.get("amount"), f"{label}.amount")
        if pct is not None:
            equity *= 1.0 + pct
        if amount is not None:
            equity += amount
        if pct is None and amount is None:
            raise EngineInputError(f"value_adjustment '{label}' needs pct or amount")
        steps.append({"step": "adjustment", "label": label, "value": round(equity, 2)})

    # Finiteness first: every individual input is finite by now, but the
    # arithmetic above can still overflow to inf, and `inf <= 0` is False.
    if not math.isfinite(equity):
        raise EngineInputError("rolled equity value is not finite after adjustments")
    if equity <= 0:
        raise EngineInputError("rolled equity value is not positive after adjustments")

    # ── Material-change detection ─────────────────────────────────────────────
    changes = _detect_changes(
        prior_inputs,
        updated_inputs,
        years_elapsed=years_elapsed,
        new_round_post_money=new_round_post_money,
        revenue_materiality=revenue_materiality,
        time_materiality_years=time_materiality_years,
    )

    # ── Pre-populated inputs for the next compute ─────────────────────────────
    pre_populated = {
        **prior_inputs,
        **updated_inputs,
        "valuation_date": d1.isoformat(),
        "last_round_post_money": round(equity, 2),
    }

    return {
        "prior_valuation_date": d0.isoformat(),
        "new_valuation_date": d1.isoformat(),
        "years_elapsed": round(years_elapsed, 4),
        "prior_equity_value": round(base_equity, 2),
        "rolled_equity_value": round(equity, 2),
        "annual_accretion": round(accretion_rate, 6),
        "calibration_steps": steps,
        "material_changes": changes,
        "requires_full_revaluation": any(c["material"] for c in changes),
        "pre_populated_inputs": pre_populated,
    }


def _prior_required_return(prior_results: dict, prior_inputs: dict) -> float:
    """Best available appreciation rate: income discount rate → default."""
    results = prior_results.get("results") if "results" in prior_results else prior_results
    approaches = results.get("approaches") if isinstance(results, dict) else None
    if isinstance(approaches, dict):
        income = approaches.get("income")
        if isinstance(income, dict) and income.get("discount_rate"):
            # Through `_num`, not a bare `float()`: this reads out of a stored
            # prior result, so a corrupt or hand-edited one should be a 400
            # naming the field, not a ValueError escaping as a 500.
            dr = _num(income["discount_rate"], "prior_results.approaches.income.discount_rate")
            if dr is not None:
                return dr
    income_in = prior_inputs.get("income") if isinstance(prior_inputs, dict) else None
    if isinstance(income_in, dict):
        dr = _num(income_in.get("discount_rate"), "income.discount_rate")
        if dr:
            return dr
    return DEFAULT_ANNUAL_ACCRETION


def _detect_changes(
    prior_inputs: dict,
    updated_inputs: dict,
    *,
    years_elapsed: float,
    new_round_post_money: float | None,
    revenue_materiality: float,
    time_materiality_years: float,
) -> list[dict]:
    changes: list[dict] = []

    if new_round_post_money is not None:
        changes.append(
            {
                "field": "new_round",
                "material": True,
                "detail": f"new priced round at post-money {float(new_round_post_money):,.0f}",
            }
        )

    if years_elapsed > time_materiality_years:
        changes.append(
            {
                "field": "valuation_date",
                "material": True,
                "detail": f"{years_elapsed:.2f} years since prior valuation (> {time_materiality_years})",
            }
        )

    # Revenue move — check a few common fields.
    prev_rev = _extract_revenue(prior_inputs)
    new_rev = _extract_revenue(updated_inputs)
    if prev_rev is not None and new_rev is not None and prev_rev > 0:
        delta = (new_rev - prev_rev) / prev_rev
        if abs(delta) >= revenue_materiality:
            changes.append(
                {
                    "field": "revenue",
                    "material": True,
                    "detail": f"revenue moved {delta:+.1%} ({prev_rev:,.0f} → {new_rev:,.0f})",
                    "delta_pct": round(delta, 4),
                }
            )
        elif delta != 0.0:
            changes.append(
                {
                    "field": "revenue",
                    "material": False,
                    "detail": f"revenue moved {delta:+.1%} (below {revenue_materiality:.0%} threshold)",
                    "delta_pct": round(delta, 4),
                }
            )

    # Cap-table changes.
    for field in ("shares_outstanding_common", "shares_outstanding_preferred", "options_outstanding"):
        prev = _num(prior_inputs.get(field), field)
        new = _num(updated_inputs.get(field), field)
        if prev is not None and new is not None and prev != new:
            changes.append(
                {
                    "field": field,
                    "material": True,
                    "detail": f"{field} changed {prev:,.0f} → {new:,.0f}",
                }
            )

    prior_classes = prior_inputs.get("share_classes")
    new_classes = updated_inputs.get("share_classes")
    if isinstance(new_classes, list) and prior_classes != new_classes:
        changes.append(
            {
                "field": "share_classes",
                "material": True,
                "detail": "cap-table share_classes changed",
            }
        )

    return changes


def _extract_revenue(inputs: dict):
    """Best-effort revenue read from an inputs blob."""
    if not isinstance(inputs, dict):
        return None
    if inputs.get("revenue") is not None:
        return _num(inputs.get("revenue"), "revenue")
    market = inputs.get("market")
    if isinstance(market, dict) and market.get("metric") is not None:
        return _num(market.get("metric"), "market.metric")
    return None
