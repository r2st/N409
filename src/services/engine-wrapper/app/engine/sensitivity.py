"""Sensitivity analysis over a completed valuation (features.md §engine).

Takes a full compute payload (``params`` + ``inputs``) and re-runs the engine
while stressing one or two assumptions at a time, holding everything else at
its base value. Supports the five levers analysts most want to see move the
common FMV:

* ``discount_rate``  — income approach WACC (inputs.income.discount_rate)
* ``volatility``     — OPM / DLOM volatility (inputs.volatility)
* ``exit_multiple``  — market comparable multiple (inputs.market.multiples)
* ``time_to_exit``   — years to a liquidity event (inputs.time_to_exit_years)
* ``growth_rate``    — DCF terminal growth (inputs.income.terminal_growth)

One-way tables vary a single lever across a range (default ±20% in five
steps); two-way tables vary a pair simultaneously into a matrix. Each cell
carries the resulting FMV per share, the equity value, and the relative change
from the base case. A variation that the engine rejects (e.g. a discount rate
driven below terminal growth) degrades to ``null`` with an ``error`` note
rather than failing the whole request.
"""

from __future__ import annotations

import copy
import statistics

from .compute import _time_to_exit, compute
from .errors import EngineInputError

PARAMETERS = ("discount_rate", "volatility", "exit_multiple", "time_to_exit", "growth_rate")

DEFAULT_SPAN = 0.20  # ±20%
DEFAULT_STEPS = 5


def _income(inputs: dict) -> dict:
    income = inputs.get("income")
    return income if isinstance(income, dict) else {}


def _market_multiples(inputs: dict) -> list[float] | None:
    market = inputs.get("market")
    if not isinstance(market, dict):
        return None
    multiples = market.get("multiples")
    if isinstance(multiples, list) and multiples:
        return [float(m) for m in multiples]
    if market.get("multiple") is not None:
        return [float(market["multiple"])]
    return None


def _base_value(name: str, params: dict, inputs: dict) -> float | None:
    """The base value of a lever, or None when the payload doesn't drive it."""
    if name == "volatility":
        v = inputs.get("volatility")
        return float(v) if v is not None else None
    if name == "discount_rate":
        v = _income(inputs).get("discount_rate")
        return float(v) if v is not None else None
    if name == "growth_rate":
        v = _income(inputs).get("terminal_growth")
        return float(v) if v is not None else 0.0 if _income(inputs) else None
    if name == "time_to_exit":
        try:
            return _time_to_exit(params, inputs)
        except EngineInputError:
            return None
    if name == "exit_multiple":
        multiples = _market_multiples(inputs)
        return statistics.median(multiples) if multiples else None
    raise EngineInputError(f"unknown sensitivity parameter '{name}'")


def _apply(name: str, value: float, params: dict, inputs: dict) -> None:
    """Set a lever to ``value`` on an already-deep-copied inputs dict."""
    if name == "volatility":
        inputs["volatility"] = value
    elif name == "discount_rate":
        income = dict(inputs.get("income") or {})
        income["discount_rate"] = value
        inputs["income"] = income
    elif name == "growth_rate":
        income = dict(inputs.get("income") or {})
        income["terminal_growth"] = value
        inputs["income"] = income
    elif name == "time_to_exit":
        inputs["time_to_exit_years"] = value
    elif name == "exit_multiple":
        base = _base_value("exit_multiple", params, inputs)
        market = dict(inputs.get("market") or {})
        current = _market_multiples(inputs) or []
        if base and base > 0 and current:
            factor = value / base
            market["multiples"] = [m * factor for m in current]
        else:
            market["multiples"] = [value]
        market.pop("multiple", None)
        inputs["market"] = market
    else:  # pragma: no cover - guarded by _base_value
        raise EngineInputError(f"unknown sensitivity parameter '{name}'")


def _steps(base: float, span: float, steps: int) -> list[float]:
    """`steps` evenly spaced points spanning base·(1±span). Falls back to
    additive spacing around a zero base (multiplicative would collapse)."""
    if steps < 1:
        raise EngineInputError("steps must be >= 1")
    if steps == 1:
        return [base]
    if base == 0:
        lo, hi = -span, span
    else:
        lo, hi = base * (1 - span), base * (1 + span)
    return [round(lo + (hi - lo) * i / (steps - 1), 8) for i in range(steps)]


def _fmv(params: dict, inputs: dict) -> tuple[float | None, float | None, str | None]:
    try:
        res = compute(params, inputs)["results"]
        return res.get("fmv_per_share"), res.get("equity_value"), None
    except EngineInputError as exc:
        return None, None, str(exc)


