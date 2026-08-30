"""Every way the LLM integration can fail, and what each one is reported as.

Round 197, methodology M5. The retry tests next door cover failures to *reach*
a model and the answer tests cover a model that replies with something
unusable. Both end in the same place: `OpenRouterError`, a 503, and — on the
valuation side of the wire — a retry followed by a circuit breaker.

That single answer was wrong for most of what actually happens. Three of the
failure modes below are permanent for the request that caused them, and two of
those are routine rather than exceptional:

* an exhausted free-tier allowance 429s *every* candidate, because the quota
  is on the key and not on the model;
* a prompt larger than the context window is a 400 that will be a 400 forever;
* a retired free model id is a 404.

Reported as 503 they were retried (a second full chain, billed again) and then
counted toward a breaker that, five failures in, denies AI to every engagement
on the platform because one of them uploaded a large cap table.

The fourth is quieter and worse: a completion stopped at the output cap used to
be indistinguishable from a finished one, so a truncated answer was parsed,
found unusable, folded into `{"notes": ...}` and returned as an empty-but-
successful pipeline result.
"""

from __future__ import annotations

import json
import time

import httpx
import pytest

from app import openrouter, pipelines
from app.openrouter import (
    AuthenticationFailed,
    DEFAULT_RETRY_AFTER_S,
    LlmResult,
    MAX_RETRY_AFTER_S,
    OpenRouterError,
    RateLimited,
    RequestRejected,
    chat,
)

GOOD_BODY = {
    "model": "good/model",
    "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 7, "completion_tokens": 5},
}


class _Reply:
    """A stand-in for `httpx.Response` — status, body and headers."""

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
        self.calls = 0

    def post(self, url, headers=None, json=None, timeout=None):  # noqa: A002
        self.calls += 1
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


@pytest.fixture
def solo(monkeypatch):
    monkeypatch.setattr(openrouter, "configured_models", lambda preferred=None: ["solo/model"])


# ── The quota, which is on the key and not on the model ──────────────────────


class TestAnExhaustedAllowance:
    def test_every_candidate_refusing_with_429_is_rate_limited_not_an_outage(self, two_models):
        client = _Client([_Reply("rate limit", status=429), _Reply("rate limit", status=429)])
        with pytest.raises(RateLimited):
            chat("sys", "user", client=client)
        assert client.calls == 2

    def test_it_is_still_an_openrouter_error_for_every_existing_caller(self, solo):
        """The agents and the research fallback catch the base class; they must
        keep catching this."""
        client = _Client([_Reply("rate limit", status=429)])
        with pytest.raises(OpenRouterError):
            chat("sys", "user", client=client)

    def test_the_providers_retry_after_is_carried_out_of_the_call(self, solo):
        client = _Client([_Reply("slow down", status=429, headers={"retry-after": "42"})])
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert caught.value.retry_after_s == 42

    def test_a_429_with_no_header_still_quotes_a_wait(self, solo):
        client = _Client([_Reply("slow down", status=429)])
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert caught.value.retry_after_s == DEFAULT_RETRY_AFTER_S

    def test_the_soonest_of_several_waits_is_the_one_reported(self, two_models):
        client = _Client(
            [
                _Reply("no", status=429, headers={"retry-after": "300"}),
                _Reply("no", status=429, headers={"retry-after": "30"}),
            ]
        )
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert caught.value.retry_after_s == 30

    def test_an_http_date_retry_after_is_understood(self, solo):
        when = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(time.time() + 120))
        client = _Client([_Reply("no", status=429, headers={"retry-after": when})])
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert 60 <= caught.value.retry_after_s <= 130

    def test_openrouters_epoch_millisecond_reset_is_understood(self, solo):
        reset_ms = str(int((time.time() + 90) * 1000))
        client = _Client([_Reply("no", status=429, headers={"x-ratelimit-reset": reset_ms})])
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert 60 <= caught.value.retry_after_s <= 100

    @pytest.mark.parametrize(
        "header",
        [{"retry-after": "not-a-number"}, {"retry-after": ""}, {"x-ratelimit-reset": "soon"}],
        ids=["junk-delta", "empty", "junk-reset"],
    )
    def test_an_unreadable_wait_falls_back_rather_than_throwing(self, header, solo):
        client = _Client([_Reply("no", status=429, headers=header)])
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert caught.value.retry_after_s == DEFAULT_RETRY_AFTER_S

    def test_a_wait_in_the_past_is_not_quoted_as_a_negative(self, solo):
        client = _Client([_Reply("no", status=429, headers={"retry-after": "-5"})])
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert caught.value.retry_after_s == DEFAULT_RETRY_AFTER_S

    def test_an_absurd_wait_is_capped(self, solo):
        client = _Client([_Reply("no", status=429, headers={"retry-after": "999999"})])
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert caught.value.retry_after_s == MAX_RETRY_AFTER_S

    def test_one_model_rate_limited_and_another_answering_is_simply_an_answer(self, two_models):
        client = _Client([_Reply("rate limit", status=429), _Reply(GOOD_BODY)])
        assert chat("sys", "user", client=client).content == '{"ok": true}'


