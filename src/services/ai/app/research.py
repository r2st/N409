"""Web-grounded research — Perplexity first, a keyless search fallback behind it.

Two providers answer the same question by different means, and this module
picks between them:

  * **Perplexity Sonar** (`perplexity.py`) — preferred whenever
    PERPLEXITY_API_KEY is set. One billed call that searches and writes the
    answer, returning the sources it read. It is the better answer: the
    retrieval is a real index rather than a scrape, and the synthesis sees the
    pages rather than the snippets.

  * **Search + synthesis** (`websearch.py` + `openrouter.chat`) — the fallback,
    and the reason the feature works at all today. `RESEARCH_PROVIDER` defaults
    to DuckDuckGo, which needs no key, no account and no billing relationship,
    so an installation with no Perplexity key still produces cited research
    instead of a 503.

The fallback is automatic and silent to the caller: no key, a rejected key, an
exhausted quota, a 5xx or an unparseable body all end the same way — the
question gets asked the other way, and the caller gets a `ResearchResult`
either way. `ResearchResult.model` names which path answered, so a stored row
still says how it was produced.

Two properties survive the choice, and both are why this is a separate module
from `pipelines.py` rather than another pipeline in it:

  * **Nothing confidential goes out.** `pipelines._ask` redacts every prompt so
    a 409A's subject never leaves the trust boundary. A search query cannot be
    redacted and still work — "[COMPANY]" is not a searchable subject — so the
    containment here is refusal instead. `assert_public` runs **once, before a
    provider is chosen**, and `ConfidentialityError` is not a `ProviderError`,
    so the fallback below cannot catch it. A refusal that fell through to the
    second provider would forward the same client text to a second search
    engine, turning the guarantee inside out.

  * **Nothing unsourced comes back.** On the fallback path, if the search
    returns no pages the model is not called at all — an LLM asked a research
    question with no sources in front of it will produce a confident multiple
    from its weights, and that number landing in an exhibit beside real
    citations, with nothing to distinguish it, is the exact failure this whole
    path exists to prevent.

    The mirror case is sources with no model: retrieval succeeds and synthesis
    does not, which on a free-tier OpenRouter account is a daily event rather
    than an outage. Those sources are returned rather than discarded, marked
    `synthesized=False`, and `ResearchResult.grounded` is false for them — so
    they can be read by an analyst and cannot be quoted by a report. Both
    halves of the same rule: what reaches a 409A must be something somebody
    wrote from sources that exist.

Configuration:
    PERPLEXITY_API_KEY etc.     see `perplexity.py`; unset disables the primary
    RESEARCH_PROVIDER etc.      see `websearch.py`; the fallback's backend
    RESEARCH_SYNTHESIS_MODEL    OpenRouter model for the fallback's write-up
"""

from __future__ import annotations

import logging
import os
import re

import httpx

from . import perplexity, websearch
from .openrouter import OpenRouterError, chat
from .perplexity import PerplexityError
from .research_types import (
    RECENCY_FILTERS,
    REDACTION_MARKERS,
    Citation,
    ConfidentialityError,
    ProviderError,
    ResearchError,
    ResearchResult,
    assert_public,
)
from .websearch import SearchError, SearchHit

DEFAULT_SYSTEM = (
    "You are a research assistant for a business valuation firm. Answer only "
    "from the sources you retrieve, cite them, and say plainly when the public "
    "record does not answer the question. Do not estimate a figure you could "
    "not find."
)

#: The fallback's system prompt. Says the same thing as `DEFAULT_SYSTEM` with
#: the one addition that path needs: the sources arrive numbered, so the answer
#: has to point at them by number for `order_by_citation` to have anything to
#: read.
FALLBACK_SYSTEM = (
    "You are a research assistant for a business valuation firm. Answer only "
    "from the numbered sources supplied, cite them inline as [1], [2], and say "
    "plainly when the sources do not answer the question. Do not estimate a "
    "figure you could not find in a source."
)

#: What the fallback says when the search came back empty. Stated as an answer
#: rather than raised as an error because a question the public record does not
#: cover is a legitimate research outcome; the empty citation list is what stops
#: it reaching a report.
NO_RESULTS_ANSWER = (
    "The public record returned no sources for this question, so it cannot be "
    "answered from retrieved material."
)

