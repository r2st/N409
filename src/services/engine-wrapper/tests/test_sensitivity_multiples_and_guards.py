"""The exit-multiple lever's base, and the inputs `sensitivity` refuses.

The first half holds `_market_multiples` to the set the market approach
actually prices — `approaches.market_multiples` drops every multiple that is
not `> 0` before taking its median, and reading the raw list here put this
lever's axis on a different footing from the valuation it is a sensitivity of.

The second half covers the guards. `/engine/v1/sensitivity` is the one engine
route with no preflight validation in front of it, so these messages are the
whole of what a caller gets back.
"""

import copy

import pytest

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.sensitivity import (
    _apply,
    _base_value,
    _market_multiples,
    _steps,
    _variant,
    sensitivity,
)

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
    "income": {
        "free_cash_flows": [500_000, 1_000_000, 2_000_000],
        "discount_rate": 0.3,
        "terminal_growth": 0.03,
    },
    "market": {"metric": 4_000_000, "multiples": [4.0, 6.0]},
}


def _with_multiples(multiples: list[float]) -> dict:
    inputs = copy.deepcopy(INPUTS)
    inputs["market"]["multiples"] = multiples
    return inputs


def _priced_multiple(params: dict, inputs: dict) -> float:
    """The multiple the market approach actually struck, for these inputs."""
    return compute(params, inputs)["results"]["approaches"]["market"]["selected_multiple"]


# ── the exit-multiple lever's base ────────────────────────────────────────────
# A negative multiple is ordinary rather than a typo: `auto_comparables` reads
# `ev_ebitda` off each comparable ticker, and a peer with negative EBITDA
# contributes a negative one.


@pytest.mark.parametrize(
    "multiples",
    [
        [4.0, 6.0],  # all positive — the filter must not disturb this
        [-8.0, 5.0, 7.0],  # one loss-making peer
        [0.0, 4.0, 6.0],  # a zero, which the engine also drops
        [-6.0, -4.0, 5.0],  # the raw median is negative
    ],
)
def test_base_value_is_the_multiple_the_engine_priced(multiples):
    inputs = _with_multiples(multiples)
    table = sensitivity(PARAMS, inputs, parameters=["exit_multiple"], steps=3)["one_way"][0]
    assert table["base_value"] == pytest.approx(_priced_multiple(PARAMS, inputs))


@pytest.mark.parametrize(
    "multiples", [[4.0, 6.0], [-8.0, 5.0, 7.0], [0.0, 4.0, 6.0], [-6.0, -4.0, 5.0]]
)
def test_every_axis_label_is_the_multiple_its_cell_was_computed_at(multiples):
    # `value` is rendered straight into the axis, so a cell captioned 6.0x has
    # to be the FMV of a 6.0x exit. On [-8, 5, 7] the labels read 4.0/5.0/6.0
    # for cells the engine had computed at 4.8/6.0/7.2 — the point labelled
    # 6.0x carried the FMV of a 7.2x exit.
    inputs = _with_multiples(multiples)
    table = sensitivity(PARAMS, inputs, parameters=["exit_multiple"], steps=3)["one_way"][0]
    for point in table["points"]:
        variant = _variant(inputs)
        _apply("exit_multiple", point["value"], PARAMS, variant)
        assert _priced_multiple(PARAMS, variant) == pytest.approx(point["value"])


def test_a_majority_negative_comparable_set_still_produces_a_table():
    # The raw median of [-6, -4, 5] is -4, which failed `base and base > 0` in
    # `_apply` and collapsed the comparables to a single negative multiple.
    # `market_multiples` then found nothing positive in any variant, so every
    # cell came back null for a payload that computes perfectly well.
    inputs = _with_multiples([-6.0, -4.0, 5.0])
    table = sensitivity(PARAMS, inputs, parameters=["exit_multiple"], steps=3)["one_way"][0]
    fmvs = [p["fmv_per_share"] for p in table["points"]]
    assert all(f is not None for f in fmvs)
    assert all("error" not in p for p in table["points"])
    # A richer exit multiple is worth more, so the axis carries a real slope.
    assert fmvs == sorted(fmvs) and fmvs[0] < fmvs[-1]


