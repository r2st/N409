"""Web search providers — the retrieval half of the research fallback.

`perplexity.py` is the primary provider: one billed call that searches and
writes the answer. This module is what answers when that one cannot — no key
configured, a lapsed key, an exhausted quota, an outage. It retrieves sources;
`research.py` then synthesises from them with the OpenRouter models this
service already uses.

Being the fallback is the whole design, and it buys three things:

  * A keyless default. `duckduckgo` needs no account, no key and no billing
    relationship, so an installation with no Perplexity key still produces
    cited research instead of a 503. Perplexity sells no free tier, so before
    this existed the entire research chain — schema, route, containment, tab,
    exhibit — had never produced a single citation.

  * A provider you can change without changing the contract. Brave, Serper and
    Tavily all sell a better index than DuckDuckGo's scrape, and all three are
    a key and one env var away. `SearchHit` is the seam: every backend returns
    the same three fields, so `research.py` never learns which one answered.

  * Honest citations. The citation list is the retrieval result itself — the
    exact set of pages whose text was put in front of the model. Nothing can
    appear in a report's source list that the answer was not written from.

A caveat that belongs at the top rather than in a footnote: the keyless
default scrapes an endpoint DuckDuckGo defends with an anti-bot challenge, and
that challenge trips after a modest number of queries from one address. It is
detected and reported honestly (`is_challenge`), never worked around.

There is a packaged way around it — `ddgs`, the renamed `duckduckgo-search`,
drives its HTTP through randomised browser TLS fingerprints
(`impersonate="random"`) so the challenge never fires. This service will not
take that route, for the reason stated at `USER_AGENT` below: a search provider
is entitled to know what is calling it and to say no. Being told no is answered
by asking someone else, which is what the chain below does.

So the challenge is handled in the two honest ways available:

  * **A chain, not a choice.** `RESEARCH_PROVIDER` names where to *start*, not
    the only place to look. When a backend cannot answer, `search` moves to the
    next configured one instead of failing the call. Every installation ends
    the chain at a backend that needs no key, so "the fallback is also down"
    now takes every provider being down rather than one.

  * **A cooldown, not a retry.** A backend that answers with a bot challenge or
    a 429 is saying stop, so it is skipped for `RESEARCH_PROVIDER_COOLDOWN_S`
    rather than asked again on the next question. That is less load on the
    endpoint that objected, not more — the opposite of what a workaround does.

Configuration:
    RESEARCH_PROVIDER        duckduckgo (default) | searxng | brave | serper |
                             tavily | wikipedia — where the chain starts
    RESEARCH_PROVIDER_CHAIN  0 to disable the fallback chain and use only the
                             provider named above
    RESEARCH_PROVIDER_COOLDOWN_S  how long a challenged backend is skipped
    RESEARCH_MAX_RESULTS     how many hits to retrieve per query
    RESEARCH_CALL_BUDGET_S   whole-search wall clock; 0 disables
    SEARXNG_URL              instance base URL; required when provider=searxng
    BRAVE_SEARCH_API_KEY     required only when RESEARCH_PROVIDER=brave
    SERPER_API_KEY           required only when RESEARCH_PROVIDER=serper
    TAVILY_API_KEY           required only when RESEARCH_PROVIDER=tavily
"""

from __future__ import annotations

import html
import logging
import os
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass

import httpx

from .llm_http import MAX_RETRIES, Deadline, backoff_sleep, env_float, env_int
from .research_types import RECENCY_FILTERS

DEFAULT_PROVIDER = "duckduckgo"
DEFAULT_MAX_RESULTS = 8
DEFAULT_CALL_BUDGET_S = 60.0

#: How long a backend that told us to go away is left alone. Fifteen minutes is
#: chosen to be longer than a burst and shorter than an analyst's session: the
#: address that tripped DuckDuckGo's challenge on one report should not still be
#: hammering it while the next one is written, and should not be locked out of
#: it for the afternoon either.
DEFAULT_COOLDOWN_S = 900.0

#: Providers cap their own allowlists, and a query with forty `site:` clauses
#: is not a filter, it is a syntax error with a 200 on it.
MAX_DOMAINS = 10

