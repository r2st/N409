"""End-to-end compute + API contract tests."""

import pytest
from fastapi.testclient import TestClient

from app.engine.compute import compute
from app.engine.errors import EngineInputError
from app.engine.dlom import finnerty_dlom
from app.main import app

client = TestClient(app)

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.6,
    "weight_income": 0.15,
    "weight_market": 0.25,
    "dloc": 0.1,
    "dlom_method": "finnerty",
    "exit_timeline": "2029-06-30",
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "cash": 1_500_000,
    "debt": 200_000,
    "last_round_post_money": 20_000_000,
    "income": {"free_cash_flows": [-500_000, 250_000, 1_200_000], "discount_rate": 0.3, "terminal_growth": 0.03},
    "market": {"metric": 4_000_000, "multiples": [6.0, 4.0]},
}


def test_full_compute_shape_and_weighting():
    out = compute(PARAMS, INPUTS)
    res = out["results"]
    assert out["engine_version"] == "py-1.0.0"

    a = res["approaches"]
    assert set(a) == {"opm_backsolve", "income", "market"}  # weight_asset=0 → skipped
    expected_equity = (
        0.6 * a["opm_backsolve"]["equity_value"]
        + 0.15 * a["income"]["equity_value"]
        + 0.25 * a["market"]["equity_value"]
    )
    assert res["equity_value"] == pytest.approx(expected_equity, abs=0.01)

    # T = 3 years exactly (2026-06-30 → 2029-06-30 = 1096 days / 365.25)
    assert res["assumptions"]["time_to_exit_years"] == pytest.approx(3.0, abs=0.01)

    # DLOM matches the Finnerty model at (σ=0.6, T≈3)
    assert res["discounts"]["dlom"] == pytest.approx(
        finnerty_dlom(0.6, res["assumptions"]["time_to_exit_years"]), abs=1e-4
    )

    # FMV consistency: common equity × (1−dloc)(1−dlom) / FD common
    fd = res["fully_diluted_common"]
    assert fd == 8_000_000
    expected_fmv = res["common_equity_value"] * 0.9 * (1 - res["discounts"]["dlom"]) / fd
    assert res["fmv_per_share"] == pytest.approx(expected_fmv, abs=1e-3)
    assert 0 < res["fmv_per_share"] < a["opm_backsolve"]["equity_value"] / fd


def test_opm_allocation_below_preference_is_option_value():
    # Equity barely above the preference: common keeps only option value.
    params = {**PARAMS, "weight_opm": 1.0, "weight_income": 0.0, "weight_market": 0.0}
    inputs = {**INPUTS, "last_round_post_money": 5_500_000}
    res = compute(params, inputs)["results"]
    assert res["allocation"]["method"] == "opm_single_breakpoint"
    assert res["allocation"]["upside_after_preference"] < 5_500_000
    assert res["fmv_per_share"] > 0


def test_no_preferred_means_full_allocation():
    params = {**PARAMS, "dlom_method": None, "dloc": 0}
    inputs = {
        **INPUTS,
        "shares_outstanding_preferred": 0,
        "liquidation_preference": 0,
        "options_outstanding": 0,
    }
    res = compute(params, inputs)["results"]
    assert res["allocation"]["method"] == "as_converted"
    assert res["common_equity_value"] == pytest.approx(res["equity_value"])
    # fmv_per_share is rounded to 4dp by the engine
    assert res["fmv_per_share"] == pytest.approx(res["equity_value"] / 7_000_000, abs=1e-3)


def test_qualitative_dlom_and_chaffee():
    q = compute({**PARAMS, "dlom_method": "qualitative", "dlom_qualitative": 0.25}, INPUTS)["results"]
    assert q["discounts"]["dlom"] == 0.25
    c = compute({**PARAMS, "dlom_method": "chaffee"}, INPUTS)["results"]
    f = compute({**PARAMS, "dlom_method": "finnerty"}, INPUTS)["results"]
    assert c["discounts"]["dlom"] > f["discounts"]["dlom"]


