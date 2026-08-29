"""What ``chat`` does with an answer it cannot use.

``chat`` exists to try candidate models in order until one answers, and its
contract to every caller is a single exception type: OpenRouterError, which
``main`` turns into a clean 503 and the agents catch to degrade. The retry
tests next door cover failures to *reach* a model. These cover the other half —
a model that replies 200 with something unusable.

That half used to leak. ``resp.json()`` on a proxy's HTML error page raised
JSONDecodeError, and a body that was valid JSON of the wrong shape raised
AttributeError on ``.get``; neither is an OpenRouterError, so both escaped
``chat`` as a 500 *and* skipped the remaining healthy candidates — the fallback
chain was abandoned precisely when it was needed. So each test here asserts two
things: the bad answer is treated as that candidate failing, and the next model
still gets its turn.
"""

from __future__ import annotations

import json

import pytest

from app import openrouter
from app.openrouter import LlmResult, OpenRouterError, chat

GOOD_BODY = {
    "model": "good/model",
    "choices": [{"message": {"content": '{"ok": true}'}}],
    "usage": {"prompt_tokens": 7, "completion_tokens": 5},
}


class _Reply:
    """A response whose body is whatever the test says, JSON or not."""

    def __init__(self, body, *, status: int = 200, decodable: bool = True, headers=None):
        self.status_code = status
        self.headers = headers or {}
        self._body = body
        self._decodable = decodable
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        if not self._decodable:
            raise json.JSONDecodeError("Expecting value", str(self._body), 0)
        return self._body


def _html(status: int = 200) -> _Reply:
    """What an ingress/proxy in front of OpenRouter answers with."""
    return _Reply(
        "<html><head><title>502 Bad Gateway</title></head></html>",
        status=status,
        decodable=False,
    )


class _Client:
    def __init__(self, replies):
        self._replies = list(replies)
        self.calls = 0

    def post(self, url, headers=None, json=None, timeout=None):  # noqa: A002 - httpx signature
        self.calls += 1
        return self._replies.pop(0)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setattr(openrouter.time, "sleep", lambda _s: None)
    openrouter._budget._used = 0
    yield
    openrouter._budget._used = 0


@pytest.fixture
def two_models(monkeypatch):
    """A bad candidate followed by a good one, so fallback is observable."""
    monkeypatch.setattr(
        openrouter, "configured_models", lambda preferred=None: ["bad/model", "good/model"]
    )


@pytest.fixture
def solo(monkeypatch):
    """One candidate, so a failure has nowhere to fall through to."""
    monkeypatch.setattr(openrouter, "configured_models", lambda preferred=None: ["solo/model"])


# The bodies a model or the infrastructure in front of it can realistically
# return with a 200 that `chat` cannot make a completion out of.
UNUSABLE = {
    "html-error-page": _html,
    "truncated-json": lambda: _Reply('{"choices": [{"mess', decodable=False),
    "empty-body": lambda: _Reply("", decodable=False),
    "json-list": lambda: _Reply(["not", "an", "object"]),
    "json-string": lambda: _Reply("just a string"),
    "json-null": lambda: _Reply(None),
    "no-choices": lambda: _Reply({"model": "bad/model"}),
    "choices-not-a-list": lambda: _Reply({"choices": {"message": "nope"}}),
    "choices-empty": lambda: _Reply({"choices": []}),
    "choice-not-an-object": lambda: _Reply({"choices": ["text"]}),
    "no-message": lambda: _Reply({"choices": [{"finish_reason": "stop"}]}),
    "message-not-an-object": lambda: _Reply({"choices": [{"message": "text"}]}),
    "content-missing": lambda: _Reply({"choices": [{"message": {"role": "assistant"}}]}),
    "content-null": lambda: _Reply({"choices": [{"message": {"content": None}}]}),
    "content-not-a-string": lambda: _Reply({"choices": [{"message": {"content": {"a": 1}}}]}),
    "content-empty": lambda: _Reply({"choices": [{"message": {"content": ""}}]}),
}


