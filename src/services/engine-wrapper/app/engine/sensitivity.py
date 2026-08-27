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

import statistics

from .compute import _num, _req, _time_to_exit, compute
from .errors import EngineInputError

PARAMETERS = ("discount_rate", "volatility", "exit_multiple", "time_to_exit", "growth_rate")

DEFAULT_SPAN = 0.20  # ±20%
DEFAULT_STEPS = 5

# Distinct ordered (row, col) pairs that can be asked for: every lever against
# every other. A request naming more than this is naming one of them twice.
MAX_TWO_WAY_TABLES = len(PARAMETERS) * (len(PARAMETERS) - 1)


def _income(inputs: dict) -> dict:
    income = inputs.get("income")
    return income if isinstance(income, dict) else {}


def _market_multiples(inputs: dict) -> list[float] | None:
    """The multiples the market approach actually prices, or None if it can't.

    Filtered to the positive members, because that is the set
    ``approaches.market_multiples`` strikes its median over — it drops
    everything that is not ``> 0`` before selecting. Reading the raw list here
    put this lever's whole axis on a different footing from the valuation it
    claims to be a sensitivity of.

    A non-positive multiple is ordinary rather than a typo: ``auto_comparables``
    takes ``ev_ebitda`` straight off each comparable ticker, and a peer with
    negative EBITDA contributes a negative multiple. On ``[-8, 5, 7]`` the
    engine prices the median of ``[5, 7]`` — 6.0× — while this returned the
    median of all three, 5.0×, so the table was captioned 4.0 / 5.0 / 6.0 for
    cells the engine had computed at 4.8 / 6.0 / 7.2. Those labels are rendered
    straight into the axis, and the point labelled 6.0× carried the FMV of a
    7.2× exit. Worse, a majority-negative set (``[-6, -4, 5]``) gave a negative
    median, which failed ``base and base > 0`` in ``_apply`` and collapsed the
    comparables to a single negative multiple: every cell in the table came
    back null for a payload that computes fine.

    Nothing positive left means the market approach cannot be driven at all, so
    the lever is reported as skipped rather than tabulated against a base the
    valuation never used.
    """
    market = inputs.get("market")
    if not isinstance(market, dict):
        return None
    multiples = market.get("multiples")
    if isinstance(multiples, list) and multiples:
        return [m for m in (_req(x, "market.multiples[]") for x in multiples) if m > 0] or None
    if market.get("multiple") is not None:
        one = _req(market["multiple"], "market.multiple")
        return [one] if one > 0 else None
    return None


def _base_value(name: str, params: dict, inputs: dict) -> float | None:
    """The base value of a lever, or None when the payload doesn't drive it.

    Every read goes through the engine's numeric guard rather than a bare
    `float()`. This endpoint has no preflight validation in front of it, so a
    lever whose base value is unusable — "12.5x" typed into a multiple, a null
    left in a comparables list — reached `float()` directly and raised
    ValueError/TypeError. Neither is an EngineInputError, so the route's 422
    handler did not see them and the caller got an opaque 500 for an input
    problem it could have fixed.
    """
    if name == "volatility":
        return _num(inputs.get("volatility"), "volatility")
    if name == "discount_rate":
        return _num(_income(inputs).get("discount_rate"), "income.discount_rate")
    if name == "growth_rate":
        v = _num(_income(inputs).get("terminal_growth"), "income.terminal_growth")
        return v if v is not None else (0.0 if _income(inputs) else None)
    if name == "time_to_exit":
        try:
            # `_time_to_exit` returns (years, basis); the lever is the number.
            # The basis is a disclosure about where the base case came from and
            # says nothing about the swept points, every one of which is an
            # explicit override written by `_apply`.
            return _time_to_exit(params, inputs)[0]
        except EngineInputError:
            return None
    if name == "exit_multiple":
        multiples = _market_multiples(inputs)
        return statistics.median(multiples) if multiples else None
    raise EngineInputError(f"unknown sensitivity parameter '{name}'")


