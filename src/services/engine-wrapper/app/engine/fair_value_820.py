"""ASC 820 fair value measurement (Topic 820, Fair Value Measurement).

An ASC 820 engagement is not a 409A with a different cover page. The concluded
number is often the easy part — what the auditor tests, and what the disclosure
standard is almost entirely about, is *how the measurement is categorised and
disclosed*:

  - **the hierarchy** (820-10-35-37..55). A measurement takes the level of the
    LOWEST level input that is significant to it, not the level of its best
    input. A position marked off a Level 2 quote and a Level 3 illiquidity
    adjustment that moves the mark materially is a Level 3 measurement, and
    reporting it as Level 2 is the single most common finding on these files;

  - **the practical expedient** (820-10-35-59, as amended by ASU 2015-07).
    Investments measured at NAV per share are *not categorised in the
    hierarchy at all*. They are disclosed as a reconciling line to the total.
    Slotting them into Level 3 — which is what happens when the hierarchy is
    built by "everything unquoted is Level 3" — makes both the Level 3 total
    and the Level 3 rollforward wrong;

  - **the Level 3 rollforward** (820-10-50-2(c)): beginning balance, purchases,
    sales, settlements, transfers in/out, and gains/losses split realised vs
    unrealised, tying to the ending balance;

  - **the unobservable input table** (820-10-50-2(bbb)): for each significant
    unobservable input, its range and weighted average — weighted by the fair
    value of the positions it applies to, which is the definition the standard
    gives and not the arithmetic mean;

  - **the sensitivity** the same paragraph requires in narrative form.

Pure and deterministic. Position marks arrive as inputs; this module
categorises, aggregates and reconciles them into the disclosure.
"""

from __future__ import annotations

import math

from .errors import EngineInputError

LEVELS = ("level_1", "level_2", "level_3")

# A rollforward that does not tie is a disclosure error, but floating-point
# addition of many marks is not exact. Tie to the cent, or to a relative
# tolerance for very large portfolios.
_TIE_ABS = 0.01
_TIE_REL = 1e-9

MAX_POSITIONS = 5_000


def _num(
    value, name: str, *, minimum: float | None = None, maximum: float | None = None
) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"{name} must be a number") from exc
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be finite")
    if minimum is not None and out < minimum:
        raise EngineInputError(f"{name} must be >= {minimum}")
    if maximum is not None and out > maximum:
        raise EngineInputError(f"{name} must be <= {maximum}")
    return out


def _opt_num(value, name: str, **kw) -> float | None:
    return None if value is None else _num(value, name, **kw)


def _level(value, name: str) -> str:
    level = str(value or "").strip().lower().replace(" ", "_")
    if level in {"1", "2", "3"}:
        level = f"level_{level}"
    if level not in LEVELS:
        raise EngineInputError(f"{name} must be one of level_1, level_2, level_3")
    return level


def classify_position(position: dict, index: int) -> dict:
    """One position's measurement level, and why it is that level.

    ``inputs`` is the list of inputs the mark actually uses, each with its own
    level and a ``significant`` flag. The measurement takes the lowest level
    among the *significant* ones — 820-10-35-37A, and the reason a Level 2
    quote with a significant Level 3 adjustment is a Level 3 measurement.

    A position that names no inputs falls back to its stated ``level``; that is
    the ordinary case for a listed equity and should not require ceremony.
    """
    label = f"positions[{index}]"
    name = str(position.get("name") or f"Position {index + 1}")
    fair_value = _num(position.get("fair_value"), f"{label}.fair_value")

    # The practical expedient short-circuits everything: a NAV-measured
    # investment is deliberately outside the hierarchy (ASU 2015-07).
    if bool(position.get("measured_at_nav")):
        return {
            "name": name,
            "fair_value": fair_value,
            "level": None,
            "nav_practical_expedient": True,
            "basis": "measured at NAV per share — not categorised in the fair value hierarchy",
            "significant_unobservable_inputs": [],
        }

    raw_inputs = position.get("inputs")
    if raw_inputs is not None and not isinstance(raw_inputs, list):
        raise EngineInputError(f"{label}.inputs must be a list")

    stated = _level(position.get("level", "level_3"), f"{label}.level")
    significant_unobservable: list[dict] = []
    lowest = 0
    for j, raw in enumerate(raw_inputs or []):
        if not isinstance(raw, dict):
            raise EngineInputError(f"{label}.inputs[{j}] must be an object")
        input_level = _level(raw.get("level"), f"{label}.inputs[{j}].level")
        # Significance defaults to True: an input worth naming is presumed to
        # matter, and the failure mode of the opposite default is a Level 3
        # measurement quietly disclosed as Level 2.
        if raw.get("significant", True) is False:
            continue
        rank = LEVELS.index(input_level) + 1
        lowest = max(lowest, rank)
        if input_level == "level_3":
            significant_unobservable.append(
                {
                    "name": str(raw.get("name") or f"input {j + 1}"),
                    "value": _opt_num(raw.get("value"), f"{label}.inputs[{j}].value"),
                    "fair_value": fair_value,
                }
            )

    level = f"level_{lowest}" if lowest else stated
    if lowest and level != stated:
        basis = (
            f"lowest significant input is {level.replace('_', ' ')}; "
            f"stated {stated.replace('_', ' ')} does not govern (ASC 820-10-35-37A)"
        )
    else:
        basis = f"lowest significant input is {level.replace('_', ' ')}"

    return {
        "name": name,
        "fair_value": fair_value,
        "level": level,
        "nav_practical_expedient": False,
        "basis": basis,
        "significant_unobservable_inputs": significant_unobservable,
    }


