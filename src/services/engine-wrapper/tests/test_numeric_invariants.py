"""Executable form of the rule in docs/engine-numeric-invariants.md.

The non-finite defect has been fixed six times in this engine, and the last two
were introduced the same way: by *omission*, in a module written without the
rule in mind. `rollforward._num` was the one numeric coercion helper in the
engine that never checked finiteness, and it had been that way since the module
was written — no test failed, because there was no test that could.

These tests are that test. They read the engine's own source and hold every
numeric coercion helper to the shape the doc describes, so a new module that
takes numbers from a request has to opt *out* deliberately rather than forget.
"""

from __future__ import annotations

import ast
import math
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parent.parent / "app" / "engine"

# The naming convention for "coerce caller data to a number" across the engine.
COERCION_NAMES = {"_num", "_finite", "_safe_float", "_coerce", "_coerce_float"}

# Helpers that are themselves the guard, so delegating to one satisfies the rule.
DELEGATES = COERCION_NAMES | {"isfinite"}


def _engine_modules() -> list[Path]:
    return sorted(p for p in ENGINE_DIR.glob("*.py") if p.name != "__init__.py")


def _functions(path: Path) -> list[ast.FunctionDef]:
    tree = ast.parse(path.read_text())
    return [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]


def _names_used(node: ast.AST) -> set[str]:
    used: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name):
            used.add(sub.id)
        elif isinstance(sub, ast.Attribute):
            used.add(sub.attr)
    return used


COERCION_HELPERS = [
    (path.name, fn)
    for path in _engine_modules()
    for fn in _functions(path)
    if fn.name in COERCION_NAMES
]


def test_the_engine_actually_has_coercion_helpers():
    """Guards the guard: if the naming convention drifts, this suite goes quiet."""
    modules = {name for name, _ in COERCION_HELPERS}
    assert len(COERCION_HELPERS) >= 10, f"only found {len(COERCION_HELPERS)} helpers"
    # The modules the doc names as enforcement points must still be among them.
    for expected in ("waterfall.py", "rollforward.py", "market_feed.py", "wacc.py"):
        assert expected in modules, f"{expected} no longer defines a coercion helper"


@pytest.mark.parametrize(
    "module,fn",
    [(m, f) for m, f in COERCION_HELPERS],
    ids=[f"{m}::{f.name}" for m, f in COERCION_HELPERS],
)
def test_every_coercion_helper_checks_finiteness(module: str, fn: ast.FunctionDef):
    """A numeric coercion helper must reject NaN/Inf, not just non-numbers.

    NaN passes every one-sided range check written to catch it — `NaN <= 0` is
    False — so a helper that only try/excepts `float()` lets it through to be
    serialised as `null` on a 200.
    """
    used = _names_used(fn)
    assert used & DELEGATES, (
        f"{module}::{fn.name} coerces to a number without a finiteness check. "
        "See docs/engine-numeric-invariants.md."
    )


@pytest.mark.parametrize(
    "module,fn",
    [(m, f) for m, f in COERCION_HELPERS],
    ids=[f"{m}::{f.name}" for m, f in COERCION_HELPERS],
)
def test_coercion_helpers_raise_engine_input_error_not_valueerror(
    module: str, fn: ast.FunctionDef
):
    """Whatever a helper raises must render as a 4xx naming the field.

    A bare `ValueError` escaping `float()` reaches the client as an opaque 500.
    A helper that returns None instead of raising (the external-provider case)
    is equally fine — what it must not do is raise something untranslated.
    """
    raised = {
        sub.exc.func.id
        for sub in ast.walk(fn)
        if isinstance(sub, ast.Raise)
        and isinstance(sub.exc, ast.Call)
        and isinstance(sub.exc.func, ast.Name)
    }
    assert raised <= {"EngineInputError"}, (
        f"{module}::{fn.name} raises {sorted(raised - {'EngineInputError'})}, "
        "which does not render as a 4xx"
    )


# ── The invariant itself, exercised rather than inspected ────────────────────


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_shared_coercion_helpers_reject_non_finite(bad):
    """The three helpers the doc quotes verbatim, held to their contract."""
    from app.engine.debt_valuation import _num as debt_num
    from app.engine.errors import EngineInputError
    from app.engine.fund_valuation import _num as fund_num
    from app.engine.rollforward import _num as roll_num
    from app.engine.waterfall import _finite

    for helper in (debt_num, fund_num, roll_num):
        with pytest.raises(EngineInputError, match="finite"):
            helper(bad, "field")
    with pytest.raises(EngineInputError, match="finite"):
        _finite(bad, "field")


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_market_feed_treats_non_finite_as_no_data(bad):
    """The external-provider case: not an error, but not a value either."""
    from app.engine.market_feed import _safe_float

    assert _safe_float(bad) is None


def test_nan_would_defeat_a_one_sided_bound():
    """Documents *why* the helpers above cannot be skipped.

    If this ever fails, Python's comparison semantics changed and most of
    docs/engine-numeric-invariants.md needs rewriting.
    """
    nan = float("nan")
    assert not (nan <= 0)  # passes "must be positive"
    assert not (nan < 0)  # passes "must be non-negative"
    assert isinstance(nan, float)  # passes "is this a usable value?"
    assert not math.isfinite(nan)  # ...only this catches it
