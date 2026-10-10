"""Perplexity Sonar client — the primary research provider.

The bulk of this file is the confidentiality gate rather than the HTTP client,
which is the right proportion: a research provider that returns a slightly
worse answer is a bad afternoon, and one that puts a client's company name into
a live web search is the thing this whole service is built to prevent.

The gate is asserted here *and* in `test_research.py`, which is duplication on
purpose. `research.research` runs it once before choosing a provider, and this
module runs it again on the way out — so a future caller that reaches this
client directly, bypassing the chooser, still cannot leak.
"""

import os

import httpx
import pytest

from app import perplexity
from app.anonymize import _PLACEHOLDERS
from app.perplexity import (
    Citation,
    ConfidentialityError,
    PerplexityError,
    REDACTION_MARKERS,
    ResearchResult,
    assert_public,
    configured_model,
    is_configured,
    parse_citations,
    research,
    tokens_used,
    TokenBudgetExceeded,
    verify_api_key,
)
from app.research_types import ProviderError, ResearchError

GOOD_KEY = "pplx-0123456789abcdef"

BODY = {
    "model": "sonar",
    "choices": [{"message": {"role": "assistant", "content": "SaaS trades at 6-8x ARR."}}],
    "search_results": [
        {"title": "Q3 SaaS multiples", "url": "https://example.com/saas", "date": "2026-07-01"},
    ],
    "usage": {"prompt_tokens": 40, "completion_tokens": 120},
}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.setenv("PERPLEXITY_API_KEY", GOOD_KEY)
    for var in (
        "PERPLEXITY_MODEL",
        "PERPLEXITY_MAX_TOKENS",
        "PERPLEXITY_CALL_BUDGET_S",
        "PERPLEXITY_TOKEN_BUDGET",
    ):
        monkeypatch.delenv(var, raising=False)
    perplexity.reset_key_cache()
    perplexity.reset_budget()
    yield
    perplexity.reset_key_cache()
    perplexity.reset_budget()


def stub(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def ok_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=BODY)


# ── the confidentiality gate ─────────────────────────────────────────────────


class TestAssertPublic:
    @pytest.mark.parametrize("marker", REDACTION_MARKERS)
    def test_every_redaction_marker_is_refused(self, marker):
        with pytest.raises(ConfidentialityError, match="redaction placeholder"):
            assert_public(f"What does {marker} do?")

    def test_the_marker_list_matches_the_redactor(self):
        """If `anonymize.py` adds a placeholder and this list does not, redacted
        client text carrying it would sail through the gate."""
        assert set(REDACTION_MARKERS) == set(_PLACEHOLDERS.values())

    def test_the_system_prompt_is_checked_too(self):
        """A caller-supplied system prompt is as much an outbound payload as
        the query — /ai/v1/test exists because operator-authored prompt text is
        exactly what nobody thinks to check."""
        with pytest.raises(ConfidentialityError):
            assert_public("a fine query", "You are advising [COMPANY].")

    def test_a_genuinely_public_question_passes(self):
        assert_public("What are 2026 median EV/Revenue multiples for public SaaS?")

    def test_empty_parts_are_skipped(self):
        assert_public("", "fine")

    def test_research_refuses_before_making_a_request(self):
        """The gate has to fire before the socket opens, not after."""

        def explode(request: httpx.Request) -> httpx.Response:
            raise AssertionError("a request was made despite the confidentiality gate")

        with pytest.raises(ConfidentialityError):
            research("How is [COMPANY] funded?", client=stub(explode))

    def test_confidentiality_error_is_not_a_provider_error(self):
        """The load-bearing assertion of the whole fallback design.

        `research.research` falls back on `except PerplexityError`. If the
        confidentiality refusal were catchable there, a query carrying a
        client's company name would be refused by Sonar and then handed
        straight to DuckDuckGo — the guarantee inverted into a feature. It was
        a `PerplexityError` subclass before there was anything to fall back to;
        it must never be one again.
        """
        assert not issubclass(ConfidentialityError, PerplexityError)
        assert issubclass(ConfidentialityError, ResearchError)
        with pytest.raises(ConfidentialityError):
            research("[NAME] holds 2,000,000 shares", client=stub(ok_handler))

    def test_perplexity_errors_are_provider_errors_so_the_fallback_can_catch_them(self):
        """The other half: a Sonar outage *must* be catchable as "try someone
        else", or the fallback never runs."""
        assert issubclass(PerplexityError, ProviderError)


