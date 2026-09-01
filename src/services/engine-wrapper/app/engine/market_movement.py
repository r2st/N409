"""Market-movement adjustment to a stale transaction indication.

Why this exists
---------------
The OPM backsolve reads a value out of a financing round: the round's price per
share is taken as evidence of what the company was worth *on the day it
closed*. That is the strongest single input a 409A has, and it is also the one
that decays. A round priced in October and a valuation dated the following June
are eight months apart, and in those eight months the market for companies of
this profile moved. Concluding on the round price unadjusted asserts that it did
not.

The remedy every appraiser applies, and which the legacy 409.ai report presents
as its own chapter ("Adjustment Factor: Market Movement"), is to move the round
indication by the observed return of a public benchmark over the same interval,
geared by the subject's sensitivity to that benchmark:

    factor = 1 + beta · (index_end / index_start − 1)

`beta` is the elasticity of the subject's value to the benchmark. It defaults to
1.0 — the benchmark moves, the subject moves with it — which is the assumption a
reader should have to *disagree* with rather than one they have to discover.

What this module deliberately does not do
-----------------------------------------
It does not choose the benchmark, the dates, or the beta. All three are analyst
judgements that belong in the report's prose and in the review record, not in a
default buried in an engine. Supply no `market_movement` block and no adjustment
is made and none is claimed — which is the right behaviour for a valuation dated
days after its round, where the honest factor is 1.0 and saying so at four
decimal places would be false precision.
"""

from __future__ import annotations

import math
from datetime import date

from .errors import EngineInputError

# Ceiling on the adjustment, as a factor.
#
# Not a view about markets — a guard against a transposed index level. The
# benchmark levels are two free-form numbers an analyst types, and typing the
# S&P at 5,600 against a start of 56 asks for a 100x adjustment to the round
# price. That is not a market movement; it is a decimal point, and an engine
# that silently multiplies a $70M round by 100 has produced a number no reviewer
# will catch because it arrives already reconciled to itself.
#
# 5x either way is far outside any interval a 409A spans (a 409A is at most 12
# months stale by construction, and no benchmark a valuation would cite moved
# 5x in a year) while leaving genuine drawdowns and rallies untouched.
MAX_MOVEMENT_FACTOR = 5.0
MIN_MOVEMENT_FACTOR = 0.2


def _level(value: object, name: str) -> float:
    if value is None:
        raise EngineInputError(f"market_movement.{name} is required")
    try:
        out = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"market_movement.{name} must be a number") from exc
    if not math.isfinite(out):
        raise EngineInputError(f"market_movement.{name} must be a finite number")
    if out <= 0:
        raise EngineInputError(f"market_movement.{name} must be positive (it is an index level)")
    return out


def _period(value: object, name: str) -> date | None:
    """One end of the interval the benchmark return was measured over.

    Absent is fine — the exhibit falls back to "Round date to valuation date" —
    but a string that is not a day is not. These two fields are not arithmetic:
    they are printed verbatim into Exhibit C's market-movement block as the
    window the index levels were read at, on a signed §409A opinion. The block
    took whatever it was handed and truncated it to ten characters, so
    ``2026-02-31`` reached the page as a date that does not exist and
    ``"last autumn"`` reached it as ``"last autumn"``, each stated as the
    period a measurement covers.

    Checked against the calendar rather than a shape, for the reason
    `rollforward.ts`'s `isoDate` gives: ``2026-02-31`` matches every plausible
    pattern and is not a day. Sliced to ten characters first, so a caller
    passing a full ISO instant keeps working.
    """
    if value is None:
        return None
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not value.strip():
        raise EngineInputError(f"market_movement.{name} must be an ISO date (YYYY-MM-DD)")
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError as exc:
        raise EngineInputError(
            f"market_movement.{name} must be an ISO date (YYYY-MM-DD); got {value.strip()[:40]!r}"
        ) from exc


def market_movement(block: dict) -> dict:
    """Resolve a `market_movement` input block into the factor and its working.

    Accepts either the two index levels, or a `return` already computed by the
    analyst (for a benchmark quoted as a return rather than a level — a bond
    index, or a published venture index). Levels win when both are supplied,
    since they are the reviewable form.
    """
    beta_in = block.get("beta")
    if beta_in is None:
        beta = 1.0
    else:
        try:
            beta = float(beta_in)
        except (TypeError, ValueError) as exc:
            raise EngineInputError("market_movement.beta must be a number") from exc
        if not math.isfinite(beta):
            raise EngineInputError("market_movement.beta must be a finite number")
        if beta < 0:
            raise EngineInputError("market_movement.beta must be >= 0")

    if block.get("index_start") is not None or block.get("index_end") is not None:
        start = _level(block.get("index_start"), "index_start")
        end = _level(block.get("index_end"), "index_end")
        index_return = end / start - 1.0
    elif block.get("return") is not None:
        start = end = None
        try:
            index_return = float(block["return"])
        except (TypeError, ValueError) as exc:
            raise EngineInputError("market_movement.return must be a number") from exc
        if not math.isfinite(index_return):
            raise EngineInputError("market_movement.return must be a finite number")
    else:
        raise EngineInputError(
            "market_movement needs index_start and index_end, or a return"
        )

    factor = 1.0 + beta * index_return
    if factor <= 0:
        raise EngineInputError(
            f"the market movement adjustment factor is not positive ({factor:.4f}) — "
            "check the benchmark levels and beta"
        )
    if not MIN_MOVEMENT_FACTOR <= factor <= MAX_MOVEMENT_FACTOR:
        raise EngineInputError(
            f"the market movement adjustment factor is {factor:.4f}, outside the "
            f"[{MIN_MOVEMENT_FACTOR:g}, {MAX_MOVEMENT_FACTOR:g}] band a 409A interval admits — "
            "check the benchmark levels (a start of 56 against an end of 5,600 is a decimal point, "
            "not a market movement)"
        )

    out: dict = {
        "beta": beta,
        "index_return": round(index_return, 6),
        "factor": round(factor, 6),
    }
    if start is not None and end is not None:
        out["index_start"] = start
        out["index_end"] = end
    name = block.get("index_name")
    if isinstance(name, str) and name.strip():
        out["index_name"] = name.strip()[:120]
    period_start = _period(block.get("period_start"), "period_start")
    period_end = _period(block.get("period_end"), "period_end")
    if period_start is not None:
        out["period_start"] = period_start.isoformat()
    if period_end is not None:
        out["period_end"] = period_end.isoformat()
    # The interval is the claim the two index levels are evidence for, so it
    # cannot run backwards: `end / start - 1` is a return earned going forward,
    # and a window whose end precedes its start says the benchmark was read in
    # the other order — which would make the sign of the adjustment wrong on
    # the page that explains it.
    if period_start is not None and period_end is not None and period_end < period_start:
        raise EngineInputError(
            f"market_movement.period_end ({period_end.isoformat()}) precedes "
            f"market_movement.period_start ({period_start.isoformat()}) — the benchmark "
            "return is measured from the round date forward to the valuation date"
        )
    return out


def apply_movement(indication: float, movement: dict) -> float:
    """The adjusted indication. Kept beside the factor so the two cannot drift."""
    return indication * float(movement["factor"])
