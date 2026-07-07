"""Pipeline tests — OpenRouter is monkeypatched; no network, no key needed."""

import base64
import json

import pytest
from fastapi.testclient import TestClient

from app import pipelines
from app.main import app
from app.openrouter import LlmResult, OpenRouterError, extract_json


@pytest.fixture
def client():
    return TestClient(app)


def fake_chat(response: dict | str, model: str = "test/fake-model"):
    content = response if isinstance(response, str) else json.dumps(response)

    def _chat(system: str, user: str, *, client=None) -> LlmResult:
        _chat.calls.append({"system": system, "user": user})
        return LlmResult(model=model, content=content)

    _chat.calls = []
    return _chat


def doc(filename: str, kind: str, text: str) -> dict:
    return {
        "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "filename": filename,
        "kind": kind,
        "content_type": "text/csv",
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


# ── extract_json robustness ───────────────────────────────────────────────────
def test_extract_json_plain():
    assert extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_fenced():
    assert extract_json('Here you go:\n```json\n{"a": 1}\n```\nHope that helps!') == {"a": 1}


def test_extract_json_embedded_prose():
    assert extract_json('The answer is {"a": {"b": 2}} as requested.') == {"a": {"b": 2}}


def test_extract_json_garbage_raises():
    with pytest.raises(ValueError):
        extract_json("I could not find any data.")


# ── missing_data ──────────────────────────────────────────────────────────────
def test_missing_data_combines_checklist_and_llm(monkeypatch, client):
    chat = fake_chat(
        {
            "gaps": [{"item": "Cap table lacks preference amounts", "why": "x", "severity": "blocking"}],
            "notes": "Solid start.",
        }
    )
    monkeypatch.setattr(pipelines, "chat", chat)

    resp = client.post(
        "/ai/v1/pipelines/missing_data",
        json={
            "valuation": {"company_name": "Acme", "kind": "409a"},
            "params": {"revenue_status": "post_revenue"},
            "documents": [doc("cap.csv", "cap_table", "holder,shares")],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "test/fake-model"
    result = body["result"]
    # cap_table uploaded → not missing; income_statement etc. are.
    missing_kinds = {m["kind"] for m in result["missing_documents"]}
    assert "cap_table" not in missing_kinds
    assert "income_statement" in missing_kinds
    # revenue_status set → not in missing params; exit_timeline is.
    missing_params = {m["field"] for m in result["missing_params"]}
    assert "revenue_status" not in missing_params
    assert "exit_timeline" in missing_params
    assert result["gaps"][0]["severity"] == "blocking"
    # The document text made it into the prompt.
    assert "holder,shares" in chat.calls[0]["user"]


# ── extract ───────────────────────────────────────────────────────────────────
def test_extract_whitelists_and_normalizes(monkeypatch, client):
    chat = fake_chat(
        {
            "engine_inputs": {
                "shares_outstanding_common": "8,000,000",
                "cash": "$1,200,000.50",
                "revenue_ltm": 5000000,
                "made_up_field": 42,
                "debt": None,
                "volatility": "not a number",
            },
            "extractions": [
                {"field": "cash", "value": 1200000.5, "source_document": "bs.csv", "quote": "cash 1,200,000.50", "confidence": 0.9}
            ],
        }
    )
    monkeypatch.setattr(pipelines, "chat", chat)

    resp = client.post(
        "/ai/v1/pipelines/extract",
        json={
            "valuation": {"company_name": "Acme", "currency": "USD"},
            "documents": [doc("bs.csv", "balance_sheet", "cash,1200000.50")],
        },
    )
    assert resp.status_code == 200
    inputs = resp.json()["result"]["engine_inputs"]
    assert inputs["shares_outstanding_common"] == 8_000_000
    assert inputs["cash"] == 1_200_000.5
    assert inputs["revenue_ltm"] == 5_000_000
    assert "made_up_field" not in inputs  # hallucinated keys never reach the engine
    assert "debt" not in inputs  # nulls dropped
    assert "volatility" not in inputs  # unparseable dropped


# ── comparables ───────────────────────────────────────────────────────────────
def test_comparables_normalizes_multiples(monkeypatch, client):
    chat = fake_chat(
        "```json\n"
        + json.dumps(
            {
                "comparables": [
                    {"name": "Datadog", "ticker": "DDOG", "rationale": "obs", "revenue_multiple": 12.5, "ebitda_multiple": None},
                    {"name": "", "ticker": "BAD"},
                    {"name": "Dynatrace", "ticker": "DT", "rationale": "obs", "revenue_multiple": "9.1", "ebitda_multiple": 25},
                ],
                "sector": "Observability SaaS",
                "caveats": "Estimates only.",
            }
        )
        + "\n```"
    )
    monkeypatch.setattr(pipelines, "chat", chat)

    resp = client.post(
        "/ai/v1/pipelines/comparables",
        json={"valuation": {"company_name": "Acme"}, "params": {"business_overview": "APM"}},
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert len(result["comparables"]) == 2  # nameless row dropped
    assert result["comparables"][1]["revenue_multiple"] == 9.1
    assert result["sector"] == "Observability SaaS"


# ── error surface ─────────────────────────────────────────────────────────────
def test_unknown_pipeline_404(client):
    resp = client.post("/ai/v1/pipelines/summarize", json={})
    assert resp.status_code == 404


def test_openrouter_down_is_503(monkeypatch, client):
    def boom(system, user, *, client=None):
        raise OpenRouterError("All models failed")

    monkeypatch.setattr(pipelines, "chat", boom)
    resp = client.post("/ai/v1/pipelines/missing_data", json={"valuation": {}})
    assert resp.status_code == 503


def test_unparseable_completion_degrades_to_notes(monkeypatch, client):
    monkeypatch.setattr(pipelines, "chat", fake_chat("I refuse to answer in JSON."))
    resp = client.post("/ai/v1/pipelines/missing_data", json={"valuation": {}})
    assert resp.status_code == 200
    assert "refuse" in resp.json()["result"]["notes"]


# ── document extraction ───────────────────────────────────────────────────────
def test_pdf_and_text_extraction():
    from pypdf import PdfWriter

    import io

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)

    docs = pipelines.extract_texts(
        [
            {"id": "1", "filename": "blank.pdf", "kind": "other", "content_base64": base64.b64encode(buf.getvalue()).decode()},
            {"id": "2", "filename": "notes.txt", "kind": "other", "content_base64": base64.b64encode("hello world".encode()).decode()},
            {"id": "3", "filename": "broken.pdf", "kind": "other", "content_base64": "!!!not-base64!!!"},
        ]
    )
    assert len(docs) == 3
    assert docs[1].text == "hello world"
    assert "could not extract" in docs[2].text or docs[2].text == ""