#: DuckDuckGo's lite endpoint is a server-rendered form with no JS, no API key
#: and no per-account quota. It is scraped rather than consumed as an API, so
#: the parser below is written to return fewer results rather than to raise
#: when the markup shifts — see `parse_duckduckgo`.
#:
#: Know what you are getting. DuckDuckGo has no search API and no agreement
#: covering this; it defends the endpoint with an anti-bot challenge that
#: trips after a modest number of queries from one address (see
#: `DUCKDUCKGO_CHALLENGE_STATUS`). That challenge is detected and reported, and
#: deliberately not worked around — solving it would be both a bypass of a bot
#: check and a bet that the workaround outlives the next change to it. So this
#: backend is the right default for a fresh checkout and for an analyst asking
#: a handful of questions, and the wrong choice for a busy installation, which
#: should set one of the free-tier keyed providers below.
DUCKDUCKGO_URL = "https://lite.duckduckgo.com/lite/"
#: DuckDuckGo answers a challenged request 202 with a page carrying an
#: `anomaly.js` form rather than results. It is a success code on a failure,
#: so it has to be recognised explicitly or the parser reports "no sources
#: found" for what is actually "we were blocked" — the same answer a caller
#: gets for a genuinely obscure question, which is the one confusion worth
#: spending code to prevent.
DUCKDUCKGO_CHALLENGE_STATUS = 202
_CHALLENGE_MARKERS = ("anomaly.js", "challenge-form")

#: Identifies this service honestly rather than impersonating a browser. A
#: search provider is entitled to know what is calling it and to say no; the
#: answer to being told no is `RESEARCH_PROVIDER`, not a better disguise.
USER_AGENT = "n409-research/1.0 (+https://www.n409.ai; valuation research)"

#: SearXNG is the other keyless option, and the only one with an actual JSON
#: API behind it. There is no default instance on purpose: the public ones
#: rate-limit and come and go, and pointing every N409 install at a stranger's
#: server by default would be both rude and unreliable. Self-host it, or name
#: an instance you trust.
SEARXNG_URL_VAR = "SEARXNG_URL"

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
SERPER_URL = "https://google.serper.dev/search"
TAVILY_URL = "https://api.tavily.com/search"

#: MediaWiki's search API — the third keyless backend, and the only one that is
#: keyless because the publisher *intends* it to be rather than because it has
#: not noticed. It is a documented, versioned, public API with a published
#: etiquette policy (identify yourself, do not parallelise heavily), which
#: `USER_AGENT` satisfies. Nothing here is scraped and nothing can be
#: challenged, so this is the one backend whose availability does not depend on
#: how many questions the last analyst asked.
#:
#: The trade is coverage. Wikipedia knows about industries, business models and
#: established companies — which is most of what the industry_overview and
#: company_overview prompts ask — and knows nothing about last quarter's
#: transaction comps. So it is the *end* of the chain, not the front of it: the
#: backend that keeps a 409A memo cited when every general index has said no.
WIKIPEDIA_URL = "https://en.wikipedia.org/w/api.php"
WIKIPEDIA_ARTICLE_BASE = "https://en.wikipedia.org/wiki/"

_log = logging.getLogger("websearch")


class SearchError(Exception):
    """Raised when a search cannot be completed."""


@dataclass(frozen=True)
class SearchHit:
    """One retrieved source.

    `snippet` is what the provider returned as the page's relevant extract. It
    is the only page text this service ever sees — nothing here fetches the
    document itself, which keeps one search to one round trip and keeps the
    synthesis prompt bounded.
    """

    url: str
    title: str = ""
    snippet: str = ""

    def as_dict(self) -> dict:
        return {"url": self.url, "title": self.title, "snippet": self.snippet}


# ── Configuration ────────────────────────────────────────────────────────────


#: Env var each provider reads its key from. `duckduckgo` maps to None, which
#: is the whole point of it: `is_configured()` is True out of the box.
PROVIDER_KEYS: dict[str, str | None] = {
    "duckduckgo": None,
    # Keyless too, but it needs an instance to talk to, so `is_configured`
    # treats SEARXNG_URL the way the others treat a key.
    "searxng": SEARXNG_URL_VAR,
    "brave": "BRAVE_SEARCH_API_KEY",
    "serper": "SERPER_API_KEY",
    "tavily": "TAVILY_API_KEY",
    "wikipedia": None,
}

PROVIDERS = tuple(PROVIDER_KEYS)

#: Order the chain falls through in, best index first. The keyed providers buy
#: a real commercial index, so they lead; SearXNG is keyless but only exists if
#: an operator stood one up, which is itself a statement of preference;
#: DuckDuckGo is the zero-setup general index; Wikipedia is last because it is
#: the narrowest and, being the only one that cannot be turned off, has to be
#: the terminator rather than compete for a place further up.
CHAIN_ORDER = ("brave", "serper", "tavily", "searxng", "duckduckgo", "wikipedia")

#: Providers that cannot honour a domain allowlist and so must not be asked to
#: answer a query carrying one. Everything else either takes an allowlist
#: parameter or understands `site:`; Wikipedia does neither, and a citation
#: from outside the allowlist is worse than one fewer citation — the allowlist
#: is usually there because a regulator or a client asked for it.
NO_DOMAIN_FILTER = ("wikipedia",)


