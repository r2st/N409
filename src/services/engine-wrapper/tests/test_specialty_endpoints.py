"""HTTP surface tests for the specialty report-type engines
(QSBS, intangibles/PPA, impairment, ESOP, SMB, EMI/CSOP)."""

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def test_root_lists_the_new_endpoints(client: TestClient):
    endpoints = client.get("/").json()["endpoints"]
    for path in (
        "/engine/v1/qsbs",
        "/engine/v1/intangible",
        "/engine/v1/ppa",
        "/engine/v1/impairment",
        "/engine/v1/esop",
        "/engine/v1/smb",
        "/engine/v1/emi-csop",
    ):
        assert path in endpoints


# ── QSBS ─────────────────────────────────────────────────────────────────────


def test_qsbs_endpoint_happy_path(client: TestClient):
    res = client.post(
        "/engine/v1/qsbs",
        json={
            "inputs": {
                "entity_type": "c_corp",
                "gross_assets_before_issuance": 8_000_000,
                "gross_assets_after_issuance": 12_000_000,
                "industry": "software",
                "active_business_asset_pct": 0.95,
                "acquired_at_original_issue": True,
                "acquisition_date": "2018-03-15",
                "assessment_date": "2024-06-30",
                "aggregate_basis": 2_000_000,
            }
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["eligible"] is True
    assert body["gain_exclusion_cap"] == 20_000_000


def test_qsbs_endpoint_maps_engine_error_to_422(client: TestClient):
    res = client.post("/engine/v1/qsbs", json={"inputs": {"entity_type": "c_corp"}})
    assert res.status_code == 422


def test_qsbs_endpoint_unknown_input_name_is_422(client: TestClient):
    res = client.post("/engine/v1/qsbs", json={"inputs": {"bogus": 1}})
    assert res.status_code == 422
    assert "invalid qsbs inputs" in res.json()["detail"]


# ── Intangibles / PPA ────────────────────────────────────────────────────────


def test_intangible_endpoint_rfr(client: TestClient):
    res = client.post(
        "/engine/v1/intangible",
        json={
            "method": "relief_from_royalty",
            "params": {
                "revenues": [1_000_000, 1_100_000],
                "royalty_rate": 0.06,
                "tax_rate": 0.25,
                "discount_rate": 0.15,
            },
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["method"] == "relief_from_royalty"
    assert body["fair_value"] > body["value_before_tab"]


def test_intangible_endpoint_unknown_method_is_422(client: TestClient):
    res = client.post("/engine/v1/intangible", json={"method": "dcf", "params": {}})
    assert res.status_code == 422


def test_ppa_endpoint_allocates_and_ties_out(client: TestClient):
    res = client.post(
        "/engine/v1/ppa",
        json={
            "inputs": {
                "consideration_transferred": 10_000_000,
                "net_working_capital": 500_000,
                "fixed_assets": 1_000_000,
                "assumed_liabilities": 300_000,
                "intangibles": [
                    {
                        "name": "Developed technology",
                        "method": "relief_from_royalty",
                        "params": {
                            "revenues": [2_000_000] * 5,
                            "royalty_rate": 0.08,
                            "tax_rate": 0.25,
                            "discount_rate": 0.16,
                        },
                    }
                ],
            }
        },
    )
    assert res.status_code == 200
    body = res.json()
    total = body["tangible_net_assets"] + body["total_intangible_value"] + body["goodwill"]
    assert total == pytest.approx(body["consideration_transferred"])


# ── Impairment ───────────────────────────────────────────────────────────────


def test_impairment_endpoint_goodwill(client: TestClient):
    res = client.post(
        "/engine/v1/impairment",
        json={
            "test": "goodwill",
            "params": {"carrying_amount": 100, "fair_value": 85, "goodwill_carrying_amount": 30},
        },
    )
    assert res.status_code == 200
    assert res.json()["impairment_loss"] == 15


def test_impairment_endpoint_unknown_test_is_422(client: TestClient):
    res = client.post("/engine/v1/impairment", json={"test": "asc999", "params": {}})
    assert res.status_code == 422


# ── ESOP ─────────────────────────────────────────────────────────────────────


def test_esop_endpoint_with_repurchase_defaults_price_to_conclusion(client: TestClient):
    res = client.post(
        "/engine/v1/esop",
        json={
            "inputs": {
                "equity_value": 10_000_000,
                "shares_outstanding": 1_000_000,
                "dloc": 0.20,
                "dlom": 0.10,
                "esop_shares": 300_000,
            },
            "repurchase": {
                "esop_share_balance": 300_000,
                "annual_redemption_rate": 0.10,
                "years": 5,
            },
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["fmv_per_share"] == pytest.approx(7.20)
    schedule = body["repurchase_obligation"]["schedule"]
    assert schedule[0]["share_price"] == pytest.approx(7.20)


def test_esop_endpoint_without_repurchase_omits_it(client: TestClient):
    res = client.post(
        "/engine/v1/esop",
        json={"inputs": {"equity_value": 1_000_000, "shares_outstanding": 100_000}},
    )
    assert res.status_code == 200
    assert "repurchase_obligation" not in res.json()


def test_esop_endpoint_conflicting_discount_inputs_are_422(client: TestClient):
    res = client.post(
        "/engine/v1/esop",
        json={
            "inputs": {
                "equity_value": 1,
                "shares_outstanding": 1,
                "dloc": 0.2,
                "control_premium": 0.25,
            }
        },
    )
    assert res.status_code == 422


# ── SMB ──────────────────────────────────────────────────────────────────────


def test_smb_endpoint_weighted_conclusion(client: TestClient):
    res = client.post(
        "/engine/v1/smb",
        json={
            "inputs": {
                "sde": 400_000,
                "sde_multiple": 2.8,
                "annual_revenue": 2_000_000,
                "revenue_multiple": 0.6,
            }
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["equity_value"] == pytest.approx((400_000 * 2.8 + 2_000_000 * 0.6) / 2)


def test_smb_endpoint_no_method_is_422(client: TestClient):
    res = client.post("/engine/v1/smb", json={"inputs": {"sde": 400_000}})
    assert res.status_code == 422


# ── EMI / CSOP ───────────────────────────────────────────────────────────────


def test_emi_endpoint_full_valuation(client: TestClient):
    res = client.post(
        "/engine/v1/emi-csop",
        json={
            "scheme": "emi",
            "params": {
                "equity_value": 10_000_000,
                "total_shares": 1_000_000,
                "restriction_discount": 0.20,
                "gross_assets": 5_000_000,
                "employee_count": 40,
                "options_granted": 20_000,
            },
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["umv_per_share"] == pytest.approx(10.0)
    assert body["amv_per_share"] == pytest.approx(8.0)
    assert body["qualification"]["qualifies"] is True


def test_csop_endpoint_flags_discounted_strike(client: TestClient):
    res = client.post(
        "/engine/v1/emi-csop",
        json={
            "scheme": "csop",
            "params": {
                "equity_value": 1_000_000,
                "total_shares": 100_000,
                "options_granted": 1_000,
                "exercise_price": 5.0,
            },
        },
    )
    assert res.status_code == 200
    assert res.json()["qualification"]["failed_checks"] == ["exercise_price_not_below_umv"]


def test_emi_csop_bad_scheme_is_request_validation_error(client: TestClient):
    res = client.post("/engine/v1/emi-csop", json={"scheme": "saye", "params": {}})
    assert res.status_code == 422
