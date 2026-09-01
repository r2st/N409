"""The allocation is computed once per run, and the two readings of it agree.

`compute._opm_allocate` wants the waterfall allocation *and* the class-volatility
schedule. It asked for them by calling `allocate_waterfall` and then
`class_volatilities` with the identical five arguments, and each of those runs
`_allocate` — the same normalisation, the same breakpoint segmentation, and a
Black-Scholes call on every breakpoint — so the whole allocation was computed
twice and one copy thrown away. `class_volatilities`' own docstring says its
deltas are the term-by-term derivative of the very sum `_allocate` uses for the
values, which is the statement that the two are one allocation read two ways.

Two assertions, because either alone is satisfiable by a wrong fix:

* the *count* — one `_allocate` per run on the waterfall path — which is what a
  reintroduced second call trips, and
* the *answers*, byte-for-byte against the two standalone entry points, which is
  what a "one pass" that quietly computes something else trips.
"""

from __future__ import annotations

import pytest

from app.engine import waterfall
from app.engine.compute import compute
from app.engine.waterfall import allocate_waterfall, allocate_with_volatilities, class_volatilities

CLASSES = [
    {"name": "Common", "kind": "common", "shares": 7_000_000},
    {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000, "seniority": 1},
    {
        "name": "Series B",
        "kind": "preferred",
        "shares": 1_500_000,
        "preference": 9_000_000,
        "seniority": 2,
        "participating": True,
    },
    {"name": "Options", "kind": "option", "shares": 1_000_000, "strike": 0.75},
]

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "dloc": 0.05,
    "dlom": 0.2,
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "last_round_post_money": 30_000_000,
    "exit_timeline": "2029-06-30",
    "share_classes": CLASSES,
}

ARGS = (40_000_000.0, CLASSES, 3.0, 0.042, 0.6)


@pytest.fixture
def allocate_calls(monkeypatch):
    """Counts `_allocate` without changing what it returns."""
    calls = []
    original = waterfall._allocate

    def counted(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(waterfall, "_allocate", counted)
    return calls


def test_one_allocation_per_waterfall_run(allocate_calls):
    out = compute(dict(PARAMS), dict(INPUTS))
    assert out["results"]["allocation"]["method"] == "opm_waterfall"
    assert out["results"]["class_volatility"] is not None
    assert len(allocate_calls) == 1


def test_the_combined_call_answers_what_the_two_answered():
    allocation, volatilities = allocate_with_volatilities(*ARGS)
    assert allocation == allocate_waterfall(*ARGS)
    assert volatilities == class_volatilities(*ARGS)


def test_the_two_standalone_entry_points_still_allocate_for_themselves(allocate_calls):
    """They have their own callers — the tests below this one, and the docs.

    The fix is a third entry point, not a cache: `class_volatilities` called on
    its own must still be a complete answer.
    """
    class_volatilities(*ARGS)
    assert len(allocate_calls) == 1
    allocate_waterfall(*ARGS)
    assert len(allocate_calls) == 2