@pytest.mark.parametrize("make_reply", list(UNUSABLE.values()), ids=list(UNUSABLE))
class TestAnUnusableAnswerIsJustThatCandidateFailing:
    def test_the_next_model_still_gets_its_turn(self, make_reply, two_models) -> None:
        client = _Client([make_reply(), _Reply(GOOD_BODY)])
        result = chat("sys", "user", client=client)
        assert isinstance(result, LlmResult)
        assert result.model == "good/model"
        assert result.content == '{"ok": true}'
        # Two POSTs: the bad candidate, then the good one. If this is 1 the
        # unusable answer aborted the chain instead of falling through.
        assert client.calls == 2

    def test_with_no_fallback_left_it_is_an_openrouter_error(
        self, make_reply, solo
    ) -> None:
        # The contract callers depend on: not JSONDecodeError, not
        # AttributeError, not TypeError — OpenRouterError, every time.
        client = _Client([make_reply()])
        with pytest.raises(OpenRouterError) as caught:
            chat("sys", "user", client=client)
        assert "All models failed" in str(caught.value)
        assert "solo/model" in str(caught.value)


class TestTheErrorSaysWhichCandidateAndWhy:
    """The joined `errors` string is the only diagnostic that reaches an operator."""

    def test_a_non_json_body_is_named_as_such(self, solo) -> None:
        client = _Client([_html()])
        with pytest.raises(OpenRouterError, match="non-JSON body"):
            chat("sys", "user", client=client)

    def test_a_wrong_shaped_body_is_named_with_its_type(self, solo) -> None:
        client = _Client([_Reply(["nope"])])
        with pytest.raises(OpenRouterError, match="non-object body \\(list\\)"):
            chat("sys", "user", client=client)

    def test_a_missing_completion_is_still_reported_as_empty(self, solo) -> None:
        client = _Client([_Reply({"choices": [{"message": {"content": ""}}]})])
        with pytest.raises(OpenRouterError, match="empty completion"):
            chat("sys", "user", client=client)

    def test_every_candidate_is_accounted_for(self, two_models) -> None:
        client = _Client([_html(), _Reply(["nope"])])
        with pytest.raises(OpenRouterError) as caught:
            chat("sys", "user", client=client)
        message = str(caught.value)
        assert "bad/model" in message and "good/model" in message


class TestUsageAccountingNeverDiscardsACompletion:
    """By this point the call is spent — junk in `usage` must not throw it away."""

    @pytest.mark.parametrize(
        "usage",
        [
            {"prompt_tokens": "lots", "completion_tokens": 2},
            {"prompt_tokens": None, "completion_tokens": None},
            {"prompt_tokens": {"nested": 1}, "completion_tokens": []},
            {"prompt_tokens": -5, "completion_tokens": -5},
            {},
            "not-an-object",
            None,
        ],
        ids=["non-numeric", "nulls", "containers", "negative", "empty", "string", "missing"],
    )
    def test_the_content_survives_unusable_counters(self, usage, solo) -> None:
        body = {**GOOD_BODY, "usage": usage}
        client = _Client([_Reply(body)])
        result = chat("sys", "user", client=client)
        assert result.content == '{"ok": true}'
        # Unusable counters read as zero rather than as a crash or a negative
        # that would credit the budget back.
        assert result.prompt_tokens >= 0
        assert result.completion_tokens >= 0
        assert result.total_tokens >= 0

    def test_numeric_strings_and_floats_are_still_counted(self, solo) -> None:
        # Providers are loose about types; a countable value should count.
        body = {**GOOD_BODY, "usage": {"prompt_tokens": "7", "completion_tokens": 5.0}}
        client = _Client([_Reply(body)])
        result = chat("sys", "user", client=client)
        assert result.prompt_tokens == 7
        assert result.completion_tokens == 5
        assert openrouter.tokens_used() == 12

    def test_a_junk_counter_charges_an_estimate_rather_than_nothing(self, solo) -> None:
        """Uncountable counters used to leave the budget exactly where it was.

        That looks conservative and is the opposite: OPENROUTER_TOKEN_BUDGET is
        the only stop on a runaway loop, and a model that reports no usage —
        several free-tier ones report none at all — could then loop against it
        for free while `/ready` went on saying nothing had been spent. The
        estimate is crude by design; it is a cap, not an invoice.
        """
        body = {**GOOD_BODY, "usage": {"prompt_tokens": "lots", "completion_tokens": "more"}}
        client = _Client([_Reply(body)])
        result = chat("sys", "user", client=client)
        # The *result* still reports what arrived, so nothing downstream can
        # mistake the estimate for something the provider said.
        assert result.prompt_tokens == 0
        assert result.completion_tokens == 0
        assert openrouter.tokens_used() > 0


