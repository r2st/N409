"""Web-grounded research: the confidentiality gate, and the no-unsourced-answer rule.

The bulk of this file is those two invariants rather than the happy path, which
is the right proportion. A research provider that returns a slightly worse
answer is a bad afternoon. One that puts a client's company name into a live
web search is the thing this whole service is built to prevent, and one that
answers a valuation question from an LLM's weights while wearing a citation
list is how an unsourced multiple ends up in a report nobody can defend.
"""

import os

import httpx
import pytest

from app import perplexity
from app import research as research_mod
from app import websearch
from app.anonymize import _PLACEHOLDERS
from app.openrouter import LlmResult, OpenRouterError
from app.research import (
    Citation,
    ConfidentialityError,
    NO_RESULTS_ANSWER,
    REDACTION_MARKERS,
    ResearchError,
    ResearchResult,
    UNSYNTHESIZED_ANSWER,
    assert_public,
    build_source_block,
    is_configured,
    order_by_citation,
    research,
)
from app.research_types import ProviderError
from app.websearch import SearchError, SearchHit

PPLX_KEY = "pplx-0123456789abcdef"

HITS = [
    SearchHit("https://a.example/saas", "SaaS multiples 2026", "Public SaaS trades at 6-8x ARR."),
    SearchHit("https://b.example/index", "Sector index", "Median EV/Revenue of 6.4x."),
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in (
        "RESEARCH_PROVIDER",
        "RESEARCH_PROVIDER_CHAIN",
        "RESEARCH_PROVIDER_COOLDOWN_S",
        "RESEARCH_MAX_RESULTS",
        "RESEARCH_CALL_BUDGET_S",
        "RESEARCH_SYNTHESIS_MODEL",
        "BRAVE_SEARCH_API_KEY",
        "SERPER_API_KEY",
        "TAVILY_API_KEY",
        # No Perplexity key by default, so the unqualified tests below exercise
        # the fallback — which is the path a deployment without a key runs.
        "PERPLEXITY_API_KEY",
        "PERPLEXITY_MODEL",
    ):
        monkeypatch.delenv(var, raising=False)
    perplexity.reset_key_cache()
    yield
    perplexity.reset_key_cache()


@pytest.fixture
def answered(monkeypatch):
    """Stub both legs: search returns HITS, synthesis returns a citing answer.

    Returns the call log so a test can assert on what the model was shown —
    which is the only way to check that the sources really are the input.
    """
    calls: dict = {}

    def fake_search(query, **kwargs):
        calls["search"] = {"query": query, **kwargs}
        return "duckduckgo", list(HITS)

    def fake_chat(system, user, *, model=None, client=None):
        calls["chat"] = {"system": system, "user": user, "model": model}
        return LlmResult(
            model="openai/gpt-oss-20b:free",
            content="Public SaaS trades at 6-8x ARR [1], with a 6.4x median [2].",
            prompt_tokens=40,
            completion_tokens=120,
        )

    monkeypatch.setattr(research_mod.websearch, "search_with_provider", fake_search)
    monkeypatch.setattr(research_mod, "chat", fake_chat)
    return calls


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
        the query — operator-authored prompt text is exactly what nobody thinks
        to check."""
        with pytest.raises(ConfidentialityError):
            assert_public("a fine query", "You are advising [COMPANY].")

    def test_a_genuinely_public_question_passes(self):
        assert_public("What are 2026 median EV/Revenue multiples for public SaaS?")

    def test_empty_parts_are_skipped(self):
        assert_public("", "fine")

    def test_research_refuses_before_searching(self, monkeypatch):
        """The gate has to fire before the socket opens, not after."""

        def explode(*args, **kwargs):
            raise AssertionError("searched despite the confidentiality gate")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", explode)
        monkeypatch.setattr(research_mod, "chat", explode)
        with pytest.raises(ConfidentialityError):
            research("How is [COMPANY] funded?")

    def test_confidentiality_error_is_not_caught_as_a_transient(self, monkeypatch):
        """It must not be retryable: a caller catching ResearchError to fall
        back to another provider would forward the same client text there."""
        assert issubclass(ConfidentialityError, ResearchError)

        def explode(*args, **kwargs):
            raise AssertionError("searched despite the confidentiality gate")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", explode)
        with pytest.raises(ConfidentialityError):
            research("[NAME] holds 2,000,000 shares")


def test_pipelines_does_not_import_the_research_modules():
    """The document pipelines must never reach a web-search provider.

    Asserted structurally rather than trusted to review: `pipelines.py` is
    where client documents are assembled, and an import here would be the first
    step of routing them outward.
    """
    src = os.path.join(os.path.dirname(os.path.dirname(__file__)), "app", "pipelines.py")
    with open(src, encoding="utf-8") as fh:
        body = fh.read().lower()
    assert "websearch" not in body
    assert "from .research" not in body
    assert "import research" not in body


# ── the no-unsourced-answer rule ─────────────────────────────────────────────


class TestNothingUnsourced:
    def test_no_search_results_means_the_model_is_never_asked(self, monkeypatch):
        """An LLM asked a valuation question with no sources in front of it
        produces a confident multiple from its weights. That number landing in
        an exhibit beside real citations is the failure this path prevents."""
        monkeypatch.setattr(research_mod.websearch, "search_with_provider", lambda q, **kw: ("duckduckgo", []))

        def explode(*args, **kwargs):
            raise AssertionError("synthesised an answer with no sources")

        monkeypatch.setattr(research_mod, "chat", explode)
        out = research("a question the record does not cover")
        assert out.content == NO_RESULTS_ANSWER
        assert out.citations == []

    def test_an_empty_search_is_ungrounded_not_an_error(self, monkeypatch):
        """A question the public record does not cover is a legitimate research
        outcome, not a provider outage — and `grounded: false` is what keeps it
        out of the report."""
        monkeypatch.setattr(research_mod.websearch, "search_with_provider", lambda q, **kw: ("duckduckgo", []))
        assert research("q").grounded is False

    def test_an_answer_from_sources_is_grounded(self, answered):
        assert research("public question").grounded is True

    def test_the_sources_are_what_the_model_is_shown(self, answered):
        research("public question")
        user = answered["chat"]["user"]
        assert "https://a.example/saas" in user
        assert "Public SaaS trades at 6-8x ARR." in user
        assert "[1]" in user and "[2]" in user

    def test_the_system_prompt_forbids_unsourced_figures(self, answered):
        research("public question")
        system = answered["chat"]["system"].lower()
        assert "cite" in system
        assert "do not estimate" in system

    def test_a_caller_system_prompt_is_honoured(self, answered):
        research("public question", system="Answer in French, citing [n].")
        assert answered["chat"]["system"] == "Answer in French, citing [n]."


# ── citations ────────────────────────────────────────────────────────────────


class TestCitations:
    def test_every_retrieved_source_is_cited(self, answered):
        """All of them were put in front of the model, so all of them are part
        of how the answer was produced."""
        out = research("public question")
        assert [c.url for c in out.citations] == [h.url for h in HITS]

    def test_cited_sources_come_first(self):
        """A reviewer checking `[2]` should find it second in the exhibit."""
        ordered = order_by_citation(HITS, "A median of 6.4x [2] against a range [1].")
        assert [c.url for c in ordered] == ["https://b.example/index", "https://a.example/saas"]

    def test_uncited_sources_are_kept_after_the_cited_ones(self):
        ordered = order_by_citation(HITS, "Only the second matters [2].")
        assert [c.url for c in ordered] == ["https://b.example/index", "https://a.example/saas"]

    def test_an_answer_citing_nothing_still_lists_what_was_retrieved(self):
        """The sources were read either way; dropping them would understate
        what the answer was written from, not overstate it."""
        ordered = order_by_citation(HITS, "No markers at all.")
        assert len(ordered) == 2

    @pytest.mark.parametrize("content", ["[0] out of range", "[9] out of range", "[] empty", ""])
    def test_out_of_range_markers_are_ignored_rather_than_indexing_wildly(self, content):
        ordered = order_by_citation(HITS, content)
        assert [c.url for c in ordered] == [h.url for h in HITS]

    def test_a_repeated_marker_does_not_duplicate_the_source(self):
        ordered = order_by_citation(HITS, "[1] and again [1] and once more [1].")
        assert len(ordered) == 2

    def test_titles_travel_with_the_url(self, answered):
        out = research("public question")
        assert out.citations[0].title == "SaaS multiples 2026"


class TestSourceBlock:
    def test_numbering_is_one_based(self):
        assert build_source_block(HITS).startswith("[1] ")

    def test_a_hit_with_no_title_falls_back_to_its_url(self):
        block = build_source_block([SearchHit("https://a.example", "", "x")])
        assert "[1] https://a.example" in block

    def test_a_hit_with_no_snippet_omits_the_extract_line(self):
        block = build_source_block([SearchHit("https://a.example", "A", "")])
        assert "Extract:" not in block


class TestGrounded:
    def test_an_answer_with_sources_is_grounded(self):
        assert ResearchResult("x", "text", [Citation("https://a.example")]).grounded

    def test_an_answer_without_sources_is_not(self):
        assert not ResearchResult("x", "text").grounded

    def test_sources_nobody_summarised_are_not_grounded(self):
        """The case the second condition exists for. Citations alone used to
        mean "quotable", and a sources-only result has citations and no
        answer."""
        result = ResearchResult(
            "x", "text", [Citation("https://a.example")], synthesized=False
        )
        assert not result.grounded

    def test_results_are_synthesised_unless_said_otherwise(self):
        """Every existing construction predates the flag and means an answer."""
        assert ResearchResult("x", "text").synthesized is True


class TestUnsynthesizedResults:
    """The sources-only degradation: retrieval worked, synthesis did not.

    On a free-tier OpenRouter account this is a daily event rather than an
    outage, so what it returns matters as much as the happy path.
    """

    @pytest.fixture
    def unsynthesized(self, monkeypatch):
        monkeypatch.setattr(
            research_mod.websearch, "search_with_provider", lambda q, **kw: ("duckduckgo", list(HITS))
        )

        def boom(*args, **kwargs):
            raise OpenRouterError("rate limited: free-tier daily allowance exhausted")

        monkeypatch.setattr(research_mod, "chat", boom)
        return research("public question")

    def test_it_is_not_grounded_so_no_report_can_quote_it(self, unsynthesized):
        """The invariant this whole change turns on. `grounded` is what the
        report exhibit and the narrative thread gate on, and the standing text
        where an answer should be must never reach either."""
        assert unsynthesized.grounded is False

    def test_it_says_it_was_not_synthesised(self, unsynthesized):
        assert unsynthesized.synthesized is False

    def test_the_sources_survive(self, unsynthesized):
        """The entire point: the completed search is not thrown away."""
        assert [c.url for c in unsynthesized.citations] == [h.url for h in HITS]

    def test_titles_travel_with_them(self, unsynthesized):
        assert [c.title for c in unsynthesized.citations] == [h.title for h in HITS]

    def test_the_standin_text_asserts_nothing_about_the_subject(self, unsynthesized):
        """It is prose sitting in the field a drafting step reads. It has to be
        inert: no figure, no finding, nothing a model could lift as a claim."""
        content = unsynthesized.content
        assert content == UNSYNTHESIZED_ANSWER
        assert "could not be summarised" in content
        # No digits at all — a multiple or a percentage in this string is
        # exactly the unsourced figure the module refuses to produce.
        assert not any(ch.isdigit() for ch in content)

    def test_the_model_field_records_what_happened(self, unsynthesized):
        """A stored row has one column to say how it was produced, and
        "duckduckgo+unsynthesized" is the operator's answer to why a topic on
        the tab has sources and no write-up."""
        assert unsynthesized.model == "duckduckgo+unsynthesized"

    def test_no_tokens_are_claimed(self, unsynthesized):
        """Nothing was generated, so nothing is billed to the report's total."""
        assert unsynthesized.total_tokens == 0

    def test_the_route_contract_carries_both_flags(self, unsynthesized):
        payload = unsynthesized.as_dict()
        assert payload["grounded"] is False
        assert payload["synthesized"] is False
        assert len(payload["citations"]) == len(HITS)

    def test_it_is_distinguishable_from_an_empty_search(self, monkeypatch, unsynthesized):
        """Both are ungrounded and they mean opposite things: one says the
        public record has nothing, the other says we could not write up what it
        had. A caller holding only `grounded` cannot tell them apart."""
        monkeypatch.setattr(
            research_mod.websearch, "search_with_provider", lambda q, **kw: ("duckduckgo", [])
        )
        empty = research("a question the record does not cover")
        assert empty.grounded is False and unsynthesized.grounded is False
        assert empty.synthesized is True
        assert unsynthesized.synthesized is False

    def test_a_retrieval_failure_still_raises(self, monkeypatch):
        """Only the synthesis leg degrades. With no sources there is nothing to
        return, so the error has to reach the caller."""

        def boom(query, **kwargs):
            raise SearchError("duckduckgo unreachable")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", boom)
        with pytest.raises(ResearchError):
            research("public question")


# ── configuration and the result contract ────────────────────────────────────


class TestConfiguration:
    def test_research_is_available_with_no_key_configured(self):
        """The reason this replaced the Perplexity client: citations must not
        require a billing relationship."""
        assert is_configured() is True

    def test_a_keyed_provider_without_its_key_is_unavailable(self, monkeypatch):
        """With the chain pinned off, since otherwise the keyless backends
        behind it keep research available — which is the chain's whole job, and
        is covered in `TestAvailability`."""
        monkeypatch.setenv("RESEARCH_PROVIDER_CHAIN", "0")
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
        assert is_configured() is False

    def test_the_synthesis_model_can_be_pinned_by_env(self, answered, monkeypatch):
        monkeypatch.setenv("RESEARCH_SYNTHESIS_MODEL", "google/gemma-4-31b-it:free")
        research("public question")
        assert answered["chat"]["model"] == "google/gemma-4-31b-it:free"

    def test_an_explicit_model_outranks_the_env(self, answered, monkeypatch):
        monkeypatch.setenv("RESEARCH_SYNTHESIS_MODEL", "from/env")
        research("public question", model="from/argument")
        assert answered["chat"]["model"] == "from/argument"

    def test_recency_and_domains_reach_the_search(self, answered):
        research("public question", recency="month", domains=["sec.gov"])
        assert answered["search"]["recency"] == "month"
        assert answered["search"]["domains"] == ["sec.gov"]


class TestResultContract:
    def test_as_dict_is_the_route_contract(self, answered):
        out = research("public question").as_dict()
        assert set(out) == {"model", "content", "citations", "grounded", "synthesized", "tokens"}
        assert out["citations"][0]["url"] == "https://a.example/saas"

    def test_the_model_field_names_both_halves(self, answered):
        """'Which model wrote this' and 'which index found the sources' are
        different questions about the same stored row, with one column to
        answer them in."""
        out = research("public question")
        assert out.model == "duckduckgo+openai/gpt-oss-20b:free"

    def test_the_model_field_tracks_the_provider_that_answered(self, monkeypatch):
        """Not the configured one. `websearch` walks a chain, so a search
        started at Tavily can be answered by Wikipedia, and the stored row has
        to say which — a report exhibit is built from it."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "tavily")
        monkeypatch.setenv("TAVILY_API_KEY", "tvly-1")
        monkeypatch.setattr(
            research_mod.websearch,
            "search_with_provider",
            lambda q, **kw: ("wikipedia", list(HITS)),
        )
        monkeypatch.setattr(
            research_mod,
            "chat",
            lambda system, user, **kw: LlmResult(
                model="openai/gpt-oss-20b:free", content="Answer [1].",
                prompt_tokens=1, completion_tokens=1,
            ),
        )
        assert research("public question").model.startswith("wikipedia+")

    def test_tokens_are_the_synthesis_tokens(self, answered):
        assert research("public question").total_tokens == 160

    def test_an_empty_query_is_refused(self):
        with pytest.raises(ResearchError, match="empty"):
            research("   ")


class TestFailures:
    def test_a_search_failure_is_a_research_error(self, monkeypatch):
        def boom(query, **kwargs):
            raise SearchError("duckduckgo unreachable: no route")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", boom)
        with pytest.raises(ResearchError, match="search failed"):
            research("public question")

    def test_a_synthesis_failure_keeps_the_sources_instead_of_raising(self, monkeypatch):
        """Retrieval is the expensive, rate-limited half and it already
        succeeded. Raising here discarded a completed search and returned a 503
        — which is what an exhausted OpenRouter daily allowance produced every
        time, on a question whose sources had been found."""
        monkeypatch.setattr(
            research_mod.websearch, "search_with_provider", lambda q, **kw: ("duckduckgo", list(HITS))
        )

        def boom(*args, **kwargs):
            raise OpenRouterError("every candidate model failed")

        monkeypatch.setattr(research_mod, "chat", boom)
        out = research("public question")
        assert out.content == UNSYNTHESIZED_ANSWER
        assert [c.url for c in out.citations] == [h.url for h in HITS]

    def test_neither_failure_is_mistaken_for_a_confidentiality_refusal(self, monkeypatch):
        """The route maps ConfidentialityError to 422 and everything else to
        503; a provider outage reported as a caller bug sends an operator to
        the wrong place."""

        def boom(query, **kwargs):
            raise SearchError("down")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", boom)
        with pytest.raises(ResearchError) as caught:
            research("public question")
        assert not isinstance(caught.value, ConfidentialityError)


def test_recency_vocabulary_is_shared_across_both_providers():
    """The route validates `recency` against this tuple before dispatching, so
    a caller's filter has to mean the same thing whichever provider answers.
    Three copies drifting apart would 422 a filter one of them supports."""
    assert research_mod.RECENCY_FILTERS is websearch.RECENCY_FILTERS
    assert research_mod.RECENCY_FILTERS is perplexity.RECENCY_FILTERS


# ── choosing between the two providers ───────────────────────────────────────


PPLX_BODY = {
    "model": "sonar",
    "choices": [{"message": {"content": "Sonar says SaaS trades at 6-8x ARR."}}],
    "search_results": [{"title": "Sonar source", "url": "https://sonar.example/idx"}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 20},
}


def pplx_stub(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def pplx_ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=PPLX_BODY)


@pytest.fixture
def keyed(monkeypatch):
    """A configured Perplexity key, so the primary path is live."""
    monkeypatch.setenv("PERPLEXITY_API_KEY", PPLX_KEY)
    perplexity.reset_key_cache()
    yield
    perplexity.reset_key_cache()


class TestPrimaryIsPerplexity:
    """With a key set, Sonar answers and the fallback is never touched.

    Sonar stays the preferred path because it is one call against a real index
    that returns a sourced answer, where the fallback is a scrape plus a
    synthesis step and is only as good as the snippets it retrieved.
    """

    def test_perplexity_answers_when_configured(self, keyed, monkeypatch):
        def explode(*args, **kwargs):
            raise AssertionError("fell back while Perplexity was working")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", explode)
        out = research("public question", perplexity_client=pplx_stub(pplx_ok))
        assert out.content == "Sonar says SaaS trades at 6-8x ARR."
        assert out.model == "sonar"
        assert out.citations[0].url == "https://sonar.example/idx"

    def test_primary_available_tracks_the_key(self, keyed):
        assert research_mod.primary_available() is True

    def test_without_a_key_the_primary_is_not_even_tried(self, answered, monkeypatch):
        """No key means no round trip, not a failed one — `is_configured` is
        checked before the socket opens."""

        def explode(request: httpx.Request) -> httpx.Response:
            raise AssertionError("called Perplexity with no key configured")

        assert research_mod.primary_available() is False
        out = research("public question", perplexity_client=pplx_stub(explode))
        assert out.model.startswith("duckduckgo+")

    def test_a_sonar_tier_on_the_request_reaches_perplexity(self, keyed):
        seen = {}

        def capture(request: httpx.Request) -> httpx.Response:
            import json

            seen.update(json.loads(request.content))
            return httpx.Response(200, json=PPLX_BODY)

        research("public question", model="sonar-pro", perplexity_client=pplx_stub(capture))
        assert seen["model"] == "sonar-pro"


class TestFallsBackToSearch:
    """Every way Sonar can fail ends with the question asked the other way."""

    def test_a_rejected_key_falls_back(self, keyed, answered):
        rejected = pplx_stub(lambda r: httpx.Response(401, text="nope"))
        out = research("public question", perplexity_client=rejected)
        assert out.model.startswith("duckduckgo+")
        assert out.grounded

    def test_an_exhausted_quota_falls_back(self, keyed, answered):
        limited = pplx_stub(lambda r: httpx.Response(429, text="slow down"))
        assert research("public question", perplexity_client=limited).grounded

    def test_an_outage_falls_back(self, keyed, answered, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_CALL_BUDGET_S", "0")

        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        assert research("public question", perplexity_client=pplx_stub(boom)).grounded

    def test_an_unusable_200_falls_back(self, keyed, answered):
        """A 200 carrying no completion is a failure wearing a success code —
        the fallback exists for it as much as for a 500."""
        empty = pplx_stub(lambda r: httpx.Response(200, json={"choices": []}))
        assert research("public question", perplexity_client=empty).grounded

    def test_the_fallback_is_silent_to_the_caller(self, keyed, answered):
        """Same shape either way; only `model` says which path answered. A
        caller that had to branch on which provider ran would defeat the point."""
        out = research("public question", perplexity_client=pplx_stub(lambda r: httpx.Response(500)))
        assert set(out.as_dict()) == {"model", "content", "citations", "grounded", "synthesized", "tokens"}

    def test_a_sonar_tier_is_not_forwarded_to_openrouter_on_the_fallback(
        self, keyed, answered
    ):
        """The prompt registry pins Sonar tiers (migration 0124). Handing
        'sonar-pro' to OpenRouter as a preferred model would put a guaranteed
        404 at the head of the chain every time the fallback ran."""
        research(
            "public question",
            model="sonar-pro",
            perplexity_client=pplx_stub(lambda r: httpx.Response(500)),
        )
        assert answered["chat"]["model"] is None

    def test_an_openrouter_id_is_honoured_on_the_fallback(self, keyed, answered):
        research(
            "public question",
            model="google/gemma-4-31b-it:free",
            perplexity_client=pplx_stub(lambda r: httpx.Response(500)),
        )
        assert answered["chat"]["model"] == "google/gemma-4-31b-it:free"

    def test_both_failing_reports_both_reasons(self, keyed, monkeypatch):
        """An operator debugging a dead research tab needs to know that *two*
        providers failed and why each did, not just the last one."""

        def boom(query, **kwargs):
            raise SearchError("duckduckgo HTTP 202: blocked")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", boom)
        with pytest.raises(ResearchError) as caught:
            research("public question", perplexity_client=pplx_stub(lambda r: httpx.Response(500)))
        text = str(caught.value)
        assert "perplexity" in text
        assert "search failed" in text


class TestTheGateSurvivesTheFallback:
    """The one failure the fallback must never paper over."""

    def test_client_text_is_refused_before_either_provider_is_chosen(self, keyed):
        def explode(*args, **kwargs):
            raise AssertionError("a provider was reached with client text")

        with pytest.raises(ConfidentialityError):
            research("How is [COMPANY] funded?", perplexity_client=pplx_stub(explode))

    def test_a_refusal_does_not_fall_back_to_the_search_provider(self, keyed, monkeypatch):
        """The heart of it. If ConfidentialityError were a ProviderError, this
        query would be refused by Sonar and then sent to DuckDuckGo — the
        guarantee turned inside out."""

        def explode(*args, **kwargs):
            raise AssertionError("client text was forwarded to the fallback")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", explode)
        monkeypatch.setattr(research_mod, "chat", explode)
        with pytest.raises(ConfidentialityError):
            research("[NAME] holds 2,000,000 shares", perplexity_client=pplx_stub(pplx_ok))

    def test_the_hierarchy_that_makes_that_true(self):
        assert not issubclass(ConfidentialityError, ProviderError)
        assert issubclass(perplexity.PerplexityError, ProviderError)


class TestAvailability:
    """`is_configured` is what stands between a caller and a 503, so what
    counts as "no provider" is the contract being pinned here.

    The chain moved that line. A keyed provider with no key used to mean no
    research at all; now it means the keyless backends answer instead, and it
    takes pinning the chain off — an explicit operator choice — to get back to
    a state where nothing can answer.
    """

    def test_configured_when_only_perplexity_has_a_key(self, keyed, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER_CHAIN", "0")
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")  # keyed, no key set
        assert websearch.is_configured() is False
        assert is_configured() is True

    def test_configured_when_only_the_fallback_is_available(self):
        assert research_mod.primary_available() is False
        assert is_configured() is True

    def test_the_chain_keeps_search_available_despite_an_unkeyed_provider(
        self, monkeypatch
    ):
        """The reason the two tests either side of this one have to pin the
        chain off to observe an unconfigured state at all."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")  # keyed, no key set
        assert websearch.is_configured() is True
        assert is_configured() is True

    def test_unconfigured_only_when_neither_path_exists(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER_CHAIN", "0")
        monkeypatch.setenv("RESEARCH_PROVIDER", "serper")
        assert is_configured() is False

    def test_with_no_path_at_all_it_raises_rather_than_pretending(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER_CHAIN", "0")
        monkeypatch.setenv("RESEARCH_PROVIDER", "serper")
        with pytest.raises(ResearchError, match="no research provider"):
            research("public question")
