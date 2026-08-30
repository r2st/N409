"""Amazon Bedrock adapter (design §12.2, P2-21).

Two halves worth different kinds of test. SigV4 is arithmetic with one correct
answer, so it is checked against the AWS specification's own worked example —
a signature that is nearly right is a 403 with no clue which step drifted. The
client half is checked the way the OpenRouter client is: on the responses a
provider actually returns, including the malformed ones.
"""

import datetime as dt
import hashlib
import json

import httpx
import pytest

from app import bedrock, llm_http, llm_router
from app.bedrock import (
    BedrockAuthenticationFailed,
    BedrockError,
    BedrockNotConfigured,
    BedrockRateLimited,
    BedrockRequestRejected,
    Credentials,
    chat,
    completion_text,
    configured_models,
    converse_path,
    credentials,
    handles,
    is_configured,
    signing_key,
    sign_request,
    strip_prefix,
    verify_credentials,
)
from app.openrouter import (
    AuthenticationFailed,
    OpenRouterError,
    RateLimited,
    RequestRejected,
)

MODEL = "anthropic.claude-sonnet-4-20250514-v1:0"
PREFIXED = f"bedrock/{MODEL}"

CONVERSE_OK = {
    "output": {"message": {"role": "assistant", "content": [{"text": '{"ok": true}'}]}},
    "usage": {"inputTokens": 120, "outputTokens": 40},
    "stopReason": "end_turn",
}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in (
        "BEDROCK_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "BEDROCK_MODEL",
        "BEDROCK_MAX_TOKENS",
        "BEDROCK_CALL_BUDGET_S",
        "BEDROCK_TOKEN_BUDGET",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("BEDROCK_TOKEN_BUDGET", raising=False)
    bedrock.reset_key_cache()
    bedrock.reset_budget()
    yield
    bedrock.reset_key_cache()
    bedrock.reset_budget()


def configure(monkeypatch, *, token: str | None = None) -> None:
    monkeypatch.setenv("BEDROCK_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    if token:
        monkeypatch.setenv("AWS_SESSION_TOKEN", token)


def transport(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# ── Configuration ────────────────────────────────────────────────────────────


class TestConfiguration:
    def test_off_until_every_part_is_set(self, monkeypatch):
        assert credentials() is None
        monkeypatch.setenv("BEDROCK_REGION", "us-east-1")
        # A region with no key is a misconfiguration that must read as "off"
        # rather than fail at the first prompt that happens to route here.
        assert credentials() is None
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIA")
        assert credentials() is None
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
        assert is_configured()

    def test_session_token_is_optional(self, monkeypatch):
        configure(monkeypatch)
        assert credentials().session_token is None
        configure(monkeypatch, token="FQoGZXIvYXdz")
        assert credentials().session_token == "FQoGZXIvYXdz"

    def test_offers_no_models_when_unconfigured(self):
        assert configured_models() == []

    def test_offers_one_prefixed_model_when_configured(self, monkeypatch):
        configure(monkeypatch)
        assert configured_models() == [PREFIXED]
        monkeypatch.setenv("BEDROCK_MODEL", "meta.llama3-70b-instruct-v1:0")
        assert configured_models() == ["bedrock/meta.llama3-70b-instruct-v1:0"]

    def test_claims_only_prefixed_model_ids(self):
        assert handles(PREFIXED)
        assert not handles(MODEL)
        assert not handles("openai/gpt-oss-20b:free")
        assert not handles(None)
        assert strip_prefix(PREFIXED) == MODEL
        assert strip_prefix(MODEL) == MODEL


# ── SigV4 ────────────────────────────────────────────────────────────────────


class TestSigV4:
    """Checked against AWS's own worked example (SigV4 test suite, GET vanilla)."""

    def test_derived_signing_key_matches_the_specification(self):
        # The published intermediate for this secret/date/region/service.
        key = signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam"
        )
        assert key.hex() == "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"

    def test_signs_with_the_headers_bedrock_requires(self, monkeypatch):
        configure(monkeypatch)
        headers = sign_request(
            credentials(),
            method="POST",
            path=converse_path(MODEL),
            body=b'{"x":1}',
            now=dt.datetime(2026, 8, 8, 12, 0, 0, tzinfo=dt.timezone.utc),
        )
        assert headers["x-amz-date"] == "20260808T120000Z"
        assert headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260808/us-east-1/bedrock/aws4_request")
        assert "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date," in headers["authorization"]
        # The payload hash is signed and sent, so a proxy that rewrites the body
        # produces a signature failure rather than a silently altered prompt.
        assert headers["x-amz-content-sha256"] == hashlib.sha256(b'{"x":1}').hexdigest()

    def test_includes_the_session_token_in_the_signed_headers(self, monkeypatch):
        # Temporary credentials fail with a 403 that reads like a bad key if the
        # token is sent but not signed.
        configure(monkeypatch, token="FQoGZXIvYXdz")
        headers = sign_request(
            credentials(),
            method="POST",
            path="/model/x/converse",
            body=b"{}",
            now=dt.datetime(2026, 8, 8, tzinfo=dt.timezone.utc),
        )
        assert headers["x-amz-security-token"] == "FQoGZXIvYXdz"
        assert "x-amz-security-token" in headers["authorization"]

    def test_signature_changes_with_the_body(self, monkeypatch):
        configure(monkeypatch)
        now = dt.datetime(2026, 8, 8, tzinfo=dt.timezone.utc)
        args = dict(method="POST", path="/model/x/converse", now=now)
        a = sign_request(credentials(), body=b'{"a":1}', **args)["authorization"]
        b = sign_request(credentials(), body=b'{"a":2}', **args)["authorization"]
        assert a != b

    def test_encodes_the_model_id_exactly_once(self):
        # A versioned model id contains a colon, which must be percent-encoded
        # identically in the URL and the canonical request — encoding it in one
        # place only works for most models and 403s on the versioned ones.
        path = converse_path(MODEL)
        assert path == "/model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse"
        assert "%253A" not in path


# ── Reading the response ─────────────────────────────────────────────────────


class TestResponseParsing:
    def test_joins_every_text_block(self):
        # Converse returns a list of blocks; a model that opens with a
        # reasoning block would read as empty if only the first were taken.
        data = {
            "output": {
                "message": {
                    "content": [
                        {"reasoningContent": {"text": "thinking"}},
                        {"text": "part one "},
                        {"text": "part two"},
                    ]
                }
            }
        }
        assert completion_text(data) == "part one part two"

    @pytest.mark.parametrize(
        "data",
        [
            {},
            {"output": None},
            {"output": {}},
            {"output": {"message": "not-an-object"}},
            {"output": {"message": {"content": "not-a-list"}}},
            {"output": {"message": {"content": [{"text": 42}]}}},
            {"output": {"message": {"content": []}}},
        ],
    )
    def test_returns_empty_rather_than_raising_on_anything_unexpected(self, data):
        assert completion_text(data) == ""


# ── The call ─────────────────────────────────────────────────────────────────


class TestChat:
    def test_returns_the_completion_with_token_counts(self, monkeypatch):
        configure(monkeypatch)
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["body"] = json.loads(request.content)
            seen["auth"] = request.headers.get("authorization", "")
            return httpx.Response(200, json=CONVERSE_OK)

        result = chat("sys", "user", model=PREFIXED, client=transport(handler))
        assert result.content == '{"ok": true}'
        assert (result.prompt_tokens, result.completion_tokens) == (120, 40)
        assert result.total_tokens == 160
        # Prefixed on the way out too: this string lands in job records, and
        # "which provider answered" is what those exist to record.
        assert result.model == PREFIXED
        assert seen["url"].startswith("https://bedrock-runtime.us-east-1.amazonaws.com/model/")
        assert seen["auth"].startswith("AWS4-HMAC-SHA256 ")

    def test_sends_the_converse_shape_with_the_system_prompt_separated(self, monkeypatch):
        configure(monkeypatch)
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return httpx.Response(200, json=CONVERSE_OK)

        chat("be terse", "the question", model=PREFIXED, client=transport(handler))
        assert seen["system"] == [{"text": "be terse"}]
        assert seen["messages"] == [{"role": "user", "content": [{"text": "the question"}]}]
        assert seen["inferenceConfig"]["maxTokens"] == 2000

    def test_honours_the_output_ceiling(self, monkeypatch):
        configure(monkeypatch)
        monkeypatch.setenv("BEDROCK_MAX_TOKENS", "512")
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return httpx.Response(200, json=CONVERSE_OK)

        chat("s", "u", model=PREFIXED, client=transport(handler))
        assert seen["inferenceConfig"]["maxTokens"] == 512

    def test_falls_back_to_the_default_model_when_none_is_named(self, monkeypatch):
        configure(monkeypatch)
        monkeypatch.setenv("BEDROCK_MODEL", "meta.llama3-70b-instruct-v1:0")
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json=CONVERSE_OK)

        result = chat("s", "u", client=transport(handler))
        assert "meta.llama3-70b-instruct-v1%3A0" in seen["url"]
        assert result.model == "bedrock/meta.llama3-70b-instruct-v1:0"

    def test_refuses_when_bedrock_is_not_configured(self):
        with pytest.raises(BedrockNotConfigured):
            chat("s", "u", model=PREFIXED)

    def test_surfaces_the_providers_own_error_message(self, monkeypatch):
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403, json={"message": "User is not authorized to perform bedrock:InvokeModel"}
            )

        with pytest.raises(BedrockError, match="not authorized"):
            chat("s", "u", model=PREFIXED, client=transport(handler))

    def test_does_not_retry_a_4xx(self, monkeypatch):
        # On a billed provider a quieter second attempt is money spent to
        # paper over a bad request.
        configure(monkeypatch)
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(1)
            return httpx.Response(400, json={"message": "ValidationException"})

        with pytest.raises(BedrockError):
            chat("s", "u", model=PREFIXED, client=transport(handler))
        assert len(calls) == 1

    def test_retries_a_5xx_and_re_signs_each_attempt(self, monkeypatch):
        configure(monkeypatch)
        monkeypatch.setattr(bedrock, "backoff_sleep", lambda attempt, deadline: True)

        # A signature is bound to its x-amz-date and AWS rejects one more than
        # fifteen minutes old, so a retry after a long backoff has to be
        # re-signed. Advancing the clock a minute per attempt is what makes a
        # sign-once implementation visible: its three requests would carry one
        # timestamp, and here they must carry three.
        clock = {"t": dt.datetime(2026, 8, 8, 12, 0, 0, tzinfo=dt.timezone.utc)}

        class _Clock:
            timezone = dt.timezone

            class datetime:  # noqa: N801 - mirrors the stdlib name being shadowed
                @staticmethod
                def now(tz=None):
                    clock["t"] += dt.timedelta(minutes=1)
                    return clock["t"]

        monkeypatch.setattr(bedrock, "_dt", _Clock)
        stamps: list[str] = []
        signatures: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            stamps.append(request.headers["x-amz-date"])
            signatures.append(request.headers["authorization"])
            if len(signatures) < 3:
                return httpx.Response(503, text="throttled")
            return httpx.Response(200, json=CONVERSE_OK)

        result = chat("s", "u", model=PREFIXED, client=transport(handler))
        assert result.content == '{"ok": true}'
        assert len(signatures) == 3
        assert len(set(stamps)) == 3
        assert len(set(signatures)) == 3

    def test_treats_an_empty_completion_as_a_failure(self, monkeypatch):
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"output": {"message": {"content": []}}})

        with pytest.raises(BedrockError, match="empty completion"):
            chat("s", "u", model=PREFIXED, client=transport(handler))

    def test_treats_a_non_json_200_as_a_failure(self, monkeypatch):
        # A proxy's HTML error page arrives as a 200; raising the provider's
        # error keeps it from escaping as an unhandled 500.
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>Gateway</html>")

        with pytest.raises(BedrockError, match="non-JSON"):
            chat("s", "u", model=PREFIXED, client=transport(handler))

    def test_carries_the_stop_reason_so_a_cut_off_answer_can_be_seen(self, monkeypatch):
        """Converse spells it `stopReason`; nothing here read it.

        Every guard in this service that asks whether an answer is whole reads
        `LlmResult.truncated`, which reads `finish_reason`. Left at its default
        it says "not truncated" for every Bedrock answer that ever existed — so
        `pipelines._safe_result` filed a half-written JSON object under `notes`
        and reported success, and `research` stored a write-up that stops
        mid-sentence as quotable in a report.
        """
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={**CONVERSE_OK, "stopReason": "max_tokens"})

        result = chat("s", "u", model=PREFIXED, client=transport(handler))
        assert result.finish_reason == "max_tokens"
        assert result.truncated

    def test_a_finished_answer_is_not_reported_truncated(self, monkeypatch):
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=CONVERSE_OK)

        result = chat("s", "u", model=PREFIXED, client=transport(handler))
        assert result.finish_reason == "end_turn"
        assert not result.truncated

    def test_a_missing_or_junk_stop_reason_is_simply_unknown(self, monkeypatch):
        # Provider-controlled, like every other level of the body: absent, or
        # present as a non-string, must not raise and must not read as whole-
        # or-truncated. None means "it did not say".
        configure(monkeypatch)

        for body in ({k: v for k, v in CONVERSE_OK.items() if k != "stopReason"},
                     {**CONVERSE_OK, "stopReason": 7},
                     {**CONVERSE_OK, "stopReason": ""}):
            def handler(request: httpx.Request, _body=body) -> httpx.Response:
                return httpx.Response(200, json=_body)

            result = chat("s", "u", model=PREFIXED, client=transport(handler))
            assert result.finish_reason is None
            assert not result.truncated

    def test_keeps_a_completion_whose_usage_fields_are_junk(self, monkeypatch):
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={**CONVERSE_OK, "usage": {"inputTokens": "lots", "outputTokens": None}},
            )

        result = chat("s", "u", model=PREFIXED, client=transport(handler))
        assert result.content == '{"ok": true}'
        assert result.total_tokens == 0