#: What a sources-only result says where the answer would be. Deliberately not
#: written as a partial answer: it makes no claim about the subject at all, so
#: there is nothing in it for a drafting step to mistake for a finding. The
#: sources are real and are returned alongside it; `synthesized=False` is what
#: keeps the pair out of a report, and this text is what an analyst reads.
UNSYNTHESIZED_ANSWER = (
    "Sources were retrieved for this question but could not be summarised — the "
    "synthesis model was unavailable. The sources below are listed unread: "
    "nobody, and no model, has drawn a conclusion from them. Re-run the "
    "question to get a written answer."
)

#: What a result whose write-up was cut off says where the answer would be.
#:
#: A truncated completion is the one failure on this path that arrives looking
#: exactly like a success: a 200, real prose, real citations, and a sentence
#: that simply stops. `_safe_result` catches the pipelines' version of it
#: because their answers are JSON and half a JSON object does not parse — a
#: research answer is free text, so nothing anywhere contradicted it. It was
#: stored `grounded`, listed in the sources exhibit, and handed to the narrative
#: agent as material to draft a 409A's market discussion from, with the second
#: half of its last claim missing. A figure cut off after its first digit is
#: still a figure.
#:
#: So it degrades exactly as an unavailable synthesis model does: the sources
#: are real and are kept, `synthesized=False` keeps the pair out of every report
#: path, and the partial text is not carried in `content` for the same reason
#: `UNSYNTHESIZED_ANSWER` is not written as a partial answer — a drafting step
#: reading half a claim cannot tell it is half.
TRUNCATED_ANSWER = (
    "Sources were retrieved for this question and the write-up was cut off at "
    "the model's output cap before it finished, so it has been discarded rather "
    "than quoted half-written. The sources below are listed unread. Ask a "
    "narrower question, or raise OPENROUTER_MAX_TOKENS, and re-run."
)

#: What a result whose write-up the provider withheld says where the answer
#: would be.
#:
#: The same argument as `TRUNCATED_ANSWER`, one stop reason over. A content
#: filter returns the fragment written before it tripped and a Bedrock
#: guardrail returns its own message instead of the model's, and on this path —
#: free text, nothing parsing it — either one is stored `grounded`, listed in
#: the sources exhibit and handed to the narrative agent as material for a
#: 409A's market discussion. A guardrail's "I can't help with that" quoted as a
#: market conclusion is worse than no conclusion, and indistinguishable from one.
SUPPRESSED_ANSWER = (
    "Sources were retrieved for this question but the write-up was withheld by "
    "the provider's content filter, so what came back is not the model's answer "
    "and has been discarded rather than quoted. The sources below are listed "
    "unread. Re-run the question, or ask it differently."
)

_log = logging.getLogger("research")

_CITATION_RE = re.compile(r"\[(\d{1,2})\]")


def is_configured() -> bool:
    """Whether web-grounded research is available at all.

    True by default, because the fallback's default backend needs no account.
    Callers use this to decide whether to offer research as an option, which
    must not cost a round trip — so it asks what is *configured*, never what
    currently works.
    """
    return perplexity.is_configured() or websearch.is_configured()


def primary_available() -> bool:
    """Whether Sonar is configured and will therefore be tried first."""
    return perplexity.is_configured()


def synthesis_model(preferred: str | None = None) -> str | None:
    """The OpenRouter model for the fallback's write-up, or None for the chain.

    A Sonar tier is filtered out rather than passed through. The prompt
    registry stores one `model` per research topic and it holds a Sonar tier
    (migration 0124), because Sonar is the primary; handing "sonar-pro" to
    OpenRouter as a preferred model would put a guaranteed 404 at the head of
    the fallback chain every time the fallback ran.
    """
    chosen = preferred or os.environ.get("RESEARCH_SYNTHESIS_MODEL") or ""
    chosen = chosen.strip()
    if not chosen or chosen.startswith("sonar"):
        return None
    return chosen


