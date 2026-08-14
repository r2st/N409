"""Company-profile agent — chat is monkeypatched, so no network and no key.

Two properties carry the feature and are worth reading first:

  * a classification code that is not well-formed digits is dropped, not
    stored. It reaches the comparable screen, which ranks a malformed SIC
    against no universe row at all — presenting as "no comparable companies
    found" rather than as the bad input it is; and

  * the company's name never reaches the model. This agent exists *because*
    the platform refuses to look a client up on the web, and a prompt that
    quietly carried the name would give back the answer that refusal was
    meant to prevent, sourced to nothing.
"""

import base64
import json

import pytest
from fastapi.testclient import TestClient

from app.agents import _common, company_profile
from app.main import app
from app.openrouter import LlmResult


@pytest.fixture
def client():
    return TestClient(app)


def one_chat(response, default_model="test/fake-model"):
    payload = response if isinstance(response, str) else json.dumps(response)

    def _chat(system, user, *, model=None, client=None):
        _chat.calls.append({"system": system, "user": user, "model": model})
        return LlmResult(model=model or default_model, content=payload)

    _chat.calls = []
    return _chat


def doc(filename, kind, text):
    return {
        "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "filename": filename,
        "kind": kind,
        "content_type": "text/plain",
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


PROFILE = {
    "business_description": "The company sells a subscription analytics platform to mid-market retailers.",
    "industry": "Retail analytics software",
    "sic_codes": [
        {"code": "7372", "title": "Prepackaged Software", "rationale": "Licensed software product."},
        {"code": "7379", "title": "Computer Related Services", "rationale": "Managed onboarding."},
    ],
    "naics_codes": [{"code": "511210", "title": "Software Publishers", "rationale": "Publishes SaaS."}],
    "key_metrics": {
        "revenue": {"value": "$4.2M ARR", "source_document": "deck.pdf", "confidence": 0.9},
        "employees": {"value": "31", "source_document": "deck.pdf", "confidence": 0.8},
        "founded_year": {"value": "2019", "source_document": "deck.pdf", "confidence": 1},
        "stage": {"value": "Series A", "source_document": "deck.pdf", "confidence": 0.7},
    },
    "documents_used": ["deck.pdf"],
    "gaps": ["The documents do not state the customer count."],
    "confidence": 0.82,
}


def run(client, payload=None):
    body = {
        "valuation": {"company_name": "Acme Robotics", "kind": "409a", "currency": "USD"},
        "documents": [doc("deck.pdf", "pitch_deck", "Acme Robotics sells analytics to retailers.")],
    }
    body.update(payload or {})
    return client.post("/ai/v1/pipelines/company_profile", json=body)


def test_drafts_a_profile_from_the_documents(monkeypatch, client):
    monkeypatch.setattr(_common, "chat", one_chat(PROFILE))
    resp = run(client)
    assert resp.status_code == 200
    result = resp.json()["result"]

    assert "subscription analytics platform" in result["business_description"]
    assert result["industry"] == "Retail analytics software"
    assert result["confidence"] == 0.82
    assert result["documents_reviewed"] == ["deck.pdf"]
    assert result["gaps"] == ["The documents do not state the customer count."]


def test_lifts_the_leading_classification_out_of_the_ranked_list(monkeypatch, client):
    monkeypatch.setattr(_common, "chat", one_chat(PROFILE))
    result = run(client).json()["result"]

    assert [c["code"] for c in result["sic_codes"]] == ["7372", "7379"]
    assert result["sic_code"] == "7372"
    assert result["naics_code"] == "511210"


def test_drops_a_malformed_classification_code_rather_than_storing_it(monkeypatch, client):
    monkeypatch.setattr(
        _common,
        "chat",
        one_chat(
            {
                **PROFILE,
                "sic_codes": [
                    {"code": "SIC 7372", "title": "Prefixed"},
                    {"code": "73721", "title": "Too long for a SIC"},
                    {"code": "", "title": "Empty"},
                    {"code": "7372", "title": "Prepackaged Software"},
                ],
                "naics_codes": [{"code": "abc123", "title": "Not digits"}],
            }
        ),
    )
    result = run(client).json()["result"]

    assert [c["code"] for c in result["sic_codes"]] == ["7372"]
    assert result["sic_code"] == "7372"
    assert result["naics_codes"] == []
    assert result["naics_code"] is None


def test_keeps_only_the_first_of_a_repeated_code(monkeypatch, client):
    monkeypatch.setattr(
        _common,
        "chat",
        one_chat(
            {
                **PROFILE,
                "sic_codes": [
                    {"code": "7372", "title": "First"},
                    {"code": "7372", "title": "Duplicate"},
                ],
            }
        ),
    )
    result = run(client).json()["result"]
    assert [c["title"] for c in result["sic_codes"]] == ["First"]


def test_caps_the_ranked_candidates(monkeypatch, client):
    monkeypatch.setattr(
        _common,
        "chat",
        one_chat(
            {
                **PROFILE,
                "sic_codes": [{"code": str(7370 + i), "title": f"Code {i}"} for i in range(6)],
            }
        ),
    )
    result = run(client).json()["result"]
    assert len(result["sic_codes"]) == company_profile.MAX_CODES


def test_returns_every_metric_key_even_when_the_documents_answer_none(monkeypatch, client):
    monkeypatch.setattr(_common, "chat", one_chat({**PROFILE, "key_metrics": {}}))
    result = run(client).json()["result"]

    assert [m["key"] for m in result["key_metrics"]] == list(company_profile.METRIC_KEYS)
    # A metric the documents did not answer is present and null — "the deck does
    # not say" is a finding, and a missing key is one nobody sees.
    assert all(m["value"] is None for m in result["key_metrics"])


def test_normalises_a_percentage_confidence(monkeypatch, client):
    monkeypatch.setattr(
        _common,
        "chat",
        one_chat(
            {
                **PROFILE,
                "confidence": 90,
                "key_metrics": {"revenue": {"value": "$1M", "confidence": 75}},
            }
        ),
    )
    result = run(client).json()["result"]
    assert result["confidence"] == 0.9
    revenue = next(m for m in result["key_metrics"] if m["key"] == "revenue")
    assert revenue["confidence"] == 0.75


def test_degrades_rather_than_failing_when_the_model_returns_prose(monkeypatch, client):
    monkeypatch.setattr(_common, "chat", one_chat("I could not read those documents."))
    resp = run(client)
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["business_description"] == ""
    assert result["sic_code"] is None
    assert [m["key"] for m in result["key_metrics"]] == list(company_profile.METRIC_KEYS)


def test_the_company_name_never_reaches_the_model(monkeypatch, client):
    chat = one_chat(PROFILE)
    monkeypatch.setattr(_common, "chat", chat)
    run(
        client,
        {
            "documents": [
                doc("Acme Robotics deck.pdf", "pitch_deck", "Acme Robotics sells analytics."),
            ]
        },
    )

    sent = chat.calls[0]["user"] + chat.calls[0]["system"]
    assert "Acme Robotics" not in sent
    # The redaction placeholder is what stands in its place, and the prompt is
    # written to be answerable from the documents without the name.
    assert "[COMPANY]" in sent


def test_honours_the_registry_prompt_and_model_override(monkeypatch, client):
    chat = one_chat(PROFILE)
    monkeypatch.setattr(_common, "chat", chat)
    run(client, {"prompt": {"system": "Custom profile persona.", "model": "vendor/tuned"}})

    assert chat.calls[0]["system"] == "Custom profile persona."
    assert chat.calls[0]["model"] == "vendor/tuned"


def test_reports_the_documents_it_was_given(monkeypatch, client):
    monkeypatch.setattr(_common, "chat", one_chat(PROFILE))
    result = run(
        client,
        {
            "documents": [
                doc("deck.pdf", "pitch_deck", "narrative"),
                doc("financials.csv", "income_statement", "revenue,4200000"),
            ]
        },
    ).json()["result"]

    assert result["documents_reviewed"] == ["deck.pdf", "financials.csv"]