def _variant(inputs: dict) -> dict:
    """A copy of ``inputs`` that ``_apply`` may write a lever into.

    Deliberately shallow. A two-way table at the maximum 21 steps is 441 cells,
    each needing its own payload, and a real 409A payload carries a cap table,
    projections and comparable price series — deep-copying it per cell was
    about two thirds of the wall time of a sensitivity run and bought nothing,
    because nothing downstream writes through the shared references:

    * ``_apply`` only ever rebinds a top-level key, and rebuilds the ``income``
      and ``market`` sub-dicts with ``dict(...)`` before touching them.
    * ``compute`` treats its ``inputs`` as read-only — the one place it writes
      (``_apply_auto_engines``) shallow-copies first and likewise rebuilds each
      nested dict it modifies.

    ``test_sensitivity_does_not_mutate_the_callers_payload`` holds that second
    property to account, so this stays safe if ``compute`` changes.
    """
    return dict(inputs)


def _apply(name: str, value: float, params: dict, inputs: dict) -> None:
    """Set a lever to ``value`` on a private copy of the inputs (see ``_variant``)."""
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
    """`steps` evenly spaced points spanning base·(1±span), always ascending.

    Falls back to additive spacing around a zero base (multiplicative would
    collapse).

    The endpoints have to be ordered rather than assumed. Multiplying a
    *negative* base by (1−span) gives the larger of the two — a terminal growth
    of −2% spans −0.016 … −0.024 — so taken in the written order the axis runs
    downwards, and it is the one lever where a negative base is ordinary:
    a business in runoff is priced on a declining terminal growth. Every other
    lever (volatility, discount rate, multiple, time to exit) is positive by
    construction and ascends, so the table for that one lever came out reading
    backwards against the rest. `row_values`/`col_values` are rendered straight
    into the axis labels, and the cells travel with them, so a two-way heatmap
    against growth was mirrored rather than merely relabelled.
    """
    if steps < 1:
        raise EngineInputError("steps must be >= 1")
    if steps == 1:
        return [base]
    if base == 0:
        lo, hi = -span, span
    else:
        lo, hi = sorted((base * (1 - span), base * (1 + span)))
    return [round(lo + (hi - lo) * i / (steps - 1), 8) for i in range(steps)]


def _fmv(params: dict, inputs: dict) -> tuple[float | None, float | None, float | None, str | None]:
    """One run: the reported FMV, the unrounded one, and the equity value.

    Two per-share figures because they answer different questions. The reported
    `results.fmv_per_share` is the conclusion at the four decimals every surface
    prints, and it is what a cell of this table shows. The unrounded one is what
    `delta_from_base` divides — a ratio inherits the quantum of its operands,
    and 1e-4 against a sub-cent common share is a 2% step, which is 20,000 times
    the six decimals the delta was being reported to. On the reference cap table
    in `test_calculation_provenance.py` a swept volatility that really moves the
    conclusion +85.65% was published as +83.67%.
    """
    try:
        out = compute(params, inputs)
        res = out["results"]
        return (
            res.get("fmv_per_share"),
            out.get("fmv_per_share_unrounded"),
            res.get("equity_value"),
            None,
        )
    except EngineInputError as exc:
        return None, None, None, str(exc)


def _one_way(
    name: str, base_value: float, base_fmv: float, params: dict, inputs: dict, span: float, steps: int
) -> dict:
    points = []
    for value in _steps(base_value, span, steps):
        mutated = _variant(inputs)
        _apply(name, value, params, mutated)
        fmv, exact, equity, error = _fmv(params, mutated)
        points.append(
            {
                "value": value,
                "fmv_per_share": fmv,
                "equity_value": equity,
                "delta_from_base": round(exact / base_fmv - 1, 6)
                if exact is not None and base_fmv
                else None,
                **({"error": error} if error else {}),
            }
        )
    return {"parameter": name, "base_value": round(base_value, 8), "points": points}