def configured_provider() -> str:
    """The backend to search with (RESEARCH_PROVIDER), defaulting to DuckDuckGo.

    An unrecognised name falls back to the default rather than raising. A typo
    in one env var should not take down a service whose other twenty settings
    are fine, and the keyless default always works — so the degraded state is
    "searching with the wrong engine", which is visible in the logs, rather
    than "not starting".
    """
    chosen = (os.environ.get("RESEARCH_PROVIDER") or "").strip().lower()
    if not chosen:
        return DEFAULT_PROVIDER
    if chosen not in PROVIDER_KEYS:
        _log.warning(
            "unknown RESEARCH_PROVIDER, falling back",
            extra={"event": "search_unknown_provider", "provider": chosen},
        )
        return DEFAULT_PROVIDER
    return chosen


def max_results() -> int:
    return env_int("RESEARCH_MAX_RESULTS", DEFAULT_MAX_RESULTS)


def call_budget_s() -> float:
    return env_float("RESEARCH_CALL_BUDGET_S", DEFAULT_CALL_BUDGET_S)


def cooldown_s() -> float:
    return env_float("RESEARCH_PROVIDER_COOLDOWN_S", DEFAULT_COOLDOWN_S)


def chain_enabled() -> bool:
    """Whether a failed backend falls through to the next configured one.

    On by default. The off switch exists for the installation that has to be
    able to say which index a given citation came from — a compliance answer,
    not a performance one — and would rather have the call fail than have it
    quietly answered by a second engine.
    """
    raw = (os.environ.get("RESEARCH_PROVIDER_CHAIN") or "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def available_providers() -> list[str]:
    """Every backend this installation could actually call, in chain order."""
    return [p for p in CHAIN_ORDER if PROVIDER_KEYS[p] is None or provider_key(p)]


def search_chain(
    provider: str | None = None,
    *,
    domains: list[str] | None = None,
    chain: bool | None = None,
) -> list[str]:
    """The backends to try, in order, for one search.

    The configured provider leads even when the preference order would put it
    elsewhere: RESEARCH_PROVIDER is an operator's explicit choice and the rest
    of the chain is only what happens when that choice cannot answer.

    `chain=False` pins the result to that one provider regardless of the env
    var — what /ready needs, since it is asking about a named backend rather
    than about whether an answer is obtainable.
    """
    start = provider or configured_provider()
    walk = chain_enabled() if chain is None else chain
    if not walk:
        found = [start]
    else:
        found = [start] + [p for p in available_providers() if p != start]
    if domains:
        found = [p for p in found if p not in NO_DOMAIN_FILTER]
    return found


def provider_key(provider: str | None = None) -> str:
    """The configured key for `provider`, or "" when it needs none."""
    var = PROVIDER_KEYS.get(provider or configured_provider())
    if var is None:
        return ""
    return os.environ.get(var, "").strip()


def is_configured() -> bool:
    """Whether search can run at all.

    True whenever any backend in the chain could be called, which with the
    chain on is always: DuckDuckGo and Wikipedia need no key, and that is the
    reason they are in it. A keyed provider named by RESEARCH_PROVIDER with no
    key set is therefore a misconfiguration that degrades rather than one that
    503s — `verify_provider` is what reports it.
    """
    return any(
        PROVIDER_KEYS[p] is None or provider_key(p) for p in search_chain()
    )


@dataclass(frozen=True)
class ProviderStatus:
    """Outcome of checking the search provider.

    ``state`` reuses `openrouter.KeyStatus`'s vocabulary — ``valid``,
    ``missing``, ``invalid``, ``unreachable`` — so /ready can report search
    alongside the completion providers without special-casing it.
    """

    state: str
    detail: str

    @property
    def ok(self) -> bool:
        return self.state == "valid"


#: /ready is polled by systemd and uptime checks. Verification issues a real
#: query, and on the keyless backend the scarce resource is not money but the
#: per-address allowance that DuckDuckGo's anti-bot challenge enforces — so an
#: uncached probe would spend the whole research budget on readiness and get
#: the service blocked for the analysts it is supposed to be ready for.
CHECK_TTL_S = 300.0

_check_lock = threading.Lock()
_check_cache: tuple[str, float, ProviderStatus] | None = None


def reset_check_cache() -> None:
    """Drop the cached verification (used by tests and by a forced check)."""
    global _check_cache
    with _check_lock:
        _check_cache = None


# ── Cooldown: taking "no" for an answer ──────────────────────────────────────

#: provider -> monotonic time it may be asked again.
_cooldowns: dict[str, float] = {}
_cooldown_lock = threading.Lock()


def reset_cooldowns() -> None:
    """Forget every cooldown (tests, and an operator forcing a recheck)."""
    with _cooldown_lock:
        _cooldowns.clear()


def in_cooldown(provider: str) -> bool:
    """Whether `provider` recently told us to stop and hasn't served its time."""
    with _cooldown_lock:
        until = _cooldowns.get(provider)
        if until is None:
            return False
        if time.monotonic() >= until:
            del _cooldowns[provider]
            return False
        return True


def cooldown_remaining(provider: str) -> float:
    """Seconds left on `provider`'s cooldown; 0 when it is callable."""
    with _cooldown_lock:
        until = _cooldowns.get(provider)
    return max(0.0, until - time.monotonic()) if until is not None else 0.0


def begin_cooldown(provider: str) -> None:
    """Stop calling `provider` for a while.

    Called when a backend has said, in the only vocabulary it has, that it does
    not want to be called: an anti-bot challenge or a 429. Honouring that is
    the entire policy — there is no path here that retries harder, changes how
    the client identifies itself, or routes around it.
    """
    window = cooldown_s()
    if window <= 0:
        return
    with _cooldown_lock:
        _cooldowns[provider] = time.monotonic() + window
    _log.warning(
        "search provider asked us to stop; cooling down",
        extra={"event": "search_cooldown", "path": provider, "status": int(window)},
    )


def _is_refusal(error: str) -> bool:
    """Whether a `SearchError` means "stop asking" rather than "that failed".

    A challenge and a 429 are refusals. A 500 is not — it is the provider
    failing, which a retry may well fix, so it must not put a working backend
    on the bench for fifteen minutes.
    """
    return f"HTTP {DUCKDUCKGO_CHALLENGE_STATUS}" in error or "HTTP 429" in error


def verify_provider(
    *, client: httpx.Client | None = None, force: bool = False
) -> ProviderStatus:
    """Check that the configured provider can actually answer a query.

    Memoised for CHECK_TTL_S, keyed on the provider, because the probe is a
    real search — see `CHECK_TTL_S`. A missing key is answered without a probe
    at all, which is both faster and the common case for a misconfiguration.
    """
    global _check_cache

    provider = configured_provider()
    var = PROVIDER_KEYS[provider]
    if var is not None and not provider_key(provider):
        return ProviderStatus("missing", f"{var} is not set for RESEARCH_PROVIDER={provider}")

    if not force:
        with _check_lock:
            cached = _check_cache
        if (
            cached is not None
            and cached[0] == provider
            and time.monotonic() - cached[1] < CHECK_TTL_S
        ):
            return cached[2]

    try:
        # Pinned to the configured provider on purpose. /ready is answering
        # "is RESEARCH_PROVIDER working", and letting the chain answer it would
        # report `valid` for a backend that has not worked in a week because
        # Wikipedia picked up its calls.
        hits = search(
            "site availability check",
            limit=1,
            provider=provider,
            chain=False,
            client=client,
        )
    except SearchError as exc:
        text = str(exc)
        if "HTTP 401" in text or "HTTP 403" in text:
            status = ProviderStatus("invalid", f"{provider} rejected the credentials: {text}")
        else:
            status = ProviderStatus("unreachable", f"could not reach {provider}: {text}")
    else:
        status = ProviderStatus(
            "valid", f"{provider} answered ({len(hits)} result{'' if len(hits) == 1 else 's'})"
        )

    with _check_lock:
        _check_cache = (provider, time.monotonic(), status)
    return status


# ── Query shaping ────────────────────────────────────────────────────────────


def apply_domain_filter(query: str, domains: list[str] | None) -> str:
    """Fold a domain allowlist into the query text.

    Used by the providers that have no allowlist parameter (DuckDuckGo,
    Serper). `site:` is understood by both, and OR-ing the clauses widens
    rather than narrows — `site:a OR site:b` is "either", which is what an
    allowlist means. Without the OR, engines read the sequence as AND and
    return nothing, which is the kind of filter that looks like an outage.
    """
    clean = [d.strip() for d in (domains or []) if d and d.strip()][:MAX_DOMAINS]
    if not clean:
        return query
    clause = " OR ".join(f"site:{d}" for d in clean)
    return f"{query} ({clause})" if len(clean) > 1 else f"{query} {clause}"


# ── DuckDuckGo (keyless default) ─────────────────────────────────────────────

#: Recency as the lite endpoint spells it.
_DDG_RECENCY = {"day": "d", "week": "w", "month": "m", "year": "y"}

_TAG_RE = re.compile(r"<[^>]+>")
#: Result links and snippets, in document order. Pairing is positional because
#: the markup nests them in sibling table rows rather than a shared container:
#: a link is followed by its snippet, or by nothing when the result has none.
_DDG_ROW_RE = re.compile(
    r"<a[^>]+class=['\"]result-link['\"][^>]*href=['\"](?P<href>[^'\"]+)['\"][^>]*>(?P<title>.*?)</a>"
    r"|<a[^>]+href=['\"](?P<href2>[^'\"]+)['\"][^>]*class=['\"]result-link['\"][^>]*>(?P<title2>.*?)</a>"
    r"|<td[^>]+class=['\"]result-snippet['\"][^>]*>(?P<snippet>.*?)</td>",
    re.DOTALL | re.IGNORECASE,
)


def _text(raw: str) -> str:
    """Markup fragment to plain text."""
    return html.unescape(_TAG_RE.sub("", raw or "")).strip()


def _unwrap(url: str) -> str:
    """Resolve DuckDuckGo's `/l/?uddg=` redirect wrapper to the real target.

    The lite endpoint serves direct hrefs most of the time and wrapped ones
    when it feels like it. A citation pointing at a duckduckgo.com redirector
    is useless in a report exhibit two years from now, so it is unwrapped here
    rather than stored.
    """
    if "uddg=" not in url:
        return url
    try:
        query = urllib.parse.urlparse(url).query
        target = urllib.parse.parse_qs(query).get("uddg", [""])[0]
        return target or url
    except ValueError:
        return url


def parse_duckduckgo(body: str, limit: int) -> list[SearchHit]:
    """Hits out of a lite-endpoint response.

    Deliberately total: any shape it does not recognise yields fewer hits, and
    an unparseable page yields none. Zero hits is a state `research.py` already
    handles honestly (it declines to answer), whereas an exception here would
    turn a markup tweak at DuckDuckGo into a 503 on a valuation.
    """
    hits: list[SearchHit] = []
    seen: set[str] = set()
    pending: str | None = None
    pending_title = ""

    def flush(snippet: str = "") -> None:
        nonlocal pending, pending_title
        if pending is None:
            return
        url, title, pending, pending_title = pending, pending_title, None, ""
        if url in seen:
            return
        seen.add(url)
        hits.append(SearchHit(url=url, title=title, snippet=snippet))

    for match in _DDG_ROW_RE.finditer(body):
        href = match.group("href") or match.group("href2")
        if href:
            # A new link means the previous one had no snippet row.
            flush()
            url = _unwrap(html.unescape(href.strip()))
            if is_web_url(url):
                pending = url
                pending_title = _text(match.group("title") or match.group("title2") or "")
            continue
        flush(_text(match.group("snippet") or ""))
        if len(hits) >= limit:
            return hits
    flush()
    return hits[:limit]


def _search_duckduckgo(
    query: str,
    *,
    limit: int,
    recency: str | None,
    domains: list[str] | None,
    http: httpx.Client,
    deadline: Deadline,
) -> list[SearchHit]:
    data = {"q": apply_domain_filter(query, domains)}
    if recency in _DDG_RECENCY:
        data["df"] = _DDG_RECENCY[recency]
    resp = http.post(
        DUCKDUCKGO_URL,
        data=data,
        headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        timeout=deadline.attempt_timeout(),
        follow_redirects=True,
    )
    if is_challenge(resp):
        # Reported, not solved, and not retried either: `_is_refusal` classifies
        # this, `search` moves to the next backend and puts DuckDuckGo on
        # cooldown. The message still names the durable fix, because falling
        # through to Wikipedia keeps the feature alive rather than making it
        # good — an installation seeing this regularly wants a real index.
        raise SearchError(
            f"duckduckgo HTTP {resp.status_code}: blocked by DuckDuckGo's anti-bot "
            "challenge. The keyless backend is rate-limited per address; set "
            "RESEARCH_PROVIDER to a free-tier provider (brave, serper, tavily) "
            "or to a SearXNG instance."
        )
    if resp.status_code != 200:
        raise SearchError(f"duckduckgo HTTP {resp.status_code}")
    return parse_duckduckgo(resp.text, limit)


def is_challenge(resp: httpx.Response) -> bool:
    """Whether DuckDuckGo served its anti-bot challenge instead of results.

    Checked on body content as well as status because the status alone is a
    2xx: a caller that trusted the code would parse the challenge page, find no
    results in it, and report "the public record has nothing on this".
    """
    if resp.status_code != DUCKDUCKGO_CHALLENGE_STATUS:
        return False
    body = resp.text[:4000].lower()
    return any(marker in body for marker in _CHALLENGE_MARKERS)


# ── SearXNG (keyless, self-hosted or a named instance) ───────────────────────


def searxng_base() -> str:
    return (os.environ.get(SEARXNG_URL_VAR) or "").strip().rstrip("/")


def _search_searxng(
    query: str,
    *,
    limit: int,
    recency: str | None,
    domains: list[str] | None,
    http: httpx.Client,
    deadline: Deadline,
) -> list[SearchHit]:
    base = searxng_base()
    if not base:
        raise SearchError(f"{SEARXNG_URL_VAR} is not set for RESEARCH_PROVIDER=searxng")
    params: dict[str, object] = {
        "q": apply_domain_filter(query, domains),
        "format": "json",
        "safesearch": 0,
    }
    if recency in RECENCY_FILTERS:
        params["time_range"] = recency
    resp = http.get(
        f"{base}/search",
        params=params,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=deadline.attempt_timeout(),
    )
    if resp.status_code != 200:
        raise SearchError(f"searxng HTTP {resp.status_code}: {resp.text[:200]}")
    data = _json_object(resp, "searxng")
    return _hits_from(
        data.get("results"), url_key="url", title_key="title", snippet_key="content", limit=limit
    )


# ── Brave ────────────────────────────────────────────────────────────────────

_BRAVE_RECENCY = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}


