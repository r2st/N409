"""Tests for the LLM router — provider dispatch, error mapping, and model listing."""

from app.llm_router import (
    _as_openrouter_error,
    _outcome_for,
    configured_models,
    provider_for,
    set_llm_metrics_sink,
)
from app.openrouter import (
    AuthenticationFailed,
    OpenRouterError,
    RateLimited,
    RequestRejected,
)
from app.bedrock import (
    BedrockAuthenticationFailed,
    BedrockError,
    BedrockRateLimited,
    BedrockRequestRejected,
)


class TestProviderFor:
    def test_bedrock_prefix_routes_to_bedrock(self):
        assert provider_for("bedrock/us.anthropic.claude-3-5-sonnet") == "bedrock"

    def test_none_routes_to_openrouter(self):
        assert provider_for(None) == "openrouter"

    def test_plain_model_routes_to_openrouter(self):
        assert provider_for("anthropic/claude-3.5-sonnet") == "openrouter"


class TestOutcomeFor:
    def test_rate_limited(self):
        assert _outcome_for(RateLimited("slow down", 30)) == "rate_limited"

    def test_auth_failed(self):
        assert _outcome_for(AuthenticationFailed("bad key")) == "auth_failed"

    def test_request_rejected(self):
        assert _outcome_for(RequestRejected("bad input", 422)) == "request_rejected"

    def test_generic_error(self):
        assert _outcome_for(OpenRouterError("boom")) == "error"

    def test_non_openrouter_exception(self):
        assert _outcome_for(ValueError("unknown")) == "error"


class TestBedrockErrorMapping:
    def test_rate_limited_maps_to_rate_limited(self):
        err = _as_openrouter_error(BedrockRateLimited("throttled", retry_after_s=60))
        assert isinstance(err, RateLimited)
        assert err.retry_after_s == 60

    def test_auth_failed_maps(self):
        err = _as_openrouter_error(BedrockAuthenticationFailed("no creds"))
        assert isinstance(err, AuthenticationFailed)

    def test_request_rejected_maps(self):
        err = _as_openrouter_error(BedrockRequestRejected("bad", status=400))
        assert isinstance(err, RequestRejected)

    def test_generic_bedrock_error_maps_to_base(self):
        err = _as_openrouter_error(BedrockError("unknown"))
        assert isinstance(err, OpenRouterError)
        assert not isinstance(err, RateLimited)
        assert not isinstance(err, AuthenticationFailed)


class TestConfiguredModels:
    def test_returns_a_list(self):
        models = configured_models()
        assert isinstance(models, list)

    def test_preferred_is_hoisted_to_head(self):
        models = configured_models()
        if models:
            last = models[-1]
            hoisted = configured_models(preferred=last)
            assert hoisted[0] == last

    def test_preferred_not_in_list_is_still_first(self):
        models = configured_models(preferred="custom/model-that-does-not-exist")
        assert models[0] == "custom/model-that-does-not-exist"

    def test_no_duplicates_when_preferred_is_already_present(self):
        models = configured_models()
        if models:
            first = models[0]
            hoisted = configured_models(preferred=first)
            assert hoisted.count(first) == 1


class TestMetricsSink:
    def test_set_and_clear(self):
        calls = []
        set_llm_metrics_sink(lambda **kw: calls.append(kw))
        set_llm_metrics_sink(None)