class TestSpendAccounting:
    """Bedrock's tokens were counted nowhere.

    `OPENROUTER_TOKEN_BUDGET` is documented as the guard against a runaway loop
    "once a paid key is configured", and every Bedrock call is billed to the
    operator's own AWS account — so the one provider whose spend is certain sat
    outside the ledger entirely. `/ready` reported a lifetime spend of zero for
    an installation routing every prompt here, and no ceiling would have stopped
    a loop doing it.
    """

    def test_counts_the_tokens_a_response_reported(self, monkeypatch):
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=CONVERSE_OK)

        chat("s", "u", model=PREFIXED, client=transport(handler))
        assert bedrock.tokens_used() == 160

    def test_estimates_when_the_response_counted_nothing(self, monkeypatch):
        # A guess, and only the ledger sees it: `LlmResult` keeps the counters
        # exactly as they arrived so nothing downstream mistakes one for a
        # measurement. Same rule as the OpenRouter client.
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={**CONVERSE_OK, "usage": {}})

        result = chat("s", "u", model=PREFIXED, client=transport(handler))
        assert result.total_tokens == 0
        assert bedrock.tokens_used() > 0

    def test_refuses_once_the_ceiling_is_reached(self, monkeypatch):
        configure(monkeypatch)
        monkeypatch.setenv("BEDROCK_TOKEN_BUDGET", "100")
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=CONVERSE_OK)

        client = transport(handler)
        chat("s", "u", model=PREFIXED, client=client)  # spends 160 of 100
        with pytest.raises(bedrock.TokenBudgetExceeded, match="BEDROCK_TOKEN_BUDGET"):
            chat("s", "u", model=PREFIXED, client=client)
        # Refused before the request was sent, which is the whole point.
        assert calls == 1

    def test_an_exhausted_ceiling_reaches_callers_as_the_error_they_catch(self, monkeypatch):
        # Every caller in this service catches OpenRouterError as "the LLM could
        # not answer"; a budget refusal escaping as its own type would be a 500.
        configure(monkeypatch)
        monkeypatch.setenv("BEDROCK_TOKEN_BUDGET", "1")
        bedrock._budget.add(10)
        with pytest.raises(OpenRouterError, match="BEDROCK_TOKEN_BUDGET"):
            llm_router.chat("s", "u", model=PREFIXED)

    def test_the_two_providers_ledgers_are_separate(self, monkeypatch):
        # A sum answers neither "what has OpenRouter cost this process" nor
        # "what has AWS", and one provider's traffic must not spend the other's
        # ceiling.
        from app import openrouter

        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=CONVERSE_OK)

        before = openrouter.tokens_used()
        chat("s", "u", model=PREFIXED, client=transport(handler))
        assert openrouter.tokens_used() == before
        assert bedrock.tokens_used() == 160