# ── A key that stopped working ───────────────────────────────────────────────


class TestARevokedOrWrongKey:
    @pytest.mark.parametrize("status", [401, 403])
    def test_it_is_named_as_an_authentication_failure(self, status, two_models):
        client = _Client([_Reply("no", status=status), _Reply("no", status=status)])
        with pytest.raises(AuthenticationFailed):
            chat("sys", "user", client=client)

    def test_one_rejection_settles_it_even_beside_other_failures(self, two_models):
        """The key is the same for every candidate, so a 401 anywhere in the
        chain is the whole chain's answer — no fallback was going to help."""
        client = _Client([_Reply("busy", status=429), _Reply("no", status=401)])
        with pytest.raises(AuthenticationFailed):
            chat("sys", "user", client=client)


# ── Requests the provider will never serve ───────────────────────────────────


class TestARequestThatCannotBeServed:
    @pytest.mark.parametrize(
        "status",
        [400, 404, 413, 422],
        ids=["context-window", "model-retired", "payload-too-large", "unprocessable"],
    )
    def test_a_permanent_4xx_is_a_rejection_not_an_outage(self, status, two_models):
        client = _Client([_Reply("no", status=status), _Reply("no", status=status)])
        with pytest.raises(RequestRejected) as caught:
            chat("sys", "user", client=client)
        assert caught.value.status == status

    def test_a_mix_of_permanent_4xx_and_429_is_still_a_rejection(self, two_models):
        """A retry cannot fix either half, and the 400 is the one that names
        what to do about it."""
        client = _Client([_Reply("too long", status=400), _Reply("busy", status=429)])
        with pytest.raises(RequestRejected) as caught:
            chat("sys", "user", client=client)
        assert caught.value.status == 400


# ── When no verdict is safe ──────────────────────────────────────────────────


class TestWhenTheChainIsMerelyUnwell:
    def test_a_5xx_stays_the_generic_error(self, two_models):
        client = _Client([_Reply("boom", status=500)] * 6)
        with pytest.raises(OpenRouterError) as caught:
            chat("sys", "user", client=client)
        assert type(caught.value) is OpenRouterError

    def test_a_429_beside_an_unreachable_model_is_not_called_rate_limiting(self, two_models):
        """One candidate never produced a status at all. "The quota is out" is a
        claim about the whole chain, and this chain did not make it."""
        client = _Client(
            [_Reply("busy", status=429)] + [httpx.ConnectError("refused")] * 3
        )
        with pytest.raises(OpenRouterError) as caught:
            chat("sys", "user", client=client)
        assert type(caught.value) is OpenRouterError

    def test_a_429_beside_an_empty_completion_is_not_called_rate_limiting(self, two_models):
        empty = {**GOOD_BODY, "choices": [{"message": {"content": ""}}]}
        client = _Client([_Reply("busy", status=429), _Reply(empty)])
        with pytest.raises(OpenRouterError) as caught:
            chat("sys", "user", client=client)
        assert type(caught.value) is OpenRouterError

    def test_every_candidate_is_still_named_in_the_message(self, two_models):
        client = _Client([_Reply("no", status=429), _Reply("no", status=429)])
        with pytest.raises(RateLimited) as caught:
            chat("sys", "user", client=client)
        assert "a/one" in str(caught.value) and "b/two" in str(caught.value)


