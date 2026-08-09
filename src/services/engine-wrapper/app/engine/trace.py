"""Step-by-step record of what a calculation did, for the inspector.

Why this exists
---------------
`compute` returns a finished result document. When a reviewer disagrees with a
concluded FMV — and that is the whole job — the document says what the answer
is and nothing about how it got there. Answering "why is the market approach
$4M when the multiples say 8x" today means reading `compute.py` alongside the
stored input payload and re-doing the arithmetic by hand.

A trace records each stage as it runs: what it consumed, what it produced, and
whether it ran at all. That last part is the one a results document can never
show. An approach with zero weight and an approach reused from a previous run
are both absent from `results.approaches` in exactly the same way, and they
mean opposite things — "the analyst excluded this" versus "this number is older
than the inputs you are looking at".

Design notes
------------
Steps are recorded by the code that runs them, not derived afterwards from the
result. Deriving would make the trace a second implementation of the pipeline
that agrees with the first only until someone edits one of them, and a debug
view that lies is worse than no debug view.

`Trace.off()` is a working recorder that keeps nothing, so the call sites have
no `if trace is not None` branches. Tracing is opt-in per request because the
payloads are the engine's whole working state and most callers never look.

Nothing here is allowed to change a number. `record` deep-copies what it is
given so a later mutation upstream cannot rewrite history, and every value it
stores goes through `_plain`, which is also what keeps the trace JSON-safe.
"""

from __future__ import annotations

import math
import time
from typing import Any

#: How deep a recorded payload is walked before it is summarised rather than
#: copied. Share-class waterfalls nest a few levels; anything deeper than this
#: is a structure nobody reads in a step view, and copying it wholesale is how
#: a trace ends up larger than the calculation it describes.
MAX_DEPTH = 6

#: Longest list copied element-by-element. A projection can carry hundreds of
#: periods; the head is what a reviewer scans, and the count is what tells them
#: the tail exists.
MAX_ITEMS = 50


def _plain(value: Any, depth: int = 0) -> Any:
    """A JSON-safe, bounded, detached copy of `value`.

    Non-finite floats become `None` rather than raising: a trace of a run that
    overflowed is precisely the trace worth having, and `_assert_finite_results`
    is what refuses the *result*. Serialising the debug record must not be the
    thing that turns a diagnosable failure into a 500.
    """
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        if depth >= MAX_DEPTH:
            return {"__truncated__": f"{len(value)} keys"}
        return {str(k): _plain(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        if depth >= MAX_DEPTH:
            return {"__truncated__": f"{len(value)} items"}
        head = [_plain(v, depth + 1) for v in list(value)[:MAX_ITEMS]]
        if len(value) > MAX_ITEMS:
            head.append({"__truncated__": f"{len(value) - MAX_ITEMS} more items"})
        return head
    # A type the engine does not otherwise produce (a Decimal from a driver, a
    # date). Its repr is more use in a debug view than dropping the key.
    return repr(value)


class Trace:
    """Ordered steps, with timings. `Trace.off()` records nothing."""

    __slots__ = ("_steps", "_enabled", "_started")

    def __init__(self, enabled: bool = True) -> None:
        self._enabled = enabled
        self._steps: list[dict] = []
        self._started = time.perf_counter()

    @classmethod
    def off(cls) -> "Trace":
        return cls(enabled=False)

    @property
    def enabled(self) -> bool:
        return self._enabled

    def record(
        self,
        key: str,
        label: str,
        *,
        status: str = "computed",
        inputs: Any = None,
        outputs: Any = None,
        note: str | None = None,
    ) -> None:
        """Append one step.

        `status` is the field the results document cannot express:

        * ``computed`` — ran now, from the inputs shown.
        * ``reused``   — taken from a previous run because this was a
          per-approach recalculation that did not name it. The number is real
          and it is *older than the inputs above it*.
        * ``skipped``  — did not run, with `note` saying why (zero weight, an
          allocation method that has no such stage).
        """
        if not self._enabled:
            return
        self._steps.append(
            {
                "seq": len(self._steps) + 1,
                "key": key,
                "label": label,
                "status": status,
                "inputs": _plain(inputs),
                "outputs": _plain(outputs),
                "note": note,
                # Cumulative rather than per-step: steps are recorded on
                # completion, so this is "how far into the run this finished",
                # which is what makes one slow stage visible against the rest.
                "elapsed_ms": round((time.perf_counter() - self._started) * 1000, 3),
            }
        )

    def as_list(self) -> list[dict]:
        return list(self._steps)


__all__ = ["MAX_DEPTH", "MAX_ITEMS", "Trace"]