# ── Credential verification ──────────────────────────────────────────────────


class TestVerifyCredentials:
    def test_missing_when_nothing_is_configured(self):
        assert verify_credentials().state == "missing"

    def test_valid_on_a_successful_control_plane_call(self, monkeypatch):
        configure(monkeypatch)
        # Free and needs no model enabled — and it separates "the signature is
        # wrong" from "this account cannot use this model".
        status = verify_credentials(
            client=transport(lambda r: httpx.Response(200, json={"modelSummaries": []})),
            force=True,
        )
        assert status.ok
        assert "us-east-1" in status.detail

    def test_invalid_when_aws_rejects_the_signature(self, monkeypatch):
        configure(monkeypatch)
        status = verify_credentials(
            client=transport(
                lambda r: httpx.Response(403, json={"message": "signature does not match"})
            ),
            force=True,
        )
        assert status.state == "invalid"
        assert not status.ok

    def test_unreachable_rather_than_invalid_when_aws_cannot_be_asked(self, monkeypatch):
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route to host")

        status = verify_credentials(client=transport(handler), force=True)
        assert status.state == "unreachable"

    def test_memoises_the_result(self, monkeypatch):
        configure(monkeypatch)
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(1)
            return httpx.Response(200, json={})

        verify_credentials(client=transport(handler), force=True)
        verify_credentials(client=transport(handler))
        assert len(calls) == 1

    def test_a_changed_key_is_re_verified(self, monkeypatch):
        configure(monkeypatch)
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(1)
            return httpx.Response(200, json={})

        verify_credentials(client=transport(handler), force=True)
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIADIFFERENT")
        verify_credentials(client=transport(handler))
        assert len(calls) == 2