# ── A completion that stopped early ──────────────────────────────────────────


class TestATruncatedCompletion:
    def _cut_off(self, content: str) -> dict:
        return {
            "model": "solo/model",
            "choices": [{"message": {"content": content}, "finish_reason": "length"}],
            "usage": {"prompt_tokens": 9, "completion_tokens": 2000},
        }

    def test_the_stop_reason_reaches_the_result(self, solo):
        client = _Client([_Reply(self._cut_off('{"ok": true}'))])
        result = chat("sys", "user", client=client)
        assert result.finish_reason == "length"
        assert result.truncated is True

    def test_a_finished_answer_is_not_marked_truncated(self, solo):
        client = _Client([_Reply(GOOD_BODY)])
        assert chat("sys", "user", client=client).truncated is False

    def test_a_provider_that_says_nothing_is_not_assumed_truncated(self, solo):
        body = {**GOOD_BODY, "choices": [{"message": {"content": '{"ok": true}'}}]}
        client = _Client([_Reply(body)])
        result = chat("sys", "user", client=client)
        assert result.finish_reason is None
        assert result.truncated is False

    @pytest.mark.parametrize("reason", ["length", "max_tokens", "MAX_TOKENS"])
    def test_every_spelling_of_out_of_room_counts(self, reason, solo):
        body = {**GOOD_BODY, "choices": [{"message": {"content": "x"}, "finish_reason": reason}]}
        client = _Client([_Reply(body)])
        assert chat("sys", "user", client=client).truncated is True

    def test_a_truncated_unparseable_answer_is_refused_not_folded_into_notes(self):
        """The bug this closes: `{"summaries": [{...}, {"filena` parsed as
        nothing, became `{"notes": ...}`, and every caller then read its own
        keys off that dict, found none, and returned an empty result — which
        the job row recorded as a success."""
        llm = LlmResult(
            model="solo/model",
            content='{"summaries": [{"filename": "a.pdf", "summary": "It is a ca',
            finish_reason="length",
        )
        with pytest.raises(pipelines.TruncatedCompletionError) as caught:
            pipelines._safe_result(llm)
        assert "output cap" in str(caught.value)

    def test_it_is_a_value_error_so_the_old_catch_still_holds(self):
        llm = LlmResult(model="m", content="{ not json", finish_reason="length")
        with pytest.raises(ValueError):
            pipelines._safe_result(llm)

    def test_prose_that_simply_ignored_the_json_instruction_still_degrades(self):
        """The `notes` fallback earns its keep for a model that finished and
        wrote prose; only the cut-off case is refused."""
        llm = LlmResult(model="m", content="I think the company is worth a lot.", finish_reason="stop")
        assert pipelines._safe_result(llm) == {"notes": "I think the company is worth a lot."}

    def test_a_truncated_answer_that_is_nonetheless_parseable_is_kept(self):
        """Truncation is not by itself a reason to throw away a usable answer —
        only a reason not to invent one from the wreckage."""
        llm = LlmResult(model="m", content='{"summaries": []}', finish_reason="length")
        assert pipelines._safe_result(llm) == {"summaries": []}


# ── A completion the provider withheld ───────────────────────────────────────
#
# The other half of `stopReason`, and the half nobody read. R236 taught both
# clients to see `max_tokens`; a content filter and a Bedrock guardrail say the
# same kind of thing — "this is not the model's finished answer" — and both
# came back looking exactly like one. What is in `content` on that path is the
# fragment written before the filter tripped, or the guardrail's own
# substituted message.


