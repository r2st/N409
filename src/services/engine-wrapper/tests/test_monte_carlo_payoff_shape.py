"""The per-draw payoff: what it may be rewritten into, and what it may not.

`_common_payoff_factory` is the innermost loop of this engine. At `MAX_PATHS`
against the 200-class cap it runs four hundred thousand times, walking every
segment of the waterfall on each — so it attracts optimisation, and two kinds
of rewrite look equally harmless from outside.

One is safe: hoisting work that does not depend on the draw out of the loop.
The other is not. The natural speed-up here is to precompute each class's
cumulative allocation at every breakpoint and evaluate a draw as
`cumulative[k] + width·slope`, which turns a walk of every segment into a
lookup — and changes the order the floating-point terms are added in. The
result of that sum is not only the allocation: it is `s_common`, and
`s_common_sq`, and therefore `standard_error_per_share`, which is the run's
published precision claim, and `conservation_error`, which is the diagnostic
that decides whether the run is refused at all. A seeded run is also a
reproducibility promise — the same seed re-derived elsewhere has to reconcile
to the cent.

So the arithmetic is pinned here against an independent naive model, term by
term, and the "built once" claim in the factory's own docstring is pinned as a
count rather than left as a comment.
"""

import math
import random

from app.engine import monte_carlo
from app.engine.monte_carlo import _common_payoff_factory
from app.engine.waterfall import _normalize, _segments


def _cap_table(n: int) -> list[dict]:
    out = [{"name": "Common", "kind": "common", "shares": 8_000_000}]
    for i in range(n - 1):
        out.append(
            {
                "name": f"Series {i}",
                "kind": "preferred",
                "shares": 1_000_000,
                "preference": 1_000_000.0,
                "price_per_share": 1.0 + i / 100,
                "seniority": i + 1,
                "participating": i % 3 == 0,
                "conversion_ratio": 1.0,
            }
        )
    return out


def _reference_payoff(classes: list[dict]):
    """The naive walk, written out here so the test does not share the code
    under test's structure — segments in order, term by term, nothing hoisted.
    """
    segments = _segments(classes)
    index = {c["name"]: i for i, c in enumerate(classes)}

    def payoff(exit_value: float, into: list[float]) -> None:
        for seg in segments:
            lo = seg["from"]
            hi = math.inf if seg["to"] is None else seg["to"]
            if exit_value <= lo:
                break
            width = min(exit_value, hi) - lo
            for name, fraction in seg["participants"].items():
                into[index[name]] += width * fraction

    return payoff


def test_the_payoff_accumulates_the_same_bits_as_the_naive_walk():
    """Equality, not `approx`. The reported standard error is struck from these
    sums, so a difference in the last bit is a difference in a published figure.
    """
    rng = random.Random(409)
    for n in (2, 5, 40, 200):
        classes = _normalize(_cap_table(n))
        fast = _common_payoff_factory(classes)
        naive = _reference_payoff(classes)
        got = [0.0] * len(classes)
        want = [0.0] * len(classes)
        for _ in range(500):
            # Spread across the whole range on purpose: below the first
            # breakpoint, inside the stack, and far above the last one, so the
            # early `break` and the unbounded final segment are both exercised.
            exit_value = 50_000_000.0 * math.exp(rng.gauss(0.0, 1.5))
            fast(exit_value, got)
            naive(exit_value, want)
        assert got == want


def test_the_segments_are_built_once_per_factory_and_not_per_draw():
    """The claim the factory's docstring makes, as a count.

    Calling `exit_allocation` — or `_segments` — inside the loop is the mistake
    this factory exists to prevent, and it is invisible in the output: the
    numbers come out right and the request stops finishing.
    """
    calls = [0]
    real = monte_carlo._segments

    def counting(classes):
        calls[0] += 1
        return real(classes)

    monte_carlo._segments = counting
    try:
        classes = _normalize(_cap_table(20))
        payoff = _common_payoff_factory(classes)
        assert calls[0] == 1
        totals = [0.0] * len(classes)
        for i in range(1_000):
            payoff(1_000_000.0 * (i + 1), totals)
        assert calls[0] == 1
    finally:
        monte_carlo._segments = real
