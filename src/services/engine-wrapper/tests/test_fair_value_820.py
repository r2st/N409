"""ASC 820 fair value measurement — hierarchy, NAV expedient, disclosure tables."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.fair_value_820 import classify_position, fair_value_measurement
from app.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def position(**over) -> dict:
    return {"name": "Position", "fair_value": 1_000_000.0, "level": "level_1", **over}


# ── the hierarchy ────────────────────────────────────────────────────────────


def test_measurement_takes_the_lowest_significant_input_not_the_best():
    """ASC 820-10-35-37A. The finding this module exists to prevent: a mark
    struck off a Level 2 quote with a significant Level 3 adjustment is a
    Level 3 measurement, however good the quote was."""
    out = classify_position(
        position(
            level="level_2",
            inputs=[
                {"name": "broker quote", "level": "level_2"},
                {"name": "illiquidity adjustment", "level": "level_3", "value": 0.25},
            ],
        ),
        0,
    )
    assert out["level"] == "level_3"
    assert "does not govern" in out["basis"]


def test_an_insignificant_level_3_input_does_not_drag_the_level_down():
    out = classify_position(
        position(
            level="level_2",
            inputs=[
                {"name": "broker quote", "level": "level_2"},
                {"name": "rounding", "level": "level_3", "value": 0.001, "significant": False},
            ],
        ),
        0,
    )
    assert out["level"] == "level_2"


def test_significance_defaults_to_true():
    # The opposite default quietly discloses Level 3 measurements as Level 2.
    out = classify_position(
        position(level="level_1", inputs=[{"name": "adj", "level": "level_3", "value": 0.1}]), 0
    )
    assert out["level"] == "level_3"


def test_a_position_naming_no_inputs_keeps_its_stated_level():
    # A listed equity should not need ceremony.
    assert classify_position(position(level="level_1"), 0)["level"] == "level_1"


@pytest.mark.parametrize("stated,expected", [("1", "level_1"), ("Level 2", "level_2"), ("3", "level_3")])
def test_level_spellings_are_accepted(stated, expected):
    assert classify_position(position(level=stated), 0)["level"] == expected


def test_an_unknown_level_is_refused():
    with pytest.raises(EngineInputError, match="level_1"):
        classify_position(position(level="level_4"), 0)


# ── the NAV practical expedient ──────────────────────────────────────────────


def test_nav_positions_are_outside_the_hierarchy_but_inside_the_total():
    """ASU 2015-07. Slotting NAV investments into Level 3 — which is what
    "everything unquoted is Level 3" does — overstates both the Level 3 total
    and the rollforward it has to tie to."""
    result = fair_value_measurement(
        positions=[
            position(name="Listed equity", fair_value=2_000_000, level="level_1"),
            position(name="Fund of funds", fair_value=5_000_000, measured_at_nav=True),
        ]
    )
    assert result["by_level"]["level_3"] == 0.0
    assert result["categorized_fair_value"] == 2_000_000
    assert result["nav_practical_expedient"]["fair_value"] == 5_000_000
    assert result["nav_practical_expedient"]["position_count"] == 1
    # The reconciling line: hierarchy table + NAV = the statement total.
    assert result["total_fair_value"] == 7_000_000


def test_nav_short_circuits_any_stated_level():
    out = classify_position(position(level="level_3", measured_at_nav=True), 0)
    assert out["level"] is None
    assert out["nav_practical_expedient"] is True


# ── aggregation ──────────────────────────────────────────────────────────────


def test_totals_by_level_and_the_predominant_level():
    result = fair_value_measurement(
        positions=[
            position(name="A", fair_value=1_000, level="level_1"),
            position(name="B", fair_value=4_000, level="level_2"),
            position(name="C", fair_value=9_000, level="level_3"),
        ]
    )
    assert result["by_level"] == {"level_1": 1_000.0, "level_2": 4_000.0, "level_3": 9_000.0}
    assert result["predominant_level"] == "level_3"
    assert result["level_3_pct_of_total"] == pytest.approx(9_000 / 14_000)


def test_reclassified_positions_are_listed_for_the_reviewer():
    result = fair_value_measurement(
        positions=[
            position(name="Overridden", level="level_2",
                     inputs=[{"name": "adj", "level": "level_3", "value": 0.2}]),
            position(name="Plain", level="level_1"),
        ]
    )
    assert [p["name"] for p in result["reclassified_positions"]] == ["Overridden"]


def test_an_empty_portfolio_is_refused():
    with pytest.raises(EngineInputError, match="non-empty"):
        fair_value_measurement(positions=[])


# ── the unobservable input table ─────────────────────────────────────────────


def test_weighted_average_is_weighted_by_fair_value_not_by_position_count():
    """820-10-50-2(bbb) says weighted average, and the weight is fair value.
    An arithmetic mean here lets a $1k position pull the disclosure as hard as
    a $9m one — which is the difference between 0.30 and 0.11 below."""
    result = fair_value_measurement(
        positions=[
            position(name="Small", fair_value=1_000, level="level_3",
                     inputs=[{"name": "discount rate", "level": "level_3", "value": 0.50}]),
            position(name="Large", fair_value=9_000, level="level_3",
                     inputs=[{"name": "discount rate", "level": "level_3", "value": 0.10}]),
        ]
    )
    (row,) = result["unobservable_inputs"]
    assert row["input"] == "discount rate"
    assert row["low"] == 0.10
    assert row["high"] == 0.50
    # (0.50·1000 + 0.10·9000) / 10000 = 0.14, not the 0.30 mean.
    assert row["weighted_average"] == pytest.approx(0.14)
    assert row["weighted"] is True
    assert row["position_count"] == 2


def test_zero_value_positions_fall_back_to_an_unweighted_mean_and_say_so():
    result = fair_value_measurement(
        positions=[
            position(name="A", fair_value=0.0, level="level_3",
                     inputs=[{"name": "haircut", "level": "level_3", "value": 0.2}]),
            position(name="B", fair_value=0.0, level="level_3",
                     inputs=[{"name": "haircut", "level": "level_3", "value": 0.4}]),
        ]
    )
    (row,) = result["unobservable_inputs"]
    assert row["weighted_average"] == pytest.approx(0.3)
    assert row["weighted"] is False


def test_observable_inputs_do_not_appear_in_the_unobservable_table():
    result = fair_value_measurement(
        positions=[position(inputs=[{"name": "exchange price", "level": "level_1", "value": 12.0}])]
    )
    assert result["unobservable_inputs"] == []


# ── the Level 3 rollforward ──────────────────────────────────────────────────


def test_rollforward_ties_to_the_measured_ending_balance():
    result = fair_value_measurement(
        positions=[position(name="L3", fair_value=1_250_000, level="level_3")],
        level_3_rollforward={
            "beginning_balance": 1_000_000,
            "purchases": 300_000,
            "sales": 150_000,
            "unrealized_gains_losses": 100_000,
        },
    )
    roll = result["level_3_rollforward"]
    assert roll["computed_ending_balance"] == pytest.approx(1_250_000)
    assert roll["ties"] is True


def test_an_untied_rollforward_is_reported_not_raised():
    # A real finding for the analyst — but not a reason to refuse the rest of
    # the measurement.
    result = fair_value_measurement(
        positions=[position(name="L3", fair_value=1_000_000, level="level_3")],
        level_3_rollforward={"beginning_balance": 900_000},
    )
    roll = result["level_3_rollforward"]
    assert roll["ties"] is False
    assert roll["difference"] == pytest.approx(100_000)


def test_transfers_out_and_settlements_reduce_the_balance():
    result = fair_value_measurement(
        positions=[position(name="L3", fair_value=400_000, level="level_3")],
        level_3_rollforward={
            "beginning_balance": 1_000_000,
            "settlements": 100_000,
            "transfers_out_of_level_3": 500_000,
        },
    )
    assert result["level_3_rollforward"]["ties"] is True


def test_no_rollforward_supplied_means_none_reported():
    result = fair_value_measurement(positions=[position()])
    assert result["level_3_rollforward"] is None


# ── sensitivity ──────────────────────────────────────────────────────────────


def test_sensitivity_moves_the_level_3_total():
    result = fair_value_measurement(
        positions=[position(name="L3", fair_value=2_000_000, level="level_3")],
        sensitivity=[{"input": "discount rate", "shift": -0.10}],
    )
    (row,) = result["sensitivity"]
    assert row["fair_value_effect"] == pytest.approx(-200_000)
    assert row["fair_value_after"] == pytest.approx(1_800_000)
    assert row["basis"] == "level_3_total"


def test_sensitivity_scales_the_position_the_input_drives_not_the_whole_level_3_book():
    """An unobservable input is rarely significant to every Level 3 position.
    Striking the shift on the whole Level 3 total overstates (or understates)
    the disclosed effect whenever it isn't — here a discount-rate input that
    drives $2M of an $10M Level 3 book must move $2M x shift, not $10M x shift."""
    result = fair_value_measurement(
        positions=[
            position(
                name="Revenue-multiple asset",
                fair_value=8_000_000,
                level="level_3",
                inputs=[{"name": "revenue multiple", "level": "level_3", "value": 4.0}],
            ),
            position(
                name="Discount-rate asset",
                fair_value=2_000_000,
                level="level_3",
                inputs=[{"name": "discount rate", "level": "level_3", "value": 0.25}],
            ),
        ],
        sensitivity=[{"input": "discount rate", "shift": -0.10}],
    )
    (row,) = result["sensitivity"]
    assert row["basis"] == "input"
    assert row["basis_fair_value"] == pytest.approx(2_000_000)
    # Not -1,000,000 (10% of the $10M Level 3 total).
    assert row["fair_value_effect"] == pytest.approx(-200_000)
    assert row["fair_value_after"] == pytest.approx(9_800_000)


def test_a_shift_beyond_plus_or_minus_one_is_refused():
    with pytest.raises(EngineInputError):
        fair_value_measurement(positions=[position()], sensitivity=[{"shift": 2.0}])


# ── HTTP surface ─────────────────────────────────────────────────────────────


def test_endpoint_is_listed_and_computes(client: TestClient):
    assert "/engine/v1/fair-value-820" in client.get("/").json()["endpoints"]
    res = client.post(
        "/engine/v1/fair-value-820",
        json={
            "inputs": {
                "measurement_date": "2026-06-30",
                "positions": [
                    {"name": "Listed", "fair_value": 1_000_000, "level": "level_1"},
                    {"name": "NAV fund", "fair_value": 500_000, "measured_at_nav": True},
                ],
            }
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total_fair_value"] == 1_500_000
    assert body["measurement_date"] == "2026-06-30"


def test_endpoint_maps_an_input_error_to_422(client: TestClient):
    res = client.post("/engine/v1/fair-value-820", json={"inputs": {"positions": []}})
    assert res.status_code == 422


def test_endpoint_unknown_input_name_is_422(client: TestClient):
    res = client.post(
        "/engine/v1/fair-value-820",
        json={"inputs": {"positions": [{"fair_value": 1}], "nonsense": True}},
    )
    assert res.status_code == 422