# ── Routing ──────────────────────────────────────────────────────────────────


class TestRouting:
    def test_routes_by_model_prefix(self):
        assert llm_router.provider_for(PREFIXED) == "bedrock"
        assert llm_router.provider_for("openai/gpt-oss-20b:free") == "openrouter"
        assert llm_router.provider_for(None) == "openrouter"

    def test_sends_a_bedrock_prompt_to_bedrock(self, monkeypatch):
        from app.openrouter import LlmResult

        configure(monkeypatch)
        seen = {}

        def fake(system, user, *, model=None, client=None):
            seen["model"] = model
            return LlmResult(model=model or "", content="ok")

        monkeypatch.setattr(bedrock, "chat", fake)
        result = llm_router.chat("s", "u", model=PREFIXED)
        assert seen["model"] == PREFIXED
        assert result.content == "ok"

    def test_sends_everything_else_to_openrouter(self, monkeypatch):
        from app import openrouter

        seen = {}

        def fake(system, user, *, model=None, client=None):
            seen["model"] = model
            return openrouter.LlmResult(model=model or "", content="ok")

        monkeypatch.setattr(openrouter, "chat", fake)
        llm_router.chat("s", "u", model="openai/gpt-oss-20b:free")
        assert seen["model"] == "openai/gpt-oss-20b:free"

    def test_re_raises_a_bedrock_failure_as_the_error_callers_catch(self, monkeypatch):
        # Every caller catches OpenRouterError as "the LLM could not answer". A
        # second exception type escapes as an unhandled 500 from the one code
        # path nobody exercised.
        configure(monkeypatch)

        def boom(*args, **kwargs):
            raise BedrockError("bedrock/x: HTTP 403: not authorized")

        monkeypatch.setattr(bedrock, "chat", boom)
        with pytest.raises(OpenRouterError, match="not authorized"):
            llm_router.chat("s", "u", model=PREFIXED)

    def test_lists_openrouter_first_so_a_billed_provider_never_becomes_default(
        self, monkeypatch
    ):
        configure(monkeypatch)
        models = llm_router.configured_models()
        assert models[0].startswith("openai/")
        assert PREFIXED in models

    def test_omits_bedrock_entirely_when_it_is_not_configured(self):
        assert all(not m.startswith("bedrock/") for m in llm_router.configured_models())

    def test_hoists_the_prompts_current_binding_to_the_head(self, monkeypatch):
        configure(monkeypatch)
        assert llm_router.configured_models(preferred=PREFIXED)[0] == PREFIXED
        # Including one this installation does not list at all — a prompt bound
        # to a model an operator later removed still shows its own binding.
        assert llm_router.configured_models(preferred="bedrock/other")[0] == "bedrock/other"