def _search_brave(
    query: str,
    *,
    limit: int,
    recency: str | None,
    domains: list[str] | None,
    http: httpx.Client,
    deadline: Deadline,
) -> list[SearchHit]:
    params: dict[str, object] = {"q": query, "count": limit}
    if recency in _BRAVE_RECENCY:
        params["freshness"] = _BRAVE_RECENCY[recency]
    clean = [d.strip() for d in (domains or []) if d and d.strip()][:MAX_DOMAINS]
    if clean:
        # Brave has no allowlist parameter either; same `site:` fold-in.
        params["q"] = apply_domain_filter(query, clean)
    resp = http.get(
        BRAVE_URL,
        params=params,
        headers={
            "X-Subscription-Token": provider_key("brave"),
            "Accept": "application/json",
        },
        timeout=deadline.attempt_timeout(),
    )
    if resp.status_code != 200:
        raise SearchError(f"brave HTTP {resp.status_code}: {resp.text[:200]}")
    data = _json_object(resp, "brave")
    web = data.get("web")
    rows = web.get("results") if isinstance(web, dict) else None
    return _hits_from(rows, url_key="url", title_key="title", snippet_key="description", limit=limit)


# ── Serper ───────────────────────────────────────────────────────────────────

_SERPER_RECENCY = {"day": "qdr:d", "week": "qdr:w", "month": "qdr:m", "year": "qdr:y"}


