"""Analyst-agent tests — chat and the engine client are monkeypatched, so no
network and no OpenRouter key are needed."""

import base64
import json

import pytest
from fastapi.testclient import TestClient

from app.agents import _common, comp_selection
from app.main import app
from app.openrouter import LlmResult


@pytest.fixture
def client():
    return TestClient(app)


def seq_chat(responses, default_model="test/fake-model"):
    """A chat stub that returns each response in turn (multi-step agents call
    chat more than once); the last response repeats if calls exceed the list."""
    payloads = [r if isinstance(r, str) else json.dumps(r) for r in responses]

    def _chat(system, user, *, model=None, client=None):
        idx = len(_chat.calls)
        _chat.calls.append({"system": system, "user": user, "model": model})
        content = payloads[idx] if idx < len(payloads) else payloads[-1]
        return LlmResult(model=model or default_model, content=content)

    _chat.calls = []
    return _chat


def fake_verify(companies_map):
    def _verify(tickers, *, client=None):
        companies = [companies_map[t] for t in tickers if t in companies_map]
        not_found = [t for t in tickers if t not in companies_map]
        return {"companies": companies, "not_found": not_found, "count": len(companies)}

    return _verify


def market_company(ticker, **overrides):
    base = {
        "ticker": ticker,
        "name": f"{ticker} Inc.",
        "sic_code": "7372",
        "sic_description": "Prepackaged Software",
        "sector": "SaaS",
        "market_cap": 10_000_000_000,
        "ev_revenue": 10.0,
        "ev_ebitda": 30.0,
    }
    base.update(overrides)
    return base