# ── Why the call failed ──────────────────────────────────────────────────────


class TestRefusalVerdicts:
    """A Bedrock refusal says which kind it is, and keeps saying it through the router.

    Every one of these used to arrive as a bare `BedrockError` and leave `main`
    as 503. `clients/internal.ts` retries a 5xx and counts five toward a breaker
    shared by every engagement, so a throttled invocation on the provider that
    is always billed was paid for twice and charged against everyone else.
    """

    def _refuse(self, monkeypatch, status: int, headers: dict | None = None):
        configure(monkeypatch)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status, headers=headers or {}, json={"message": f"status {status}"}
            )

        return transport(handler)

    def test_a_throttle_is_rate_limited_not_an_outage(self, monkeypatch):
        client = self._refuse(monkeypatch, 429, {"retry-after": "17"})
        with pytest.raises(BedrockRateLimited) as caught:
            chat("s", "u", model=PREFIXED, client=client)
        assert caught.value.retry_after_s == 17.0

    def test_a_throttle_without_a_header_quotes_no_wait_of_its_own(self, monkeypatch):
        # `main._rate_limited` supplies the default; inventing one here would
        # make the client's answer look like the provider's.
        client = self._refuse(monkeypatch, 429)
        with pytest.raises(BedrockRateLimited) as caught:
            chat("s", "u", model=PREFIXED, client=client)
        assert caught.value.retry_after_s is None

    @pytest.mark.parametrize("status", [401, 403])
    def test_a_rejected_signature_is_an_authentication_failure(self, monkeypatch, status):
        with pytest.raises(BedrockAuthenticationFailed):
            chat("s", "u", model=PREFIXED, client=self._refuse(monkeypatch, status))

    @pytest.mark.parametrize("status", [400, 404, 413, 424])
    def test_an_unservable_request_says_so_rather_than_looking_transient(
        self, monkeypatch, status
    ):
        with pytest.raises(BedrockRequestRejected) as caught:
            chat("s", "u", model=PREFIXED, client=self._refuse(monkeypatch, status))
        assert caught.value.status == status

    def test_a_5xx_that_survived_the_retries_stays_an_outage(self, monkeypatch):
        # 503 is the honest answer for this one, and the retry ladder above it
        # is the right response — so it keeps the base class it always had.
        monkeypatch.setattr(bedrock, "backoff_sleep", lambda attempt, deadline: True)
        client = self._refuse(monkeypatch, 502)
        with pytest.raises(BedrockError) as caught:
            chat("s", "u", model=PREFIXED, client=client)
        assert type(caught.value) is BedrockError

    def test_the_message_still_names_bedrock_and_the_model(self, monkeypatch):
        client = self._refuse(monkeypatch, 429)
        with pytest.raises(BedrockError, match=MODEL):
            chat("s", "u", model=PREFIXED, client=client)


