"""The two chain endings that reach a caller as a 4xx, and so were logged nowhere.

R428, methodology M11. `errors.py` writes the rule down and it is right about
the population it was written for: "4xx stays unlogged. Those describe the
request, the caller was told, and their rate is set by whoever is making the
mistakes." Two of this chain's endings are 4xx and neither is that.

* `RateLimited` — every configured candidate answered 429. `llm_http.py` says
  why walking the rest of the chain is theatre: the free allowance is counted
  against the *key*, so a spent quota refuses every model. `main._rate_limited`
  says the rest: the service is "perfectly healthy and merely out of
  allowance". Every AI feature on the platform is then down at once, and the
  remedy is an operator raising the allowance.
* `RequestRejected` — every candidate answered some other 4xx. Its own
  docstring names a retired model id (404) beside the context-length case, and
  a free model id going stale is this deployment's commonest configuration
  fault.

Neither had a record anywhere. The per-attempt warnings in `_post_with_retry`
are about a *candidate*; the chain's verdict — the thing that says which of
these two situations an operator is in — was raised and never written down.
The 5xx endings do get a line, from `install_error_handlers`; these took the
one exit that skips it, and the response they become (429, 422) is excluded
from `UpstreamErrorRate` on the far side of the wire by name.

`warning` is what puts them into `log_degraded_events_total{event,level}` — the
counter reads every warning-or-worse line carrying an `event` — which is the
only channel on this box an alert can be built on. The rules are
`LlmQuotaExhausted` (page) and `LlmModelsRefusingRequests` (ticket).
"""

from __future__ import annotations

import json
import logging

import pytest

from app import bedrock, openrouter
from app.bedrock import BedrockRateLimited, BedrockRequestRejected
from app.observability import JsonLogFormatter
from app.openrouter import RateLimited, RequestRejected, chat


class _Reply:
    def __init__(self, body, *, status: int = 200, headers: dict | None = None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        if isinstance(self._body, str):
            raise json.JSONDecodeError("Expecting value", self._body, 0)
        return self._body


class _Client:
    def __init__(self, replies):
        self._replies = list(replies)

    def post(self, url, headers=None, json=None, timeout=None):  # noqa: A002
        outcome = self._replies.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setattr(openrouter.time, "sleep", lambda _s: None)
    openrouter._budget._used = 0
    yield
    openrouter._budget._used = 0


@pytest.fixture
def two_models(monkeypatch):
    monkeypatch.setattr(openrouter, "configured_models", lambda preferred=None: ["a/one", "b/two"])


def _events(records: list[logging.LogRecord]) -> dict[str, logging.LogRecord]:
    return {getattr(r, "event", ""): r for r in records}


class TestOpenRouter:
    def test_an_exhausted_quota_writes_one_warning_naming_itself(self, two_models, caplog):
        caplog.set_level(logging.WARNING, logger="openrouter")
        client = _Client([_Reply("rate limit", status=429), _Reply("rate limit", status=429)])
        with pytest.raises(RateLimited):
            chat("sys", "user", client=client)

        line = _events(caplog.records)["llm_quota_exhausted"]
        assert line.levelno == logging.WARNING
        assert line.provider == "openrouter"
        # Both candidates were asked, which is what separates a one-model
        # deployment from a whole chain being refused.
        assert line.count == 2
        # The provider's own words, which is what the runbook sends an operator
        # to the journal for.
        assert "rate limit" in line.detail

    def test_a_chain_of_other_4xx_says_so_separately(self, two_models, caplog):
        caplog.set_level(logging.WARNING, logger="openrouter")
        client = _Client([_Reply("no such model", status=404), _Reply("no such model", status=404)])
        with pytest.raises(RequestRejected):
            chat("sys", "user", client=client)

        line = _events(caplog.records)["llm_models_refused"]
        # `status` separates a retired model id from a prompt over the context
        # length, and is the field an operator filters with.
        assert line.status == 404
        assert line.provider == "openrouter"

    def test_a_mixed_chain_stays_out_of_both(self, two_models, caplog):
        """`_classify`'s own rule: "a bad afternoon, and the generic error is
        the honest one" — and that ending is a 503, which is already logged."""
        caplog.set_level(logging.WARNING, logger="openrouter")
        # Three replies for the second candidate: a 5xx is retried in place
        # (`MAX_RETRIES`) before the chain gives up on it.
        client = _Client(
            [_Reply("rate limit", status=429)] + [_Reply("boom", status=500)] * 3
        )
        with pytest.raises(openrouter.OpenRouterError):
            chat("sys", "user", client=client)

        seen = _events(caplog.records)
        assert "llm_quota_exhausted" not in seen
        assert "llm_models_refused" not in seen

    def test_a_chain_that_answers_is_silent(self, two_models, caplog):
        caplog.set_level(logging.WARNING, logger="openrouter")
        body = {
            "model": "a/one",
            "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 7, "completion_tokens": 5},
        }
        chat("sys", "user", client=_Client([_Reply(body)]))
        assert _events(caplog.records).keys() <= {""}


class TestBedrock:
    """The second provider, which R246 found escaping three guards written for
    the first. A provider that answers a spent quota in silence is that shape
    again, so it gets the same two events under the same spellings."""

    def test_a_throttle_writes_the_same_event(self, caplog):
        caplog.set_level(logging.WARNING, logger="bedrock")
        bedrock._announce_refusal(BedrockRateLimited("anthropic.x: HTTP 429", 30), "anthropic.x")

        line = _events(caplog.records)["llm_quota_exhausted"]
        # `provider` is what tells the two apart once they share an event name,
        # and they need telling apart: one is answered by an OpenRouter key and
        # the other by an AWS quota increase.
        assert line.provider == "bedrock"
        assert line.model == "anthropic.x"

    def test_a_refusal_carries_its_status(self, caplog):
        caplog.set_level(logging.WARNING, logger="bedrock")
        bedrock._announce_refusal(
            BedrockRequestRejected("anthropic.x: HTTP 400", 400), "anthropic.x"
        )
        assert _events(caplog.records)["llm_models_refused"].status == 400

    def test_a_5xx_is_left_to_the_error_handler(self, caplog):
        caplog.set_level(logging.WARNING, logger="bedrock")
        bedrock._announce_refusal(bedrock.BedrockError("anthropic.x: HTTP 503"), "anthropic.x")
        assert _events(caplog.records).keys() <= {""}


def test_every_field_survives_the_formatter():
    """The half a `caplog` assertion cannot see.

    `observability._EXTRA_KEYS` is an allowlist, so a key it does not name is
    dropped between the call site and disk with nothing to say so — which is
    the failure this round found one of in the engine tier. Asserting on the
    record proves the call site; asserting on the formatted line proves the
    field reaches the journal an operator greps.
    """
    record = logging.LogRecord("openrouter", logging.WARNING, __file__, 1, "refused", None, None)
    record.event = "llm_models_refused"
    record.provider = "openrouter"
    record.model = "a/one"
    record.status = 404
    record.count = 2
    record.detail = "a/one: HTTP 404 no such model"
    parsed = json.loads(JsonLogFormatter("ai").format(record))
    for field in ("event", "provider", "model", "status", "count", "detail"):
        assert field in parsed, field