def _unobservable_table(classified: list[dict]) -> list[dict]:
    """Range and *fair-value-weighted* average per unobservable input.

    820-10-50-2(bbb) asks for the weighted average, and the weight is the fair
    value of the positions the input applies to. An arithmetic mean lets a
    thousand-dollar position pull the disclosed average as hard as a
    ten-million-dollar one.
    """
    buckets: dict[str, list[dict]] = {}
    for position in classified:
        for entry in position["significant_unobservable_inputs"]:
            if entry["value"] is None:
                continue
            buckets.setdefault(entry["name"], []).append(entry)

    table: list[dict] = []
    for name, entries in sorted(buckets.items()):
        values = [e["value"] for e in entries]
        weights = [abs(e["fair_value"]) for e in entries]
        total_weight = sum(weights)
        weighted = (
            sum(v * w for v, w in zip(values, weights)) / total_weight
            if total_weight > 0
            # Every position carrying the input is marked at zero, so there is
            # no weight to average by; the unweighted mean is the only
            # defensible answer and is labelled as such.
            else sum(values) / len(values)
        )
        table.append(
            {
                "input": name,
                "low": min(values),
                "high": max(values),
                "weighted_average": weighted,
                "weighted": total_weight > 0,
                "position_count": len(entries),
                "fair_value": total_weight,
            }
        )
    return table