class TestTheModelNameOnTheResult:
    """`model` lands in job records and audit trails, so it must be a string."""

    def test_the_provider_echo_is_preferred(self, solo) -> None:
        body = {**GOOD_BODY, "model": "solo/model:exact-revision"}
        client = _Client([_Reply(body)])
        assert chat("sys", "user", client=client).model == "solo/model:exact-revision"

    @pytest.mark.parametrize(
        "echoed", [None, "", 42, {"name": "x"}, ["x"]], ids=["null", "empty", "int", "dict", "list"]
    )
    def test_a_non_string_echo_falls_back_to_the_requested_model(self, echoed, solo) -> None:
        body = {**GOOD_BODY, "model": echoed}
        client = _Client([_Reply(body)])
        result = chat("sys", "user", client=client)
        assert result.model == "solo/model"
        assert isinstance(result.model, str)

    def test_an_absent_echo_falls_back_too(self, solo) -> None:
        body = {k: v for k, v in GOOD_BODY.items() if k != "model"}
        client = _Client([_Reply(body)])
        assert chat("sys", "user", client=client).model == "solo/model"


class TestKeyVerificationSurvivesAnOddBody:
    """`verify_api_key` runs on /ready; an exception there is a 500.

    A 200 from the introspection endpoint is the proof that the key works. The
    body is read only for a friendlier label, so nothing in it can be allowed
    to change the verdict — or to raise.
    """

    class _KeyClient:
        def __init__(self, reply):
            self._reply = reply
            self.calls = 0

        def get(self, url, headers=None):
            self.calls += 1
            return self._reply

        def close(self):  # pragma: no cover - the client is caller-owned here
            raise AssertionError("an injected client must not be closed")

    @pytest.fixture(autouse=True)
    def _fresh_cache(self):
        openrouter.reset_key_cache()
        yield
        openrouter.reset_key_cache()

    @pytest.mark.parametrize(
        "reply",
        [
            _Reply({"data": {"label": "prod key"}}),
            _Reply({"data": {}}),
            _Reply({"data": None}),
            _Reply({"data": ["surprise"]}),
            _Reply({}),
            _Reply(["not", "an", "object"]),
            _Reply(None),
            _html(),
        ],
        ids=[
            "labelled",
            "no-label",
            "null-data",
            "list-data",
            "no-data",
            "list-body",
            "null-body",
            "html-body",
        ],
    )
    def test_a_200_means_valid_whatever_the_body_says(self, reply) -> None:
        status = openrouter._probe_key("sk-or-test", self._KeyClient(reply))
        assert status.state == "valid"
        assert status.ok

    def test_a_usable_label_is_surfaced_in_the_detail(self) -> None:
        client = self._KeyClient(_Reply({"data": {"label": "prod key"}}))
        assert "prod key" in openrouter._probe_key("sk-or-test", client).detail

    def test_an_unusable_label_degrades_to_unlabelled(self) -> None:
        client = self._KeyClient(_Reply(["not", "an", "object"]))
        assert "unlabelled" in openrouter._probe_key("sk-or-test", client).detail

    def test_a_rejection_is_still_a_rejection(self) -> None:
        client = self._KeyClient(_Reply({"error": "nope"}, status=401))
        assert openrouter._probe_key("sk-or-test", client).state == "invalid"

    def test_an_html_error_page_under_a_non_200_is_unreachable_not_a_crash(self) -> None:
        client = self._KeyClient(_html(status=503))
        assert openrouter._probe_key("sk-or-test", client).state == "unreachable"