class TestVerdictsSurviveTheRouter:
    """The status `main` answers comes off the type, so the router must not flatten it."""

    def _route(self, monkeypatch, exc):
        configure(monkeypatch)

        def boom(*args, **kwargs):
            raise exc

        monkeypatch.setattr(bedrock, "chat", boom)

    def test_a_throttle_arrives_as_the_429_the_handlers_answer(self, monkeypatch):
        self._route(monkeypatch, BedrockRateLimited("bedrock/x: throttled", 12.0))
        with pytest.raises(RateLimited) as caught:
            llm_router.chat("s", "u", model=PREFIXED)
        assert caught.value.retry_after_s == 12.0
        assert "throttled" in str(caught.value)

    def test_an_unservable_request_arrives_as_the_422(self, monkeypatch):
        self._route(monkeypatch, BedrockRequestRejected("bedrock/x: too long", 400))
        with pytest.raises(RequestRejected) as caught:
            llm_router.chat("s", "u", model=PREFIXED)
        assert caught.value.status == 400

    def test_refused_credentials_arrive_as_an_authentication_failure(self, monkeypatch):
        self._route(monkeypatch, BedrockAuthenticationFailed("bedrock/x: expired token"))
        with pytest.raises(AuthenticationFailed):
            llm_router.chat("s", "u", model=PREFIXED)

    def test_everything_else_is_still_the_error_every_caller_catches(self, monkeypatch):
        self._route(monkeypatch, BedrockError("bedrock/x: HTTP 502"))
        with pytest.raises(OpenRouterError) as caught:
            llm_router.chat("s", "u", model=PREFIXED)
        assert type(caught.value) is OpenRouterError

    def test_every_verdict_is_still_catchable_as_the_one_error(self, monkeypatch):
        # The whole reason the router translates rather than lets Bedrock's own
        # hierarchy escape: an agent's `except OpenRouterError` must keep working.
        for exc in (
            BedrockRateLimited("a", 1.0),
            BedrockAuthenticationFailed("b"),
            BedrockRequestRejected("c", 400),
            BedrockError("d"),
        ):
            self._route(monkeypatch, exc)
            with pytest.raises(OpenRouterError):
                llm_router.chat("s", "u", model=PREFIXED)


