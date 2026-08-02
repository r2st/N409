"""Engine-level sensitivity analysis over a completed valuation."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.sensitivity import PARAMETERS, sensitivity
from app.main import app

client = TestClient(app)

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.5,
    "weight_income": 0.25,
    "weight_market": 0.25,
    "dloc": 0.0,
    "dlom": 0.2,
    "exit_timeline": "2029-06-30",
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 8_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.04,
    "cash": 1_000_000,
    "debt": 200_000,
    "last_round_post_money": 20_000_000,
    "income": {"free_cash_flows": [500_000, 1_000_000, 2_000_000], "discount_rate": 0.3, "terminal_growth": 0.03},
    "market": {"metric": 4_000_000, "multiples": [4.0, 6.0]},
}


def test_base_and_selected_parameters():
    out = sensitivity(PARAMS, INPUTS)
    assert out["base"]["fmv_per_share"] > 0
    # All five levers are drivable in this payload.
    names = {t["parameter"] for t in out["one_way"]}
    assert names == set(PARAMETERS)


def test_one_way_shape_and_default_span():
    out = sensitivity(PARAMS, INPUTS, parameters=["volatility"], steps=5)
    table = out["one_way"][0]
    assert table["parameter"] == "volatility"
    assert table["base_value"] == pytest.approx(0.6)
    assert len(table["points"]) == 5
    # ±20% around 0.6 → 0.48 … 0.72; middle point is the base.
    assert table["points"][0]["value"] == pytest.approx(0.48)
    assert table["points"][-1]["value"] == pytest.approx(0.72)
    assert table["points"][2]["value"] == pytest.approx(0.6)
    assert table["points"][2]["delta_from_base"] == pytest.approx(0.0, abs=1e-6)


def test_fmv_monotonic_in_volatility():
    # Higher OPM volatility lifts the common (call-option) FMV.
    table = sensitivity(PARAMS, INPUTS, parameters=["volatility"])["one_way"][0]
    fmvs = [p["fmv_per_share"] for p in table["points"]]
    assert fmvs == sorted(fmvs)


def test_two_way_matrix():
    out = sensitivity(
        PARAMS, INPUTS, parameters=[], two_way=[["discount_rate", "exit_multiple"]], steps=3
    )
    assert out["one_way"] == []
    tw = out["two_way"][0]
    assert tw["row_parameter"] == "discount_rate"
    assert tw["col_parameter"] == "exit_multiple"
    assert len(tw["row_values"]) == 3
    assert len(tw["rows"]) == 3
    assert len(tw["rows"][0]) == 3
    # Center cell is the base case → zero delta.
    assert tw["rows"][1][1]["delta_from_base"] == pytest.approx(0.0, abs=1e-6)


def test_exit_multiple_scales_market_multiples():
    table = sensitivity(PARAMS, INPUTS, parameters=["exit_multiple"], steps=5)["one_way"][0]
    # Base multiple is the median of [4, 6] = 5.
    assert table["base_value"] == pytest.approx(5.0)
    fmvs = [p["fmv_per_share"] for p in table["points"]]
    assert fmvs == sorted(fmvs)  # a higher multiple lifts the market approach


def test_bad_variation_degrades_to_null():
    # A negative discount-rate span can drive discount_rate below terminal
    # growth (income_dcf rejects it). That cell is null with an error, but the
    # whole request still succeeds.
    out = sensitivity(PARAMS, INPUTS, parameters=["discount_rate"], span=0.95, steps=5)
    points = out["one_way"][0]["points"]
    assert any(p["fmv_per_share"] is None and "error" in p for p in points)
    assert any(p["fmv_per_share"] is not None for p in points)


def test_skips_undrivable_parameters():
    # No income section → discount_rate / growth_rate aren't drivable.
    inputs = {k: v for k, v in INPUTS.items() if k != "income"}
    params = {**PARAMS, "weight_income": 0.0, "weight_opm": 0.75}
    out = sensitivity(params, inputs, parameters=["volatility", "discount_rate"])
    names = {t["parameter"] for t in out["one_way"]}
    assert names == {"volatility"}
    assert out["skipped"] == ["discount_rate"]


def test_skips_undrivable_two_way_pair():
    inputs = {k: v for k, v in INPUTS.items() if k != "income"}
    params = {**PARAMS, "weight_income": 0.0, "weight_opm": 0.75}
    out = sensitivity(
        params, inputs, parameters=[], two_way=[["volatility", "discount_rate"]]
    )
    assert out["two_way"] == []
    assert out["skipped_two_way"] == [["volatility", "discount_rate"]]


def test_unknown_parameter_rejected():
    with pytest.raises(EngineInputError, match="unknown sensitivity parameters"):
        sensitivity(PARAMS, INPUTS, parameters=["nope"])


def test_broken_base_valuation_rejected():
    with pytest.raises(EngineInputError, match="base valuation"):
        sensitivity({"weight_opm": 0.5}, {})  # weights don't sum to 1


def test_api_sensitivity():
    resp = client.post(
        "/engine/v1/sensitivity",
        json={"params": PARAMS, "inputs": INPUTS, "parameters": ["volatility", "time_to_exit"], "two_way": [["volatility", "time_to_exit"]]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["one_way"]) == 2
    assert len(body["two_way"]) == 1


def test_api_sensitivity_bad_request_is_422():
    resp = client.post("/engine/v1/sensitivity", json={"params": {"weight_opm": 0.5}, "inputs": {}})
    assert resp.status_code == 422


# ── Payload isolation ────────────────────────────────────────────────────────
# `_variant` hands each cell a *shallow* copy of the inputs, which is only safe
# while nothing downstream writes through the shared references. These tests
# hold that to account: if `_apply` or `compute` ever starts mutating a nested
# structure in place, the per-cell copies stop isolating and every later cell
# in the run inherits the earlier ones' levers.

import copy as _copy

from app.engine.sensitivity import _apply, _variant

# A payload whose nested structures are worth protecting: sub-dicts, lists, and
# a list-of-dicts hanging off the top level.
NESTED_INPUTS = {
    **INPUTS,
    "share_classes": [
        {"name": "Common", "kind": "common", "shares": 8_000_000},
        {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 5_000_000},
    ],
    "income": {"free_cash_flows": [500_000, 1_000_000, 2_000_000], "discount_rate": 0.3, "terminal_growth": 0.03},
    "market": {"metric": 4_000_000, "multiples": [4.0, 6.0]},
}


def test_sensitivity_does_not_mutate_the_callers_payload():
    params, inputs = _copy.deepcopy(PARAMS), _copy.deepcopy(NESTED_INPUTS)
    before = _copy.deepcopy(inputs)
    params_before = _copy.deepcopy(params)

    sensitivity(
        params,
        inputs,
        two_way=[["volatility", "discount_rate"], ["exit_multiple", "growth_rate"]],
        steps=5,
    )

    assert inputs == before, "sensitivity wrote through to the caller's inputs"
    assert params == params_before, "sensitivity wrote through to the caller's params"


@pytest.mark.parametrize("name,value", [
    ("volatility", 0.75),
    ("discount_rate", 0.35),
    ("growth_rate", 0.05),
    ("time_to_exit", 4.0),
    ("exit_multiple", 7.0),
])
def test_apply_isolates_every_lever_from_the_original(name, value):
    original = _copy.deepcopy(NESTED_INPUTS)
    variant = _variant(original)
    _apply(name, value, PARAMS, variant)

    assert original == NESTED_INPUTS, f"applying {name} leaked into the source payload"
    assert variant != original, f"applying {name} did not change the variant"


@pytest.mark.parametrize("name,value", [
    ("volatility", 0.75),
    ("discount_rate", 0.35),
    ("growth_rate", 0.05),
    ("time_to_exit", 4.0),
    ("exit_multiple", 7.0),
])
def test_shallow_variant_matches_a_deep_copy(name, value):
    """The optimisation is only worth having if it is a no-op on the result."""
    shallow = _variant(NESTED_INPUTS)
    deep = _copy.deepcopy(NESTED_INPUTS)
    _apply(name, value, PARAMS, shallow)
    _apply(name, value, PARAMS, deep)
    assert shallow == deep


def test_cells_do_not_inherit_each_others_levers():
    """A two-way table's cells must be independent, not cumulative."""
    out = sensitivity(PARAMS, NESTED_INPUTS, two_way=[["volatility", "discount_rate"]], steps=3)
    table = out["two_way"][0]
    # The centre cell holds both levers at their base, so it must reproduce the
    # base FMV exactly. It would not if the preceding cells had leaked into it.
    centre = table["rows"][1][1]
    assert centre["fmv_per_share"] == pytest.approx(out["base"]["fmv_per_share"])
    assert centre["delta_from_base"] == pytest.approx(0.0, abs=1e-9)


