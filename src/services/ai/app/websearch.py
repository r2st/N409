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
detected and reported honestly (`is_challenge`), never worked around. Treat
`duckduckgo` as the zero-setup default that keeps the feature alive without a
Perplexity key, and set a Perplexity key or one of the free-tier keyed
providers for an installation doing real volume.

Configuration:
    RESEARCH_PROVIDER        duckduckgo (default) | searxng | brave | serper | tavily
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
}

PROVIDERS = tuple(PROVIDER_KEYS)


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
            extra={"event": "search_unknown_provider", "path": chosen},
        )
        return DEFAULT_PROVIDER
    return chosen


def max_results() -> int:
    return env_int("RESEARCH_MAX_RESULTS", DEFAULT_MAX_RESULTS)


def call_budget_s() -> float:
    return env_float("RESEARCH_CALL_BUDGET_S", DEFAULT_CALL_BUDGET_S)


def provider_key(provider: str | None = None) -> str:
    """The configured key for `provider`, or "" when it needs none."""
    var = PROVIDER_KEYS.get(provider or configured_provider())
    if var is None:
        return ""
    return os.environ.get(var, "").strip()


def is_configured() -> bool:
    """Whether search can run at all.

    True for DuckDuckGo unconditionally — that is the reason it is the default.
    For the keyed providers this only reports that a key is *present*; whether
    it works is `verify_provider`.
    """
    provider = configured_provider()
    if PROVIDER_KEYS[provider] is None:
        return True
    return bool(provider_key(provider))


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
        hits = search("site availability check", limit=1, client=client)
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
            if url.startswith("http"):
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
        # Reported, not solved. Worth one backoff-spaced retry in case it was a
        # burst, and then it is an operator's problem with a one-line fix — so
        # the message says what the fix is rather than only what broke.
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


def _json_object(resp: httpx.Response, provider: str) -> dict:
    try:
        data = resp.json()
    except ValueError as exc:
        raise SearchError(f"{provider} returned non-JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SearchError(f"{provider} returned a non-object body ({type(data).__name__})")
    return data


def _hits_from(
    rows: object, *, url_key: str, title_key: str, snippet_key: str, limit: int
) -> list[SearchHit]:
    """Provider rows to `SearchHit`s, skipping anything malformed.

    Every level is provider-controlled, so none of it is assumed. A row without
    a usable URL is dropped rather than kept as a citation with nothing to cite.
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
}


def search(
    query: str,
    *,
    limit: int | None = None,
    recency: str | None = None,
    domains: list[str] | None = None,
    provider: str | None = None,
    client: httpx.Client | None = None,
) -> list[SearchHit]:
    """Retrieve sources for `query` from the configured provider.

    Returns an empty list when the provider answered but found nothing — that
    is a real answer about the public record, not a failure, and `research.py`
    reports it as such rather than inventing one. `SearchError` is reserved for
    "the provider did not answer".

    Transport failures and 5xx are retried within one shared wall clock, on the
    same argument as the completion providers: the retry is worth making only
    if there is time left to hear back from it. 4xx is not retried — a rejected
    key or a malformed query answers a second attempt the same way.
    """
    if not query.strip():
        raise SearchError("search query is empty")
    chosen = provider or configured_provider()
    backend = _BACKENDS.get(chosen)
    if backend is None:
        raise SearchError(f"unknown search provider {chosen!r}")
    var = PROVIDER_KEYS[chosen]
    if var is not None and not provider_key(chosen):
        raise SearchError(f"{var} is not configured for RESEARCH_PROVIDER={chosen}")

    cap = limit if limit is not None else max_results()
    owns_client = client is None
    http = client or httpx.Client(timeout=call_budget_s() or None)
    deadline = Deadline(call_budget_s())
    last_error = ""
    try:
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
                retryable = any(
                    f"HTTP {code}" in text
                    for code in (DUCKDUCKGO_CHALLENGE_STATUS, 429, 500, 502, 503, 504)
                )
                last_error = text
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
    finally:
        if owns_client:
            http.close()
