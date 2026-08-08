"""One property over the engine, rather than one case at a time.

`test_boundary_inputs.py` pins named boundaries that the mutation run found.
This file asserts the general rule those cases are instances of:

    take a payload the engine accepts, push exactly one numeric field to a
    boundary, and the outcome is still a *considered* one — either a result
    whose every number is finite, or an EngineInputError naming the field.

Those are the two things `main.py` knows how to answer with. It maps
EngineInputError to a 422 carrying the message; everything else falls through
to the unhandled-exception middleware, which is a 500 with a request id and a
traceback in the log and nothing for the caller. So "the only exception that
escapes is EngineInputError" is precisely "the engine never 500s", stated
where it can be checked cheaply and without the rate limiter in the way.

The finiteness half is the quieter bug of the two. `json.dumps` writes a
non-finite float as bare `Infinity` or `NaN`, which is not valid JSON; a strict
client fails on it, and a lenient one — the valuation service — stores it as a
calculation and puts it in front of an analyst as a number.

Both are what a half-filled intake form produces: a zeroed-out share count, a
discount rate left at 0, a figure pasted with the wrong number of zeros. The
sweep is exhaustive over the fields rather than selective, so a new input on an
existing approach is covered the day it is added, without anyone remembering
to add a case for it.
"""

from __future__ import annotations

import copy
import math

import pytest

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.sensitivity import sensitivity
from app.engine.validate import validate_payload

COMMON = {"name": "Common", "kind": "common", "shares": 8_000_000.0}
PREF_A = {
    "name": "Series A",
    "kind": "preferred",
    "shares": 4_000_000.0,
    "preference": 2e7,
    "seniority": 1,
}
PREF_B = {
    "name": "Series B",
    "kind": "preferred",
    "shares": 2_000_000.0,
    "preference": 3e7,
    "seniority": 2,
    "participating": True,
    "participation_cap": 6e7,
}

BASE_CAP_TABLE = {
    "shares_outstanding_common": 8e6,
    "shares_outstanding_preferred": 4e6,
    "liquidation_preference": 2e7,
    "volatility": 0.6,
    "last_round_post_money": 5e7,
}

# One payload per allocation method and per approach — between them these reach
# the OPM, the waterfall, the DCF, the multiples and the NAV.
COMPUTE_PAYLOADS: dict[str, dict] = {
    "opm_single_breakpoint": {
        "params": {"weight_asset": 0, "weight_opm": 1, "weight_income": 0, "weight_market": 0, "dlom": 0.2},
        "inputs": {**BASE_CAP_TABLE, "options_outstanding": 1e6, "time_to_liquidity": 4.0, "risk_free_rate": 0.04},
    },
    "waterfall": {
        "params": {"weight_asset": 0, "weight_opm": 1, "weight_income": 0, "weight_market": 0, "dlom": 0.25},
        "inputs": {
            **BASE_CAP_TABLE,
            "last_round_post_money": 8e7,
            "shares_outstanding_preferred": 6e6,
            "liquidation_preference": 5e7,
            "share_classes": [COMMON, PREF_A, PREF_B],
            "options_outstanding": 1e6,
            "time_to_liquidity": 3.0,
            "risk_free_rate": 0.045,
        },
    },
    "income": {
        "params": {"weight_asset": 0, "weight_opm": 0.5, "weight_income": 0.5, "weight_market": 0, "dlom": 0.2},
        "inputs": {
            **BASE_CAP_TABLE,
            "income": {
                "free_cash_flows": [1e6, 1.4e6, 1.9e6, 2.4e6, 3e6],
                "discount_rate": 0.25,
                "terminal_growth": 0.03,
            },
        },
    },
    "market": {
        "params": {"weight_asset": 0, "weight_opm": 0.5, "weight_income": 0, "weight_market": 0.5, "dlom": 0.2},
        "inputs": {
            **BASE_CAP_TABLE,
            "market": {"multiples": [4.0, 6.0, 8.5], "metric": 1e7, "net_debt": 1e6},
        },
    },
    "asset": {
        "params": {"weight_asset": 1, "weight_opm": 0, "weight_income": 0, "weight_market": 0, "dlom": 0.15},
        "inputs": {
            **BASE_CAP_TABLE,
            "last_round_post_money": 5e6,
            "asset": {"total_assets": 5e6, "total_liabilities": 1e6},
        },
    },
}

# Zero and one are where the guards sit; a negative is the sign flip an
# unguarded subtraction produces; 1e15 and 1e300 are the magnitudes that
# overflow a product or a power before they overflow a double.
BOUNDARIES: list[float] = [0, -1, 1e-9, 1.0, 1e15, 1e300]


def _numeric_paths(obj, prefix=()):
    """Every path to a number in the payload. Booleans are not numbers here."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from _numeric_paths(v, prefix + (k,))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _numeric_paths(v, prefix + (i,))
    elif isinstance(obj, bool):
        return
    elif isinstance(obj, (int, float)):
        yield prefix


def _set_path(obj, path, value):
    cur = obj
    for k in path[:-1]:
        cur = cur[k]
    cur[path[-1]] = value


def _cases():
    for name, payload in COMPUTE_PAYLOADS.items():
        for path in _numeric_paths(payload):
            for value in BOUNDARIES:
                yield pytest.param(name, path, value, id=f"{name}-{'.'.join(map(str, path))}={value:g}")


def _non_finite(obj, prefix=()) -> str | None:
    """The path of the first number that is not finite, or None."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            found = _non_finite(v, prefix + (str(k),))
            if found:
                return found
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            found = _non_finite(v, prefix + (str(i),))
            if found:
                return found
    elif isinstance(obj, float) and not math.isfinite(obj):
        return f"{'.'.join(prefix)}={obj}"
    return None


@pytest.mark.parametrize(("case", "path", "value"), list(_cases()))
def test_one_field_at_a_boundary_computes_or_explains_itself(
    case: str, path: tuple, value: float
) -> None:
    payload = copy.deepcopy(COMPUTE_PAYLOADS[case])
    _set_path(payload, list(path), value)
    where = f"{case} {'.'.join(map(str, path))}={value!r}"

    # Pre-flight never raises at all: its whole job is to collect problems and
    # return them, so an exception here is a hole in the collector.
    validate_payload(payload["params"], payload["inputs"])

    for label, run in (
        ("compute", lambda: compute(payload["params"], payload["inputs"])),
        ("sensitivity", lambda: sensitivity(payload["params"], payload["inputs"])),
    ):
        try:
            result = run()
        except EngineInputError:
            continue  # a 422 naming the field — the considered refusal
        except Exception as exc:  # noqa: BLE001 — the point is what else escapes
            pytest.fail(f"{label} {where} raised {type(exc).__name__}: {exc}")
        bad = _non_finite(result)
        assert bad is None, f"{label} {where} -> non-finite {bad}"


def test_the_unmutated_payloads_all_compute() -> None:
    """Guards the guard.

    Every case above passes trivially if the base payload stopped being one the
    engine accepts — the mutation would raise EngineInputError for the original
    reason and the sweep would assert nothing. This is what notices.
    """
    for name, payload in COMPUTE_PAYLOADS.items():
        result = compute(payload["params"], payload["inputs"])
        assert result["results"]["fmv_per_share"] > 0, name
        assert _non_finite(result) is None, name