def _search_serper(
    query: str,
    *,
    limit: int,
    recency: str | None,
    domains: list[str] | None,
    http: httpx.Client,
    deadline: Deadline,
) -> list[SearchHit]:
    body: dict[str, object] = {"q": apply_domain_filter(query, domains), "num": limit}
    if recency in _SERPER_RECENCY:
        body["tbs"] = _SERPER_RECENCY[recency]
    resp = http.post(
        SERPER_URL,
        json=body,
        headers={"X-API-KEY": provider_key("serper"), "Content-Type": "application/json"},
        timeout=deadline.attempt_timeout(),
    )
    if resp.status_code != 200:
        raise SearchError(f"serper HTTP {resp.status_code}: {resp.text[:200]}")
    data = _json_object(resp, "serper")
    return _hits_from(
        data.get("organic"), url_key="link", title_key="title", snippet_key="snippet", limit=limit
    )


# ── Tavily ───────────────────────────────────────────────────────────────────

_TAVILY_RECENCY = {"day": "day", "week": "week", "month": "month", "year": "year"}


def _search_tavily(
    query: str,
    *,
    limit: int,
    recency: str | None,
    domains: list[str] | None,
    http: httpx.Client,
    deadline: Deadline,
) -> list[SearchHit]:
    body: dict[str, object] = {"query": query, "max_results": limit}
    if recency in _TAVILY_RECENCY:
        body["time_range"] = _TAVILY_RECENCY[recency]
    clean = [d.strip() for d in (domains or []) if d and d.strip()][:MAX_DOMAINS]
    if clean:
        # The one provider with a real allowlist parameter — use it rather than
        # spending query tokens on `site:` clauses it would also honour.
        body["include_domains"] = clean
    resp = http.post(
        TAVILY_URL,
        json=body,
        headers={
            "Authorization": f"Bearer {provider_key('tavily')}",
            "Content-Type": "application/json",
        },
        timeout=deadline.attempt_timeout(),
    )
    if resp.status_code != 200:
        raise SearchError(f"tavily HTTP {resp.status_code}: {resp.text[:200]}")
    data = _json_object(resp, "tavily")
    return _hits_from(
        data.get("results"), url_key="url", title_key="title", snippet_key="content", limit=limit
    )


