"""Transient-failure retry policy for the OpenRouter client (audit P2-8).

Connect/transport errors and 5xx responses should be retried a couple of times
with exponential backoff before the client falls through to the next candidate
model. 4xx responses (including 429) are NOT retried here — model fallback
already handles those.
"""

import httpx
import pytest

from app import openrouter
from app.openrouter import LlmResult, OpenRouterError, chat


class _Response:
    def __init__(self, status_code=200, completion='{"ok": true}', usage=None):
        self.status_code = status_code
        self._completion = completion
        self._usage = usage or {"prompt_tokens": 3, "completion_tokens": 2}
        self.text = "error body" if status_code != 200 else completion

    def json(self):
        return {
            "model": "test/model",
            "choices": [{"message": {"content": self._completion}}],
            "usage": self._usage,
        }


class _ScriptedClient:
    """Returns/raises a scripted sequence of outcomes, one per POST.

    Each entry is either an int status code, an Exception to raise, or a
    ready-made _Response.
    """

    def __init__(self, outcomes):
        self._outcomes = list(outcomes)
        self.calls = 0

    def post(self, url, headers=None, json=None):  # noqa: A002 - httpx signature
        self.calls += 1
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, int):
            return _Response(status_code=outcome)
        return outcome


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    # Pin to a single model so retries — not model fallback — are what's exercised.
    monkeypatch.setenv("OPENROUTER_MODEL", "solo/model")
    # Neutralise the real backoff sleep so tests are instant.
    monkeypatch.setattr(openrouter.time, "sleep", lambda _s: None)
    openrouter._budget._used = 0
    yield
    openrouter._budget._used = 0


def _configured_only_solo(monkeypatch):
    # Ensure exactly one candidate model, so a success/failure isn't masked by
    # falling through to another default model.
    monkeypatch.setattr(openrouter, "configured_models", lambda preferred=None: ["solo/model"])


def test_retries_on_connect_error_then_succeeds(monkeypatch):
    _configured_only_solo(monkeypatch)
    client = _ScriptedClient([httpx.ConnectError("refused"), _Response()])
    result = chat("sys", "user", client=client)
    assert isinstance(result, LlmResult)
    assert client.calls == 2  # one failure + one success


def test_retries_on_5xx_then_succeeds(monkeypatch):
    _configured_only_solo(monkeypatch)
    client = _ScriptedClient([503, _Response()])
    result = chat("sys", "user", client=client)
    assert isinstance(result, LlmResult)
    assert client.calls == 2


def test_gives_up_after_max_retries_on_persistent_connect_error(monkeypatch):
    _configured_only_solo(monkeypatch)
    # 3 attempts total = 1 initial + MAX_RETRIES(2). All fail → OpenRouterError.
    client = _ScriptedClient([httpx.ConnectError("x")] * (openrouter.MAX_RETRIES + 1))
    with pytest.raises(OpenRouterError):
        chat("sys", "user", client=client)
    assert client.calls == openrouter.MAX_RETRIES + 1


def test_gives_up_after_max_retries_on_persistent_5xx(monkeypatch):
    _configured_only_solo(monkeypatch)
    client = _ScriptedClient([500] * (openrouter.MAX_RETRIES + 1))
    with pytest.raises(OpenRouterError):
        chat("sys", "user", client=client)
    assert client.calls == openrouter.MAX_RETRIES + 1


def test_does_not_retry_on_4xx(monkeypatch):
    _configured_only_solo(monkeypatch)
    # A 400/429 is a non-transient response: the model is tried exactly once and
    # then the candidate loop moves on (here, straight to the error).
    client = _ScriptedClient([429])
    with pytest.raises(OpenRouterError):
        chat("sys", "user", client=client)
    assert client.calls == 1


def test_backoff_is_exponential(monkeypatch):
    _configured_only_solo(monkeypatch)
    slept: list[float] = []
    monkeypatch.setattr(openrouter.time, "sleep", lambda s: slept.append(s))
    client = _ScriptedClient([500, 503, _Response()])
    chat("sys", "user", client=client)
    # Two retries → two backoff sleeps that double: base * 2**0, base * 2**1.
    base = openrouter.RETRY_BACKOFF_BASE_S
    assert slept == [base, base * 2]
