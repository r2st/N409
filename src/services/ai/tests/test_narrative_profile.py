"""The structured company profile reaching the narrative agent (migration 0151).

The `company_overview` section has always been asked for "what the company does,
its stage and traction, and the industry it competes in" with nothing in front
of the model that says any of it — a calculation carries share counts and
discount rates, not a business description. So the section was drafted from
whatever the params implied, which is how a company overview ends up describing
a generic company at that revenue.

These tests pin what the agent does with a profile once the valuation service
ships one: the fields reach the model, the block is bounded, an absent profile
changes nothing, and the profile travels through the redactor like everything
else.

`chat` is monkeypatched, so no network and no OpenRouter key are needed.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.agents import _common
from app.agents.report_narrative import MAX_PROFILE_CHARS, profile_block
from app.main import app
from app.openrouter import LlmResult


@pytest.fixture
def client():
    return TestClient(app)


def capture_chat(payload):
    def _chat(system, user, *, model=None, client=None):
        _chat.calls.append({"system": system, "user": user})
        return LlmResult(model=model or "test/fake-model", content=json.dumps(payload))

    _chat.calls = []
    return _chat


PROFILE = {
    "business_description": "Sells a subscription analytics platform to mid-market retailers.",
    "industry": "Retail analytics software",
    "sic_code": "7372",
    "naics_code": "511210",
    "revenue_range": "1m_10m",
    "employee_count": 31,
    "founded_on": "2019-04-01",
}

DRAFT = {"sections": {"company_overview": "The company operates in retail analytics."}}


def narrative_body(extra=None):
    body = {
        "valuation": {"company_name": "Acme Robotics", "kind": "409a", "currency": "USD"},
        "calculation": {"fmv_per_share": 1.23, "results": {}},
    }
    body.update(extra or {})
    return body


# ── the block itself ─────────────────────────────────────────────────────────
def test_block_is_empty_without_a_profile():
    assert profile_block({}) == ""
    assert profile_block({"company_profile": None}) == ""
    assert profile_block({"company_profile": "a string"}) == ""


def test_block_is_empty_when_the_profile_holds_nothing_usable():
    assert profile_block({"company_profile": {}}) == ""
    assert profile_block({"company_profile": {"industry": "  "}}) == ""


def test_block_carries_every_field_under_a_readable_label():
    block = profile_block({"company_profile": PROFILE})
    assert "What the company does: Sells a subscription analytics platform" in block
    assert "Industry: Retail analytics software" in block
    assert "SIC: 7372" in block
    assert "NAICS: 511210" in block
    assert "Employees: 31" in block
    assert "Founded: 2019-04-01" in block


def test_block_omits_a_field_the_profile_does_not_have():
    block = profile_block({"company_profile": {"industry": "Retail analytics software"}})
    assert "Industry: Retail analytics software" in block
    assert "SIC:" not in block


def test_block_bounds_a_long_description():
    block = profile_block(
        {"company_profile": {"business_description": "x" * (MAX_PROFILE_CHARS * 3)}}
    )
    assert len(block) < MAX_PROFILE_CHARS * 2


def test_block_tells_the_model_not_to_contradict_the_profile():
    block = profile_block({"company_profile": PROFILE})
    assert "do not contradict it" in block


# ── reaching the model ───────────────────────────────────────────────────────
def test_profile_reaches_the_narrative_prompt(monkeypatch, client):
    chat = capture_chat(DRAFT)
    monkeypatch.setattr(_common, "chat", chat)

    resp = client.post(
        "/ai/v1/pipelines/report_narrative",
        json=narrative_body({"company_profile": PROFILE}),
    )
    assert resp.status_code == 200

    user = chat.calls[0]["user"]
    assert "Sells a subscription analytics platform" in user
    assert "SIC: 7372" in user


def test_a_narrative_run_without_a_profile_is_unchanged(monkeypatch, client):
    chat = capture_chat(DRAFT)
    monkeypatch.setattr(_common, "chat", chat)

    resp = client.post("/ai/v1/pipelines/report_narrative", json=narrative_body())
    assert resp.status_code == 200
    assert "What the company does:" not in chat.calls[0]["user"]


def test_the_profile_goes_through_the_redactor(monkeypatch, client):
    """A hand-edited description can easily have had the company name typed back
    into it, and the whole point of the redactor is that no path around it
    exists."""
    chat = capture_chat(DRAFT)
    monkeypatch.setattr(_common, "chat", chat)

    client.post(
        "/ai/v1/pipelines/report_narrative",
        json=narrative_body(
            {
                "company_profile": {
                    **PROFILE,
                    "business_description": "Acme Robotics sells analytics to retailers.",
                }
            }
        ),
    )

    user = chat.calls[0]["user"]
    assert "Acme Robotics" not in user
    assert "[COMPANY]" in user