# ── Shared response handling ─────────────────────────────────────────────────


# ── Wikipedia (keyless, and keyless on purpose) ──────────────────────────────


def _wikipedia_url(title: str) -> str:
    """Article title to its canonical URL.

    Built from the title rather than `?curid=` so the citation in a report
    exhibit says what it points at. Spaces become underscores the way MediaWiki
    writes them; everything else is percent-encoded, with `/` and `:` left
    alone because subpages and namespaces use them literally.
    """
    return WIKIPEDIA_ARTICLE_BASE + urllib.parse.quote(title.replace(" ", "_"), safe="/:()")


def _search_wikipedia(
    query: str,
    *,
    limit: int,
    recency: str | None,
    domains: list[str] | None,
    http: httpx.Client,
    deadline: Deadline,
) -> list[SearchHit]:
    """Search MediaWiki.

    `recency` and `domains` are accepted and ignored, for different reasons.
    Recency has no equivalent — article text has no publication date to filter
    on — and dropping the filter is the honest behaviour, since the alternative
    is pretending a constraint was applied. Domains never arrive: `search_chain`
    removes this backend from any chain carrying an allowlist, because unlike
    recency an unhonoured allowlist would put a citation somewhere the caller
    explicitly excluded.
    """
    resp = http.get(
        WIKIPEDIA_URL,
        params={
            "action": "query",
            "list": "search",
            "srsearch": query,
            "srlimit": max(1, min(limit, 50)),
            "srprop": "snippet",
            "format": "json",
            "formatversion": "2",
        },
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=deadline.attempt_timeout(),
        follow_redirects=True,
    )
    if resp.status_code != 200:
        raise SearchError(f"wikipedia HTTP {resp.status_code}")
    rows = _json_object(resp, "wikipedia").get("query", {})
    rows = rows.get("search") if isinstance(rows, dict) else None
    if not isinstance(rows, list):
        return []
    hits: list[SearchHit] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = row.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        # The snippet is HTML — MediaWiki wraps the matched terms in
        # <span class="searchmatch">. Stripped rather than kept, because it
        # goes into a prompt, not a page.
        raw_snippet = row.get("snippet")
        hits.append(
            SearchHit(
                url=_wikipedia_url(title.strip()),
                title=title.strip(),
                snippet=_text(raw_snippet) if isinstance(raw_snippet, str) else "",
            )
        )
        if len(hits) >= limit:
            break
    return hits


