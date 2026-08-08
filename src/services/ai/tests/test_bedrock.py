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

from app import bedrock, llm_router
from app.bedrock import (
    BedrockError,
    BedrockNotConfigured,
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
from app.openrouter import OpenRouterError

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
    ):
        monkeypatch.delenv(name, raising=False)
    bedrock.reset_key_cache()
    yield
    bedrock.reset_key_cache()


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
