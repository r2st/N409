"""Which model ids this service will actually send a prompt to.

`ai_prompts.model` is a free string. The route that writes it
(`valuation/src/routes/prompts.ts`) validates a length and nothing else, and
the picker beside it is served from this service's own candidate list — so the
dropdown was a suggestion, and everything below it went through unread:
`chat` hoisted whatever it was handed to the head of the fallback chain and
sent the prompt.

Two things rode on that, and the second is why these tests exist at all.

* Cost. The OpenRouter chain is free-tier by choice; one pinned paid id bills
  every run of that pipeline, and nothing sits between the edit and the invoice.
* Disclosure. OpenRouter is a *router*: the model id chooses which upstream
  provider receives the prompt, and the prompt is a redacted-but-real chunk of
  a client's cap table. Which third parties process client data is not a
  decision a valuation firm leaves to a text field.

So the allowed set is the offered set — `configured_models()`, the list the
picker is drawn from — plus the env vars an operator sets on the box beside the
key. Refusals are `RequestRejected` (→ 422), not the base error (→ 503): no
retry and no second candidate turns a disallowed id into an answer, and 503
would put the valuation service's retry ladder and its shared circuit breaker
in front of a fault that is in the request.
"""

from __future__ import annotations

import httpx
import pytest

from app import bedrock, llm_router, openrouter
from app.bedrock import BedrockRequestRejected
from app.openrouter import RequestRejected, allowed_models, assert_allowed


class _NeverCalled:
    """A client that fails the test if the guard let anything through."""

    def post(self, *a, **k):  # pragma: no cover - the point is that it is not hit
        raise AssertionError("a disallowed model reached the provider")

    def get(self, *a, **k):  # pragma: no cover - same
        raise AssertionError("a disallowed model reached the provider")


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    for name in ("OPENROUTER_MODEL", "RESEARCH_SYNTHESIS_MODEL"):
        monkeypatch.delenv(name, raising=False)
    openrouter._budget._used = 0
    yield
    openrouter._budget._used = 0


class TestAllowedModels:
    def test_the_offered_chain_is_the_allowed_set(self):
        assert allowed_models() == list(openrouter.DEFAULT_MODELS)

    def test_the_env_override_is_allowed_because_an_operator_set_it(self, monkeypatch):
        monkeypatch.setenv("OPENROUTER_MODEL", "some/paid-model")
        assert "some/paid-model" in allowed_models()

    def test_the_research_synthesis_model_is_allowed_too(self, monkeypatch):
        """It reaches `chat` through `research`, not through `llm_router`, and
        it is not in the picker's list — so it needs naming here or the one
        path that uses it would be refused by its own service."""
        monkeypatch.setenv("RESEARCH_SYNTHESIS_MODEL", "some/writer-model")
        assert "some/writer-model" in allowed_models()
        assert "some/writer-model" not in openrouter.configured_models()

    def test_an_env_var_set_to_a_default_is_not_listed_twice(self, monkeypatch):
        monkeypatch.setenv("OPENROUTER_MODEL", openrouter.DEFAULT_MODELS[0])
        assert allowed_models() == list(openrouter.DEFAULT_MODELS)

    def test_assert_allowed_names_what_it_refused_and_what_it_takes(self):
        with pytest.raises(RequestRejected) as exc:
            assert_allowed("anthropic/claude-opus-4")
        message = str(exc.value)
        assert "anthropic/claude-opus-4" in message
        assert openrouter.DEFAULT_MODELS[0] in message


class TestOpenRouterChat:
    def test_refuses_a_model_that_is_not_on_the_list_before_sending_anything(self):
        """Two claims in one, and `_NeverCalled` carries the second.

        The type: `RequestRejected` is a 422 in `main`, where the base class is
        a 503 — which `clients/internal.ts` retries and counts toward a circuit
        breaker shared by every engagement, for a fault that is in the request.

        The timing: the cost and the disclosure both happen on the wire, so a
        guard that refused *after* the POST would protect nothing.
        """
        with pytest.raises(RequestRejected):
            openrouter.chat("s", "u", model="openai/gpt-4o", client=_NeverCalled())

    def test_an_allowed_model_still_goes_through(self):
        replies = [
            httpx.Response(
                200,
                json={
                    "model": openrouter.DEFAULT_MODELS[0],
                    "choices": [{"message": {"content": "{}"}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                },
            )
        ]

        class _Client:
            def post(self, *a, **k):
                return replies.pop(0)

        result = openrouter.chat(
            "s", "u", model=openrouter.DEFAULT_MODELS[0], client=_Client()
        )
        assert result.model == openrouter.DEFAULT_MODELS[0]

    def test_no_pinned_model_is_still_the_default_chain(self):
        """The unpinned path must not be narrowed by the guard: an empty
        `model` means "use the chain", which is every pipeline's default."""
        seen = []

        class _Client:
            def post(self, url, headers=None, json=None, timeout=None):  # noqa: A002
                seen.append(json["model"])
                return httpx.Response(
                    200,
                    json={
                        "choices": [{"message": {"content": "{}"}}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                    },
                )

        openrouter.chat("s", "u", client=_Client())
        assert seen == [openrouter.DEFAULT_MODELS[0]]


class TestBedrock:
    """The billed provider, where the same edit spends the operator's own money.

    IAM is the other boundary and a better one — but it is not one this service
    can see, and an installation that granted `bedrock:InvokeModel` broadly has
    none.
    """

    @staticmethod
    def _configure(monkeypatch):
        monkeypatch.setenv("BEDROCK_REGION", "us-east-1")
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIA")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
        monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
        monkeypatch.delenv("BEDROCK_MODEL", raising=False)

    def test_refuses_a_model_the_picker_never_offered(self, monkeypatch):
        self._configure(monkeypatch)
        with pytest.raises(BedrockRequestRejected):
            bedrock.chat("s", "u", model="bedrock/anthropic.claude-opus-4", client=_NeverCalled())

    def test_the_configured_model_still_goes_through(self, monkeypatch):
        self._configure(monkeypatch)
        monkeypatch.setenv("BEDROCK_MODEL", "meta.llama3-70b-instruct-v1:0")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "output": {"message": {"content": [{"text": "{}"}]}},
                    "usage": {"inputTokens": 1, "outputTokens": 1},
                    "stopReason": "end_turn",
                },
            )

        client = httpx.Client(transport=httpx.MockTransport(handler))
        result = bedrock.chat(
            "s", "u", model="bedrock/meta.llama3-70b-instruct-v1:0", client=client
        )
        assert result.model == "bedrock/meta.llama3-70b-instruct-v1:0"

    def test_the_refusal_arrives_as_the_type_every_caller_catches(self, monkeypatch):
        """`llm_router` maps Bedrock's verdicts onto OpenRouter's types; a new
        refusal that skipped that mapping would escape `main` as a 500."""
        self._configure(monkeypatch)
        with pytest.raises(RequestRejected):
            llm_router.chat(
                "s", "u", model="bedrock/anthropic.claude-opus-4", client=_NeverCalled()
            )