def _two_way(
    row: str,
    col: str,
    row_base: float,
    col_base: float,
    params: dict,
    inputs: dict,
    base_fmv: float,
    span: float,
    steps: int,
) -> dict:
    row_values = _steps(row_base, span, steps)
    col_values = _steps(col_base, span, steps)
    rows = []
    for rv in row_values:
        cells = []
        for cv in col_values:
            mutated = _variant(inputs)
            _apply(row, rv, params, mutated)
            _apply(col, cv, params, mutated)
            fmv, exact, _equity, error = _fmv(params, mutated)
            cells.append(
                {
                    "fmv_per_share": fmv,
                    "delta_from_base": round(exact / base_fmv - 1, 6)
                    if exact is not None and base_fmv
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
    # Two figures again, and the denominator is the unrounded one: `base_exact`
    # divides every delta in the response, `base_fmv` is only reported. Dividing
    # by the 4-dp conclusion shifted every delta in the table by the same
    # amount, so the error did not even average out across the sweep.
    base_fmv, base_exact, base_equity, base_error = _fmv(params, inputs)
    if base_error is not None or base_fmv is None or base_exact is None:
        raise EngineInputError(f"base valuation does not compute: {base_error or 'no FMV'}")

    # Every lever's base, resolved once. `time_to_exit` in particular re-parses
    # dates out of the payload, and this used to be recomputed a dozen-odd
    # times per request — once per lever, twice more per lever for the `base`
    # block, and twice per two-way pair.
    bases: dict[str, float | None] = {p: _base_value(p, params, inputs) for p in PARAMETERS}

    if parameters is None:
        selected = [p for p in PARAMETERS if bases[p] is not None]
    else:
        unknown = set(parameters) - set(PARAMETERS)
        if unknown:
            raise EngineInputError(f"unknown sensitivity parameters: {sorted(unknown)}")
        selected = list(dict.fromkeys(parameters))  # de-dupe, keep order

    one_way = []
    skipped = []
    for name in selected:
        base_value = bases[name]
        if base_value is None:
            skipped.append(name)
            continue
        one_way.append(_one_way(name, base_value, base_exact, params, inputs, span, steps))

    # Refused up front rather than de-duped below, because a list this long
    # cannot be anything but repetition — and saying so beats silently
    # collapsing a quarter of a million entries into twenty.
    if two_way is not None and len(two_way) > MAX_TWO_WAY_TABLES:
        raise EngineInputError(
            f"two_way accepts at most {MAX_TWO_WAY_TABLES} pairs "
            f"({len(PARAMETERS)} parameters against each other); got {len(two_way)}"
        )

    two_way_tables = []
    skipped_two_way = []
    seen_pairs: set[tuple[str, str]] = set()
    for pair in two_way or []:
        if not (isinstance(pair, (list, tuple)) and len(pair) == 2):
            raise EngineInputError("each two_way entry must be a [row, col] pair")
        row, col = pair
        if row not in PARAMETERS or col not in PARAMETERS:
            raise EngineInputError(f"unknown two-way parameters: {pair}")
        if row == col:
            raise EngineInputError("two-way parameters must differ")
        # De-duped for the same reason the one-way levers above are, and with
        # more riding on it. A repeated pair produces a byte-identical table, so
        # nothing is lost — but each one costs steps² full `compute` runs, and
        # the list had no cap of any kind. `[["discount_rate","exit_multiple"]]`
        # repeated fills an 8 MB body with about 4,700 entries at 36 bytes
        # apiece, which is ~4,700 × 441 = two million valuations: measured on a
        # cap-table payload, a little over an hour of CPU bought by one request.
        # That runs synchronously in a threadpool slot, so no request timeout
        # interrupts it and forty such requests take the service down.
        #
        # Only 20 distinct pairs exist, so collapsing them bounds the work at
        # what an honest caller could have asked for anyway.
        if (row, col) in seen_pairs:
            continue
        seen_pairs.add((row, col))
        # An undrivable lever (not present in this payload) is skipped, not an
        # error — the caller can request a default pair set without knowing
        # which levers the valuation actually exercises.
        row_base, col_base = bases[row], bases[col]
        if row_base is None or col_base is None:
            skipped_two_way.append([row, col])
            continue
        two_way_tables.append(
            _two_way(row, col, row_base, col_base, params, inputs, base_exact, span, steps)
        )

    return {
        "base": {
            "fmv_per_share": base_fmv,
            "equity_value": base_equity,
            "parameters": {p: v for p, v in bases.items() if v is not None},
        },
        "span": span,
        "steps": steps,
        "one_way": one_way,
        "two_way": two_way_tables,
        **({"skipped": skipped} if skipped else {}),
        **({"skipped_two_way": skipped_two_way} if skipped_two_way else {}),
    }