def test_pipelines_does_not_import_this_module():
    """The document pipelines must never reach a web-search provider.

    Asserted structurally rather than trusted to review: `pipelines.py` is
    where client documents are assembled, and an import here would be the first
    step of routing them outward.
    """
    src = os.path.join(os.path.dirname(os.path.dirname(__file__)), "app", "pipelines.py")
    with open(src, encoding="utf-8") as fh:
        assert "perplexity" not in fh.read().lower()


# ── configuration ────────────────────────────────────────────────────────────


class TestConfiguration:
    def test_is_configured_tracks_the_key(self, monkeypatch):
        assert is_configured() is True
        monkeypatch.setenv("PERPLEXITY_API_KEY", "   ")
        assert is_configured() is False

    def test_default_model(self):
        assert configured_model() == "sonar"

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_MODEL", "sonar-pro")
        assert configured_model() == "sonar-pro"

    def test_explicit_argument_outranks_env(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_MODEL", "sonar-pro")
        assert configured_model("sonar-reasoning") == "sonar-reasoning"

    def test_an_unknown_tier_is_passed_through_not_rejected(self):
        """Perplexity ships tiers faster than this list updates; refusing one
        would break a working key on their release day."""
        assert configured_model("sonar-next") == "sonar-next"

    def test_max_tokens_falls_back_on_junk(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_MAX_TOKENS", "not-a-number")
        assert perplexity.max_output_tokens() == perplexity.DEFAULT_MAX_TOKENS

    def test_missing_key_is_an_error_not_an_empty_header(self, monkeypatch):
        monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
        with pytest.raises(PerplexityError, match="not configured"):
            research("public question", client=stub(ok_handler))


# ── key verification ─────────────────────────────────────────────────────────


class TestKeyVerification:
    def test_missing(self, monkeypatch):
        monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
        assert verify_api_key().state == "missing"

    def test_wrong_provider_key_is_caught_without_a_round_trip(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_API_KEY", "sk-or-v1-someopenrouterkey")

        def explode(request: httpx.Request) -> httpx.Response:
            raise AssertionError("probed the network for a malformed key")

        status = verify_api_key(client=stub(explode))
        assert status.state == "malformed"
        assert not status.ok

    @pytest.mark.parametrize("code", [401, 403])
    def test_rejected_key(self, code):
        status = verify_api_key(client=stub(lambda r: httpx.Response(code, json={})))
        assert status.state == "invalid"

    def test_valid_key(self):
        assert verify_api_key(client=stub(ok_handler)).ok

    def test_unreachable_provider(self):
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        assert verify_api_key(client=stub(boom)).state == "unreachable"

    def test_result_is_cached(self):
        calls = {"n": 0}

        def counting(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=BODY)

        verify_api_key(client=stub(counting))
        verify_api_key(client=stub(counting))
        assert calls["n"] == 1

    def test_force_skips_the_cache(self):
        calls = {"n": 0}

        def counting(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=BODY)

        verify_api_key(client=stub(counting))
        verify_api_key(client=stub(counting), force=True)
        assert calls["n"] == 2


# ── citations ────────────────────────────────────────────────────────────────


class TestCitations:
    def test_search_results_shape(self):
        cites = parse_citations(BODY)
        assert cites == [
            Citation(url="https://example.com/saas", title="Q3 SaaS multiples", date="2026-07-01")
        ]

    def test_bare_url_list_shape(self):
        cites = parse_citations({"citations": ["https://a.example", "https://b.example"]})
        assert [c.url for c in cites] == ["https://a.example", "https://b.example"]
        assert cites[0].title == ""

    def test_richer_shape_wins_when_both_are_present(self):
        cites = parse_citations(
            {
                "search_results": [{"url": "https://a.example", "title": "A"}],
                "citations": ["https://a.example"],
            }
        )
        assert len(cites) == 1
        assert cites[0].title == "A"

    def test_duplicates_collapse(self):
        """One source cited for three claims is one source; three rows in a
        report exhibit reads as padding."""
        cites = parse_citations({"citations": ["https://a.example"] * 3})
        assert len(cites) == 1

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"citations": None},
            {"citations": [None, 42, {}]},
            {"search_results": "nope"},
            {"search_results": [{"no_url": 1}]},
            {"citations": ["", "   "]},
        ],
    )
    def test_junk_yields_no_citations_rather_than_raising(self, body):
        assert parse_citations(body) == []


class TestGrounded:
    def test_an_answer_with_sources_is_grounded(self):
        assert ResearchResult("sonar", "text", [Citation("https://a.example")]).grounded

    def test_an_answer_without_sources_is_not(self):
        """An ungrounded Sonar answer is an expensive completion. The flag is
        how a caller knows not to quote it in a report."""
        assert not ResearchResult("sonar", "text").grounded