def test_repeated_runs_are_identical():
    inputs = _copy.deepcopy(NESTED_INPUTS)
    first = sensitivity(PARAMS, inputs, two_way=[["volatility", "growth_rate"]], steps=5)
    second = sensitivity(PARAMS, inputs, two_way=[["volatility", "growth_rate"]], steps=5)
    assert first == second


# ── Axis direction ───────────────────────────────────────────────────────────
# `_steps` derives its endpoints as base·(1−span) and base·(1+span). For a
# negative base the first of those is the *larger*, so taken in the written
# order the axis ran downwards. Terminal growth is the one lever where a
# negative base is ordinary — a business in runoff is priced on a declining
# terminal growth — while every other lever is positive by construction, so
# that one table read backwards against the rest of the run. The values were
# right; their order was not, and both the one-way table and the two-way
# heatmap are rendered in exactly the order the engine emits them.

from app.engine.sensitivity import _steps  # noqa: E402

DECLINING = {
    **INPUTS,
    "income": {
        "free_cash_flows": [500_000, 1_000_000, 2_000_000],
        "discount_rate": 0.3,
        "terminal_growth": -0.02,
    },
}


@pytest.mark.parametrize("base", [0.6, 5.0, 0.03, 0.0, -0.02, -0.30, -7.0])
def test_steps_always_ascend(base):
    values = _steps(base, 0.20, 5)
    assert values == sorted(values), f"axis for base={base} runs backwards"


