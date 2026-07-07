"""Summarize-attachments pipeline tests (mocked OpenRouter)."""

import base64
import json

from app import pipelines
from app.openrouter import LlmResult


def _doc(filename: str, text: str, kind: str = "projections") -> dict:
    return {
        "id": filename,
        "filename": filename,
        "kind": kind,
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


COMPLETION = {
    "summaries": [
        {
            "filename": "forecast.txt",
            "summary": "Three-year revenue forecast reaching $12M ARR.",
            "key_figures": ["FY27 revenue $12,000,000", "burn $250k/mo"],
        },
        {"filename": "made_up.txt", "summary": "Not in the corpus."},
        "garbage-entry",
    ],
    "overall": "Early-stage SaaS with aggressive growth assumptions.",
}


def test_summarize_result_schema(monkeypatch):
    captured: dict = {}

    def fake_chat(system, user, *, model=None, client=None):
        captured["system"], captured["model"] = system, model
        return LlmResult(model="test/model", content=json.dumps(COMPLETION))

    monkeypatch.setattr(pipelines, "chat", fake_chat)

    model, result = pipelines.run_summarize(
        {
            "valuation": {"company_name": "Acme", "kind": "409a"},
            "documents": [_doc("forecast.txt", "FY27 revenue 12,000,000")],
        }
    )
    assert model == "test/model"
    assert result["documents_reviewed"] == ["forecast.txt"]
    assert result["overall"].startswith("Early-stage")

    [known, unknown] = result["summaries"]  # garbage entry dropped
    assert known["filename"] == "forecast.txt"
    assert known["kind"] == "projections"  # joined back to the uploaded doc
    assert known["key_figures"] == ["FY27 revenue $12,000,000", "burn $250k/mo"]
    assert unknown["kind"] == "other"  # filename the model invented


def test_summarize_registered_and_honors_prompt_override(monkeypatch):
    assert "summarize" in pipelines.PIPELINES

    captured: dict = {}

    def fake_chat(system, user, *, model=None, client=None):
        captured["system"], captured["model"] = system, model
        return LlmResult(model="custom/model", content="{}")

    monkeypatch.setattr(pipelines, "chat", fake_chat)
    pipelines.run_summarize(
        {
            "valuation": {},
            "documents": [],
            "prompt": {"system": "Custom summarizer.", "model": "custom/model"},
        }
    )
    assert captured["system"] == "Custom summarizer."
    assert captured["model"] == "custom/model"
