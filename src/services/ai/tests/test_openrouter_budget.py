"""Token ceiling / budget accounting for the OpenRouter client (audit B-2 P2)."""

import json

import pytest

from app import openrouter
from app.openrouter import LlmResult, TokenBudgetExceeded, chat, max_output_tokens, tokens_used


class _FakeResponse:
    def __init__(self, payload):
        self.status_code = 200
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _FakeClient:
    """Records the JSON body of the last request and returns a canned completion."""

    def __init__(self, completion="{}", usage=None):
        self.last_json = None
        self._completion = completion
        self._usage = usage or {"prompt_tokens": 10, "completion_tokens": 5}

    def post(self, url, headers=None, json=None):  # noqa: A002 - httpx signature
        self.last_json = json
        return _FakeResponse(
            {
                "model": "test/model",
                "choices": [{"message": {"content": self._completion}}],
                "usage": self._usage,
            }
        )


@pytest.fixture(autouse=True)
def _reset_budget(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    openrouter._budget._used = 0
    yield
    openrouter._budget._used = 0


def test_max_output_tokens_default_and_override(monkeypatch):
    monkeypatch.delenv("OPENROUTER_MAX_TOKENS", raising=False)
    assert max_output_tokens() == 2000
    monkeypatch.setenv("OPENROUTER_MAX_TOKENS", "512")
    assert max_output_tokens() == 512
    monkeypatch.setenv("OPENROUTER_MAX_TOKENS", "0")
    assert max_output_tokens() == 2000


def test_chat_sends_max_tokens_and_records_usage(monkeypatch):
    monkeypatch.setenv("OPENROUTER_MAX_TOKENS", "256")
    client = _FakeClient(completion='{"ok": true}')
    result = chat("sys", "user", client=client)
    assert isinstance(result, LlmResult)
    assert client.last_json["max_tokens"] == 256
    assert result.prompt_tokens == 10
    assert result.completion_tokens == 5
    assert result.total_tokens == 15
    assert tokens_used() == 15


def test_budget_exhaustion_raises_before_spending(monkeypatch):
    monkeypatch.setenv("OPENROUTER_TOKEN_BUDGET", "20")
    client = _FakeClient()
    # First call spends 15 (<20), allowed.
    chat("sys", "user", client=client)
    assert tokens_used() == 15
    # Budget now exhausted (15 >= 20 is false, but next check: 15 < 20 passes,
    # spends to 30). Third call is blocked.
    chat("sys", "user", client=client)
    assert tokens_used() == 30
    with pytest.raises(TokenBudgetExceeded):
        chat("sys", "user", client=client)


def test_unset_budget_is_unlimited(monkeypatch):
    monkeypatch.delenv("OPENROUTER_TOKEN_BUDGET", raising=False)
    client = _FakeClient()
    for _ in range(5):
        chat("sys", "user", client=client)
    assert tokens_used() == 75