def test_missing_weights_and_inputs_are_422_through_api():
    r = client.post("/engine/v1/compute", json={"params": {}, "inputs": {}})
    assert r.status_code == 422
    assert "weights" in r.json()["detail"]

    r = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": {}})
    assert r.status_code == 422
    assert "last_round_post_money" in r.json()["detail"]

    no_vol = {**INPUTS}
    del no_vol["volatility"]
    r = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": no_vol})
    assert r.status_code == 422
    assert "volatility" in r.json()["detail"]


def test_bad_weight_sum_is_422():
    bad = {**PARAMS, "weight_opm": 0.7}
    with pytest.raises(Exception) as exc:
        compute(bad, INPUTS)
    assert "sum to 1.0" in str(exc.value)


def test_compute_via_api_matches_direct_call():
    r = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": INPUTS})
    assert r.status_code == 200
    assert r.json()["results"]["fmv_per_share"] == compute(PARAMS, INPUTS)["results"]["fmv_per_share"]


def test_engine_health_contract():
    r = client.get("/engine/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["contract"] == "engine/v1"
    assert body["engine_version"] == "py-1.0.0"


# ── Per-subsystem recalculation (remaining-gaps §3 #5) ────────────────────────
def test_recompute_single_approach_reuses_prior():
    full = compute(PARAMS, INPUTS)["results"]
    prior = full["approaches"]

    # Recompute only the market approach with a different multiple set; the
    # other approaches must be carried over from the prior run untouched.
    new_inputs = {**INPUTS, "market": {"metric": 4_000_000, "multiples": [8.0]}}
    partial = compute(PARAMS, new_inputs, recompute=["market"], prior_approaches=prior)["results"]

    a = partial["approaches"]
    assert partial["recomputed"] == ["market"]
    assert a["market"]["equity_value"] != prior["market"]["equity_value"]
    assert "reused" not in a["market"]
    for name in ("opm_backsolve", "income"):
        assert a[name]["equity_value"] == prior[name]["equity_value"]
        assert a[name]["reused"] is True
        # current params re-weight the merged set
        assert a[name]["weight"] == PARAMS[f"weight_{'opm' if name == 'opm_backsolve' else name}"]

    # Weighted equity and downstream FMV re-run over the merged approaches.
    expected_equity = (
        0.6 * a["opm_backsolve"]["equity_value"]
        + 0.15 * a["income"]["equity_value"]
        + 0.25 * a["market"]["equity_value"]
    )
    assert partial["equity_value"] == pytest.approx(expected_equity, abs=0.01)


def test_recompute_matches_full_run_when_inputs_unchanged():
    full = compute(PARAMS, INPUTS)["results"]
    partial = compute(
        PARAMS, INPUTS, recompute=["income"], prior_approaches=full["approaches"]
    )["results"]
    assert partial["fmv_per_share"] == full["fmv_per_share"]


def test_recompute_missing_prior_computes_fresh():
    # A weighted approach absent from the prior run is computed fresh rather
    # than failing — e.g. its weight was 0 in the baseline.
    full = compute(PARAMS, INPUTS)["results"]
    prior = {k: v for k, v in full["approaches"].items() if k != "income"}
    partial = compute(PARAMS, INPUTS, recompute=["market"], prior_approaches=prior)["results"]
    assert partial["approaches"]["income"]["equity_value"] == pytest.approx(
        full["approaches"]["income"]["equity_value"], abs=0.01
    )
    assert "reused" not in partial["approaches"]["income"]


def test_recompute_validation_errors():
    full = compute(PARAMS, INPUTS)["results"]
    with pytest.raises(Exception) as exc:
        compute(PARAMS, INPUTS, recompute=["dcf"], prior_approaches=full["approaches"])
    assert "unknown recompute" in str(exc.value)
    with pytest.raises(Exception) as exc:
        compute(PARAMS, INPUTS, recompute=[], prior_approaches=full["approaches"])
    assert "at least one" in str(exc.value)
    with pytest.raises(Exception) as exc:
        compute(
            PARAMS, INPUTS, recompute=["market"], prior_approaches={"income": {"note": "no equity"}}
        )
    assert "equity_value" in str(exc.value)


def test_recompute_via_api():
    full = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": INPUTS}).json()
    r = client.post(
        "/engine/v1/compute",
        json={
            "params": PARAMS,
            "inputs": INPUTS,
            "recompute": ["opm_backsolve"],
            "prior_approaches": full["results"]["approaches"],
        },
    )
    assert r.status_code == 200
    res = r.json()["results"]
    assert res["recomputed"] == ["opm_backsolve"]
    assert res["approaches"]["income"]["reused"] is True


# ── valuation_date with a time component ──────────────────────────────────────
#
# `validate._check_dates` truncates both dates to `[:10]`; `_time_to_exit`
# truncated only `exit_timeline`, so a `valuation_date` carrying a time cleared
# preflight validation and then failed the calculation it had just cleared.

@pytest.mark.parametrize(
    "stamped",
    [
        "2026-06-30T00:00:00",
        "2026-06-30T00:00:00.000Z",
        "2026-06-30T13:45:12+00:00",
    ],
)
def test_valuation_date_with_a_time_matches_the_plain_date(stamped):
    from app.engine.validate import split_issues, validate_payload

    errors, _ = split_issues(validate_payload(PARAMS, {**INPUTS, "valuation_date": stamped}))
    assert errors == []  # validation has always accepted this shape

    stamped_out = compute(PARAMS, {**INPUTS, "valuation_date": stamped})["results"]
    plain_out = compute(PARAMS, INPUTS)["results"]
    assert stamped_out["assumptions"]["time_to_exit_years"] == (
        plain_out["assumptions"]["time_to_exit_years"]
    )
    assert stamped_out["fmv_per_share"] == plain_out["fmv_per_share"]


def test_a_genuinely_unparseable_valuation_date_is_still_rejected():
    from app.engine.approaches import EngineInputError

    with pytest.raises(EngineInputError, match="must be YYYY-MM-DD"):
        compute(PARAMS, {**INPUTS, "valuation_date": "30/06/2026"})


# ── Unusable market multiples are input errors, not crashes ──────────────────
#
# `float(m)` raised ValueError on "12.5x" and TypeError on a null, neither of
# which the route's `except EngineInputError` handler sees — so an input problem
# the caller could fix came back as an opaque 500.


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(["12.5x"], id="unit-suffixed string"),
        pytest.param([{"value": 6.0}], id="object"),
        pytest.param([[6.0]], id="nested list"),
    ],
)
def test_non_numeric_market_multiple_is_an_input_error(bad):
    inputs = {**INPUTS, "market": {**INPUTS["market"], "multiples": bad}}
    with pytest.raises(EngineInputError):
        compute(PARAMS, inputs)


def test_a_null_beside_a_good_multiple_is_an_input_error():
    """Preflight validation drops the unusable entries and passes the list as
    long as one good multiple survives, so this cleared validation and then
    crashed the calculation it had just cleared."""
    inputs = {**INPUTS, "market": {**INPUTS["market"], "multiples": [6.0, None]}}
    with pytest.raises(EngineInputError):
        compute(PARAMS, inputs)


def test_numeric_strings_are_still_accepted():
    """Multiples arrive from spreadsheet cells and JSON payloads, so a numeric
    string has always worked and must keep working."""
    inputs = {**INPUTS, "market": {**INPUTS["market"], "multiples": ["6.0", "4.0"]}}
    assert compute(PARAMS, inputs)["results"]["approaches"]["market"]["selected_multiple"] == 5.0


def test_compute_endpoint_answers_422_not_500_for_a_null_multiple():
    inputs = {**INPUTS, "market": {**INPUTS["market"], "multiples": [6.0, None]}}
    res = client.post("/engine/v1/compute", json={"params": PARAMS, "inputs": inputs})
    assert res.status_code == 422
    assert "market.multiples" in res.json()["detail"]