def _rollforward(raw: dict | None, ending_level_3: float) -> dict | None:
    """Level 3 rollforward (820-10-50-2(c)), checked against the ending balance."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise EngineInputError("level_3_rollforward must be an object")

    fields = (
        "beginning_balance",
        "purchases",
        "issuances",
        "sales",
        "settlements",
        "transfers_into_level_3",
        "transfers_out_of_level_3",
        "realized_gains_losses",
        "unrealized_gains_losses",
    )
    values = {f: _num(raw.get(f, 0.0), f"level_3_rollforward.{f}") for f in fields}

    # Sales, settlements and transfers out reduce the balance; the caller
    # supplies them as positive magnitudes, which is how the disclosure reads.
    computed = (
        values["beginning_balance"]
        + values["purchases"]
        + values["issuances"]
        - values["sales"]
        - values["settlements"]
        + values["transfers_into_level_3"]
        - values["transfers_out_of_level_3"]
        + values["realized_gains_losses"]
        + values["unrealized_gains_losses"]
    )
    difference = ending_level_3 - computed
    tolerance = max(_TIE_ABS, _TIE_REL * max(abs(ending_level_3), abs(computed)))
    return {
        **values,
        "computed_ending_balance": computed,
        "measured_ending_balance": ending_level_3,
        "difference": difference,
        # Surfaced rather than raised: an untied rollforward is a real finding
        # the analyst has to resolve, but it is not a reason to refuse to
        # produce the rest of the measurement.
        "ties": abs(difference) <= tolerance,
    }


def _sensitivity(level_3_total: float, shifts: list | None, unobservable: list[dict]) -> list[dict]:
    """Effect on the Level 3 total of moving one unobservable input.

    ``shift`` is the relative change in the measurement the input drives, which
    is what the narrative disclosure states ("a 10% increase in the discount
    rate would decrease fair value by ...").

    THE SHIFT USED TO BE STRUCK ON THE WHOLE LEVEL 3 TOTAL, NOT ON WHAT THE
    INPUT ACTUALLY DRIVES. An unobservable input is rarely significant to every
    Level 3 position — a discount-rate input on a $2M position inside a $10M
    Level 3 book drives $2M of measurement, not $10M — and ``_unobservable_table``
    already computes exactly that figure per input (the fair value of the
    positions carrying it, the same weight the weighted-average row is struck
    on). Scaling the portfolio total instead overstated a −10% discount-rate
    shift on that book fivefold: −$1,000,000 where −$200,000 is what the named
    input can move, reported under a caption that says "discount rate" and a
    number that is four-fifths somebody else's position.

    Falls back to the Level 3 total for an input name the position-level
    ``inputs[]`` never named — a caller stating a narrative sensitivity without
    wiring it to specific positions is not told less than it asked for, only
    that the figure is portfolio-wide rather than input-specific.
    """
    if shifts is None:
        return []
    if not isinstance(shifts, list):
        raise EngineInputError("sensitivity must be a list")
    driven_fair_value = {row["input"]: row["fair_value"] for row in unobservable}
    out: list[dict] = []
    for i, raw in enumerate(shifts):
        if not isinstance(raw, dict):
            raise EngineInputError(f"sensitivity[{i}] must be an object")
        shift = _num(raw.get("shift"), f"sensitivity[{i}].shift", minimum=-1.0, maximum=1.0)
        name = str(raw.get("input") or f"input {i + 1}")
        basis_is_input = name in driven_fair_value
        base = driven_fair_value[name] if basis_is_input else level_3_total
        effect = base * shift
        out.append(
            {
                "input": name,
                "shift": shift,
                "fair_value_effect": effect,
                "fair_value_after": level_3_total + effect,
                # Which base the effect was struck on — the value the named
                # input actually drives, or the whole Level 3 total when this
                # input was never tied to a position's `inputs[]`.
                "basis_fair_value": base,
                "basis": "input" if basis_is_input else "level_3_total",
            }
        )
    return out


def fair_value_measurement(
    *,
    positions: list,
    measurement_date: str | None = None,
    level_3_rollforward: dict | None = None,
    sensitivity: list | None = None,
) -> dict:
    """Categorise, aggregate and disclose a portfolio of ASC 820 measurements.

    Returns the 820-10-50-1 hierarchy table, the NAV reconciling line, the
    unobservable input table, the optional Level 3 rollforward, and the
    per-input sensitivity.
    """
    if not isinstance(positions, list) or not positions:
        raise EngineInputError("positions must be a non-empty list")
    if len(positions) > MAX_POSITIONS:
        raise EngineInputError(f"positions is capped at {MAX_POSITIONS} rows")

    classified = [
        classify_position(p if isinstance(p, dict) else {}, i) for i, p in enumerate(positions)
    ]

    by_level = {level: 0.0 for level in LEVELS}
    nav_total = 0.0
    for position in classified:
        if position["nav_practical_expedient"]:
            nav_total += position["fair_value"]
        else:
            by_level[position["level"]] += position["fair_value"]

    categorised = sum(by_level.values())
    total = categorised + nav_total
    level_3_total = by_level["level_3"]

    reclassified = [
        {"name": p["name"], "level": p["level"], "basis": p["basis"]}
        for p in classified
        if "does not govern" in p["basis"]
    ]
    unobservable_inputs = _unobservable_table(classified)

    return {
        "measurement_date": measurement_date,
        "positions": classified,
        "by_level": by_level,
        "categorized_fair_value": categorised,
        "nav_practical_expedient": {
            "fair_value": nav_total,
            "position_count": sum(1 for p in classified if p["nav_practical_expedient"]),
            # The reconciling-line disclosure exists precisely because these
            # are outside the table but inside the total.
            "note": (
                "Investments measured at net asset value per share as a practical expedient "
                "are not categorised in the fair value hierarchy (ASC 820-10-35-59); the "
                "amount is presented to reconcile the hierarchy table to the statement total."
            ),
        },
        "total_fair_value": total,
        "predominant_level": max(LEVELS, key=lambda lv: by_level[lv]) if categorised > 0 else None,
        "level_3_pct_of_total": (level_3_total / total) if total > 0 else 0.0,
        # The positions whose stated level the hierarchy rules overrode. This
        # is the list a reviewer reads first.
        "reclassified_positions": reclassified,
        "unobservable_inputs": unobservable_inputs,
        "level_3_rollforward": _rollforward(level_3_rollforward, level_3_total),
        "sensitivity": _sensitivity(level_3_total, sensitivity, unobservable_inputs),
    }