def _one_way(
    name: str, base_value: float, base_fmv: float, params: dict, inputs: dict, span: float, steps: int
) -> dict:
    points = []
    for value in _steps(base_value, span, steps):
        mutated = copy.deepcopy(inputs)
        _apply(name, value, params, mutated)
        fmv, equity, error = _fmv(params, mutated)
        points.append(
            {
                "value": value,
                "fmv_per_share": fmv,
                "equity_value": equity,
                "delta_from_base": round(fmv / base_fmv - 1, 6)
                if fmv is not None and base_fmv
                else None,
                **({"error": error} if error else {}),
            }
        )
    return {"parameter": name, "base_value": round(base_value, 8), "points": points}


def _two_way(
    row: str,
    col: str,
    params: dict,
    inputs: dict,
    base_fmv: float,
    span: float,
    steps: int,
) -> dict:
    row_base = _base_value(row, params, inputs)
    col_base = _base_value(col, params, inputs)
    if row_base is None or col_base is None:
        raise EngineInputError(
            f"two-way [{row} × {col}] needs both levers present in the payload"
        )
    row_values = _steps(row_base, span, steps)
    col_values = _steps(col_base, span, steps)
    rows = []
    for rv in row_values:
        cells = []
        for cv in col_values:
            mutated = copy.deepcopy(inputs)
            _apply(row, rv, params, mutated)
            _apply(col, cv, params, mutated)
            fmv, _equity, error = _fmv(params, mutated)
            cells.append(
                {
                    "fmv_per_share": fmv,
                    "delta_from_base": round(fmv / base_fmv - 1, 6)
                    if fmv is not None and base_fmv
                    else None,
                    **({"error": error} if error else {}),
                }
            )
        rows.append(cells)
    return {
        "row_parameter": row,
        "col_parameter": col,
        "row_base": round(row_base, 8),
        "col_base": round(col_base, 8),
        "row_values": row_values,
        "col_values": col_values,
        "rows": rows,
    }


def sensitivity(
    params: dict,
    inputs: dict,
    *,
    parameters: list[str] | None = None,
    two_way: list[list[str]] | None = None,
    span: float = DEFAULT_SPAN,
    steps: int = DEFAULT_STEPS,
) -> dict:
    """One-way (and optional two-way) sensitivity around the base valuation.

    ``parameters`` selects the one-way levers (default: every lever the payload
    actually drives). ``two_way`` is a list of ``[row, col]`` lever pairs.
    """
    if not 0 < span <= 2:
        raise EngineInputError("span must be in (0, 2]")
    if not 2 <= steps <= 21:
        raise EngineInputError("steps must be between 2 and 21")

    # Base case must compute — a sensitivity around a broken valuation is
    # meaningless, so surface that error directly.
    base_fmv, base_equity, base_error = _fmv(params, inputs)
    if base_error is not None or base_fmv is None:
        raise EngineInputError(f"base valuation does not compute: {base_error or 'no FMV'}")

    if parameters is None:
        selected = [p for p in PARAMETERS if _base_value(p, params, inputs) is not None]
    else:
        unknown = set(parameters) - set(PARAMETERS)
        if unknown:
            raise EngineInputError(f"unknown sensitivity parameters: {sorted(unknown)}")
        selected = list(dict.fromkeys(parameters))  # de-dupe, keep order

    one_way = []
    skipped = []
    for name in selected:
        base_value = _base_value(name, params, inputs)
        if base_value is None:
            skipped.append(name)
            continue
        one_way.append(_one_way(name, base_value, base_fmv, params, inputs, span, steps))

    two_way_tables = []
    skipped_two_way = []
    for pair in two_way or []:
        if not (isinstance(pair, (list, tuple)) and len(pair) == 2):
            raise EngineInputError("each two_way entry must be a [row, col] pair")
        row, col = pair
        if row not in PARAMETERS or col not in PARAMETERS:
            raise EngineInputError(f"unknown two-way parameters: {pair}")
        if row == col:
            raise EngineInputError("two-way parameters must differ")
        # An undrivable lever (not present in this payload) is skipped, not an
        # error — the caller can request a default pair set without knowing
        # which levers the valuation actually exercises.
        if _base_value(row, params, inputs) is None or _base_value(col, params, inputs) is None:
            skipped_two_way.append([row, col])
            continue
        two_way_tables.append(_two_way(row, col, params, inputs, base_fmv, span, steps))

    return {
        "base": {
            "fmv_per_share": base_fmv,
            "equity_value": base_equity,
            "parameters": {
                p: _base_value(p, params, inputs)
                for p in PARAMETERS
                if _base_value(p, params, inputs) is not None
            },
        },
        "span": span,
        "steps": steps,
        "one_way": one_way,
        "two_way": two_way_tables,
        **({"skipped": skipped} if skipped else {}),
        **({"skipped_two_way": skipped_two_way} if skipped_two_way else {}),
    }
