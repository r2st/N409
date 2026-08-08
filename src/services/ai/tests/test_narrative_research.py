"""Web-grounded research reaching the narrative agent (design §12.3).

The valuation service ships the live `market_research` rows (migration 0116) as
`market_research`, already filtered to the grounded ones. These tests pin what
the agent does with them: the answers and their URLs reach the model, the block
is bounded, and an absent or unusable field changes nothing about the draft.

`chat` is monkeypatched, so no network and no Perplexity key are needed.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.agents import _common
from app.agents.report_narrative import MAX_RESEARCH_ITEMS, research_block
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


RESEARCH = [
    {
        "topic": "market_conditions",
        "region": "uk",
        "answer": "UK industrial robotics traded at 3.8x forward revenue in Q2 2026.",
        "citations": [
            {"url": "https://example.com/uk-robotics-2026", "title": "UK robotics review"},
            {"url": "https://example.com/lse-multiples"},
        ],
        "retrieved_at": "2026-07-14T09:00:00.000Z",
    },
    {
        "topic": "industry_outlook",
        "region": None,
        "answer": "Sector growth is forecast at 9% CAGR through 2029.",
        "citations": [{"url": "https://example.com/outlook"}],
        "retrieved_at": "2026-07-14T09:05:00.000Z",
    },
]


def run(client, chat, monkeypatch, **payload):
    monkeypatch.setattr(_common, "chat", chat)
    body = {
        "valuation": {"company_name": "Acme", "kind": "409a", "currency": "USD"},
        "calculation": {"fmv_per_share": 1.20, "equity_value": 12_000_000},
        **payload,
    }
    resp = client.post("/ai/v1/pipelines/report_narrative", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["result"]


def test_answers_and_their_urls_reach_the_model(client, monkeypatch):
    chat = capture_chat({"sections": {}})
    run(client, chat, monkeypatch, market_research=RESEARCH)

    user = chat.calls[0]["user"]
    assert "3.8x forward revenue" in user
    assert "9% CAGR" in user
    # The URLs travel with the text. A research paragraph the reviewer cannot
    # follow back to a publisher is worth less than none — it reads as
    # authoritative and is uncheckable.
    assert "https://example.com/uk-robotics-2026" in user
    assert "https://example.com/outlook" in user


def test_the_market_is_named_on_a_region_scoped_answer(client, monkeypatch):
    chat = capture_chat({"sections": {}})
    run(client, chat, monkeypatch, market_research=RESEARCH)

    user = chat.calls[0]["user"]
    assert "[market_conditions · uk]" in user
    assert "[industry_outlook]" in user


def test_retrieval_date_rides_along(client, monkeypatch):
    # A market multiple with no as-of date is not evidence of anything.
    chat = capture_chat({"sections": {}})
    run(client, chat, monkeypatch, market_research=RESEARCH)
    assert "retrieved 2026-07-14" in chat.calls[0]["user"]


def test_the_model_is_told_not_to_go_beyond_the_block(client, monkeypatch):
    chat = capture_chat({"sections": {}})
    run(client, chat, monkeypatch, market_research=RESEARCH)
    assert "do not assert a figure that is not in this block" in chat.calls[0]["user"]


def test_topics_are_recorded_on_the_job(client, monkeypatch):
    chat = capture_chat({"sections": {}})
    result = run(client, chat, monkeypatch, market_research=RESEARCH)
    # "Which research was in front of the model" is the first question asked of
    # a cited paragraph, and the table it would otherwise be answered from is
    # append-only and has since moved on.
    assert result["research_topics"] == ["market_conditions:uk", "industry_outlook"]


def test_absent_or_unusable_research_changes_nothing(client, monkeypatch):
    chat = capture_chat({"sections": {}})
    result = run(client, chat, monkeypatch)
    assert "Market research retrieved" not in chat.calls[0]["user"]
    assert result["research_topics"] == []

    for junk in ("not a list", [], [{"topic": "x"}], [None, 3]):
        assert research_block({"market_research": junk}) == ""


def test_the_block_is_bounded(client, monkeypatch):
    # A narrative call already carries the calculation, the params and the
    # section library; an unbounded research block would crowd them out, and
    # the sections that read research are the ones that would lose.
    many = [
        {
            "topic": f"topic_{i}",
            "region": None,
            "answer": "x" * 6000,
            "citations": [{"url": f"https://example.com/{j}"} for j in range(30)],
            "retrieved_at": "2026-07-14T09:00:00.000Z",
        }
        for i in range(20)
    ]
    block = research_block({"market_research": many})
    assert block.count("[topic_") == MAX_RESEARCH_ITEMS
    assert "x" * 3000 not in block
    assert block.count("https://example.com/") <= MAX_RESEARCH_ITEMS * 8
