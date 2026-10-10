"""Tests for the research_types module — exception hierarchy, confidentiality gate, and result shape.

The exception hierarchy enforces a security invariant: ConfidentialityError must
not be catchable by ``except ProviderError``, because the fallback in
research.py relies on that separation. If a confidentiality refusal were a
ProviderError, a query carrying a client's company name would be refused by the
first provider and handed to the second.
"""

import pytest

from app.research_types import (
    RECENCY_FILTERS,
    REDACTION_MARKERS,
    Citation,
    ConfidentialityError,
    ProviderError,
    ResearchError,
    ResearchResult,
    assert_public,
)


class TestExceptionHierarchy:
    def test_confidentiality_error_is_not_provider_error(self):
        assert not issubclass(ConfidentialityError, ProviderError)

    def test_both_are_research_errors(self):
        assert issubclass(ProviderError, ResearchError)
        assert issubclass(ConfidentialityError, ResearchError)

    def test_provider_error_is_catchable_as_research_error(self):
        with pytest.raises(ResearchError):
            raise ProviderError("timeout")

    def test_confidentiality_error_is_not_catchable_as_provider_error(self):
        with pytest.raises(ConfidentialityError):
            try:
                raise ConfidentialityError("leaked client name")
            except ProviderError:
                pytest.fail("ConfidentialityError must not be caught by except ProviderError")


class TestAssertPublic:
    def test_passes_clean_text(self):
        assert_public("What is the market cap of Apple?", "Tell me about AAPL")

    def test_passes_empty_and_none_like(self):
        assert_public("", "", None)  # type: ignore[arg-type]

    @pytest.mark.parametrize("marker", REDACTION_MARKERS)
    def test_rejects_each_redaction_marker(self, marker: str):
        with pytest.raises(ConfidentialityError, match="redaction placeholder"):
            assert_public(f"The company {marker} has 10M shares")

    def test_checks_all_parts(self):
        with pytest.raises(ConfidentialityError):
            assert_public("clean first part", "but [COMPANY] leaks here")

    def test_rejects_marker_in_any_position(self):
        with pytest.raises(ConfidentialityError):
            assert_public("[EMAIL] is at the start")
        with pytest.raises(ConfidentialityError):
            assert_public("marker at end [SSN]")


class TestResearchResult:
    def test_total_tokens(self):
        r = ResearchResult(model="test", content="answer", prompt_tokens=100, completion_tokens=50)
        assert r.total_tokens == 150

    def test_grounded_requires_citations_and_synthesis(self):
        r = ResearchResult(
            model="test",
            content="answer",
            citations=[Citation(url="https://example.com")],
            synthesized=True,
        )
        assert r.grounded is True

    def test_not_grounded_without_citations(self):
        r = ResearchResult(model="test", content="answer", citations=[], synthesized=True)
        assert r.grounded is False

    def test_not_grounded_without_synthesis(self):
        r = ResearchResult(
            model="test",
            content="sources only",
            citations=[Citation(url="https://example.com")],
            synthesized=False,
        )
        assert r.grounded is False

    def test_as_dict_shape(self):
        c = Citation(url="https://example.com", title="Example", date="2026-01-01")
        r = ResearchResult(
            model="test-model",
            content="answer text",
            citations=[c],
            prompt_tokens=10,
            completion_tokens=20,
        )
        d = r.as_dict()
        assert d["model"] == "test-model"
        assert d["content"] == "answer text"
        assert d["grounded"] is True
        assert d["synthesized"] is True
        assert d["tokens"] == 30
        assert len(d["citations"]) == 1
        assert d["citations"][0]["url"] == "https://example.com"


class TestCitation:
    def test_as_dict(self):
        c = Citation(url="https://x.com", title="Title", date="2026-01")
        assert c.as_dict() == {"url": "https://x.com", "title": "Title", "date": "2026-01"}

    def test_defaults(self):
        c = Citation(url="https://x.com")
        assert c.title == ""
        assert c.date == ""


class TestRecencyFilters:
    def test_expected_values(self):
        assert set(RECENCY_FILTERS) == {"day", "week", "month", "year"}
