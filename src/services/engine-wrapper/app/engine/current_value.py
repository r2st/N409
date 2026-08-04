"""Current Value Method (CVM) equity allocation.

The CVM allocates the company's *current* equity value to share classes as if a
liquidity event happened on the valuation date (AICPA Practice Aid, CVM). It is
appropriate for very early-stage / pre-revenue companies whose future is too
uncertain to model discrete exits (PWERM) or a lognormal path (OPM), and for
distressed companies where equity value is at or below the preference stack.

Mechanically it is the σ→0, t→0 limit of the OPM: the deterministic liquidation
waterfall applied at the current equity value. Senior preferences are paid
first, non-participating preferred converts only where conversion beats its
preference, and the residual is shared pro-rata on as-converted shares — exactly
``waterfall.exit_allocation``. No volatility or time-to-exit assumption is used
for the allocation itself (a model DLOM may still use them downstream).
"""

from __future__ import annotations

import math

from .errors import EngineInputError
from .waterfall import exit_allocation


def _num(value, name: str, *, positive: bool = False, nonneg: bool = False) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be a number") from None
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be a finite number")
    if positive and out <= 0:
        raise EngineInputError(f"{name} must be positive")
    # Mirrors compute._num: a negative share count or preference reads as zero in
    # every branch below, so the CVM would quietly hand common the whole equity
    # value. Worse here than in the OPM path — negative options also shrink the
    # fully-diluted denominator on line 115, and enough of them make it zero.
    if nonneg and out < 0:
        raise EngineInputError(f"{name} cannot be negative")
    return out


def allocate_cvm(equity_value: float, inputs: dict) -> dict:
    """Allocate ``equity_value`` to common under the current value method.

    Uses the full cap-table waterfall when ``inputs.share_classes`` is present;
    otherwise falls back to a simplified single-preference structure built from
    the scalar cap-table inputs (``shares_outstanding_common`` / ``_preferred``,
    ``liquidation_preference``, ``options_outstanding``). Options are folded into
    fully diluted common in the simplified path — consistent with the OPM
    as-converted fallback in ``compute.py``.
    """
    if equity_value <= 0:
        raise EngineInputError(f"equity value is not positive ({equity_value:.2f})")

    share_classes = inputs.get("share_classes")
    if isinstance(share_classes, list) and share_classes:
        alloc = exit_allocation(equity_value, share_classes)
        return {
            "method": "cvm_waterfall",
            "equity_value": round(equity_value, 2),
            "common_value": alloc["common_value"],
            "common_shares": alloc["common_shares"],
            "common_per_share": alloc["common_per_share"],
            "fully_diluted_common": alloc["common_shares"],
            "classes": alloc["classes"],
            "breakpoints": alloc["breakpoints"],
        }

    # ── Simplified path: scalar cap-table inputs, no explicit share classes ──
    common_shares = _num(
        inputs.get("shares_outstanding_common"), "shares_outstanding_common", positive=True
    )
    if common_shares is None:
        raise EngineInputError("shares_outstanding_common is required for CVM")
    options = _num(inputs.get("options_outstanding"), "options_outstanding", nonneg=True) or 0.0
    fully_diluted_common = common_shares + options
    preferred_shares = (
        _num(inputs.get("shares_outstanding_preferred"), "shares_outstanding_preferred", nonneg=True) or 0.0
    )
    liquidation_preference = (
        _num(inputs.get("liquidation_preference"), "liquidation_preference", nonneg=True) or 0.0
    )

    if preferred_shares > 0 and liquidation_preference > 0:
        # Reuse the deterministic waterfall via a synthetic two-class cap table
        # so conversion economics (pref vs. as-converted) are handled exactly.
        synthetic = [
            {"name": "Common", "kind": "common", "shares": fully_diluted_common},
            {
                "name": "Preferred",
                "kind": "preferred",
                "shares": preferred_shares,
                "preference": liquidation_preference,
                "seniority": 1,
                "participating": False,
                "conversion_ratio": 1.0,
            },
        ]
        alloc = exit_allocation(equity_value, synthetic)
        common_value = alloc["classes"]["Common"]["value"]
        method = "cvm_single_preference"
        detail: dict = {
            "liquidation_preference": liquidation_preference,
            "preferred_converts": alloc["classes"]["Preferred"]["value"] > liquidation_preference + 0.5,
        }
    elif preferred_shares > 0:
        # Preferred with no stated preference → pure as-converted pro-rata.
        common_fraction = fully_diluted_common / (fully_diluted_common + preferred_shares)
        common_value = equity_value * common_fraction
        method = "cvm_pro_rata"
        detail = {"common_fraction": round(common_fraction, 6)}
    else:
        common_value = equity_value
        method = "cvm_common_only"
        detail = {"common_fraction": 1.0}

    return {
        "method": method,
        "equity_value": round(equity_value, 2),
        "common_value": round(common_value, 2),
        "common_shares": fully_diluted_common,
        "common_per_share": round(common_value / fully_diluted_common, 6),
        "fully_diluted_common": fully_diluted_common,
        "detail": detail,
    }
