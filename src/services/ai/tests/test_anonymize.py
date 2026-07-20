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
    assert result["anonymization"] == {
        "applied": True,
        "redacted": {"emails": 1},
        "enforced": False,
    }


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


# ── Named-entity redaction (audit B-1 P1) ────────────────────────────────────


def test_redacts_company_and_person_names():
    text = "Acme Robotics Inc raised a round. Prepared by: Ada Lovelace. Dr. Grace Hopper signed."
    redacted, counts = redact(
        text, company_names=["Acme Robotics Inc"], person_names=["Ada Lovelace"]
    )
    assert "Acme Robotics" not in redacted
    assert "[COMPANY]" in redacted
    # "Ada Lovelace" struck both as a known person and via the "Prepared by:" rule.
    assert "Ada Lovelace" not in redacted
    assert "Grace Hopper" not in redacted  # honorific-led name pattern
    assert counts.get("companies", 0) >= 1
    assert counts.get("names", 0) >= 1


def test_redacts_street_and_city_state_zip_addresses():
    text = "Offices at 123 Sand Hill Road and mail to San Mateo, CA 94402."
    redacted, counts = redact(text)
    assert "Sand Hill Road" not in redacted
    assert "94402" not in redacted
    assert counts.get("addresses", 0) == 2


def test_entity_redaction_still_spares_financial_figures():
    text = "Acme shares 10000000 outstanding, post-money 20000000.00, zip-like 94402 alone"
    redacted, counts = redact(text, company_names=["Acme"])
    assert "10000000" in redacted and "20000000.00" in redacted
    # A bare 5-digit number with no City, ST context is not an address.
    assert "94402" in redacted
    assert "addresses" not in counts
    assert redacted.count("[COMPANY]") == 1


def test_company_name_redacted_through_pipeline(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    payload = {
        "valuation": {"company_name": "Zephyr Dynamics"},
        "documents": [_doc("Zephyr Dynamics is a robotics startup.")],
    }
    _, result = pipelines.run_missing_data(payload)
    # The document body's mention of the company is struck; the deliberate
    # "Company: …" prompt header is out of scope (the model needs that context).
    assert "[COMPANY] is a robotics startup" in captured["user"]
    assert result["anonymization"]["redacted"].get("companies") == 1


def test_production_ignores_anonymize_false(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    monkeypatch.setenv("APP_ENV", "production")
    payload = {
        "valuation": {"company_name": "Acme"},
        "documents": [_doc("email founder@acme.io")],
        "options": {"anonymize": False},  # must be ignored in production
    }
    _, result = pipelines.run_missing_data(payload)
    assert "founder@acme.io" not in captured["user"]
    assert result["anonymization"]["applied"] is True
    assert result["anonymization"]["enforced"] is True


def test_anonymize_enforce_env_toggle(monkeypatch):
    from app.anonymize import anonymization_enforced

    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("ANONYMIZE_ENFORCE", raising=False)
    assert anonymization_enforced() is False
    monkeypatch.setenv("ANONYMIZE_ENFORCE", "1")
    assert anonymization_enforced() is True
