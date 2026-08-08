"""IFRS 2 share-based payment — fair value, attribution, true-up, remeasurement."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.ifrs2 import expense_schedule, grant_date_fair_value, ifrs2_valuation
from app.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


MODEL = {
    "share_price": 10.0,
    "exercise_price": 10.0,
    "expected_term_years": 4.0,
    "expected_volatility": 0.60,
    "risk_free_rate": 0.04,
}


def run(**over) -> dict:
    return ifrs2_valuation(**{**MODEL, "options_granted": 100_000, "vesting_years": 4.0, **over})


# ── grant-date fair value ────────────────────────────────────────────────────


def test_an_at_the_money_option_has_time_value():
    fv = grant_date_fair_value(**MODEL)
    assert 0 < fv < 10.0


def test_a_dividend_yield_lowers_the_fair_value():
    assert grant_date_fair_value(**MODEL, dividend_yield=0.03) < grant_date_fair_value(**MODEL)


def test_the_market_condition_haircut_lands_inside_the_fair_value():
    """IFRS 2.21 — a market condition is priced into the grant-date fair value.
    Applying it to the expense instead would be the same number by accident on
    a fully-vesting grant and the wrong number the moment forfeitures differ."""
    plain = grant_date_fair_value(**MODEL)
    haircut = grant_date_fair_value(**MODEL, market_condition_discount=0.25)
    assert haircut == pytest.approx(plain * 0.75)


def test_a_supplied_fair_value_skips_the_model():
    out = run(fair_value_per_award=3.50)
    assert out["model"] == "supplied"
    assert out["fair_value_per_award"] == 3.50
    assert out["grant_date_fair_value_total"] == pytest.approx(350_000)


def test_neither_a_fair_value_nor_the_model_inputs_is_refused_by_name():
    with pytest.raises(EngineInputError, match="expected_volatility"):
        ifrs2_valuation(share_price=10, exercise_price=10, expected_term_years=4, risk_free_rate=0.04)


# ── which conditions live in the fair value ──────────────────────────────────


def test_a_market_condition_is_not_trued_up():
    """IFRS 2.21 — the expense stands even if the condition is never met,
    provided the service is rendered."""
    out = run(vesting_condition="market")
    assert out["true_up"]["applies"] is False
    assert out["true_up"]["condition_in_fair_value"] is True
    assert "no true-up" in out["true_up"]["basis"]


@pytest.mark.parametrize("condition", ["service", "performance_non_market"])
def test_a_non_market_condition_is_trued_up(condition):
    out = run(vesting_condition=condition)
    assert out["true_up"]["applies"] is True
    assert out["true_up"]["condition_in_fair_value"] is False


def test_a_forfeiture_estimate_reduces_the_expense_but_not_the_grant_date_value():
    out = run(expected_forfeiture_rate=0.10)
    assert out["expected_to_vest"] == pytest.approx(90_000)
    assert out["total_expense"] == pytest.approx(out["fair_value_per_award"] * 90_000)
    # The grant-date measurement itself is unaffected — IFRS 2.19 keeps the
    # estimate out of the fair value.
    assert out["grant_date_fair_value_total"] == pytest.approx(
        out["fair_value_per_award"] * 100_000
    )


def test_a_market_condition_with_a_forfeiture_estimate_is_refused():
    # Double-counting the same condition: once in the fair value, once in the
    # vesting estimate. The two paragraphs are mutually exclusive.
    with pytest.raises(EngineInputError, match="market condition"):
        run(vesting_condition="market", expected_forfeiture_rate=0.1)


# ── attribution ──────────────────────────────────────────────────────────────


def test_graded_attribution_front_loads_the_charge():
    """IFRS 2.IG11 — each instalment is its own award over its own period, so
    year 1 carries far more than a quarter of a four-year grant."""
    graded = expense_schedule(
        total_fair_value=100.0, vesting_years=4.0, attribution="graded", tranches=4
    )
    straight = expense_schedule(
        total_fair_value=100.0, vesting_years=4.0, attribution="straight_line", tranches=4
    )
    assert graded[0]["cumulative"] > straight[0]["cumulative"]
    # 1/4 + 1/4·(1/2) + 1/4·(1/3) + 1/4·(1/4) = 52.08%
    assert graded[0]["cumulative_pct"] == pytest.approx(0.520833, rel=1e-4)
    assert straight[0]["cumulative_pct"] == pytest.approx(0.25)


def test_both_attributions_expense_the_whole_grant_by_the_end():
    for attribution in ("graded", "straight_line"):
        schedule = expense_schedule(
            total_fair_value=100.0, vesting_years=4.0, attribution=attribution, tranches=4
        )
        assert schedule[-1]["cumulative"] == pytest.approx(100.0)
        assert sum(row["period"] for row in schedule) == pytest.approx(100.0)


def test_the_schedule_is_monotonic():
    schedule = expense_schedule(
        total_fair_value=100.0, vesting_years=4.0, attribution="graded", tranches=4
    )
    assert all(row["period"] >= 0 for row in schedule)
    cumulative = [row["cumulative"] for row in schedule]
    assert cumulative == sorted(cumulative)


def test_an_award_vested_at_grant_is_expensed_immediately():
    out = run(vesting_years=0.0)
    assert out["expense_schedule"][0]["cumulative"] == pytest.approx(out["total_expense"])
    assert len(out["expense_schedule"]) == 1


def test_a_straight_line_request_on_a_graded_award_is_answered_and_flagged():
    """ASC 718 permits the election; IFRS 2 does not. Answering it silently
    would produce a defensible-looking schedule that the standard forbids."""
    out = run(attribution="straight_line")
    assert out["attribution"] == "straight_line"
    assert any("IG11" in w for w in out["warnings"])


def test_graded_attribution_raises_no_warning():
    assert run(attribution="graded")["warnings"] == []


def test_a_single_tranche_award_needs_no_warning_either():
    # Cliff vesting: graded and straight-line are the same schedule.
    assert run(vesting_years=1.0, attribution="straight_line")["warnings"] == []


# ── remeasurement ────────────────────────────────────────────────────────────


def test_an_equity_settled_award_is_not_remeasured():
    out = run(settlement="equity_settled")
    assert out["remeasurement"]["required"] is False
    assert "not subsequently remeasured" in out["remeasurement"]["basis"]


def test_a_cash_settled_award_is_remeasured_to_the_reporting_date_value():
    """IFRS 2.30-33 — a liability that moves. Treating it as equity-settled
    freezes a charge that is supposed to change."""
    out = run(settlement="cash_settled", fair_value_per_award=3.00,
              current_fair_value_per_award=4.50)
    remeasure = out["remeasurement"]
    assert remeasure["required"] is True
    assert remeasure["current_total"] == pytest.approx(450_000)
    assert remeasure["change_in_liability"] == pytest.approx(150_000)


def test_a_cash_settled_award_with_no_new_value_shows_no_movement():
    out = run(settlement="cash_settled", fair_value_per_award=3.00)
    assert out["remeasurement"]["change_in_liability"] == pytest.approx(0.0)


@pytest.mark.parametrize(
    "field,value",
    [("settlement", "share_settled"), ("vesting_condition", "vibes"), ("attribution", "sum_of_years")],
)
def test_an_unknown_enum_value_is_refused(field, value):
    with pytest.raises(EngineInputError, match=field):
        run(**{field: value})


# ── HTTP surface ─────────────────────────────────────────────────────────────


def test_endpoint_is_listed_and_computes(client: TestClient):
    assert "/engine/v1/ifrs2" in client.get("/").json()["endpoints"]
    res = client.post(
        "/engine/v1/ifrs2",
        json={
            "inputs": {
                **MODEL,
                "grant_date": "2026-01-01",
                "options_granted": 100_000,
                "vesting_years": 4,
                "settlement": "equity_settled",
                "vesting_condition": "service",
            }
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["grant_date"] == "2026-01-01"
    assert body["total_expense"] > 0
    assert len(body["expense_schedule"]) == 4


def test_endpoint_maps_an_input_error_to_422(client: TestClient):
    res = client.post(
        "/engine/v1/ifrs2",
        json={"inputs": {**MODEL, "vesting_condition": "market", "expected_forfeiture_rate": 0.2}},
    )
    assert res.status_code == 422


def test_endpoint_unknown_input_name_is_422(client: TestClient):
    res = client.post("/engine/v1/ifrs2", json={"inputs": {**MODEL, "nonsense": 1}})
    assert res.status_code == 422
