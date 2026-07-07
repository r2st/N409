"""PII anonymization tests — redaction must never eat financial figures."""

import base64

from app import pipelines
from app.anonymize import redact
from app.openrouter import LlmResult


def test_redacts_emails_phones_ssn_ein():
    text = (
        "Contact founder@acme.io or call (415) 555-0143 / +1 415-555-0100. "
        "SSN 123-45-6789, EIN 12-3456789."
    )
    redacted, counts = redact(text)
    assert "[EMAIL]" in redacted and "founder@acme.io" not in redacted
    assert redacted.count("[PHONE]") == 2
    assert "[SSN]" in redacted and "123-45-6789" not in redacted
    assert "[EIN]" in redacted and "12-3456789" not in redacted
    assert counts == {"emails": 1, "ssns": 1, "eins": 1, "phones": 2}


def test_financial_figures_survive():
    text = "10000000 common shares, $1,500,000 preference, post-money 20000000.00, 4155550143"
    redacted, counts = redact(text)
    assert redacted == text
    assert counts == {}


def _doc(text: str) -> dict:
    return {
        "id": "d1",
        "filename": "notes.txt",
        "kind": "other",
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


def _mock_chat(monkeypatch, captured: dict):
    def fake_chat(system, user, *, model=None, client=None):
        captured["system"], captured["user"], captured["model"] = system, user, model
        return LlmResult(model="test/model", content='{"gaps": [], "notes": "ok"}')

    monkeypatch.setattr(pipelines, "chat", fake_chat)


def test_pipeline_redacts_corpus_and_reports_counts(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    payload = {"valuation": {"company_name": "Acme"}, "documents": [_doc("email founder@acme.io")]}
    _, result = pipelines.run_missing_data(payload)
    assert "founder@acme.io" not in captured["user"]
    assert result["anonymization"] == {"applied": True, "redacted": {"emails": 1}}


def test_anonymize_can_be_disabled(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    payload = {
        "valuation": {"company_name": "Acme"},
        "documents": [_doc("email founder@acme.io")],
        "options": {"anonymize": False},
    }
    _, result = pipelines.run_missing_data(payload)
    assert "founder@acme.io" in captured["user"]
    assert result["anonymization"] == {"applied": False, "redacted": {}}
