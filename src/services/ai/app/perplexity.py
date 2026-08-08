"""Perplexity Sonar client — web-grounded research with citations.

This is not a second general-purpose completion provider. OpenRouter answers
prompts *about the payload the caller sent*; Sonar answers questions *about the
public record*, and returns the sources it read. Those are different jobs, and
the difference is the reason this module exists separately rather than as
another entry in `configured_models`:

  * What it is for. A 409A cites public facts — what a sector's revenue
    multiples are trading at, whether a named public comparable is still
    independent, what a market's growth looks like this quarter. A model
    answering those from weights is guessing at a number a reviewer will check,
    and its training cutoff is not disclosed in the report. Sonar returns the
    URL it read it in, so the citation is the deliverable as much as the answer.

  * Why it is fenced off. Sonar issues live web searches. Everything else in
    this service exists to keep a confidential 409A's subject inside the trust
    boundary — `pipelines._ask` redacts every prompt precisely so the company
    name does not leave. Handing that same text to a search provider defeats
    the entire arrangement, and it would not even work: "[COMPANY]" is not a
    searchable subject.

So the contract is narrow and enforced rather than documented: `research`
takes a question about a *public* subject, and refuses anything carrying the
redaction placeholders, because their presence is positive proof that client
text was routed here by mistake. `pipelines.py` does not import this module.

Its place in the chain: `research.py` tries this provider **first** whenever
PERPLEXITY_API_KEY is set, and falls back to `websearch.py` + OpenRouter
synthesis when it is not, or when a call here fails. Sonar remains the
preferred path because it is one billed call that returns a sourced answer,
where the fallback is a scrape plus a synthesis step and is only as good as the
snippets it retrieved. Nothing in this module knows about that arrangement —
it either answers or raises, and the choosing happens one layer up.

Configuration:
    PERPLEXITY_API_KEY        the key (required; keys start 'pplx-')
    PERPLEXITY_MODEL          override the default model
    PERPLEXITY_MAX_TOKENS     per-call output ceiling
    PERPLEXITY_CALL_BUDGET_S  whole-call wall clock; 0 disables
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass

import httpx

from .llm_http import (
    MAX_RETRIES,
    Deadline,
    DeadlineExceeded as _BaseDeadlineExceeded,
    backoff_sleep,
    env_float,
    env_int,
    token_count,
)
from .research_types import (
    RECENCY_FILTERS,
    REDACTION_MARKERS,
    Citation,
    ConfidentialityError,
    ProviderError,
    ResearchResult,
    assert_public,
)

PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions"
# Every Perplexity key carries this prefix. A key that doesn't is a copy/paste
# of some *other* provider's secret — catch it before spending a round trip.
KEY_PREFIX = "pplx-"
KEY_CHECK_TIMEOUT_S = 10.0
# /ready is polled by systemd/uptime checks; re-probing on every hit would be
# both slow and rude. A minute of staleness is fine for readiness.
KEY_CHECK_TTL_S = 60.0

#: Sonar tiers, cheapest first. Unlike OpenRouter's free-tier list this is not
#: a fallback chain for rate limits — every one of these is billed, so falling
#: through on a 4xx would quietly spend more money to paper over a bad request.
#: The list exists so `PERPLEXITY_MODEL` can be validated against something.
MODELS = ("sonar", "sonar-pro", "sonar-reasoning")
DEFAULT_MODEL = "sonar"

DEFAULT_MAX_TOKENS = 1500
DEFAULT_CALL_BUDGET_S = 120.0

_log = logging.getLogger("perplexity")


class PerplexityError(ProviderError):
    """Raised when a Sonar call cannot be completed.

    A `ProviderError`, which is what makes the fallback in `research.py` legal:
    "Sonar could not answer" is a reason to ask somebody else the same public
    question. `ConfidentialityError` is imported rather than subclassed here
    precisely so it can never be caught by that fallback — see
    `research_types`.
    """


class DeadlineExceeded(PerplexityError, _BaseDeadlineExceeded):
    """Raised when the whole-call budget ran out before Sonar answered."""


def configured_model(preferred: str | None = None) -> str:
    """The Sonar tier to use: explicit argument, then env, then the default.

    An unrecognised name is not rejected — Perplexity ships new tiers faster
    than this list is updated, and refusing one would turn a working key into a
    broken service on their release day. It is logged instead.
    """
    chosen = preferred or os.environ.get("PERPLEXITY_MODEL") or DEFAULT_MODEL
    if chosen not in MODELS:
        _log.info(
            "unrecognised perplexity model, using as given",
            extra={"event": "pplx_unknown_model", "path": chosen},
        )
    return chosen


def max_output_tokens() -> int:
    return env_int("PERPLEXITY_MAX_TOKENS", DEFAULT_MAX_TOKENS)


def call_budget_s() -> float:
    """Wall-clock ceiling for one `research` (PERPLEXITY_CALL_BUDGET_S)."""
    return env_float("PERPLEXITY_CALL_BUDGET_S", DEFAULT_CALL_BUDGET_S)


def is_configured() -> bool:
    """Whether a key is present at all.

    Distinct from whether it *works* — that is `verify_api_key`. Callers use
    this to decide whether to offer web-grounded research as an option, which
    must not cost a round trip.
    """
    return bool(os.environ.get("PERPLEXITY_API_KEY", "").strip())


def _headers() -> dict[str, str]:
    key = os.environ.get("PERPLEXITY_API_KEY", "").strip()
    if not key:
        raise PerplexityError("PERPLEXITY_API_KEY is not configured")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


# ── API-key verification ─────────────────────────────────────────────────────
#
# Same argument as OpenRouter's: a non-empty key read as "configured", so a
# revoked or wrong-provider key only failed once a real request reached it.
# Perplexity has no free introspection endpoint, so the cheapest live proof is
# a one-token completion — which does cost, hence the TTL on the cache.


@dataclass(frozen=True)
class KeyStatus:
    """Outcome of verifying PERPLEXITY_API_KEY.

    ``state`` is one of ``valid``, ``missing``, ``malformed``, ``invalid`` or
    ``unreachable`` — the same vocabulary `openrouter.KeyStatus` uses, so
    /ready can report both providers without special-casing either.
    """

    state: str
    detail: str

    @property
    def ok(self) -> bool:
        return self.state == "valid"


_key_lock = threading.Lock()
_key_cache: tuple[str, float, KeyStatus] | None = None


def reset_key_cache() -> None:
    """Drop the cached verification (used by tests and by boot's forced check)."""
    global _key_cache
    with _key_lock:
        _key_cache = None


def _cached_key_status(key: str) -> KeyStatus | None:
    with _key_lock:
        if (
            _key_cache is not None
            and _key_cache[0] == key
            and time.monotonic() - _key_cache[1] < KEY_CHECK_TTL_S
        ):
            return _key_cache[2]
    return None


def _cache_key_status(key: str, status: KeyStatus) -> None:
    global _key_cache
    with _key_lock:
        _key_cache = (key, time.monotonic(), status)


def _probe_key(key: str, client: httpx.Client | None = None) -> KeyStatus:
    owns_client = client is None
    http = client or httpx.Client(timeout=KEY_CHECK_TIMEOUT_S)
    try:
        try:
            resp = http.post(
                PERPLEXITY_URL,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={
                    "model": DEFAULT_MODEL,
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                },
            )
        except httpx.HTTPError as exc:
            return KeyStatus("unreachable", f"could not reach Perplexity: {exc}")
        if resp.status_code in (401, 403):
            return KeyStatus(
                "invalid", f"Perplexity rejected PERPLEXITY_API_KEY (HTTP {resp.status_code})"
            )
        if resp.status_code != 200:
            return KeyStatus(
                "unreachable", f"unexpected HTTP {resp.status_code} from Perplexity"
            )
        return KeyStatus("valid", "Perplexity accepted the key")
    finally:
        if owns_client:
            http.close()


def verify_api_key(*, client: httpx.Client | None = None, force: bool = False) -> KeyStatus:
    """Verify PERPLEXITY_API_KEY, memoising the live result for KEY_CHECK_TTL_S."""
    key = os.environ.get("PERPLEXITY_API_KEY", "").strip()
    if not key:
        return KeyStatus("missing", "PERPLEXITY_API_KEY is not set")
    if not key.startswith(KEY_PREFIX):
        return KeyStatus(
            "malformed",
            f"PERPLEXITY_API_KEY does not start with '{KEY_PREFIX}' — "
            "that is not a Perplexity key",
        )
    if not force:
        cached = _cached_key_status(key)
        if cached is not None:
            return cached
    status = _probe_key(key, client)
    _cache_key_status(key, status)
    return status


# ── Response parsing ─────────────────────────────────────────────────────────


def _completion_text(data: dict) -> str:
    """The assistant text out of the body, or "" if it isn't there.

    Every level is provider-controlled, so none of it is assumed.
    """
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    return content if isinstance(content, str) else ""


def parse_citations(data: dict) -> list[Citation]:
    """Sources out of a Sonar body, in the order Sonar ranked them.

    Two shapes, because Perplexity ships both: the original `citations` (a list
    of bare URL strings) and the newer `search_results` (objects carrying a
    title and date). The richer one wins where both are present; where only the
    bare list is, a URL with no title is still a citation and is kept.

    Deduplicated on URL: the same source cited for three claims is one source,
    and a report exhibit listing it three times looks like padding.
    """
    out: list[Citation] = []
    seen: set[str] = set()

    def add(url: object, title: object = "", date: object = "") -> None:
        if not isinstance(url, str) or not url.strip():
            return
        clean = url.strip()
        if clean in seen:
            return
        seen.add(clean)
        out.append(
            Citation(
                url=clean,
                title=title.strip() if isinstance(title, str) else "",
                date=date.strip() if isinstance(date, str) else "",
            )
        )

    results = data.get("search_results")
    if isinstance(results, list):
        for row in results:
            if isinstance(row, dict):
                add(row.get("url"), row.get("title"), row.get("date"))

    citations = data.get("citations")
    if isinstance(citations, list):
        for row in citations:
            if isinstance(row, str):
                add(row)
            elif isinstance(row, dict):
                add(row.get("url"), row.get("title"), row.get("date"))

    return out


# ── The call ─────────────────────────────────────────────────────────────────


def _payload(
    model: str,
    system: str,
    query: str,
    recency: str | None,
    domains: list[str] | None,
) -> dict:
    body: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": query},
        ],
        # Research wants the sourced answer, not an interesting one.
        "temperature": 0.1,
        "max_tokens": max_output_tokens(),
        "return_citations": True,
    }
    if recency in RECENCY_FILTERS:
        body["search_recency_filter"] = recency
    if domains:
        # Perplexity caps the allowlist; sending more is a 400 rather than a
        # partial filter, so it is trimmed here where the reason is visible.
        body["search_domain_filter"] = list(domains)[:10]
    return body