@pytest.mark.parametrize("base", [0.6, 0.03, -0.02, -0.30])
def test_steps_stay_centred_on_the_base(base):
    """Reordering must not move the base off the middle point."""
    values = _steps(base, 0.20, 5)
    assert values[2] == pytest.approx(base)
    # …and the span is still ±20% of the base, in magnitude.
    assert min(values) == pytest.approx(base - abs(base) * 0.20)
    assert max(values) == pytest.approx(base + abs(base) * 0.20)


def test_one_way_growth_axis_ascends_for_a_declining_business():
    table = sensitivity(PARAMS, DECLINING, parameters=["growth_rate"], steps=5)["one_way"][0]
    assert table["base_value"] == pytest.approx(-0.02)
    values = [p["value"] for p in table["points"]]
    assert values == sorted(values)
    assert values[0] == pytest.approx(-0.024)
    assert values[-1] == pytest.approx(-0.016)
    # The base still sits in the middle, so its delta is the zero point.
    assert table["points"][2]["delta_from_base"] == pytest.approx(0.0, abs=1e-9)


def test_fmv_rises_with_growth_even_when_growth_is_negative():
    """The monotonicity the positive-base tables are held to, at a negative base.

    This is what the ordering bug actually broke: less-negative terminal growth
    is worth more, so a correctly ordered axis has FMV ascending alongside it.
    Before the fix the axis descended and this ran the other way.
    """
    table = sensitivity(PARAMS, DECLINING, parameters=["growth_rate"], steps=5)["one_way"][0]
    fmvs = [p["fmv_per_share"] for p in table["points"]]
    assert all(f is not None for f in fmvs)
    assert fmvs == sorted(fmvs)


def test_two_way_growth_axis_is_not_mirrored():
    """`row_values` label the rows, and the rows must travel with the labels."""
    tw = sensitivity(
        PARAMS, DECLINING, parameters=[], two_way=[["growth_rate", "volatility"]], steps=5
    )["two_way"][0]

    assert tw["row_values"] == sorted(tw["row_values"])
    assert tw["col_values"] == sorted(tw["col_values"])
    # Centre cell is both levers at base → the zero point of the heatmap.
    assert tw["rows"][2][2]["delta_from_base"] == pytest.approx(0.0, abs=1e-9)
    # Down any column, FMV rises with growth; across any row, with volatility.
    for c in range(5):
        column = [tw["rows"][r][c]["fmv_per_share"] for r in range(5)]
        assert column == sorted(column), f"column {c} is mirrored"
    for r in range(5):
        row = [cell["fmv_per_share"] for cell in tw["rows"][r]]
        assert row == sorted(row), f"row {r} is mirrored"


def test_every_drivable_lever_emits_an_ascending_axis():
    """Stated as the property, so a new lever inherits it."""
    out = sensitivity(PARAMS, DECLINING, steps=5)
    assert out["one_way"], "no levers were driven — this test would be vacuous"
    for table in out["one_way"]:
        values = [p["value"] for p in table["points"]]
        assert values == sorted(values), f"{table['parameter']} axis runs backwards"