def perplexity_model(preferred: str | None = None) -> str | None:
    """The Sonar tier to ask for, or None to let `perplexity` decide.

    The mirror image of `synthesis_model`: an OpenRouter id on the request is
    meant for the fallback's synthesis step and is not a Sonar tier, so it is
    dropped here rather than sent to Perplexity as a model it has never heard
    of. Routing on the id like this follows `llm_router`, which already picks a
    provider from a model-id prefix.
    """
    chosen = (preferred or "").strip()
    if not chosen:
        return None
    return chosen if chosen.startswith("sonar") else None


# ── The fallback path: retrieve, then synthesise ─────────────────────────────


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


def fallback_research(
    query: str,
    *,
    system: str = FALLBACK_SYSTEM,
    model: str | None = None,
    recency: str | None = None,
    domains: list[str] | None = None,
    limit: int | None = None,
    client: httpx.Client | None = None,
    search_client: httpx.Client | None = None,
) -> ResearchResult:
    """Retrieve sources for `query`, then write an answer from only those.

    Assumes the confidentiality gate has already run — `research` is the only
    caller and runs it once for both paths.

    The two legs fail differently, because they have different amounts to lose.
    Retrieval failing raises `ProviderError`: there is nothing to return, and
    the raise is what lets a caller distinguish "the fallback is also down"
    from "there was nothing to find". Synthesis failing does not raise — the
    sources are already retrieved, so they come back with `synthesized=False`
    instead of being discarded along with the error.
    """
    try:
        # The provider comes back from the call rather than from the
        # environment: `websearch` walks a chain, so which index answered is
        # only knowable after it has. Recording the configured one would label
        # a Wikipedia-sourced answer `duckduckgo` in a stored row that a report
        # exhibit is built from.
        provider, hits = websearch.search_with_provider(
            query, limit=limit, recency=recency, domains=domains, client=search_client
        )
    except SearchError as exc:
        raise ProviderError(f"search failed: {exc}") from exc

    if not hits:
        # No sources means no answer worth having. Returning an ungrounded
        # result rather than raising keeps a legitimately unanswerable question
        # out of the error path — the empty citation list is what stops it
        # reaching a report.
        _log.info(
            "research found no sources",
            extra={"event": "research_empty", "provider": provider, "count": 0},
        )
        return ResearchResult(model=provider, content=NO_RESULTS_ANSWER)

    prompt = (
        f"Question: {query.strip()}\n\n"
        f"Sources:\n{build_source_block(hits)}\n\n"
        "Answer the question using only these sources. Cite each claim inline "
        "as [n] with the source number. If the sources do not answer it, say so."
    )
    try:
        answer = chat(system, prompt, model=synthesis_model(model), client=client)
    except OpenRouterError as exc:
        # Retrieval already succeeded, so the expensive, rate-limited half of
        # this call is done and its result is sitting in `hits`. Raising here
        # would throw it away and return a 503, which is what happened every
        # time the OpenRouter free tier's daily allowance ran out: the search
        # ran, the pages were found, and the caller was told the whole thing
        # failed. The sources are worth having on their own — an analyst can
        # read them — so they are returned with `synthesized=False`, which
        # keeps them off every path that would quote them as an answer.
        _log.warning(
            "research synthesis failed, returning sources unread",
            extra={
                "event": "research_unsynthesized",
                "provider": provider,
                "count": len(hits),
            },
        )
        return ResearchResult(
            model=f"{provider}+unsynthesized",
            content=UNSYNTHESIZED_ANSWER,
            # Ordered as retrieved: `order_by_citation` promotes the sources an
            # answer cited, and there is no answer to have cited any of them.
            citations=[Citation(url=h.url, title=h.title) for h in hits],
            synthesized=False,
        )

    if answer.suppressed:
        # See `SUPPRESSED_ANSWER`. Ordered as retrieved rather than by citation
        # for the same reason the truncated case is: the answer is being
        # discarded, so its ordering is not evidence of anything.
        _log.warning(
            "research synthesis withheld by a content filter, returning sources unread",
            extra={
                "event": "research_suppressed",
                "provider": provider,
                "model": answer.model,
                "detail": answer.finish_reason,
                "count": len(hits),
            },
        )
        return ResearchResult(
            model=f"{provider}+{answer.model}",
            content=SUPPRESSED_ANSWER,
            citations=[Citation(url=h.url, title=h.title) for h in hits],
            prompt_tokens=answer.prompt_tokens,
            completion_tokens=answer.completion_tokens,
            synthesized=False,
        )

    if answer.truncated:
        # See `TRUNCATED_ANSWER`. Ordered as retrieved rather than by citation:
        # the answer is being discarded, so its ordering is not evidence of
        # anything.
        _log.warning(
            "research synthesis truncated at the output cap, returning sources unread",
            extra={
                "event": "research_truncated",
                "provider": provider,
                "model": answer.model,
                "count": len(hits),
            },
        )
        return ResearchResult(
            model=f"{provider}+{answer.model}",
            content=TRUNCATED_ANSWER,
            citations=[Citation(url=h.url, title=h.title) for h in hits],
            prompt_tokens=answer.prompt_tokens,
            completion_tokens=answer.completion_tokens,
            synthesized=False,
        )

    citations = order_by_citation(hits, answer.content)
    _log.info(
        "research answered",
        extra={"event": "research_usage", "provider": provider, "count": len(citations)},
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


# ── The choice ───────────────────────────────────────────────────────────────


def research(
    query: str,
    *,
    system: str | None = None,
    model: str | None = None,
    recency: str | None = None,
    domains: list[str] | None = None,
    limit: int | None = None,
    client: httpx.Client | None = None,
    search_client: httpx.Client | None = None,
    perplexity_client: httpx.Client | None = None,
) -> ResearchResult:
    """Answer a question about the public record, Sonar first.

    Raises `ConfidentialityError` if the query carries redaction placeholders —
    before either provider is touched — and `ResearchError` if every available
    path failed.

    `system` is applied to whichever provider answers; left unset, each uses
    its own default, which differ only in that the fallback's asks for numbered
    citations. `model` is routed by id: a `sonar` tier goes to Perplexity, an
    OpenRouter id to the fallback's synthesis step, and each path ignores the
    other's.

    The three client arguments exist because the two paths talk to three
    different services and a single stub could not answer for all of them.
    """
    assert_public(query, system or "")
    if not query.strip():
        raise ResearchError("research query is empty")

    errors: list[str] = []

    if perplexity.is_configured():
        kwargs: dict = {
            "model": perplexity_model(model),
            "recency": recency,
            "domains": domains,
            "client": perplexity_client,
        }
        if system:
            kwargs["system"] = system
        try:
            return perplexity.research(query, **kwargs)
        except ConfidentialityError:
            # Not caught by the `except PerplexityError` below, because it is
            # not one — but re-raised explicitly so that nobody "fixes" the
            # hierarchy later without this line failing loudly first.
            raise
        except PerplexityError as exc:
            # The whole point of the fallback. A lapsed key, an exhausted
            # quota or a bad afternoon at Perplexity degrades to the keyless
            # path rather than to a 503 on somebody's valuation.
            errors.append(f"perplexity: {exc}")
            _log.warning(
                "perplexity research failed, falling back to search",
                extra={"event": "research_fallback", "provider": websearch.configured_provider()},
            )

    if not websearch.is_configured():
        raise ResearchError(
            "no research provider is available"
            + (f" ({'; '.join(errors)})" if errors else "")
        )

    fallback_kwargs: dict = {
        "model": model,
        "recency": recency,
        "domains": domains,
        "limit": limit,
        "client": client,
        "search_client": search_client,
    }
    if system:
        fallback_kwargs["system"] = system
    try:
        return fallback_research(query, **fallback_kwargs)
    except ProviderError as exc:
        errors.append(str(exc))
        raise ResearchError("; ".join(errors)) from exc


__all__ = [
    "Citation",
    "ConfidentialityError",
    "DEFAULT_SYSTEM",
    "FALLBACK_SYSTEM",
    "NO_RESULTS_ANSWER",
    "RECENCY_FILTERS",
    "REDACTION_MARKERS",
    "TRUNCATED_ANSWER",
    "ResearchError",
    "ResearchResult",
    "UNSYNTHESIZED_ANSWER",
    "assert_public",
    "fallback_research",
    "is_configured",
    "primary_available",
    "research",
]