def test_the_lever_keeps_the_spread_between_the_comparables():
    # Scaling the whole set rather than replacing it is what preserves the
    # dispersion the comparables carry; only the median moves to the axis point.
    inputs = _with_multiples([-8.0, 5.0, 7.0])
    variant = _variant(inputs)
    _apply("exit_multiple", 12.0, PARAMS, variant)
    # 6.0x base doubled to 12.0x: the surviving pair scales with it.
    assert variant["market"]["multiples"] == pytest.approx([10.0, 14.0])
    assert inputs["market"]["multiples"] == [-8.0, 5.0, 7.0]  # caller's payload untouched


def test_a_lever_with_no_positive_multiple_is_skipped_not_tabulated():
    # Nothing positive left means the market approach cannot be driven, so
    # there is no honest base to put on the axis.
    params = dict(PARAMS, weight_market=0.0, weight_income=0.5)
    inputs = _with_multiples([-6.0, -4.0])
    out = sensitivity(params, inputs, parameters=["exit_multiple"], steps=3)
    assert out["one_way"] == []
    assert out["skipped"] == ["exit_multiple"]


def test_a_single_multiple_key_is_read_and_filtered_the_same_way():
    inputs = copy.deepcopy(INPUTS)
    inputs["market"] = {"metric": 4_000_000, "multiple": 5.0}
    assert _market_multiples(inputs) == [5.0]
    inputs["market"]["multiple"] = -5.0
    assert _market_multiples(inputs) is None


def test_a_market_section_driving_no_multiple_at_all():
    assert _market_multiples({"market": {"metric": 4_000_000}}) is None
    assert _market_multiples({"market": "not a dict"}) is None


# ── guards ────────────────────────────────────────────────────────────────────


def test_an_unparseable_exit_timeline_makes_the_lever_undrivable():
    # `_time_to_exit` raising is answered with None — an undrivable lever — and
    # not by failing the whole sensitivity run.
    params = dict(PARAMS, exit_timeline="whenever")
    assert _base_value("time_to_exit", params, INPUTS) is None


def test_unknown_lever_names_itself():
    with pytest.raises(EngineInputError, match="unknown sensitivity parameter 'nope'"):
        _base_value("nope", PARAMS, INPUTS)


def test_apply_seeds_a_multiple_where_the_payload_drives_none():
    inputs = dict(INPUTS, market={"metric": 4_000_000})
    _apply("exit_multiple", 9.0, PARAMS, inputs)
    assert inputs["market"]["multiples"] == [9.0]


def test_steps_of_one_is_the_base_alone():
    assert _steps(1.0, 0.2, 1) == [1.0]


def test_steps_below_one_has_no_axis_to_draw():
    with pytest.raises(EngineInputError, match="steps must be >= 1"):
        _steps(1.0, 0.2, 0)


def test_span_must_be_a_real_range():
    with pytest.raises(EngineInputError, match=r"span must be in \(0, 2\]"):
        sensitivity(PARAMS, INPUTS, span=0)


def test_steps_must_leave_two_points_to_join():
    with pytest.raises(EngineInputError, match="steps must be between 2 and 21"):
        sensitivity(PARAMS, INPUTS, steps=1)


def test_a_two_way_entry_that_is_not_a_pair():
    with pytest.raises(EngineInputError, match=r"must be a \[row, col\] pair"):
        sensitivity(PARAMS, INPUTS, parameters=[], two_way=[["volatility"]])


def test_a_two_way_pair_naming_an_unknown_lever():
    with pytest.raises(EngineInputError, match="unknown two-way parameters"):
        sensitivity(PARAMS, INPUTS, parameters=[], two_way=[["volatility", "nope"]])


def test_a_two_way_pair_against_itself_is_a_one_way_table():
    with pytest.raises(EngineInputError, match="two-way parameters must differ"):
        sensitivity(PARAMS, INPUTS, parameters=[], two_way=[["volatility", "volatility"]])