def research(
    query: str,
    *,
    system: str = (
        "You are a research assistant for a business valuation firm. Answer only "
        "from the sources you retrieve, cite them, and say plainly when the "
        "public record does not answer the question. Do not estimate a figure "
        "you could not find."
    ),
    model: str | None = None,
    recency: str | None = None,
    domains: list[str] | None = None,
    client: httpx.Client | None = None,
) -> ResearchResult:
    """Ask Sonar a question about the public record.

    Raises `ConfidentialityError` if the query carries redaction placeholders,
    `PerplexityError` if the call cannot be completed. Unlike `openrouter.chat`
    there is no model fallback: every Sonar tier is billed, so retrying a bad
    request against a pricier model spends more money to get the same 400.

    The default system prompt is the load-bearing part. "Do not estimate a
    figure you could not find" is there because the failure mode that matters
    is not a wrong answer — it is a plausible unsourced multiple landing in a
    report exhibit next to real citations, where nothing distinguishes it.
    """
    assert_public(query, system)
    if not query.strip():
        raise PerplexityError("research query is empty")

    chosen = configured_model(model)
    owns_client = client is None
    http = client or httpx.Client(timeout=call_budget_s() or None)
    deadline = Deadline(call_budget_s())
    body = _payload(chosen, system, query, recency, domains)
    last_error = ""

    try:
        for attempt in range(MAX_RETRIES + 1):
            if deadline.expired():
                raise DeadlineExceeded(
                    f"perplexity: call budget exhausted{f' ({last_error})' if last_error else ''}"
                )
            try:
                resp = http.post(
                    PERPLEXITY_URL,
                    headers=_headers(),
                    json=body,
                    timeout=deadline.attempt_timeout(),
                )
            except httpx.TransportError as exc:
                last_error = str(exc)
                if attempt < MAX_RETRIES and backoff_sleep(attempt, deadline):
                    _log.warning(
                        "perplexity connect error, retrying",
                        extra={"event": "pplx_retry", "path": chosen, "status": attempt},
                    )
                    continue
                raise PerplexityError(f"perplexity unreachable: {exc}") from exc

            if resp.status_code >= 500:
                last_error = f"HTTP {resp.status_code}"
                if attempt < MAX_RETRIES and backoff_sleep(attempt, deadline):
                    _log.warning(
                        "perplexity 5xx, retrying",
                        extra={"event": "pplx_retry", "path": chosen, "status": resp.status_code},
                    )
                    continue
            if resp.status_code != 200:
                # 4xx is not retried: a malformed request, a rejected key or an
                # exhausted quota all answer the same way to a second attempt.
                raise PerplexityError(
                    f"perplexity HTTP {resp.status_code}: {resp.text[:200]}"
                )

            try:
                data = resp.json()
            except ValueError as exc:
                raise PerplexityError(f"perplexity returned non-JSON: {exc}") from exc
            if not isinstance(data, dict):
                raise PerplexityError(
                    f"perplexity returned a non-object body ({type(data).__name__})"
                )

            content = _completion_text(data)
            if not content:
                raise PerplexityError("perplexity returned an empty completion")

            usage = data.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            citations = parse_citations(data)
            served_by = data.get("model")
            served_by = served_by if isinstance(served_by, str) and served_by else chosen

            _log.info(
                "perplexity research",
                extra={
                    "event": "pplx_usage",
                    "path": served_by,
                    "status": len(citations),
                },
            )
            return ResearchResult(
                model=served_by,
                content=content,
                citations=citations,
                prompt_tokens=token_count(usage.get("prompt_tokens")),
                completion_tokens=token_count(usage.get("completion_tokens")),
            )
        raise PerplexityError(f"perplexity: retries exhausted ({last_error})")
    finally:
        if owns_client:
            http.close()