def _json_object(resp: httpx.Response, provider: str) -> dict:
    try:
        data = resp.json()
    except ValueError as exc:
        raise SearchError(f"{provider} returned non-JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SearchError(f"{provider} returned a non-object body ({type(data).__name__})")
    return data


_WEB_SCHEME_RE = re.compile(r"https?://", re.IGNORECASE)
"""Anchored by ``match``; a scheme is only a scheme at the start."""

_URL_IGNORED = {0x09: None, 0x0A: None, 0x0D: None}
"""Tab, LF and CR — what the URL parser removes before it parses. WHATWG URL."""


def is_web_url(value: str) -> bool:
    """Is this a URL a citation can be followed to?

    ``http`` and ``https`` and nothing else. The scheme is the whole question:
    a hit's URL is rendered as an ``href`` on the research tab, put in front of
    the synthesis model, and printed in the report's public-sources exhibit, and
    ``javascript:`` in the first of those is script running in an analyst's
    session. Tabs, newlines and carriage returns are deleted before the test
    because the URL parser deletes them before it parses — ``java<TAB>script:``
    is one scheme to a browser and another to a naive prefix check.

    ``parse_duckduckgo`` asked a version of this (``startswith("http")``) and
    the JSON backends asked nothing, which is the drift rather than the
    default: DuckDuckGo is the keyless backend every deployment falls back to,
    and SearXNG — the one a deployment points at an instance of its own — was
    the one with no check at all.
    """
    return _WEB_SCHEME_RE.match(value.translate(_URL_IGNORED)) is not None


def _hits_from(
    rows: object, *, url_key: str, title_key: str, snippet_key: str, limit: int
) -> list[SearchHit]:
    """Provider rows to `SearchHit`s, skipping anything malformed.

    Every level is provider-controlled, so none of it is assumed. A row without
    a usable URL is dropped rather than kept as a citation with nothing to cite,
    and so is one whose URL is not a URL — see `is_web_url`.
    """
    out: list[SearchHit] = []
    seen: set[str] = set()
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = row.get(url_key)
        if not isinstance(url, str) or not url.strip():
            continue
        clean = url.strip()
        if not is_web_url(clean):
            continue
        if clean in seen:
            continue
        seen.add(clean)
        title = row.get(title_key)
        snippet = row.get(snippet_key)
        out.append(
            SearchHit(
                url=clean,
                title=title.strip() if isinstance(title, str) else "",
                snippet=snippet.strip() if isinstance(snippet, str) else "",
            )
        )
        if len(out) >= limit:
            break
    return out


_BACKENDS = {
    "duckduckgo": _search_duckduckgo,
    "searxng": _search_searxng,
    "brave": _search_brave,
    "serper": _search_serper,
    "tavily": _search_tavily,
    "wikipedia": _search_wikipedia,
}


def _search_one(
    query: str,
    *,
    chosen: str,
    cap: int,
    recency: str | None,
    domains: list[str] | None,
    http: httpx.Client,
    deadline: Deadline,
) -> list[SearchHit]:
    """One backend's attempt at `query`, with that backend's retries.

    Returns an empty list when the provider answered but found nothing — that
    is a real answer about the public record, not a failure, and `research.py`
    reports it as such rather than inventing one. `SearchError` is reserved for
    "the provider did not answer".

    Transport failures and 5xx are retried within one shared wall clock, on the
    same argument as the completion providers: the retry is worth making only
    if there is time left to hear back from it. 4xx is not retried — a rejected
    key or a malformed query answers a second attempt the same way.
    """
    backend = _BACKENDS.get(chosen)
    if backend is None:
        raise SearchError(f"unknown search provider {chosen!r}")
    var = PROVIDER_KEYS[chosen]
    if var is not None and not provider_key(chosen):
        raise SearchError(f"{var} is not configured for RESEARCH_PROVIDER={chosen}")

    last_error = ""
    for attempt in range(MAX_RETRIES + 1):
        if deadline.expired():
            raise SearchError(
                f"{chosen}: search budget exhausted"
                f"{f' ({last_error})' if last_error else ''}"
            )
        try:
            hits = backend(
                query,
                limit=cap,
                recency=recency,
                domains=domains,
                http=http,
                deadline=deadline,
            )
        except httpx.TransportError as exc:
            last_error = str(exc)
            if attempt < MAX_RETRIES and backoff_sleep(attempt, deadline):
                _log.warning(
                    "search connect error, retrying",
                    extra={"event": "search_retry", "path": chosen, "status": attempt},
                )
                continue
            raise SearchError(f"{chosen} unreachable: {exc}") from exc
        except SearchError as exc:
            text = str(exc)
            last_error = text
            # A refusal is not retried at all any more. It used to be worth one
            # backoff-spaced attempt on the theory that the challenge was a
            # burst; now there is a whole chain behind this backend, and asking
            # someone else is both a better answer and less load on the one
            # that objected. `search` puts it on cooldown on the way past.
            if _is_refusal(text):
                raise
            retryable = any(f"HTTP {code}" in text for code in (500, 502, 503, 504))
            if retryable and attempt < MAX_RETRIES and backoff_sleep(attempt, deadline):
                _log.warning(
                    "search transient error, retrying",
                    extra={"event": "search_retry", "path": chosen, "status": attempt},
                )
                continue
            raise
        _log.info(
            "web search",
            extra={"event": "search_usage", "path": chosen, "status": len(hits)},
        )
        return hits
    raise SearchError(f"{chosen}: retries exhausted ({last_error})")


def search_with_provider(
    query: str,
    *,
    limit: int | None = None,
    recency: str | None = None,
    domains: list[str] | None = None,
    provider: str | None = None,
    chain: bool | None = None,
    client: httpx.Client | None = None,
) -> tuple[str, list[SearchHit]]:
    """Walk the chain until a backend answers; return which one did, and its hits.

    The name comes back because the caller stores it: `research.py` records the
    retrieving index alongside the writing model, and with a chain in play
    "which index found these sources" stops being answerable from the
    environment alone.

    An empty result *ends* the walk rather than continuing it. A backend that
    answered "nothing" has answered — moving on would turn one honest "the
    public record is thin here" into an exhaustive hunt for any index willing
    to say something, which is how an obscure question acquires a citation it
    should not have.

    Raises `SearchError` only when every backend in the chain failed, with all
    of their errors, since by then the interesting question is which ones.
    """
    if not query.strip():
        raise SearchError("search query is empty")

    walk = search_chain(provider, domains=domains, chain=chain)
    if not walk:
        raise SearchError("no search provider is available for this query")

    cap = limit if limit is not None else max_results()
    owns_client = client is None
    http = client or httpx.Client(timeout=call_budget_s() or None)
    deadline = Deadline(call_budget_s())
    errors: list[str] = []
    try:
        for chosen in walk:
            if in_cooldown(chosen):
                errors.append(
                    f"{chosen}: cooling down for another "
                    f"{cooldown_remaining(chosen):.0f}s"
                )
                continue
            try:
                return chosen, _search_one(
                    query,
                    chosen=chosen,
                    cap=cap,
                    recency=recency,
                    domains=domains,
                    http=http,
                    deadline=deadline,
                )
            except SearchError as exc:
                text = str(exc)
                errors.append(text)
                if _is_refusal(text):
                    begin_cooldown(chosen)
                if deadline.expired():
                    break
                _log.warning(
                    "search provider failed, trying the next in the chain",
                    extra={"event": "search_chain_fallback", "path": chosen},
                )
        raise SearchError("; ".join(errors) or "no search provider answered")
    finally:
        if owns_client:
            http.close()


def search(
    query: str,
    *,
    limit: int | None = None,
    recency: str | None = None,
    domains: list[str] | None = None,
    provider: str | None = None,
    chain: bool | None = None,
    client: httpx.Client | None = None,
) -> list[SearchHit]:
    """`search_with_provider` for callers that only want the sources."""
    return search_with_provider(
        query,
        limit=limit,
        recency=recency,
        domains=domains,
        provider=provider,
        chain=chain,
        client=client,
    )[1]
