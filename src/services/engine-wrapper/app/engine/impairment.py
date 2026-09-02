"""Impairment testing engine (feature: Goodwill & Intangible Impairment, ASC 350/360).

Three tests, three different rules — the order matters in practice (ASU
2017-04 sequencing: long-lived assets under 360 first, then indefinite-lived
intangibles under 350-30, then goodwill under 350-20):

  - goodwill (ASC 350-20): one-step quantitative test — impairment is the
    excess of a reporting unit's carrying amount over its fair value, capped at
    the goodwill on its books;
  - indefinite-lived intangible (ASC 350-30): carrying amount vs fair value,
    no cap, no recoverability screen;
  - long-lived assets / finite-lived (ASC 360-10): two steps — a
    recoverability screen against UNdiscounted cash flows, and only if that
    fails, a write-down to fair value.

The qualitative ("step zero") screen is a judgment the analyst records, not
arithmetic; it enters here only as a flag that lets a caller document that the
quantitative test was skipped.
"""

from __future__ import annotations

import math

from .errors import EngineInputError
from .kwargs_refusal import describe_unbindable

MAX_FLOW_YEARS = 100


def _num(value, name: str, *, minimum: float | None = None) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"{name} must be a number") from exc
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be finite")
    if minimum is not None and out < minimum:
        raise EngineInputError(f"{name} must be >= {minimum}")
    return out


def goodwill_impairment(
    *,
    reporting_unit: str | None = None,
    carrying_amount: float,
    fair_value: float,
    goodwill_carrying_amount: float,
    qualitative_only: bool = False,
) -> dict:
    """ASC 350-20 quantitative test (ASU 2017-04 single step).

    Impairment = min(carrying − fair, goodwill on the books), floored at zero.
    ``qualitative_only`` records that the entity stopped at step zero; the
    arithmetic still runs so the memo can show the margin that justified it.
    """
    carrying = _num(carrying_amount, "impairment.carrying_amount")
    fair = _num(fair_value, "impairment.fair_value", minimum=0.0)
    goodwill = _num(goodwill_carrying_amount, "impairment.goodwill_carrying_amount", minimum=0.0)
    if goodwill > max(carrying, 0.0):
        raise EngineInputError(
            "impairment.goodwill_carrying_amount exceeds the reporting unit's carrying amount"
        )
    shortfall = carrying - fair
    loss = min(max(shortfall, 0.0), goodwill)
    return {
        "standard": "ASC 350-20",
        "reporting_unit": reporting_unit,
        "carrying_amount": carrying,
        "fair_value": fair,
        "headroom": fair - carrying,
        "impaired": loss > 0.0,
        "impairment_loss": loss,
        "goodwill_after": goodwill - loss,
        "qualitative_only": bool(qualitative_only),
    }


def indefinite_lived_impairment(
    *,
    asset: str | None = None,
    carrying_amount: float,
    fair_value: float,
) -> dict:
    """ASC 350-30: write an indefinite-lived intangible down to fair value."""
    carrying = _num(carrying_amount, "impairment.carrying_amount", minimum=0.0)
    fair = _num(fair_value, "impairment.fair_value", minimum=0.0)
    loss = max(carrying - fair, 0.0)
    return {
        "standard": "ASC 350-30",
        "asset": asset,
        "carrying_amount": carrying,
        "fair_value": fair,
        "impaired": loss > 0.0,
        "impairment_loss": loss,
        "carrying_after": carrying - loss,
    }


def long_lived_impairment(
    *,
    asset_group: str | None = None,
    carrying_amount: float,
    undiscounted_cash_flows: list[float],
    fair_value: float,
) -> dict:
    """ASC 360-10 two-step: recoverability screen, then measurement.

    The screen sums the cash flows *undiscounted* — that is the standard's
    rule, not an omission — and only a failed screen produces a loss. A group
    whose fair value is below carrying but whose undiscounted flows still
    cover carrying is NOT impaired under 360-10; the test reports that case
    explicitly (`recoverable=True, impairment_loss=0`) because it is the one
    outcome analysts most often have to explain to an audit committee.
    """
    carrying = _num(carrying_amount, "impairment.carrying_amount", minimum=0.0)
    fair = _num(fair_value, "impairment.fair_value", minimum=0.0)
    if not isinstance(undiscounted_cash_flows, list) or not undiscounted_cash_flows:
        raise EngineInputError("impairment.undiscounted_cash_flows must be a non-empty list")
    if len(undiscounted_cash_flows) > MAX_FLOW_YEARS:
        raise EngineInputError(
            f"impairment.undiscounted_cash_flows accepts at most {MAX_FLOW_YEARS} years; "
            f"got {len(undiscounted_cash_flows)}"
        )
    flows = [
        _num(v, f"impairment.undiscounted_cash_flows[{i}]")
        for i, v in enumerate(undiscounted_cash_flows)
    ]
    total_undiscounted = sum(flows)
    recoverable = total_undiscounted >= carrying
    loss = 0.0 if recoverable else max(carrying - fair, 0.0)
    return {
        "standard": "ASC 360-10",
        "asset_group": asset_group,
        "carrying_amount": carrying,
        "undiscounted_cash_flows_total": total_undiscounted,
        "recoverable": recoverable,
        "fair_value": fair,
        "impaired": loss > 0.0,
        "impairment_loss": loss,
        "carrying_after": carrying - loss,
    }


_TESTS = {
    "goodwill": goodwill_impairment,
    "indefinite_lived": indefinite_lived_impairment,
    "long_lived": long_lived_impairment,
}


def run_impairment_test(kind, params) -> dict:
    """Dispatch to one of the three standards' tests (endpoint entry point)."""
    fn = _TESTS.get(str(kind))
    if fn is None:
        raise EngineInputError(f"unknown impairment test {kind!r}; expected one of {sorted(_TESTS)}")
    if not isinstance(params, dict):
        raise EngineInputError("impairment params must be an object")
    # See kwargs_refusal: the caller gets this test's own input names, not the
    # TypeError's account of an internal function's signature.
    unbindable = describe_unbindable(fn, params)
    if unbindable is not None:
        raise EngineInputError(f"invalid params for {kind}: {unbindable}")
    try:
        return fn(**params)
    except TypeError as exc:
        raise EngineInputError(
            f"invalid params for {kind}: the names are all ones this test takes, but one of "
            "the values is not of a type it can use"
        ) from exc
