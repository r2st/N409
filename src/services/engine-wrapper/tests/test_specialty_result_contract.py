"""The keys each specialty engine returns, published for the report exhibits.

`domain/specialtyExhibits.ts` turns one of these result objects into the
schedules a deliverable prints, field by field, by hand. A key the exhibit
never reads is not a type error, not a crash and not a log line — it is a
figure the engine computed, stored on the calculation, and showed nobody.

That is the mirror image of the hazard `test_specialty_param_contract.py`
guards. A parameter nobody sends becomes a default printed as a conclusion; a
result key nobody reads becomes a conclusion that never reaches the page. Both
have now happened. R134 found the IFRS 2 `remeasurement` block — the liability
a cash-settled award creates, computed and dropped — and found it by hand,
while writing a census that walks parameters *into* the engine and so could
never have seen it.

So the contract is generated here, where the engines are, and checked in as
JSON. `test/unit/specialtyResultCoverage.test.ts` is what reads it: every key
must be read by the exhibit for its kind, or carry a written reason not to be.

Regenerate deliberately, never to make a red test green::

    .venv/bin/python -m pytest tests/test_specialty_result_contract.py --regenerate
"""

from __future__ import annotations

import ast
import inspect
import json
from pathlib import Path

import pytest

from app.engine.emi_csop import csop_grant_check, emi_qualification, share_values
from app.engine.esop import esop_share_value, repurchase_obligation
from app.engine.fair_value_820 import fair_value_measurement
from app.engine.gift_estate import gift_estate_valuation
from app.engine.ifrs2 import ifrs2_valuation
from app.engine.impairment import _TESTS
from app.engine.intangibles import _METHODS, purchase_price_allocation
from app.engine.qsbs import qsbs_eligibility
from app.engine.smb import smb_valuation

CONTRACT = Path(__file__).resolve().parents[1] / "contract" / "specialty-results.json"


def _result_keys(fn) -> list[str]:
    """The keys of the dict literal the function returns.

    Read from the source rather than from a call, so the contract needs no
    fixture per engine and cannot drift with one. The cost is that only a
    literal `return {...}` can be read, which is how all nine of these are
    written — and the assertion below is what keeps it that way. An engine that
    starts building its result incrementally has to say so here rather than
    quietly reporting fewer keys than it returns.
    """
    tree = ast.parse(inspect.getsource(fn))
    body = tree.body[0]
    assert isinstance(body, ast.FunctionDef), f"{fn.__name__} is not a plain function"
    returns = [n for n in ast.walk(body) if isinstance(n, ast.Return) and n.value is not None]
    literals = [n for n in returns if isinstance(n.value, ast.Dict)]
    assert literals, (
        f"{fn.__name__} does not return a dict literal, so its result keys cannot be read "
        "from the source. Give this generator an explicit key list for it."
    )
    keys: set[str] = set()
    for node in literals:
        for k in node.value.keys:
            assert isinstance(k, ast.Constant) and isinstance(k.value, str), (
                f"{fn.__name__} returns a dict with a computed key; the census cannot name it"
            )
            keys.add(k.value)
    return sorted(keys)


def _dispatch(table: dict, prefix: str) -> dict[str, list[str]]:
    return {f"{prefix}={name}": _result_keys(fn) for name, fn in sorted(table.items())}


def build_contract() -> dict:
    """Endpoint path → result variant → the keys that variant returns.

    A variant is one shape of result object. Most endpoints have exactly one,
    `result`. The three dispatchers have one per method, test or scheme, and two
    endpoints compose a nested block that the exhibit reads separately — the
    ESOP repurchase projection and the EMI/CSOP qualification — which get their
    own variant under the key they are nested at.
    """
    return {
        "/engine/v1/qsbs": {"result": _result_keys(qsbs_eligibility)},
        "/engine/v1/ppa": {"result": _result_keys(purchase_price_allocation)},
        "/engine/v1/esop": {
            # The route attaches the projection under this key when the caller
            # asked for one, so it is part of the result shape even though no
            # `return` in `esop_share_value` mentions it.
            "result": sorted({*_result_keys(esop_share_value), "repurchase_obligation"}),
            "repurchase_obligation": _result_keys(repurchase_obligation),
        },
        "/engine/v1/smb": {"result": _result_keys(smb_valuation)},
        "/engine/v1/fair-value-820": {"result": _result_keys(fair_value_measurement)},
        "/engine/v1/gift-estate": {"result": _result_keys(gift_estate_valuation)},
        "/engine/v1/ifrs2": {"result": _result_keys(ifrs2_valuation)},
        "/engine/v1/intangible": _dispatch(_METHODS, "method"),
        "/engine/v1/impairment": _dispatch(_TESTS, "test"),
        # `emi_csop_valuation` returns `{**share_values(...), "qualification": ...}`.
        "/engine/v1/emi-csop": {
            "result": sorted({*_result_keys(share_values), "qualification"}),
            "qualification=emi": _result_keys(emi_qualification),
            "qualification=csop": _result_keys(csop_grant_check),
        },
    }


def test_the_checked_in_contract_matches_the_live_returns(request):
    built = build_contract()
    if request.config.getoption("--regenerate", default=False):
        CONTRACT.write_text(json.dumps(built, indent=2, sort_keys=True) + "\n")
    stored = json.loads(CONTRACT.read_text())
    assert stored == built, (
        "contract/specialty-results.json is stale. Regenerate it with "
        "`pytest tests/test_specialty_result_contract.py --regenerate`, then run the "
        "TypeScript census in services/valuation — a key added here is a figure "
        "somebody now has to decide whether a reader sees."
    )


def test_every_dispatcher_variant_is_reachable_by_its_own_key():
    """A variant nobody can produce is a contract entry the census can never
    satisfy, and the way it would be spelled wrong is by drifting from the
    dispatch table's own keys."""
    contract = build_contract()
    assert sorted(contract["/engine/v1/intangible"]) == sorted(
        f"method={name}" for name in _METHODS
    )
    assert sorted(contract["/engine/v1/impairment"]) == sorted(f"test={name}" for name in _TESTS)


@pytest.mark.parametrize("path,variants", sorted(build_contract().items()))
def test_every_variant_returns_something(path, variants):
    for variant, keys in variants.items():
        assert keys, f"{path} {variant} returns nothing — the dispatch was not followed"


def test_the_nested_blocks_are_named_by_the_key_they_arrive_under():
    """The two composed endpoints attach their second result under a fixed key.
    If that key is renamed in the route and not here, the census would go on
    checking a block the exhibit no longer receives."""
    contract = build_contract()
    assert "repurchase_obligation" in contract["/engine/v1/esop"]["result"]
    assert "qualification" in contract["/engine/v1/emi-csop"]["result"]