# ── the call ─────────────────────────────────────────────────────────────────


class TestResearch:
    def test_happy_path(self):
        out = research("What do public SaaS companies trade at?", client=stub(ok_handler))
        assert out.content == "SaaS trades at 6-8x ARR."
        assert out.model == "sonar"
        assert out.total_tokens == 160
        assert out.grounded

    def test_as_dict_is_the_route_contract(self):
        out = research("public question", client=stub(ok_handler)).as_dict()
        assert set(out) == {"model", "content", "citations", "grounded", "synthesized", "tokens"}
        assert out["citations"][0]["url"] == "https://example.com/saas"

    def test_empty_query_is_refused(self):
        with pytest.raises(PerplexityError, match="empty"):
            research("   ", client=stub(ok_handler))

    def test_recency_filter_is_sent(self):
        seen = {}

        def capture(request: httpx.Request) -> httpx.Response:
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(200, json=BODY)

        research("public question", recency="month", client=stub(capture))
        assert seen["search_recency_filter"] == "month"

    def test_unknown_recency_is_dropped_rather_than_sent(self):
        seen = {}

        def capture(request: httpx.Request) -> httpx.Response:
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(200, json=BODY)

        research("public question", recency="fortnight", client=stub(capture))
        assert "search_recency_filter" not in seen

    def test_domain_filter_is_capped(self):
        """Perplexity 400s an over-long allowlist rather than partially
        filtering, so it is trimmed here where the reason is visible."""
        seen = {}

        def capture(request: httpx.Request) -> httpx.Response:
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(200, json=BODY)

        research(
            "public question",
            domains=[f"d{i}.example" for i in range(25)],
            client=stub(capture),
        )
        assert len(seen["search_domain_filter"]) == 10

    def test_4xx_is_not_retried(self):
        """Every Sonar tier is billed: retrying a malformed request or an
        exhausted quota spends more money for the same answer."""
        calls = {"n": 0}

        def bad_request(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(400, text="bad model")

        with pytest.raises(PerplexityError, match="HTTP 400"):
            research("public question", client=stub(bad_request))
        assert calls["n"] == 1

    def test_5xx_is_retried_then_surfaced(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_CALL_BUDGET_S", "0")
        calls = {"n": 0}

        def flaky(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(503, text="upstream down")

        with pytest.raises(PerplexityError):
            research("public question", client=stub(flaky))
        assert calls["n"] == perplexity.MAX_RETRIES + 1

    def test_5xx_that_recovers_returns_the_answer(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_CALL_BUDGET_S", "0")
        calls = {"n": 0}

        def recovering(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(500, text="blip")
            return httpx.Response(200, json=BODY)

        assert research("public question", client=stub(recovering)).content

    def test_transport_error_is_surfaced_as_a_provider_error(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_CALL_BUDGET_S", "0")

        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        with pytest.raises(PerplexityError, match="unreachable"):
            research("public question", client=stub(boom))

    @pytest.mark.parametrize(
        "response,match",
        [
            (httpx.Response(200, text="<html>not json</html>"), "non-JSON"),
            (httpx.Response(200, json=[1, 2, 3]), "non-object"),
            (httpx.Response(200, json={"choices": []}), "empty completion"),
            (httpx.Response(200, json={"choices": [{"message": {}}]}), "empty completion"),
            (httpx.Response(200, json={"choices": "nope"}), "empty completion"),
        ],
    )
    def test_unusable_200_is_a_provider_error_not_a_crash(self, response, match):
        with pytest.raises(PerplexityError, match=match):
            research("public question", client=stub(lambda r: response))

    def test_junk_usage_does_not_discard_a_good_answer(self):
        body = {**BODY, "usage": {"prompt_tokens": "lots", "completion_tokens": None}}
        out = research("public question", client=stub(lambda r: httpx.Response(200, json=body)))
        assert out.content and out.total_tokens == 0

    def test_served_model_is_echoed_when_it_differs(self):
        body = {**BODY, "model": "sonar-pro-2026-08"}
        out = research("public question", client=stub(lambda r: httpx.Response(200, json=body)))
        assert out.model == "sonar-pro-2026-08"

    def test_non_string_served_model_falls_back_to_what_we_asked_for(self):
        body = {**BODY, "model": 42}
        out = research("public question", client=stub(lambda r: httpx.Response(200, json=body)))
        assert out.model == "sonar"

    def test_default_system_prompt_forbids_unsourced_figures(self):
        """The failure that matters is a plausible unsourced multiple landing
        in an exhibit beside real citations, where nothing distinguishes it."""
        seen = {}

        def capture(request: httpx.Request) -> httpx.Response:
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(200, json=BODY)

        research("public question", client=stub(capture))
        system = seen["messages"][0]["content"]
        assert "cite" in system.lower()
        assert "do not estimate" in system.lower()


# ── What a billed provider costs, and what stops it ──────────────────────────
#
# The third provider to need a ledger and the second to have been missed. R236
# found Bedrock outside one on the argument that it is always billed; this
# module's own docstring makes the same argument about Sonar — "one billed
# call" is the reason it is the primary — and it had neither a ceiling nor a
# figure on /ready. A loop through /ai/v1/research spent an account's money
# with nothing anywhere to stop it and nothing anywhere recording that it had.


class TestSpend:
    def test_a_reported_count_advances_the_ledger(self):
        research("SaaS multiples", client=stub(lambda _r: httpx.Response(200, json=BODY)))
        assert tokens_used() == 160

    def test_a_response_that_counted_nothing_still_advances_it(self):
        """`usage` is optional in this shape too, and a provider omitting it is
        exactly the call a ceiling most needs to see — otherwise the guard is
        unenforceable against precisely the traffic least accounted for."""
        body = {k: v for k, v in BODY.items() if k != "usage"}
        research("SaaS multiples", client=stub(lambda _r: httpx.Response(200, json=body)))
        assert tokens_used() > 0

    def test_the_estimate_does_not_masquerade_as_a_measurement(self):
        body = {k: v for k, v in BODY.items() if k != "usage"}
        result = research("SaaS multiples", client=stub(lambda _r: httpx.Response(200, json=body)))
        assert result.prompt_tokens == 0 and result.completion_tokens == 0

    def test_the_ceiling_refuses_before_spending_anything(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_TOKEN_BUDGET", "100")
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(1)
            return httpx.Response(200, json=BODY)

        research("SaaS multiples", client=stub(handler))
        with pytest.raises(TokenBudgetExceeded):
            research("SaaS multiples", client=stub(handler))
        assert len(calls) == 1

    def test_an_exhausted_ceiling_is_a_reason_to_ask_the_free_path_instead(self):
        """A `PerplexityError`, so `research.fallback_research` degrades to the
        keyless search-and-synthesise chain rather than failing the request —
        the right answer for a ceiling reached *because* this provider costs."""
        assert issubclass(TokenBudgetExceeded, PerplexityError)
        assert issubclass(TokenBudgetExceeded, ProviderError)

    def test_unset_is_unlimited(self):
        for _ in range(4):
            research("SaaS multiples", client=stub(lambda _r: httpx.Response(200, json=BODY)))
        assert tokens_used() == 640

    def test_the_three_ledgers_are_separate(self):
        """A sum answers none of the three questions an operator asks: what has
        OpenRouter cost this process, what has AWS, and what has Perplexity."""
        from app import bedrock, openrouter

        research("SaaS multiples", client=stub(lambda _r: httpx.Response(200, json=BODY)))
        assert tokens_used() == 160
        assert openrouter.tokens_used() == 0
        assert bedrock.tokens_used() == 0


class TestRateLimitNotRetried:
    """A 429 is a 4xx and must not be retried — spending a second attempt
    against a quota that has already refused is both pointless and rude."""

    def test_429_raises_immediately_with_status_in_message(self):
        calls: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(1)
            return httpx.Response(429, text="Rate limit exceeded")

        with pytest.raises(PerplexityError, match="429"):
            research("SaaS multiples", client=stub(handler))
        assert len(calls) == 1

    def test_429_is_a_provider_error_so_fallback_can_catch_it(self):
        assert issubclass(PerplexityError, ProviderError)


class TestDeadlineExhaustion:
    """5xx retries consuming the budget until deadline.expired() fires."""

    def test_tight_budget_with_5xx_retries(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_CALL_BUDGET_S", "0.3")
        from app import llm_http
        monkeypatch.setattr(llm_http, "MIN_ATTEMPT_S", 0.02)
        monkeypatch.setattr(llm_http, "RETRY_BACKOFF_BASE_S", 0.05)
        monkeypatch.setattr(perplexity, "MAX_RETRIES", 50)
        calls: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(1)
            return httpx.Response(503, text="Service Unavailable")

        from app.perplexity import DeadlineExceeded as PplxDeadline

        with pytest.raises(PplxDeadline, match="budget exhausted"):
            research("SaaS multiples", client=stub(handler))
        assert len(calls) >= 2

    def test_deadline_exceeded_is_a_perplexity_error(self):
        from app.perplexity import DeadlineExceeded as PplxDeadline

        assert issubclass(PplxDeadline, PerplexityError)
