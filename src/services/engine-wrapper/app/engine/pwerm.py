"""Probability-Weighted Expected Return Method (PWERM) equity allocation.

PWERM is the standard alternative to the OPM for allocating equity value to
common stock when a company's exit is modelled as a small number of *discrete*
outcomes rather than a continuous lognormal (features.md §engine; AICPA
Practice Aid, PWERM). Each scenario is a concrete future — IPO, acquisition,
continuation (stay-private) or liquidation/dissolution — carrying:

* a probability weight (the scenario probabilities sum to 1),
* an exit equity value (given directly, or bridged from an enterprise value
  with + cash − debt),
* a time to that exit, and
* a discount rate reflecting the risk of the payoff.

Within a scenario the exit value is split across share classes by the
deterministic liquidation waterfall (``waterfall.exit_allocation`` — the σ→0
limit of the OPM breakpoint model, so PWERM and OPM agree on the payoff
structure). Each class's scenario payoff is discounted to the valuation date,
then probability-weighted across scenarios to give the present fair value per
share class. The common per-share value feeds the same DLOC/DLOM discounts as
the OPM path.
"""

from __future__ import annotations

import math

from .errors import EngineInputError
from .waterfall import exit_allocation, normalize_share_classes

# Informational only — the method never branches on the label, but validating
# it keeps scenario data clean and self-documenting in the stored payload.
SCENARIO_TYPES = (
    "ipo",
    "acquisition",
    "merger",
    "continuation",
    "stay_private",
    "liquidation",
    "dissolution",
)


def _num(value, name: str) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be a number") from None
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be a finite number")
    return out


def _scenario_equity(scenario: dict, index: int, cash: float, debt: float) -> float:
    """Exit equity value: taken directly, or bridged from an enterprise value."""
    if scenario.get("equity_value") is not None:
        equity = _num(scenario["equity_value"], f"scenarios[{index}].equity_value")
    elif scenario.get("enterprise_value") is not None:
        ev = _num(scenario["enterprise_value"], f"scenarios[{index}].enterprise_value")
        equity = ev + cash - debt
    else:
        raise EngineInputError(
            f"scenarios[{index}] needs an equity_value or enterprise_value"
        )
    if equity < 0:
        raise EngineInputError(f"scenarios[{index}] exit equity value is negative ({equity:.2f})")
    return equity


def allocate_pwerm(
    scenarios: list[dict],
    share_classes: list[dict],
    *,
    default_discount_rate: float,
    cash: float = 0.0,
    debt: float = 0.0,
) -> dict:
    """Probability-weighted present fair value per share class.

    ``scenarios`` is a list of dicts, each with ``probability`` and one of
    ``equity_value`` / ``enterprise_value``, plus optional ``name``, ``type``,
    ``time_to_exit_years`` and ``discount_rate`` (falling back to
    ``default_discount_rate``). ``share_classes`` is the cap table in the same
    shape the OPM waterfall consumes.
    """
    if not isinstance(scenarios, list) or not scenarios:
        raise EngineInputError("pwerm.scenarios must be a non-empty list")
    if len(scenarios) > 50:
        raise EngineInputError("pwerm.scenarios: at most 50 scenarios")
    # Validate the cap table once up front (each exit_allocation re-validates,
    # but this surfaces a bad cap table before we loop over scenarios).
    normalized = normalize_share_classes(share_classes)
    shares_by_class = {c["name"]: c["shares"] for c in normalized}

    weighted_value: dict[str, float] = {c["name"]: 0.0 for c in normalized}
    weighted_time = 0.0
    breakdown: list[dict] = []
    prob_total = 0.0

    for i, raw in enumerate(scenarios):
        if not isinstance(raw, dict):
            raise EngineInputError(f"scenarios[{i}] must be an object")
        prob = _num(raw.get("probability"), f"scenarios[{i}].probability")
        if prob < 0:
            raise EngineInputError(f"scenarios[{i}].probability must be >= 0")
        prob_total += prob

        scenario_type = raw.get("type")
        if scenario_type is not None and scenario_type not in SCENARIO_TYPES:
            raise EngineInputError(
                f"scenarios[{i}].type must be one of {SCENARIO_TYPES}"
            )

        equity = _scenario_equity(raw, i, cash, debt)
        t = _num(raw.get("time_to_exit_years", 0.0), f"scenarios[{i}].time_to_exit_years")
        if t < 0:
            raise EngineInputError(f"scenarios[{i}].time_to_exit_years must be >= 0")
        rate = (
            _num(raw["discount_rate"], f"scenarios[{i}].discount_rate")
            if raw.get("discount_rate") is not None
            else default_discount_rate
        )
        if rate <= -1:
            raise EngineInputError(f"scenarios[{i}].discount_rate must exceed -1")

        alloc = exit_allocation(equity, share_classes)
        discount_factor = (1.0 + rate) ** t

        classes_pv: dict[str, dict] = {}
        scenario_pv = 0.0
        for name, data in alloc["classes"].items():
            pv = data["value"] / discount_factor
            weighted_value[name] += prob * pv
            scenario_pv += pv
            classes_pv[name] = {
                "kind": data["kind"],
                "exit_value": data["value"],
                "present_value": round(pv, 2),
                "per_share": round(pv / shares_by_class[name], 6),
            }
        weighted_time += prob * t

        breakdown.append(
            {
                "name": str(raw.get("name") or f"Scenario {i + 1}"),
                "type": scenario_type,
                "probability": prob,
                "exit_equity_value": round(equity, 2),
                "time_to_exit_years": t,
                "discount_rate": rate,
                "discount_factor": round(discount_factor, 6),
                "present_value": round(scenario_pv, 2),
                "common_present_value": round(alloc["common_value"] / discount_factor, 2),
                "classes": classes_pv,
            }
        )

    if abs(prob_total - 1.0) > 1e-6:
        raise EngineInputError(
            f"pwerm scenario probabilities must sum to 1.0 (got {prob_total:.4f})"
        )

    by_class = {
        name: {
            "kind": next(c["kind"] for c in normalized if c["name"] == name),
            "shares": shares_by_class[name],
            "present_value": round(value, 2),
            "fmv_per_share": round(value / shares_by_class[name], 6),
        }
        for name, value in weighted_value.items()
    }
    common_shares = sum(c["shares"] for c in normalized if c["kind"] == "common")
    common_value = sum(weighted_value[c["name"]] for c in normalized if c["kind"] == "common")
    equity_value = sum(weighted_value.values())

    return {
        "method": "pwerm",
        "equity_value": round(equity_value, 2),
        "expected_time_to_exit_years": round(weighted_time, 4),
        "common_value": round(common_value, 2),
        "common_shares": common_shares,
        "common_per_share": round(common_value / common_shares, 6) if common_shares > 0 else 0.0,
        "classes": by_class,
        "scenarios": breakdown,
    }
