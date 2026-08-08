"""Web-grounded research — retrieve public sources, then answer only from them.

This is the module `perplexity.py` used to be, minus the vendor. Sonar sold
retrieval and synthesis as one billed call; here `websearch.py` retrieves and
`openrouter.chat` synthesises, which makes the whole feature free and — more
usefully — makes the boundary between "what the public record says" and "what a
model wrote about it" a seam in the code rather than a claim in a vendor's
marketing.

The contract the callers depend on is unchanged: `research()` takes a question
about a *public* subject and returns an answer, the sources behind it, and a
`grounded` flag saying whether there were any. The valuation service still
files only grounded answers into a report.

Two properties are worth stating plainly, because they are the reason this is
a separate module from `pipelines.py` rather than another pipeline in it:

  * Nothing confidential goes out. `pipelines._ask` redacts every prompt so a
    409A's subject never leaves the trust boundary. A search query cannot be
    redacted and still work — "[COMPANY]" is not a searchable subject — so the
    containment here is refusal instead: `assert_public` rejects anything
    carrying the redactor's placeholders, because their presence is positive
    proof that client text was routed here by mistake. `pipelines.py` does not
    import this module, and a test asserts it.

  * Nothing unsourced comes back. If the search returns no pages, this module
    does not call the model at all — it reports that the public record did not
    answer. An LLM asked a research question with no sources in front of it
    will produce a confident multiple from its weights, and that number landing
    in an exhibit beside real citations, with nothing to distinguish it, is the
    exact failure this whole path exists to prevent.

Configuration:
    RESEARCH_PROVIDER / RESEARCH_MAX_RESULTS / RESEARCH_CALL_BUDGET_S
        see `websearch.py`
    RESEARCH_SYNTHESIS_MODEL
        OpenRouter model for the write-up; defaults to the usual chain
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field

import httpx

from . import websearch
from .openrouter import OpenRouterError, chat
from .websearch import RECENCY_FILTERS, SearchError, SearchHit

#: The redaction placeholders `anonymize.py` substitutes. Their presence in a
#: research query means client text took a wrong turn — see the module docstring.
#: Mirrored from `anonymize._PLACEHOLDERS` rather than imported so that a
#: placeholder retired there cannot silently stop being refused here; the test
#: suite asserts the two agree.
REDACTION_MARKERS = (
    "[EMAIL]",
    "[SSN]",
    "[EIN]",
    "[PHONE]",
    "[ADDRESS]",
    "[NAME]",
    "[COMPANY]",
)

DEFAULT_SYSTEM = (
    "You are a research assistant for a business valuation firm. Answer only "
    "from the numbered sources supplied, cite them inline as [1], [2], and say "
    "plainly when the sources do not answer the question. Do not estimate a "
    "figure you could not find in a source."
)

#: What `research` says when the search came back empty. Stated as an answer
#: rather than raised as an error because a question the public record does not
#: cover is a legitimate research outcome; the empty citation list is what stops
#: it reaching a report.
NO_RESULTS_ANSWER = (
    "The public record returned no sources for this question, so it cannot be "
    "answered from retrieved material."
)

_log = logging.getLogger("research")

_CITATION_RE = re.compile(r"\[(\d{1,2})\]")


class ResearchError(Exception):
    """Raised when a research call cannot be completed."""


class ConfidentialityError(ResearchError):
    """Raised when a query carries client text that must not be searched.

    Deliberately not something callers retry or fall back on: this is a
    programming error in whatever assembled the query, and the only correct
    response is to stop. A caller that caught it and tried another provider
    would forward the same client text there.
    """


@dataclass(frozen=True)
class Citation:
    """One source the answer was written from."""

    url: str
    title: str = ""
    date: str = ""

    def as_dict(self) -> dict:
        return {"url": self.url, "title": self.title, "date": self.date}


@dataclass
class ResearchResult:
    model: str
    content: str
    citations: list[Citation] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def grounded(self) -> bool:
        """Whether the answer was written from retrieved sources.

        An ungrounded answer is just a completion, and the whole reason to take
        this path is the citation list. Callers use this to decide whether an
        answer may be quoted in a report.
        """
        return bool(self.citations)

    def as_dict(self) -> dict:
        return {
            "model": self.model,
            "content": self.content,
            "citations": [c.as_dict() for c in self.citations],
            "grounded": self.grounded,
            "tokens": self.total_tokens,
        }


def is_configured() -> bool:
    """Whether web-grounded research is available.

    True by default: the keyless DuckDuckGo backend needs no account. Callers
    use this to decide whether to offer research as an option, which must not
    cost a round trip.
    """
    return websearch.is_configured()


def synthesis_model() -> str | None:
    """Preferred OpenRouter model for the write-up, or None for the usual chain."""
    return (os.environ.get("RESEARCH_SYNTHESIS_MODEL") or "").strip() or None


# ── Confidentiality gate ─────────────────────────────────────────────────────


def assert_public(*parts: str) -> None:
    """Refuse text that carries redaction placeholders.

    A tripwire, not a sanitiser. It cannot tell whether a plain company name is
    a client's or a public comparable's — that judgement belongs to the caller,
    which knows which it is holding. What it can tell, with certainty, is that
    text reading "[COMPANY] holds 2,000,000 shares" came off a redaction pass
    over a client document, and no correct path routes that into a web search.
    """
    for part in parts:
        if not part:
            continue
        for marker in REDACTION_MARKERS:
            if marker in part:
                raise ConfidentialityError(
                    f"research query contains the redaction placeholder {marker} — "
                    "client text must not reach a web-search provider"
                )


# ── Synthesis ────────────────────────────────────────────────────────────────


def build_source_block(hits: list[SearchHit]) -> str:
    """The retrieved sources, numbered, as the model will see them.

    Numbering is 1-based and stable because the inline `[n]` markers in the
    answer are the only link between a claim and a URL. The snippet is included
    verbatim: it is the evidence, and paraphrasing it here would put a second
    lossy step between the page and the citation.
    """
    lines: list[str] = []
    for index, hit in enumerate(hits, start=1):
        lines.append(f"[{index}] {hit.title or hit.url}")
        lines.append(f"    URL: {hit.url}")
        if hit.snippet:
            lines.append(f"    Extract: {hit.snippet}")
    return "\n".join(lines)


def order_by_citation(hits: list[SearchHit], content: str) -> list[Citation]:
    """Retrieved sources, the ones the answer cited first.

    Every retrieved source stays in the list — they were all put in front of
    the model, so they are all part of how the answer was produced, and
    dropping the uncited ones would overstate how selective it was. But an
    exhibit reads better with the sources the text actually points at on top,
    and a reviewer checking `[2]` should find it second.
    """
    order: list[int] = []
    for raw in _CITATION_RE.findall(content or ""):
        index = int(raw) - 1
        if 0 <= index < len(hits) and index not in order:
            order.append(index)
    order.extend(i for i in range(len(hits)) if i not in order)
    return [Citation(url=hits[i].url, title=hits[i].title) for i in order]


def research(
    query: str,
    *,
    system: str = DEFAULT_SYSTEM,
    model: str | None = None,
    recency: str | None = None,
    domains: list[str] | None = None,
    limit: int | None = None,
    client: httpx.Client | None = None,
    search_client: httpx.Client | None = None,
) -> ResearchResult:
    """Answer a question about the public record from retrieved sources.

    Raises `ConfidentialityError` if the query carries redaction placeholders
    and `ResearchError` if the call cannot be completed. `model` names the
    OpenRouter model that writes the answer — the search provider is chosen by
    `RESEARCH_PROVIDER`, not per call, because it is an account-level fact
    rather than a per-question one.

    `client` is the HTTP client for synthesis and `search_client` the one for
    retrieval; tests stub them separately because the two legs talk to
    different services and a single stub could not answer both.
    """
    assert_public(query, system)
    if not query.strip():
        raise ResearchError("research query is empty")

    provider = websearch.configured_provider()
    try:
        hits = websearch.search(
            query, limit=limit, recency=recency, domains=domains, client=search_client
        )
    except SearchError as exc:
        raise ResearchError(f"search failed: {exc}") from exc

    if not hits:
        # No sources means no answer worth having. Returning an ungrounded
        # result rather than raising keeps a legitimately unanswerable question
        # out of the 503 path — the empty citation list is what stops it
        # reaching a report.
        _log.info(
            "research found no sources",
            extra={"event": "research_empty", "path": provider, "status": 0},
        )
        return ResearchResult(model=provider, content=NO_RESULTS_ANSWER)

    prompt = (
        f"Question: {query.strip()}\n\n"
        f"Sources:\n{build_source_block(hits)}\n\n"
        "Answer the question using only these sources. Cite each claim inline "
        "as [n] with the source number. If the sources do not answer it, say so."
    )
    try:
        answer = chat(system, prompt, model=model or synthesis_model(), client=client)
    except OpenRouterError as exc:
        raise ResearchError(f"synthesis failed: {exc}") from exc

    citations = order_by_citation(hits, answer.content)
    _log.info(
        "research answered",
        extra={"event": "research_usage", "path": provider, "status": len(citations)},
    )
    return ResearchResult(
        # Both halves, because "which model wrote this" and "which index found
        # the sources" are different questions an operator asks about the same
        # stored row, and there is one column to answer them in.
        model=f"{provider}+{answer.model}",
        content=answer.content,
        citations=citations,
        prompt_tokens=answer.prompt_tokens,
        completion_tokens=answer.completion_tokens,
    )


__all__ = [
    "Citation",
    "ConfidentialityError",
    "DEFAULT_SYSTEM",
    "NO_RESULTS_ANSWER",
    "RECENCY_FILTERS",
    "REDACTION_MARKERS",
    "ResearchError",
    "ResearchResult",
    "assert_public",
    "is_configured",
    "research",
]
