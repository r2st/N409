"""The parameters each specialty endpoint accepts, published for the assembler.

`domain/specialty.ts` turns a questionnaire's answers into one of these
endpoints' request bodies, field by field, by hand. The engine takes keyword
arguments with defaults, so a parameter the assembler never sends is not a type
error, not a 422 and not a log line — it is a run that used the engine's default
and a deliverable that prints the default as a conclusion. Two of those were
found by hand this round (`expected_forfeiture_rate`) and last (the §2503(b)
exclusion), and both times the search was a person reading two files in two
languages side by side.

`test/unit/specialtyEngineParams.test.ts` does that comparison automatically
now, and this is the half it cannot do for itself: what the engine accepts is a
Python signature, and three of these endpoints do not even have one — they take
``(method, params)`` and hand the params to a different function per method, so
the accepted names are in the dispatch table, not in the route's signature.

So the contract is generated here, where `inspect.signature` can follow the
dispatch, and checked in as JSON. This test is what keeps the checked-in copy
true: add a parameter to any of these functions and it fails until the file is
regenerated, at which point the TypeScript census sees the new parameter and
asks who is meant to answer for it.

Regenerate deliberately, never to make a red test green::

    .venv/bin/python -m pytest tests/test_specialty_param_contract.py --regenerate
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

from app.engine.comparables import comparable_analysis
from app.engine.emi_csop import csop_grant_check, emi_qualification, share_values
from app.engine.esop import esop_share_value, repurchase_obligation
from app.engine.fair_value_820 import fair_value_measurement
from app.engine.gift_estate import gift_estate_valuation
from app.engine.ifrs2 import ifrs2_valuation
from app.engine.impairment import _TESTS
from app.engine.intangibles import _METHODS, purchase_price_allocation
from app.engine.qsbs import qsbs_eligibility
from app.engine.smb import smb_valuation

CONTRACT = Path(__file__).resolve().parents[1] / "contract" / "specialty-params.json"


def _kwargs(fn) -> list[str]:
    """The keyword names a caller may pass, in signature order."""
    return [
        p.name
        for p in inspect.signature(fn).parameters.values()
        if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)
    ]


def _dispatch(table: dict, prefix: str) -> dict[str, list[str]]:
    return {f"{prefix}={name}": _kwargs(fn) for name, fn in sorted(table.items())}


def build_contract() -> dict:
    """Endpoint path → call variant → accepted keyword names.

    The variant key is what the request body carries alongside the params and
    selects the function they are unpacked into: `method` for an intangible,
    `test` for an impairment, `scheme` for EMI/CSOP. Endpoints whose body is a
    single free-form `inputs` object have the one variant, `inputs`.
    """
    emi = {
        # `emi_csop_valuation` splits the params: the four value keys go to
        # `share_values`, everything else to the scheme's qualification check,
        # which also receives the concluded UMV rather than a caller's.
        f"scheme={name}": sorted(
            set(_kwargs(share_values)) | (set(_kwargs(fn)) - {"umv_per_share"})
        )
        for name, fn in (("emi", emi_qualification), ("csop", csop_grant_check))
    }
    return {
        "/engine/v1/qsbs": {"inputs": _kwargs(qsbs_eligibility)},
        "/engine/v1/ppa": {"inputs": _kwargs(purchase_price_allocation)},
        "/engine/v1/esop": {
            "inputs": _kwargs(esop_share_value),
            # The route sets `fmv_per_share` from the run it just concluded, so
            # a caller that omits it is right rather than incomplete.
            "repurchase": [k for k in _kwargs(repurchase_obligation) if k != "fmv_per_share"],
        },
        "/engine/v1/smb": {"inputs": _kwargs(smb_valuation)},
        "/engine/v1/comparables": {"inputs": _kwargs(comparable_analysis)},
        "/engine/v1/fair-value-820": {"inputs": _kwargs(fair_value_measurement)},
        "/engine/v1/gift-estate": {"inputs": _kwargs(gift_estate_valuation)},
        "/engine/v1/ifrs2": {"inputs": _kwargs(ifrs2_valuation)},
        "/engine/v1/intangible": _dispatch(_METHODS, "method"),
        "/engine/v1/impairment": _dispatch(_TESTS, "test"),
        "/engine/v1/emi-csop": emi,
    }


def test_the_checked_in_contract_matches_the_live_signatures(request):
    built = build_contract()
    if request.config.getoption("--regenerate", default=False):
        CONTRACT.write_text(json.dumps(built, indent=2, sort_keys=True) + "\n")
    stored = json.loads(CONTRACT.read_text())
    assert stored == built, (
        "contract/specialty-params.json is stale. Regenerate it with "
        "`pytest tests/test_specialty_param_contract.py --regenerate`, then run the "
        "TypeScript census in services/valuation — a parameter added here is a "
        "question somebody now has to be asked."
    )


def test_every_dispatcher_variant_is_reachable_by_its_own_key():
    """A variant nobody can select is a contract entry the census can never
    satisfy, and the way it would be spelled wrong is by drifting from the
    dispatch table's own keys."""
    contract = build_contract()
    assert sorted(contract["/engine/v1/intangible"]) == sorted(
        f"method={name}" for name in _METHODS
    )
    assert sorted(contract["/engine/v1/impairment"]) == sorted(f"test={name}" for name in _TESTS)
    assert sorted(contract["/engine/v1/emi-csop"]) == ["scheme=csop", "scheme=emi"]


def test_no_variant_leaks_a_dispatcher_local_as_a_parameter():
    """The trap that stopped this being written by parsing: `emi_csop_valuation`
    and its two siblings take `(method, params)`, so a naive read of the entry
    point's signature reports `params`, `fn` and `rest` — the dispatcher's own
    names — as things a caller may send."""
    leaked = {"params", "method", "test", "scheme", "fn", "rest", "name", "kind"}
    for path, variants in build_contract().items():
        for variant, names in variants.items():
            assert not (leaked & set(names)), f"{path} {variant} leaks {leaked & set(names)}"


@pytest.mark.parametrize("path,variants", sorted(build_contract().items()))
def test_every_endpoint_accepts_at_least_one_parameter(path, variants):
    for variant, names in variants.items():
        assert names, f"{path} {variant} accepts nothing — the dispatch was not followed"