class TestASuppressedCompletion:
    def _filtered(self, content: str, reason: str = "content_filter") -> dict:
        return {
            "model": "solo/model",
            "choices": [{"message": {"content": content}, "finish_reason": reason}],
            "usage": {"prompt_tokens": 9, "completion_tokens": 5},
        }

    @pytest.mark.parametrize(
        "reason", ["content_filter", "content_filtered", "guardrail_intervened"]
    )
    def test_every_spelling_of_withheld_counts(self, reason, solo):
        client = _Client([_Reply(self._filtered("partial", reason))])
        result = chat("sys", "user", client=client)
        assert result.suppressed is True
        assert result.truncated is False

    def test_a_finished_answer_is_not_marked_suppressed(self, solo):
        assert chat("sys", "user", client=_Client([_Reply(GOOD_BODY)])).suppressed is False

    def test_a_withheld_answer_is_refused_rather_than_folded_into_notes(self):
        """What it did before: a guardrail's "I can't help with that" recorded
        as the model's answer, under `notes`, on a job row saying `succeeded`."""
        llm = LlmResult(
            model="m",
            content="Sorry, I can't help with that request.",
            finish_reason="guardrail_intervened",
        )
        with pytest.raises(pipelines.SuppressedCompletionError) as caught:
            pipelines._safe_result(llm)
        assert "withheld" in str(caught.value)

    def test_it_is_refused_even_when_what_came_back_happens_to_parse(self):
        """Where this differs from truncation, and why. A truncated answer's
        prefix is the model's own words; a suppressed one's content is whatever
        survived the filter, or text the model never wrote at all."""
        llm = LlmResult(model="m", content='{"summaries": []}', finish_reason="content_filter")
        with pytest.raises(pipelines.SuppressedCompletionError):
            pipelines._safe_result(llm)

    def test_it_is_a_value_error_so_the_old_catch_still_holds(self):
        llm = LlmResult(model="m", content="anything", finish_reason="content_filter")
        with pytest.raises(ValueError):
            pipelines._safe_result(llm)


# ── Accounting, when the provider does not do it for us ──────────────────────


class TestTokenAccountingWithoutUsage:
    def test_a_missing_usage_block_still_advances_the_budget(self, solo):
        body = {"model": "solo/model", "choices": [{"message": {"content": "hello"}}]}
        client = _Client([_Reply(body)])
        chat("sys", "user" * 100, client=client)
        assert openrouter.tokens_used() > 0

    def test_the_estimate_does_not_masquerade_as_a_measurement(self, solo):
        body = {"model": "solo/model", "choices": [{"message": {"content": "hello"}}]}
        client = _Client([_Reply(body)])
        result = chat("sys", "user", client=client)
        assert result.prompt_tokens == 0 and result.completion_tokens == 0

    def test_a_reported_count_is_used_verbatim_in_preference_to_any_estimate(self, solo):
        client = _Client([_Reply(GOOD_BODY)])
        chat("sys", "user" * 500, client=client)
        assert openrouter.tokens_used() == 12

    def test_the_hard_cap_can_now_be_reached_by_a_model_that_reports_nothing(
        self, solo, monkeypatch
    ):
        """The point of the estimate. Before it, OPENROUTER_TOKEN_BUDGET was
        unenforceable against exactly the models most likely to be looping."""
        monkeypatch.setenv("OPENROUTER_TOKEN_BUDGET", "50")
        body = {"model": "solo/model", "choices": [{"message": {"content": "x" * 400}}]}
        client = _Client([_Reply(body)])
        chat("sys", "user", client=client)
        with pytest.raises(openrouter.TokenBudgetExceeded):
            chat("sys", "user", client=_Client([_Reply(body)]))


# ── What the HTTP boundary reports ───────────────────────────────────────────
#
# The statuses matter more than they look: `clients/internal.ts` retries a 5xx
# and counts it toward a shared circuit breaker, and does neither for a 4xx.
# Anything permanent reported as 503 is therefore paid for twice and then
# charged against every other engagement's access to the AI service.


