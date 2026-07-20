"""Hybrid allocation method — a weighted blend of the OPM and PWERM.

The hybrid method (AICPA Practice Aid, "hybrid method") is used when some exit
outcomes are best modelled as discrete near-term events (an imminent IPO or
acquisition — PWERM) while the residual "stay private / continue" outcome is
best modelled as a continuous lognormal path (OPM). Rather than embed the OPM
inside a single PWERM continuation scenario, this module takes the fully
computed common-per-share of each method and blends them by configurable
weights: the PWERM weight represents the probability mass on the modelled
near-term liquidity scenarios, the OPM weight the far-term continuation.

Weights come from ``inputs.hybrid`` (``opm_weight`` / ``pwerm_weight``) and must
be non-negative and sum to 1. Both legs are computed from the shared cap table
and inputs, so the blended common-per-share, equity value and expected time to
exit are all convex combinations of the two methods' outputs. DLOC/DLOM are
applied once, downstream, to the blended per-share value.
"""

from __future__ import annotations

import math

from .errors import EngineInputError


def _num(value, name: str) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be a number") from None
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be a finite number")
    return out


def resolve_hybrid_weights(inputs: dict) -> dict[str, float]:
    """Parse and validate ``inputs.hybrid`` weights (default 50/50)."""
    raw = inputs.get("hybrid")
    if raw is None:
        return {"opm": 0.5, "pwerm": 0.5}
    if not isinstance(raw, dict):
        raise EngineInputError("inputs.hybrid must be an object with opm_weight / pwerm_weight")
    opm_w = _num(raw.get("opm_weight", 0.5), "hybrid.opm_weight")
    pwerm_w = _num(raw.get("pwerm_weight", 0.5), "hybrid.pwerm_weight")
    if opm_w < 0 or pwerm_w < 0:
        raise EngineInputError("hybrid weights must be non-negative")
    total = opm_w + pwerm_w
    if total <= 0:
        raise EngineInputError("hybrid weights must not both be zero")
    if abs(total - 1.0) > 1e-6:
        raise EngineInputError(f"hybrid weights must sum to 1.0 (got {total:.4f})")
    return {"opm": opm_w, "pwerm": pwerm_w}


def blend_hybrid(
    opm_leg: dict,
    pwerm_leg: dict,
    weights: dict[str, float],
) -> dict:
    """Blend the two legs' per-share, equity value and expected time to exit.

    ``opm_leg`` carries ``common_per_share`` (pre-discount), ``equity_value`` and
    ``time_to_exit_years``; ``pwerm_leg`` carries ``common_per_share``,
    ``equity_value`` and ``expected_time_to_exit_years``.
    """
    w_opm, w_pwerm = weights["opm"], weights["pwerm"]
    common_per_share = w_opm * opm_leg["common_per_share"] + w_pwerm * pwerm_leg["common_per_share"]
    equity_value = w_opm * opm_leg["equity_value"] + w_pwerm * pwerm_leg["equity_value"]
    time_to_exit = (
        w_opm * opm_leg["time_to_exit_years"]
        + w_pwerm * pwerm_leg["expected_time_to_exit_years"]
    )
    return {
        "method": "hybrid",
        "weights": {"opm": w_opm, "pwerm": w_pwerm},
        "equity_value": round(equity_value, 2),
        "common_per_share": common_per_share,
        "blended_time_to_exit_years": round(time_to_exit, 4),
        "opm": {
            "equity_value": round(opm_leg["equity_value"], 2),
            "common_per_share": round(opm_leg["common_per_share"], 6),
            "allocation": opm_leg.get("allocation"),
        },
        "pwerm": {
            "equity_value": round(pwerm_leg["equity_value"], 2),
            "common_per_share": round(pwerm_leg["common_per_share"], 6),
            "expected_time_to_exit_years": pwerm_leg["expected_time_to_exit_years"],
        },
    }
