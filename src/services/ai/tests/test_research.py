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
    assert_public,
    build_source_block,
    is_configured,
    order_by_citation,
    research,
)
from app.websearch import SearchError, SearchHit

HITS = [
    SearchHit("https://a.example/saas", "SaaS multiples 2026", "Public SaaS trades at 6-8x ARR."),
    SearchHit("https://b.example/index", "Sector index", "Median EV/Revenue of 6.4x."),
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in (
        "RESEARCH_PROVIDER",
        "RESEARCH_MAX_RESULTS",
        "RESEARCH_CALL_BUDGET_S",
        "RESEARCH_SYNTHESIS_MODEL",
        "BRAVE_SEARCH_API_KEY",
        "SERPER_API_KEY",
        "TAVILY_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)
    yield


@pytest.fixture
def answered(monkeypatch):
    """Stub both legs: search returns HITS, synthesis returns a citing answer.

    Returns the call log so a test can assert on what the model was shown —
    which is the only way to check that the sources really are the input.
    """
    calls: dict = {}

    def fake_search(query, **kwargs):
        calls["search"] = {"query": query, **kwargs}
        return list(HITS)

    def fake_chat(system, user, *, model=None, client=None):
        calls["chat"] = {"system": system, "user": user, "model": model}
        return LlmResult(
            model="openai/gpt-oss-20b:free",
            content="Public SaaS trades at 6-8x ARR [1], with a 6.4x median [2].",
            prompt_tokens=40,
            completion_tokens=120,
        )

    monkeypatch.setattr(research_mod.websearch, "search", fake_search)
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

        monkeypatch.setattr(research_mod.websearch, "search", explode)
        monkeypatch.setattr(research_mod, "chat", explode)
        with pytest.raises(ConfidentialityError):
            research("How is [COMPANY] funded?")

    def test_confidentiality_error_is_not_caught_as_a_transient(self, monkeypatch):
        """It must not be retryable: a caller catching ResearchError to fall
        back to another provider would forward the same client text there."""
        assert issubclass(ConfidentialityError, ResearchError)

        def explode(*args, **kwargs):
            raise AssertionError("searched despite the confidentiality gate")

        monkeypatch.setattr(research_mod.websearch, "search", explode)
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
        monkeypatch.setattr(research_mod.websearch, "search", lambda q, **kw: [])

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
        monkeypatch.setattr(research_mod.websearch, "search", lambda q, **kw: [])
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


# ── configuration and the result contract ────────────────────────────────────


class TestConfiguration:
    def test_research_is_available_with_no_key_configured(self):
        """The reason this replaced the Perplexity client: citations must not
        require a billing relationship."""
        assert is_configured() is True

    def test_a_keyed_provider_without_its_key_is_unavailable(self, monkeypatch):
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
        assert set(out) == {"model", "content", "citations", "grounded", "tokens"}
        assert out["citations"][0]["url"] == "https://a.example/saas"

    def test_the_model_field_names_both_halves(self, answered):
        """'Which model wrote this' and 'which index found the sources' are
        different questions about the same stored row, with one column to
        answer them in."""
        out = research("public question")
        assert out.model == "duckduckgo+openai/gpt-oss-20b:free"

    def test_the_model_field_tracks_the_configured_provider(self, answered, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "tavily")
        monkeypatch.setenv("TAVILY_API_KEY", "tvly-1")
        assert research("public question").model.startswith("tavily+")

    def test_tokens_are_the_synthesis_tokens(self, answered):
        assert research("public question").total_tokens == 160

    def test_an_empty_query_is_refused(self):
        with pytest.raises(ResearchError, match="empty"):
            research("   ")


class TestFailures:
    def test_a_search_failure_is_a_research_error(self, monkeypatch):
        def boom(query, **kwargs):
            raise SearchError("duckduckgo unreachable: no route")

        monkeypatch.setattr(research_mod.websearch, "search", boom)
        with pytest.raises(ResearchError, match="search failed"):
            research("public question")

    def test_a_synthesis_failure_is_a_research_error(self, monkeypatch):
        monkeypatch.setattr(research_mod.websearch, "search", lambda q, **kw: list(HITS))

        def boom(*args, **kwargs):
            raise OpenRouterError("every candidate model failed")

        monkeypatch.setattr(research_mod, "chat", boom)
        with pytest.raises(ResearchError, match="synthesis failed"):
            research("public question")

    def test_neither_failure_is_mistaken_for_a_confidentiality_refusal(self, monkeypatch):
        """The route maps ConfidentialityError to 422 and everything else to
        503; a provider outage reported as a caller bug sends an operator to
        the wrong place."""

        def boom(query, **kwargs):
            raise SearchError("down")

        monkeypatch.setattr(research_mod.websearch, "search", boom)
        with pytest.raises(ResearchError) as caught:
            research("public question")
        assert not isinstance(caught.value, ConfidentialityError)


def test_recency_vocabulary_is_shared_with_the_search_layer():
    """The route validates `recency` against this tuple before calling; two
    copies drifting apart would 422 a filter the provider supports."""
    assert research_mod.RECENCY_FILTERS is websearch.RECENCY_FILTERS