@pytest.fixture
def api(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    return TestClient(app)


def _raising(exc):
    def _chat(system, user, *, model=None, client=None):
        raise exc

    return _chat


PIPELINE_BODY = {"valuation": {"kind": "409a"}, "company": {"name": "Acme"}}


class TestThePipelineRouteStatus:
    def test_an_exhausted_quota_is_a_429_with_a_retry_after(self, api, monkeypatch):
        monkeypatch.setattr(pipelines, "chat", _raising(RateLimited("out of quota", 42)))
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.status_code == 429
        assert res.headers["retry-after"] == "42"

    def test_a_quota_refusal_with_no_stated_wait_still_carries_one(self, api, monkeypatch):
        monkeypatch.setattr(pipelines, "chat", _raising(RateLimited("out of quota")))
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.status_code == 429
        assert int(res.headers["retry-after"]) >= 1

    def test_a_sub_second_wait_is_rounded_up_rather_than_to_zero(self, api, monkeypatch):
        monkeypatch.setattr(pipelines, "chat", _raising(RateLimited("out of quota", 0.2)))
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.headers["retry-after"] == "1"

    def test_a_request_the_provider_will_never_serve_is_a_422(self, api, monkeypatch):
        monkeypatch.setattr(
            pipelines, "chat", _raising(RequestRejected("context length exceeded", 400))
        )
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.status_code == 422

    def test_a_broken_key_stays_a_503_because_the_service_really_is_unavailable(
        self, api, monkeypatch
    ):
        monkeypatch.setattr(pipelines, "chat", _raising(AuthenticationFailed("key rejected")))
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.status_code == 503

    def test_an_outage_stays_a_503(self, api, monkeypatch):
        monkeypatch.setattr(pipelines, "chat", _raising(OpenRouterError("All models failed: 500")))
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.status_code == 503

    def test_a_truncated_answer_is_a_422_not_a_502(self, api, monkeypatch):
        def _cut_off(system, user, *, model=None, client=None):
            return LlmResult(model="m", content='{"summary": "it beg', finish_reason="length")

        monkeypatch.setattr(pipelines, "chat", _cut_off)
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.status_code == 422
        assert "output cap" in res.json()["detail"]

    def test_a_withheld_answer_is_a_422_not_a_502_or_a_200(self, api, monkeypatch):
        def _filtered(system, user, *, model=None, client=None):
            return LlmResult(
                model="m", content="I can't help with that.", finish_reason="content_filter"
            )

        monkeypatch.setattr(pipelines, "chat", _filtered)
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.status_code == 422
        assert "withheld" in res.json()["detail"]

    def test_a_truncated_answer_no_longer_reports_an_empty_success(self, api, monkeypatch):
        """What it did before: 200, `summary: ""`, `methodology: []` — a job row
        that said `succeeded` over an answer nobody ever finished writing."""
        def _cut_off(system, user, *, model=None, client=None):
            return LlmResult(
                model="m",
                content='{"summary": "The company", "methodology": [{"approach": "inco',
                finish_reason="length",
            )

        monkeypatch.setattr(pipelines, "chat", _cut_off)
        res = api.post("/ai/v1/pipelines/explain", json=PIPELINE_BODY)
        assert res.status_code != 200


class TestThePromptTestRouteStatus:
    """The Bot Prompts 'test' button reaches the provider directly."""

    def test_it_reports_a_quota_refusal_as_one(self, api, monkeypatch):
        import app.main as main

        monkeypatch.setattr(main, "chat", _raising(RateLimited("out of quota", 30)))
        res = api.post("/ai/v1/test", json={"system": "s", "user": "u"})
        assert res.status_code == 429
        assert res.headers["retry-after"] == "30"

    def test_it_reports_an_unserveable_request_as_one(self, api, monkeypatch):
        import app.main as main

        monkeypatch.setattr(main, "chat", _raising(RequestRejected("too long", 400)))
        res = api.post("/ai/v1/test", json={"system": "s", "user": "u"})
        assert res.status_code == 422
