"""QA reviewer + plain-English explainer pipelines — OpenRouter monkeypatched."""

import json

import pytest
from fastapi.testclient import TestClient

from app import pipelines
from app.main import app
from app.openrouter import LlmResult


@pytest.fixture
def client():
    return TestClient(app)


def fake_chat(response: dict | str, default_model: str = "test/fake-model"):
    content = response if isinstance(response, str) else json.dumps(response)

    def _chat(system: str, user: str, *, model=None, client=None) -> LlmResult:
        _chat.calls.append({"system": system, "user": user, "model": model})
        return LlmResult(model=model or default_model, content=content)

    _chat.calls = []
    return _chat


CALCULATION = {
    "equity_value": "20000000",
    "fmv_per_share": "2.00",
    "results": {"approaches": {"income": {"value": 20000000}}},
    "inputs": {"params": {"dlom": 0.3}, "inputs": {"volatility": 0.6}},
}


# ── qa ────────────────────────────────────────────────────────────────────────
def test_qa_registered():
    assert "qa" in pipelines.PIPELINES
    assert "explain" in pipelines.PIPELINES


def test_qa_normalizes_findings_and_respects_verdict(monkeypatch, client):
    chat = fake_chat(
        {
            "findings": [
                {"area": "assumptions", "finding": "DLOM near ceiling", "severity": "warn"},
                {"area": "outputs", "finding": "made-up severity", "severity": "catastrophic"},
                {"finding": ""},  # empty finding dropped
            ],
            "assessment": "Mostly sound.",
            "verdict": "warn",
        }
    )
    monkeypatch.setattr(pipelines, "chat", chat)

    resp = client.post(
        "/ai/v1/pipelines/qa",
        json={
            "valuation": {"company_name": "Acme", "kind": "409a"},
            "calculation": CALCULATION,
            "qa_checks": [{"key": "dlom_range", "status": "warn"}],
        },
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["verdict"] == "warn"
    assert len(result["findings"]) == 2
    assert result["findings"][1]["severity"] == "info"  # unknown severity coerced
    # The calculation and the deterministic checks made it into the prompt.
    assert "20000000" in chat.calls[0]["user"]
    assert "dlom_range" in chat.calls[0]["user"]


def test_qa_derives_verdict_from_findings_when_missing(monkeypatch, client):
    chat = fake_chat(
        {
            "findings": [{"area": "outputs", "finding": "FMV inconsistent", "severity": "fail"}],
            "assessment": "Broken.",
            "verdict": "amazing",  # not a legal verdict
        }
    )
    monkeypatch.setattr(pipelines, "chat", chat)
    resp = client.post("/ai/v1/pipelines/qa", json={"valuation": {}, "calculation": CALCULATION})
    assert resp.json()["result"]["verdict"] == "fail"


def test_qa_clean_review_passes(monkeypatch, client):
    monkeypatch.setattr(pipelines, "chat", fake_chat({"findings": [], "assessment": "Clean."}))
    resp = client.post("/ai/v1/pipelines/qa", json={"valuation": {}, "calculation": CALCULATION})
    result = resp.json()["result"]
    assert result["verdict"] == "pass"
    assert result["findings"] == []


# ── explain ───────────────────────────────────────────────────────────────────
def test_explain_normalizes_methodology_and_drivers(monkeypatch, client):
    chat = fake_chat(
        {
            "summary": "Your company was valued at $20M.",
            "methodology": [
                {"approach": "Income approach", "weight": "0.6", "explanation": "Discounts future cash."},
                {"weight": 0.4},  # nameless entry dropped
                {"approach": "Market approach", "weight": None, "explanation": "Compares peers."},
            ],
            "drivers": ["Revenue growth", "Discount rate", 3, "D4", "D5", "D6", "D7", "D8"],
            "caveats": "Not advice.",
        }
    )
    monkeypatch.setattr(pipelines, "chat", chat)

    resp = client.post(
        "/ai/v1/pipelines/explain",
        json={"valuation": {"company_name": "Acme"}, "calculation": CALCULATION},
    )
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["summary"].startswith("Your company")
    assert [m["approach"] for m in result["methodology"]] == ["Income approach", "Market approach"]
    assert result["methodology"][0]["weight"] == 0.6  # string weight parsed
    assert len(result["drivers"]) == 6  # capped
    assert result["drivers"][2] == "3"  # coerced to string
    assert result["caveats"] == "Not advice."


def test_explain_without_calculation_says_so_in_prompt(monkeypatch, client):
    chat = fake_chat({"summary": "", "methodology": [], "drivers": [], "caveats": ""})
    monkeypatch.setattr(pipelines, "chat", chat)
    resp = client.post("/ai/v1/pipelines/explain", json={"valuation": {}})
    assert resp.status_code == 200
    assert "(no calculation provided)" in chat.calls[0]["user"]


def test_qa_prompt_override(monkeypatch):
    captured: dict = {}

    def fake(system, user, *, model=None, client=None):
        captured["system"], captured["model"] = system, model
        return LlmResult(model="custom/model", content="{}")

    monkeypatch.setattr(pipelines, "chat", fake)
    pipelines.run_qa({"valuation": {}, "prompt": {"system": "Harsh reviewer.", "model": "custom/model"}})
    assert captured["system"] == "Harsh reviewer."
    assert captured["model"] == "custom/model"