class TestTheRouteAnswersTheVerdict:
    """The whole stack, once: HTTP 429 from AWS out to HTTP 429 from us.

    The two classes above test each hop; this one is the reason they matter.
    Before it, this exchange ended in a 503 — retried at full price and counted
    toward a breaker shared by every engagement on the platform.
    """

    def test_a_throttled_invocation_leaves_as_a_429_with_the_wait_aws_named(
        self, monkeypatch
    ):
        from fastapi.testclient import TestClient

        from app.main import app

        configure(monkeypatch)
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                429,
                headers={"retry-after": "25"},
                json={"message": "Too many requests, please wait before trying again."},
            )

        monkeypatch.setattr(bedrock, "new_client", lambda **kw: transport(handler))
        res = TestClient(app).post(
            "/ai/v1/test", json={"system": "s", "user": "u", "model": PREFIXED}
        )
        assert res.status_code == 429
        assert res.headers["retry-after"] == "25"
        assert "Too many requests" in res.json()["detail"]


class TestASlowDrip:
    """A far end that answers, slowly, forever.

    The size ceiling never fires — the body is tiny — and an httpx read timeout
    is reset by every byte, so before the time ceiling in `http_client` this
    exchange held one of forty threadpool slots for as long as AWS cared to
    keep sending. `BEDROCK_CALL_BUDGET_S` exists to bound exactly this and
    could not, because it was only consulted *between* attempts.
    """

    def test_the_call_ends_inside_its_own_budget(self, monkeypatch):
        import time as _time

        configure(monkeypatch)
        monkeypatch.setenv("BEDROCK_CALL_BUDGET_S", "0.3")
        monkeypatch.setattr(llm_http, "MIN_ATTEMPT_S", 0.05)

        class _Drip(httpx.SyncByteStream):
            def __iter__(self):
                for _ in range(10_000):
                    _time.sleep(0.005)
                    yield b"x"

            def close(self):
                pass

        class _DripTransport(httpx.BaseTransport):
            def handle_request(self, request: httpx.Request) -> httpx.Response:
                return httpx.Response(200, stream=_Drip(), request=request)

        from app.http_client import CappedTransport

        client = httpx.Client(transport=CappedTransport(_DripTransport(), 16 * 1024 * 1024))
        started = _time.monotonic()
        with pytest.raises(BedrockError):
            chat("s", "u", model=PREFIXED, client=client)
        # Bounded by the budget and its retries rather than by the far end.
        assert _time.monotonic() - started < 5.0
