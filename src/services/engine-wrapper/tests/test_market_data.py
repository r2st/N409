"""Market-data reference lookup — verifies the comp-agent ticker check."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.market_data import lookup, normalize_ticker, universe
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


# ── normalize_ticker ──────────────────────────────────────────────────────────
def test_normalize_uppercases_and_strips():
    assert normalize_ticker(" ddog ") == "DDOG"


def test_normalize_drops_exchange_prefix():
    assert normalize_ticker("NASDAQ:SNOW") == "SNOW"
    assert normalize_ticker("nyse: crm") == "CRM"


def test_normalize_handles_none():
    assert normalize_ticker(None) == ""


# ── lookup ────────────────────────────────────────────────────────────────────
def test_lookup_returns_known_and_flags_unknown():
    result = lookup(["DDOG", "NOTATICKER", "SNOW"])
    tickers = {c["ticker"] for c in result["companies"]}
    assert tickers == {"DDOG", "SNOW"}
    assert result["not_found"] == ["NOTATICKER"]
    assert result["count"] == 2


def test_lookup_verified_company_carries_full_shape():
    ddog = lookup(["DDOG"])["companies"][0]
    assert ddog["name"] == "Datadog, Inc."
    assert ddog["sic_code"] == "7372"
    assert ddog["sic_description"]
    assert ddog["market_cap"] > 0
    assert ddog["ev_revenue"] > 0
    assert "ev_ebitda" in ddog  # present even when null


def test_lookup_ev_ebitda_null_for_unprofitable():
    # SNOW is seeded with a negative/near-zero EBITDA → null multiple.
    snow = lookup(["SNOW"])["companies"][0]
    assert snow["ev_ebitda"] is None


def test_lookup_dedupes_and_normalizes():
    result = lookup(["ddog", "DDOG", "NASDAQ:DDOG", "", "  "])
    assert result["count"] == 1
    assert result["companies"][0]["ticker"] == "DDOG"


def test_lookup_preserves_first_appearance_order():
    result = lookup(["SNOW", "DDOG", "CRM"])
    assert [c["ticker"] for c in result["companies"]] == ["SNOW", "DDOG", "CRM"]


def test_lookup_rejects_non_list():
    with pytest.raises(EngineInputError):
        lookup("DDOG")


def test_lookup_rejects_oversized_request():
    with pytest.raises(EngineInputError):
        lookup([f"T{i}" for i in range(51)])


def test_universe_is_nonempty_and_unique():
    companies = universe()
    assert len(companies) >= 20
    tickers = [c["ticker"] for c in companies]
    assert len(tickers) == len(set(tickers))  # no duplicate tickers


# ── endpoints ─────────────────────────────────────────────────────────────────
def test_post_market_data_verifies(client):
    resp = client.post("/engine/v1/market-data", json={"tickers": ["DDOG", "BOGUS"]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["companies"][0]["ticker"] == "DDOG"
    assert body["not_found"] == ["BOGUS"]


def test_post_market_data_empty_list_ok(client):
    resp = client.post("/engine/v1/market-data", json={"tickers": []})
    assert resp.status_code == 200
    assert resp.json() == {"companies": [], "not_found": [], "count": 0}


def test_post_market_data_oversized_is_422(client):
    resp = client.post(
        "/engine/v1/market-data", json={"tickers": [f"T{i}" for i in range(60)]}
    )
    assert resp.status_code == 422


def test_get_market_data_universe(client):
    resp = client.get("/engine/v1/market-data")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == len(body["companies"])
    assert body["count"] >= 20


def test_root_lists_market_data_endpoint(client):
    resp = client.get("/")
    assert "/engine/v1/market-data" in resp.json()["endpoints"]
