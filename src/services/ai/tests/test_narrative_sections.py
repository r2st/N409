"""The narrative agent's section list, when the caller supplies one.

The valuation service resolves the narrative prompt library (migration 0114 —
base rows plus the report type's overrides) and ships the winners as
`narrative_sections`. These tests pin the contract between the two: what the
agent drafts, what it asks the model for, and what it falls back to when the
field is absent or unusable.

`chat` is monkeypatched, so no network and no OpenRouter key are needed.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.agents import _common
from app.agents.report_narrative import SECTIONS, sections_for
from app.main import app
from app.openrouter import LlmResult


@pytest.fixture
def client():
    return TestClient(app)


def capture_chat(payload):
    """A chat stub that records the prompt it was handed."""

    def _chat(system, user, *, model=None, client=None):
        _chat.calls.append({"system": system, "user": user})
        return LlmResult(model=model or "test/fake-model", content=json.dumps(payload))

    _chat.calls = []
    return _chat


QSBS_SECTIONS = [
    {"key": "executive_summary", "label": "Executive Summary",
     "guidance": "whether the stock qualifies as QSBS under IRC 1202"},
    {"key": "gross_asset_test", "label": "Gross Assets Test",
     "guidance": "the aggregate gross assets against the $50m ceiling"},
    {"key": "conclusion", "label": "Conclusion",
     "guidance": "the qualification conclusion and the gain exclusion available"},
]


def run(client, chat, monkeypatch, **payload):
    monkeypatch.setattr(_common, "chat", chat)
    body = {
        "valuation": {"company_name": "Acme", "kind": "qsbs", "currency": "USD"},
        "calculation": {"fmv_per_share": 1.20, "equity_value": 12_000_000},
        **payload,
    }
    resp = client.post("/ai/v1/pipelines/report_narrative", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["result"]


# ── the supplied library wins ────────────────────────────────────────────────
def test_supplied_sections_replace_the_builtin_eight(client, monkeypatch):
    chat = capture_chat({"sections": {"executive_summary": "The stock qualifies."}})
    result = run(client, chat, monkeypatch, narrative_sections=QSBS_SECTIONS)

    keys = [s["key"] for s in result["sections"]]
    assert keys == ["executive_summary", "gross_asset_test", "conclusion"]
    assert keys == result["section_keys"]
    # The whole point of the override: a §1202 memorandum has no marketability
    # discount to discuss.
    assert "dlom_analysis" not in keys


def test_supplied_guidance_reaches_the_model(client, monkeypatch):
    chat = capture_chat({"sections": {}})
    run(client, chat, monkeypatch, narrative_sections=QSBS_SECTIONS)

    user = chat.calls[0]["user"]
    assert "the aggregate gross assets against the $50m ceiling" in user
    # ...and the 409A guidance it displaced does not.
    assert "Discount for Lack of Marketability" not in user


def test_labels_are_preserved_and_omitted_sections_blanked(client, monkeypatch):
    chat = capture_chat({"sections": {"conclusion": "It qualifies in full."}})
    result = run(client, chat, monkeypatch, narrative_sections=QSBS_SECTIONS)

    by_key = {s["key"]: s for s in result["sections"]}
    assert by_key["gross_asset_test"]["title"] == "Gross Assets Test"
    # Present-but-empty, never a missing key — the report template indexes by key.
    assert by_key["gross_asset_test"]["body"] == ""
    assert by_key["conclusion"]["body"] == "It qualifies in full."


def test_ordering_follows_the_supplied_list(client, monkeypatch):
    # The service has already applied sort_order; the agent must not re-sort.
    reordered = list(reversed(QSBS_SECTIONS))
    chat = capture_chat({"sections": {}})
    result = run(client, chat, monkeypatch, narrative_sections=reordered)
    assert [s["key"] for s in result["sections"]] == [s["key"] for s in reordered]


# ── falling back ─────────────────────────────────────────────────────────────
def test_absent_field_falls_back_to_the_builtin_sections(client, monkeypatch):
    chat = capture_chat({"sections": {}})
    result = run(client, chat, monkeypatch)
    assert result["section_keys"] == [k for k, _t, _g in SECTIONS]
    assert len(result["sections"]) == 8


@pytest.mark.parametrize(
    "supplied",
    [
        "not a list",
        [],
        [{"label": "No key"}],
        [{"key": "no_guidance", "label": "No guidance"}],
        [{"key": "", "guidance": "empty key"}],
        ["not a dict"],
    ],
    ids=["wrong-type", "empty", "no-key", "no-guidance", "blank-key", "not-a-dict"],
)
def test_unusable_input_falls_back_rather_than_drafting_nothing(supplied):
    # An un-migrated database should still produce a complete 409A narrative,
    # not a report with no prose in it.
    assert sections_for({"narrative_sections": supplied}) == SECTIONS


def test_partially_usable_input_keeps_the_usable_rows():
    spec = sections_for(
        {
            "narrative_sections": [
                {"key": "good", "label": "Good", "guidance": "say something"},
                {"key": "bad"},  # no guidance → skipped
            ]
        }
    )
    assert spec == (("good", "Good", "say something"),)


def test_duplicate_keys_are_collapsed_to_the_first():
    # Resolution upstream guarantees uniqueness; if it ever stops, the report
    # template must not receive the same key twice.
    spec = sections_for(
        {
            "narrative_sections": [
                {"key": "dup", "guidance": "first"},
                {"key": "dup", "guidance": "second"},
            ]
        }
    )
    assert spec == (("dup", "Dup", "first"),)


def test_missing_label_is_titled_from_the_key():
    spec = sections_for({"narrative_sections": [{"key": "gross_asset_test", "guidance": "g"}]})
    assert spec[0][1] == "Gross Asset Test"