def doc(filename, kind, text):
    return {
        "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "filename": filename,
        "kind": kind,
        "content_type": "text/csv",
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


# ── cap_table ─────────────────────────────────────────────────────────────────
def test_cap_table_structures_and_validates(monkeypatch, client):
    identify = {
        "classes": [
            {
                "name": "Common Stock",
                "kind": "common",
                "shares": 6_000_000,
                "citations": [
                    {"field": "shares", "value": "6,000,000", "source_document": "charter.pdf", "quote": "6,000,000 shares of Common", "confidence": 0.95}
                ],
            },
            {
                "name": "Series A Preferred",
                "kind": "preferred stock",
                "shares": 4_000_000,
                "liquidation_preference": 8_000_000,
                "seniority": 1,
                "participation": "uncapped",
                "conversion_ratio": 1.0,
                "citations": [
                    {"field": "liquidation_preference", "value": "$8M", "source_document": "charter.pdf", "quote": "1x non-participating", "confidence": 0.8}
                ],
            },
            {"name": "Ghost Class", "kind": "mystery", "shares": 100},  # unrecognised kind → dropped
        ],
        "total_shares_stated": 10_000_000,
        "notes": "Clean charter.",
    }
    structure = {
        "share_classes": [
            {"name": "Common Stock", "kind": "common", "shares": 6_000_000},
            {
                "name": "Series A Preferred",
                "kind": "preferred",
                "shares": 4_000_000,
                "preference": 8_000_000,
                "seniority": 1,
                "participating": False,
                "conversion_ratio": 1.0,
                "participation_cap": None,
            },
            {"name": "Broken Option", "kind": "option", "shares": 500_000},  # no strike → dropped
        ]
    }
    monkeypatch.setattr(_common, "chat", seq_chat([identify, structure]))

    resp = client.post(
        "/ai/v1/pipelines/cap_table",
        json={
            "valuation": {"company_name": "Acme"},
            "documents": [doc("charter.pdf", "articles_of_incorporation", "charter text")],
        },
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    names = [c["name"] for c in result["share_classes"]]
    assert names == ["Common Stock", "Series A Preferred"]  # broken option dropped
    pref = result["share_classes"][1]
    assert pref["kind"] == "preferred"
    assert pref["preference"] == 8_000_000
    assert pref["participating"] is False
    # Validation reconciles 6M + 4M against the stated 10M total.
    assert result["validation"]["share_total_computed"] == 10_000_000
    assert result["validation"]["reconciles"] is True
    # Citations only for classes that survived structuring.
    cited_classes = {c["class"] for c in result["citations"]}
    assert cited_classes == {"Common Stock", "Series A Preferred"}
    assert result["citations"][0]["confidence"] == 0.95


def test_cap_table_flags_missing_common_and_reconcile_failure(monkeypatch, client):
    identify = {"classes": [], "total_shares_stated": 5_000_000}
    structure = {
        "share_classes": [
            {"name": "Series A", "kind": "preferred", "shares": 1_000_000, "preference": 2_000_000}
        ]
    }
    monkeypatch.setattr(_common, "chat", seq_chat([identify, structure]))
    resp = client.post("/ai/v1/pipelines/cap_table", json={"valuation": {"company_name": "Acme"}})
    assert resp.status_code == 200
    validation = resp.json()["result"]["validation"]
    assert validation["reconciles"] is False  # 1M parsed vs 5M stated
    joined = " ".join(validation["issues"])
    assert "common" in joined and "reconcile" in joined


def test_cap_table_option_requires_strike(monkeypatch, client):
    identify = {"classes": []}
    structure = {
        "share_classes": [
            {"name": "Common", "kind": "common", "shares": 1_000_000},
            {"name": "Pool", "kind": "option", "shares": 200_000, "strike": 0.10},
        ]
    }
    monkeypatch.setattr(_common, "chat", seq_chat([identify, structure]))
    resp = client.post("/ai/v1/pipelines/cap_table", json={"valuation": {"company_name": "Acme"}})
    classes = resp.json()["result"]["share_classes"]
    option = next(c for c in classes if c["kind"] == "option")
    assert option["strike"] == 0.10


# ── comp_selection ────────────────────────────────────────────────────────────
def test_comp_selection_verifies_and_refines(monkeypatch, client):
    suggest = {
        "comparables": [
            {"name": "Datadog", "ticker": "DDOG", "rationale": "observability"},
            {"name": "Made Up Co", "ticker": "FAKE", "rationale": "n/a"},
            {"name": "Dynatrace", "ticker": "DT", "rationale": "observability"},
        ],
        "sector": "Observability SaaS",
    }
    refine = {
        "selected": [
            {"ticker": "DDOG", "justification": "Closest business model and scale."},
            {"ticker": "ZZZZ", "justification": "not a candidate — must be ignored"},
        ],
        "excluded": [{"ticker": "DT", "name": "Dynatrace", "reason": "Different margin profile."}],
    }
    monkeypatch.setattr(_common, "chat", seq_chat([suggest, refine]))
    monkeypatch.setattr(
        comp_selection,
        "verify_tickers",
        fake_verify(
            {
                "DDOG": market_company("DDOG", ev_revenue=14.0, ev_ebitda=78.0),
                "DT": market_company("DT", ev_revenue=10.0, ev_ebitda=42.0),
            }
        ),
    )

    resp = client.post(
        "/ai/v1/pipelines/comp_selection",
        json={"valuation": {"company_name": "Acme"}, "comp_context": {"industry": "APM", "revenue": 5_000_000, "stage": "post_revenue"}},
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["market_data_verified"] is True
    assert result["not_found_tickers"] == ["FAKE"]  # hallucinated ticker dropped
    selected_tickers = [c["ticker"] for c in result["selected"]]
    assert selected_tickers == ["DDOG"]  # ZZZZ ignored — not in verified set
    assert result["selected"][0]["ev_revenue"] == 14.0  # real multiple attached
    assert result["selected"][0]["justification"].startswith("Closest")
    assert result["multiples_summary"]["ev_revenue_median"] == 14.0


def test_comp_selection_degrades_when_engine_down(monkeypatch, client):
    suggest = {
        "comparables": [{"name": "Datadog", "ticker": "DDOG", "rationale": "x"}],
        "sector": "SaaS",
    }
    # Refine still runs against the unverified candidates.
    refine = {"selected": [{"ticker": "DDOG", "justification": "best fit"}], "excluded": []}
    monkeypatch.setattr(_common, "chat", seq_chat([suggest, refine]))

    def boom(tickers, *, client=None):
        raise comp_selection.EngineError("engine unreachable")

    monkeypatch.setattr(comp_selection, "verify_tickers", boom)

    resp = client.post(
        "/ai/v1/pipelines/comp_selection", json={"valuation": {"company_name": "Acme"}}
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["market_data_verified"] is False
    assert result["engine_error"]
    assert result["candidates"][0]["verified"] is False
    assert result["selected"][0]["ticker"] == "DDOG"


def test_comp_selection_falls_back_when_refine_empty(monkeypatch, client):
    suggest = {"comparables": [{"name": "Datadog", "ticker": "DDOG", "rationale": "x"}], "sector": "SaaS"}
    refine = {"selected": [], "excluded": []}  # model picked nothing usable
    monkeypatch.setattr(_common, "chat", seq_chat([suggest, refine]))
    monkeypatch.setattr(comp_selection, "verify_tickers", fake_verify({"DDOG": market_company("DDOG")}))
    resp = client.post("/ai/v1/pipelines/comp_selection", json={"valuation": {"company_name": "Acme"}})
    selected = resp.json()["result"]["selected"]
    assert [c["ticker"] for c in selected] == ["DDOG"]  # guardrail fallback


# ── report_narrative ──────────────────────────────────────────────────────────
def test_report_narrative_fills_all_sections(monkeypatch, client):
    chat = seq_chat(
        [
            {
                "sections": {
                    "executive_summary": "The fair market value is $1.20 per share.",
                    "conclusion": "We conclude $1.20 per common share.",
                    # other sections omitted → blanked, not missing
                }
            }
        ]
    )
    monkeypatch.setattr(_common, "chat", chat)
    resp = client.post(
        "/ai/v1/pipelines/report_narrative",
        json={
            "valuation": {"company_name": "Acme", "currency": "USD"},
            "calculation": {"fmv_per_share": 1.20, "equity_value": 12_000_000},
            "methodology": {"approaches": ["opm_backsolve"], "weights": {"weight_opm": 1.0}},
        },
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    keys = [s["key"] for s in result["sections"]]
    assert keys == list(result["section_keys"])
    assert len(result["sections"]) == 8
    execs = next(s for s in result["sections"] if s["key"] == "executive_summary")
    assert "1.20" in execs["body"]
    market = next(s for s in result["sections"] if s["key"] == "market_approach")
    assert market["body"] == ""  # omitted section is blank, still present
    assert market["title"]  # human title preserved


# ── assumptions ───────────────────────────────────────────────────────────────
def test_assumptions_normalizes_recommendations(monkeypatch, client):
    chat = seq_chat(
        [
            {
                "recommendations": {
                    "dlom": {
                        "suggested_value": "22%",
                        "range": {"low": 18, "high": 28},
                        "reasoning": "Early-stage, ~3y to liquidity.",
                        "benchmarks": ["Finnerty model 20-25%", "Stout Restricted Stock Study"],
                    },
                    "approach_weights": {
                        "value": "100% OPM backsolve",
                        "range": [0, 1],
                        "reasoning": "Recent priced round.",
                    },
                },
                "notes": "DLOM is the key call.",
            }
        ]
    )
    monkeypatch.setattr(_common, "chat", chat)
    resp = client.post(
        "/ai/v1/pipelines/assumptions",
        json={"valuation": {"company_name": "Acme"}, "comparables": [{"ticker": "DDOG"}]},
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    recs = {r["key"]: r for r in result["recommendations"]}
    assert set(recs) == set(result["recommendation_keys"])
    assert recs["dlom"]["suggested_value"] == "22%"
    assert recs["dlom"]["range"] == {"low": 18.0, "high": 28.0}
    assert len(recs["dlom"]["benchmarks"]) == 2
    # list-form range coerced to low/high
    assert recs["approach_weights"]["range"] == {"low": 0.0, "high": 1.0}
    # volatility not addressed by the model → present but empty
    assert recs["volatility"]["suggested_value"] == ""
    assert result["notes"].startswith("DLOM")


# ── audit_defense ─────────────────────────────────────────────────────────────
def test_audit_defense_builds_qa_and_weaknesses(monkeypatch, client):
    chat = seq_chat(
        [
            {
                "challenges": [
                    {
                        "topic": "DLOM",
                        "question": "Why is the DLOM only 22%?",
                        "response": "Supported by the Finnerty model at a 3-year term.",
                        "evidence": ["3-year time to exit", "45% volatility"],
                        "severity": "high",
                    },
                    {"question": "Is the discount rate reasonable?", "answer": "Yes, built up from CAPM.", "severity": "bogus"},
                    {"response": "orphan with no question — dropped"},
                ],
                "weaknesses": [
                    {"area": "Volatility source", "assessment": "Relies on few comps.", "severity": "medium"},
                    "Projections are aggressive",
                ],
                "additional_documentation": ["Board minutes approving the round", "Signed term sheet"],
                "overall_assessment": "Defensible with minor gaps.",
            }
        ]
    )
    monkeypatch.setattr(_common, "chat", chat)
    resp = client.post(
        "/ai/v1/pipelines/audit_defense",
        json={"valuation": {"company_name": "Acme"}, "calculation": {"fmv_per_share": 1.2}},
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert len(result["challenges"]) == 2  # orphan without a question dropped
    assert result["challenges"][0]["severity"] == "high"
    assert result["challenges"][1]["severity"] == "medium"  # invalid severity normalized
    assert result["challenges"][1]["response"] == "Yes, built up from CAPM."  # 'answer' alias
    assert len(result["weaknesses"]) == 2
    assert result["weaknesses"][1]["area"] == "Projections are aggressive"  # string form
    assert len(result["additional_documentation"]) == 2
    assert result["overall_assessment"].startswith("Defensible")


# ── roll_forward ──────────────────────────────────────────────────────────────
def test_roll_forward_whitelists_prepopulated_inputs(monkeypatch, client):
    chat = seq_chat(
        [
            {
                "material_changes": [
                    {"area": "funding", "change": "Raised a Series B", "impact": "Higher equity value"},
                    "Revenue doubled",
                ],
                "assumption_dispositions": [
                    {"assumption": "DLOM", "disposition": "update", "reasoning": "Closer to exit."},
                    {"assumption": "Volatility", "disposition": "bogus", "reasoning": "n/a"},
                ],
                "prepopulated_inputs": {
                    "shares_outstanding_common": "6,000,000",
                    "revenue_ltm": 10_000_000,
                    "made_up_key": 999,
                    "cash": None,
                },
                "recommended_adjustments": ["Refresh the volatility set", "Re-run the backsolve"],
                "summary": "Materially higher value since the prior date.",
            }
        ]
    )
    monkeypatch.setattr(_common, "chat", chat)
    resp = client.post(
        "/ai/v1/pipelines/roll_forward",
        json={
            "valuation": {"company_name": "Acme"},
            "prior_valuation": {"fmv_per_share": 0.9},
            "new_data": {"revenue_ltm": 10_000_000},
        },
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    inputs = result["prepopulated_inputs"]
    assert inputs["shares_outstanding_common"] == 6_000_000  # string coerced
    assert inputs["revenue_ltm"] == 10_000_000
    assert "made_up_key" not in inputs  # hallucinated key blocked
    assert "cash" not in inputs  # null dropped
    assert len(result["material_changes"]) == 2
    assert result["material_changes"][1]["area"] == "Revenue doubled"  # string form
    disp = {d["assumption"]: d["disposition"] for d in result["assumption_dispositions"]}
    assert disp["DLOM"] == "update"
    assert disp["Volatility"] == "review"  # invalid disposition normalized
    assert len(result["recommended_adjustments"]) == 2


# ── routing / registry ────────────────────────────────────────────────────────
def test_agents_registered_in_root(client):
    pipelines = client.get("/").json()["pipelines"]
    for name in ("cap_table", "comp_selection", "report_narrative", "assumptions", "audit_defense", "roll_forward"):
        assert name in pipelines


def test_agent_prompt_override_applies(monkeypatch, client):
    chat = seq_chat([{"sections": {}}])
    monkeypatch.setattr(_common, "chat", chat)
    resp = client.post(
        "/ai/v1/pipelines/report_narrative",
        json={
            "valuation": {"company_name": "Acme"},
            "calculation": {"fmv_per_share": 1.0},
            "prompt": {"system": "Terse analyst. JSON only.", "model": "meta-llama/llama-3.3-70b-instruct:free"},
        },
    )
    assert resp.status_code == 200
    assert chat.calls[0]["system"] == "Terse analyst. JSON only."
    assert chat.calls[0]["model"] == "meta-llama/llama-3.3-70b-instruct:free"
    assert resp.json()["model"] == "meta-llama/llama-3.3-70b-instruct:free"


# ── _common helpers ───────────────────────────────────────────────────────────
def test_clamp_confidence_folds_percentages():
    assert _common.clamp_confidence(0.9) == 0.9
    assert _common.clamp_confidence(85) == 0.85  # 0-100 scale folded
    assert _common.clamp_confidence("nope") is None
    # Out of range is refused rather than clamped — see the docstring, and
    # tests/test_confidence_scores.py for why.
    assert _common.clamp_confidence(-1) is None
    assert _common.clamp_confidence(9999) is None


def test_str_list_drops_blanks():
    assert _common.str_list(["a", "", "  ", "b"]) == ["a", "b"]
    assert _common.str_list("not a list") == []
