"""The router's metrics sink (R444, methodology M11).

Every prompt call passes through `llm_router.chat`, and until this round it
reported nothing a scraper could see: `llm_usage` logs at `info` (below
`log_degraded_events_total`'s WARNING floor), and the three provider token
ledgers only ever reached `/ready`'s JSON body. These assert the sink
contract directly — `main.py`'s wiring of it to real Prometheus instruments
is covered by `test_metrics_endpoint.py`.
"""

from __future__ import annotations

import json

import pytest

from app import bedrock, llm_router, openrouter
from app.llm_router import chat, set_llm_metrics_sink
from app.openrouter import AuthenticationFailed, RateLimited, RequestRejected

GOOD_BODY = {
    "model": "good/model",
    "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 7, "completion_tokens": 5},
}


class _Reply:
    def __init__(self, body, *, status: int = 200, headers: dict | None = None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return self._body


class _Client:
    def __init__(self, replies):
        self._replies = list(replies)

    def post(self, url, headers=None, json=None, timeout=None):  # noqa: A002
        return self._replies.pop(0)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setattr(openrouter.time, "sleep", lambda _s: None)
    monkeypatch.setattr(openrouter, "configured_models", lambda preferred=None: ["solo/model"])
    # `assert_allowed` checks the id against `DEFAULT_MODELS` + env overrides,
    # independent of the `configured_models` patch above — "a/one" is this
    # suite's stand-in for a prompt-registry id, and it must clear that gate
    # the same way a real allow-listed id does.
    monkeypatch.setattr(openrouter, "DEFAULT_MODELS", ["solo/model", "a/one"])
    openrouter._budget._used = 0
    yield
    openrouter._budget._used = 0
    set_llm_metrics_sink(None)


@pytest.fixture
def sink():
    calls = []
    set_llm_metrics_sink(lambda **kwargs: calls.append(kwargs))
    return calls


def test_a_successful_call_reports_provider_model_outcome_and_tokens(sink):
    chat("sys", "user", model="a/one", client=_Client([_Reply(GOOD_BODY)]))
    [call] = sink
    assert call["provider"] == "openrouter"
    assert call["model"] == "a/one"
    assert call["outcome"] == "success"
    assert call["prompt_tokens"] == 7
    assert call["completion_tokens"] == 5
    assert call["duration_s"] >= 0


def test_a_call_with_no_model_reports_the_default_label(sink):
    chat("sys", "user", client=_Client([_Reply(GOOD_BODY)]))
    [call] = sink
    assert call["model"] == "default"


@pytest.mark.parametrize(
    "status,outcome_label",
    [(429, "rate_limited"), (401, "auth_failed"), (400, "request_rejected"), (500, "error")],
    ids=["quota", "bad-key", "unserveable", "outage"],
)
def test_each_failure_kind_is_reported_under_its_own_outcome_label(sink, status, outcome_label):
    client = _Client([_Reply("no", status=status)] * 6)
    with pytest.raises(openrouter.OpenRouterError):
        chat("sys", "user", client=client)
    [call] = sink
    assert call["outcome"] == outcome_label
    assert call["prompt_tokens"] == 0
    assert call["completion_tokens"] == 0


def test_a_bedrock_failure_is_reported_under_the_bedrock_provider(sink, monkeypatch):
    monkeypatch.setattr(
        bedrock,
        "chat",
        lambda *a, **k: (_ for _ in ()).throw(
            bedrock.BedrockAuthenticationFailed("key rejected")
        ),
    )
    with pytest.raises(AuthenticationFailed):
        chat("sys", "user", model="bedrock/anthropic.claude-x")
    [call] = sink
    assert call["provider"] == "bedrock"
    assert call["outcome"] == "auth_failed"


def test_a_bedrock_success_is_reported_under_the_bedrock_provider(sink, monkeypatch):
    result = openrouter.LlmResult(
        model="anthropic.claude-x", content="ok", prompt_tokens=3, completion_tokens=4
    )
    monkeypatch.setattr(bedrock, "chat", lambda *a, **k: result)
    out = chat("sys", "user", model="bedrock/anthropic.claude-x")
    assert out is result
    [call] = sink
    assert call["provider"] == "bedrock"
    assert call["outcome"] == "success"
    assert call["prompt_tokens"] == 3
    assert call["completion_tokens"] == 4


def test_no_sink_installed_leaves_the_call_working() -> None:
    """The default state outside a running service — every test above installs
    one, so this is the only place the null path is exercised."""
    set_llm_metrics_sink(None)
    result = chat("sys", "user", client=_Client([_Reply(GOOD_BODY)]))
    assert result.content == '{"ok": true}'


def test_a_broken_sink_does_not_cost_the_call_it_is_reporting_on(monkeypatch):
    def _broken(**kwargs):
        raise RuntimeError("sink is down")

    set_llm_metrics_sink(_broken)
    result = chat("sys", "user", client=_Client([_Reply(GOOD_BODY)]))
    assert result.content == '{"ok": true}'


def test_a_broken_sink_does_not_swallow_the_original_failure():
    set_llm_metrics_sink(lambda **kwargs: (_ for _ in ()).throw(RuntimeError("sink is down")))
    client = _Client([_Reply("no", status=429)] * 6)
    with pytest.raises(RateLimited):
        chat("sys", "user", client=client)


def test_outcome_labels_match_the_status_mapping_main_uses() -> None:
    """`main.py` answers `RateLimited` 429, `AuthenticationFailed`/plain
    `OpenRouterError` 503, `RequestRejected` 422 — a dashboard built off the
    outcome label should group calls the same way."""
    assert llm_router._outcome_for(RateLimited("out of quota")) == "rate_limited"
    assert llm_router._outcome_for(AuthenticationFailed("bad key")) == "auth_failed"
    assert llm_router._outcome_for(RequestRejected("too long", 400)) == "request_rejected"
    assert llm_router._outcome_for(openrouter.OpenRouterError("boom")) == "error"
    assert llm_router._outcome_for(RuntimeError("unrelated")) == "error"
