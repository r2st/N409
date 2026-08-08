"""Comp selection with two sources: the model's suggestions and the engine screen.

The set used to be whatever the model recalled, filtered to real tickers. These
pin the second source — the engine's quantitative screen over the reference
universe — and how the two are reconciled: provenance on every candidate,
corroborated ones first, and the screen's failure never taking the run with it.

`chat` and the engine client are monkeypatched, so no network.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.agents import _common, comp_selection
from app.agents.engine import EngineError
from app.main import app
from app.openrouter import LlmResult


@pytest.fixture
def client():
    return TestClient(app)


def seq_chat(responses):
    payloads = [json.dumps(r) for r in responses]

    def _chat(system, user, *, model=None, client=None):
        idx = len(_chat.calls)
        _chat.calls.append({"system": system, "user": user})
        return LlmResult(model=model or "test/fake-model", content=payloads[min(idx, len(payloads) - 1)])

    _chat.calls = []
    return _chat


def market_row(ticker, **over):
    return {
        "ticker": ticker,
        "name": f"{ticker} Inc.",
        "sic_code": "7372",
        "sic_description": "Prepackaged Software",
        "sector": "SaaS",
        "market_cap": 10_000_000_000,
        "ev_revenue": 10.0,
        "ev_ebitda": 40.0,
        "revenue": 1_000_000_000,
        "revenue_growth": 0.25,
        "ebitda_margin": 0.25,
        **over,
    }


def screen_row(ticker, score, **over):
    return {
        **market_row(ticker),
        "score": score,
        "breakdown": {"industry": 1.0, "size": 0.8},
        **over,
    }


PAYLOAD = {
    "valuation": {"company_name": "Acme", "kind": "409a"},
    "params": {"revenue_ltm": 400_000_000, "sic_code": "7372"},
    "comp_context": {"industry": "software", "revenue_growth": 0.25, "ebitda_margin": 0.18},
}

# The model proposes DDOG and MDB; the screen finds DDOG (corroborated) and
# APPF (which the model never mentioned).
SUGGEST = {
    "comparables": [
        {"name": "Datadog", "ticker": "DDOG", "rationale": "Observability SaaS."},
        {"name": "MongoDB", "ticker": "MDB", "rationale": "Database SaaS."},
    ],
    "sector": "Application software",
}
REFINE = {
    "selected": [
        {"ticker": "DDOG", "justification": "Closest on scale and growth."},
        {"ticker": "APPF", "justification": "Vertical SaaS at a similar size."},
    ],
    "excluded": [{"ticker": "MDB", "name": "MongoDB", "reason": "No positive EBITDA."}],
}


def wire(monkeypatch, *, screen=None, screen_error=None, verify=None):
    monkeypatch.setattr(_common, "chat", seq_chat([SUGGEST, REFINE]))
    monkeypatch.setattr(
        comp_selection,
        "verify_tickers",
        lambda tickers: verify
        if verify is not None
        else {"companies": [market_row(t) for t in tickers], "not_found": []},
    )

    def _screen(target):
        if screen_error:
            raise EngineError(screen_error)
        return screen if screen is not None else {
            "selected": [screen_row("DDOG", 0.91), screen_row("APPF", 0.87)],
            "screened_out": [{"ticker": "CAT", "name": "Caterpillar", "score": 0.1,
                              "reason": "different industry"}],
            "universe_size": 54,
            "primary_multiple": {"multiple": "ev_revenue", "basis": "market convention"},
            "multiples": {"ev_revenue": {"count": 2, "trimmed_median": 10.0}},
        }

    monkeypatch.setattr(comp_selection, "screen_comparables", _screen)


def run(client, monkeypatch, **kw):
    wire(monkeypatch, **kw)
    resp = client.post("/ai/v1/pipelines/comp_selection", json=PAYLOAD)
    assert resp.status_code == 200, resp.text
    return resp.json()["result"]


# ── the screen as a second source ────────────────────────────────────────────


def test_the_screen_contributes_candidates_the_model_never_mentioned(client, monkeypatch):
    result = run(client, monkeypatch)
    tickers = {c["ticker"] for c in result["candidates"]}
    assert "APPF" in tickers  # screen only
    assert "MDB" in tickers  # model only
    assert "DDOG" in tickers  # both


def test_every_candidate_carries_its_provenance(client, monkeypatch):
    result = run(client, monkeypatch)
    by_ticker = {c["ticker"]: c for c in result["candidates"]}
    assert by_ticker["DDOG"]["sources"] == ["model", "screen"]
    assert by_ticker["MDB"]["sources"] == ["model"]
    assert by_ticker["APPF"]["sources"] == ["screen"]


def test_a_corroborated_candidate_keeps_the_model_sentence_and_the_screen_score(
    client, monkeypatch
):
    result = run(client, monkeypatch)
    ddog = next(c for c in result["candidates"] if c["ticker"] == "DDOG")
    assert ddog["rationale"] == "Observability SaaS."
    assert ddog["score"] == 0.91
    assert ddog["score_breakdown"] == {"industry": 1.0, "size": 0.8}


def test_a_model_only_candidate_has_no_score_rather_than_a_zero(client, monkeypatch):
    # A zero would read as "scored badly" instead of "never scored".
    result = run(client, monkeypatch)
    mdb = next(c for c in result["candidates"] if c["ticker"] == "MDB")
    assert "score" not in mdb


def test_corroborated_candidates_lead_the_prompt(client, monkeypatch):
    wire(monkeypatch)
    chat = _common.chat
    client.post("/ai/v1/pipelines/comp_selection", json=PAYLOAD)
    refine_prompt = chat.calls[1]["user"]
    # The strongest evidence should be at the head of the candidate list the
    # refine step reads, not wherever the model happened to list it.
    assert refine_prompt.index('"DDOG"') < refine_prompt.index('"MDB"')
    assert "sources" in refine_prompt


def test_the_screen_target_is_built_from_what_is_actually_known(client, monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(_common, "chat", seq_chat([SUGGEST, REFINE]))
    monkeypatch.setattr(
        comp_selection,
        "verify_tickers",
        lambda tickers: {"companies": [market_row(t) for t in tickers], "not_found": []},
    )

    def _screen(target):
        seen.update(target)
        return {"selected": [], "screened_out": []}

    monkeypatch.setattr(comp_selection, "screen_comparables", _screen)
    client.post("/ai/v1/pipelines/comp_selection", json=PAYLOAD)

    assert seen["sic_code"] == "7372"
    assert seen["revenue"] == 400_000_000
    assert seen["revenue_growth"] == 0.25
    assert seen["ebitda_margin"] == 0.18


def test_an_unknown_attribute_is_left_out_rather_than_sent_as_zero(client, monkeypatch):
    # The engine drops a dimension the target says nothing about and
    # renormalises; a zero margin is a different claim entirely.
    seen: dict = {}
    monkeypatch.setattr(_common, "chat", seq_chat([SUGGEST, REFINE]))
    monkeypatch.setattr(
        comp_selection, "verify_tickers", lambda tickers: {"companies": [], "not_found": []}
    )
    monkeypatch.setattr(
        comp_selection,
        "screen_comparables",
        lambda target: (seen.update(target), {"selected": [], "screened_out": []})[1],
    )
    client.post(
        "/ai/v1/pipelines/comp_selection",
        json={"valuation": {"company_name": "Acme"}, "params": {"revenue_ltm": 5_000_000}},
    )
    assert seen == {"revenue": 5_000_000}


# ── reporting ────────────────────────────────────────────────────────────────


def test_the_rejected_list_is_reported_with_its_reasons(client, monkeypatch):
    # "Why not that one" is a question only the rejected list answers.
    result = run(client, monkeypatch)
    assert result["screen"]["ran"] is True
    assert result["screen"]["screened_out"][0]["reason"] == "different industry"
    assert result["screen"]["universe_size"] == 54


def test_the_industry_multiple_choice_is_passed_through(client, monkeypatch):
    result = run(client, monkeypatch)
    assert result["screen"]["primary_multiple"]["multiple"] == "ev_revenue"
    assert result["screen"]["multiples"]["ev_revenue"]["trimmed_median"] == 10.0


def test_the_source_summary_counts_the_final_set(client, monkeypatch):
    result = run(client, monkeypatch)
    assert result["sources"] == {"model": 1, "screen": 2, "corroborated": 1}


# ── degrading ────────────────────────────────────────────────────────────────


def test_a_failed_screen_leaves_the_model_set_intact(client, monkeypatch):
    result = run(client, monkeypatch, screen_error="comparables HTTP 500")
    assert result["screen"]["ran"] is False
    assert result["screen"]["error"] == "comparables HTTP 500"
    # The run still produced a comp set from the model's suggestions.
    assert {c["ticker"] for c in result["candidates"]} == {"DDOG", "MDB"}
    assert result["market_data_verified"] is True


def test_a_screen_the_engine_refuses_is_not_an_error_for_the_run(client, monkeypatch):
    # The engine 422s a screen with no target attributes; that is the right
    # answer, not a reason to abandon the model's set.
    result = run(client, monkeypatch, screen_error="comparables HTTP 422: no attributes")
    assert result["selected"]


def test_a_dead_engine_still_yields_flagged_unverified_suggestions(client, monkeypatch):
    monkeypatch.setattr(_common, "chat", seq_chat([SUGGEST, REFINE]))

    def _dead(*_a, **_k):
        raise EngineError("market-data request failed")

    monkeypatch.setattr(comp_selection, "verify_tickers", _dead)
    monkeypatch.setattr(comp_selection, "screen_comparables", _dead)
    resp = client.post("/ai/v1/pipelines/comp_selection", json=PAYLOAD)
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["market_data_verified"] is False
    assert all(c["verified"] is False for c in result["candidates"])
    assert all(c["sources"] == ["model"] for c in result["candidates"])


def test_the_screen_is_skipped_entirely_when_market_data_is_down(client, monkeypatch):
    # No point screening against a universe the engine cannot serve.
    calls: list = []
    monkeypatch.setattr(_common, "chat", seq_chat([SUGGEST, REFINE]))
    monkeypatch.setattr(
        comp_selection,
        "verify_tickers",
        lambda _t: (_ for _ in ()).throw(EngineError("down")),
    )
    monkeypatch.setattr(
        comp_selection, "screen_comparables", lambda t: calls.append(t) or {"selected": []}
    )
    client.post("/ai/v1/pipelines/comp_selection", json=PAYLOAD)
    assert calls == []


def test_selection_still_only_draws_from_the_candidate_set(client, monkeypatch):
    # The refine step naming a ticker nobody verified must not smuggle it in.
    monkeypatch.setattr(
        _common,
        "chat",
        seq_chat([SUGGEST, {"selected": [{"ticker": "FAKE", "justification": "invented"}]}]),
    )
    monkeypatch.setattr(
        comp_selection,
        "verify_tickers",
        lambda tickers: {"companies": [market_row(t) for t in tickers], "not_found": []},
    )
    monkeypatch.setattr(
        comp_selection,
        "screen_comparables",
        lambda _t: {"selected": [screen_row("APPF", 0.8)], "screened_out": []},
    )
    resp = client.post("/ai/v1/pipelines/comp_selection", json=PAYLOAD)
    tickers = {c["ticker"] for c in resp.json()["result"]["selected"]}
    assert "FAKE" not in tickers
