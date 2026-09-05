"""Web search providers.

Two things carry weight here. First, that the keyless default really is
keyless — the whole reason this replaced the Perplexity client is that a fresh
checkout should be able to cite the public record without a billing
relationship, and a test that passes only with a key set would hide a
regression back to the old state. Second, that the DuckDuckGo parser is total:
it scrapes a page nobody promised to keep stable, so every malformed shape has
to yield fewer results rather than an exception, because an exception here
becomes a 503 on somebody's valuation.
"""

import importlib.util
import logging
import time

import httpx
import pytest

from app import websearch
from app.websearch import (
    CHAIN_ORDER,
    MAX_DOMAINS,
    NO_DOMAIN_FILTER,
    PROVIDERS,
    SearchError,
    SearchHit,
    apply_domain_filter,
    configured_provider,
    is_configured,
    is_web_url,
    parse_duckduckgo,
    search,
    search_chain,
    search_with_provider,
    verify_provider,
)

# A trimmed copy of a real lite.duckduckgo.com response: two results, the
# second without a snippet, wrapped in the same table markup the endpoint
# emits. Kept verbatim rather than minimised so a parser change is tested
# against the shape that actually ships.
DDG_HTML = """
<table border="0">
  <tr><td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="https://windsordrake.com/saas" class='result-link'>2026 SaaS Valuation Multiples</a></td>
  </tr>
  <tr><td>&nbsp;</td>
    <td class='result-snippet'><b>Public</b> SaaS companies trade at roughly 6 to 7x <b>EV/Revenue</b>.</td>
  </tr>
  <tr><td>&nbsp;</td><td><span class='link-text'>windsordrake.com/saas</span></td></tr>
  <tr><td valign="top">2.&nbsp;</td>
    <td><a rel="nofollow" href="https://aventis-advisors.com/saas" class='result-link'>SaaS Valuation Multiples</a></td>
  </tr>
</table>
"""


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in (
        "RESEARCH_PROVIDER",
        "RESEARCH_PROVIDER_CHAIN",
        "RESEARCH_PROVIDER_COOLDOWN_S",
        "RESEARCH_MAX_RESULTS",
        "RESEARCH_CALL_BUDGET_S",
        "SEARXNG_URL",
        "BRAVE_SEARCH_API_KEY",
        "SERPER_API_KEY",
        "TAVILY_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)
    # Both caches are module-level and deliberately outlive a call, so without
    # this a challenge asserted in one test benches DuckDuckGo for every test
    # that runs after it — the failure mode being tested for, arriving in the
    # wrong place.
    websearch.reset_cooldowns()
    websearch.reset_check_cache()
    yield
    websearch.reset_cooldowns()
    websearch.reset_check_cache()


@pytest.fixture
def solo(monkeypatch):
    """Pin searches to the configured provider alone.

    Most of the tests below are about one backend's request or parser, and the
    chain would have them answered by the next provider the moment the case
    under test failed — which is the chain working, but it turns a precise
    assertion into "something answered". The chain gets its own section.
    """
    monkeypatch.setenv("RESEARCH_PROVIDER_CHAIN", "0")


def stub(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def ddg_ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, text=DDG_HTML)


def capturing(response: httpx.Response):
    """A handler that records the request it was given and replays `response`."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["content"] = request.content.decode() if request.content else ""
        seen["headers"] = dict(request.headers)
        return response

    return handler, seen


# ── the keyless default ──────────────────────────────────────────────────────


class TestKeylessDefault:
    def test_the_default_provider_is_duckduckgo(self):
        assert configured_provider() == "duckduckgo"

    def test_research_is_configured_with_no_key_anywhere(self):
        """The point of the rewrite. If this ever needs an env var to pass,
        web-grounded research has quietly become opt-in again."""
        assert is_configured() is True

    def test_duckduckgo_declares_no_key(self):
        assert websearch.PROVIDER_KEYS["duckduckgo"] is None

    def test_every_provider_is_reachable_through_a_backend(self):
        """A provider listed but not dispatchable would be a 'unknown provider'
        SearchError at runtime for someone who set it from the documented list."""
        assert set(PROVIDERS) == set(websearch._BACKENDS)


class TestProviderSelection:
    @pytest.mark.parametrize("name", PROVIDERS)
    def test_each_documented_provider_is_selectable(self, name, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", name)
        assert configured_provider() == name

    def test_case_and_whitespace_are_forgiven(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "  BRAVE ")
        assert configured_provider() == "brave"

    def test_a_typo_falls_back_rather_than_raising(self, monkeypatch):
        """A wrong value in one env var must not take down a service whose
        other settings are fine — the keyless default always works."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "gooogle")
        assert configured_provider() == "duckduckgo"

    def test_a_keyed_provider_without_its_key_degrades_rather_than_unconfiguring(
        self, monkeypatch
    ):
        """This used to report unconfigured, and a 503 followed. With the chain
        it is a misconfiguration that costs index quality, not the feature:
        `verify_provider` is what still calls it out."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
        assert is_configured() is True
        assert verify_provider().state == "missing"
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brv-123")
        assert is_configured() is True

    def test_a_keyed_provider_without_its_key_is_unconfigured_when_pinned(
        self, monkeypatch, solo
    ):
        """Pin the chain off and the old contract is back, because then there
        really is nowhere else for the call to go."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
        assert is_configured() is False

    def test_a_keyed_provider_refuses_before_making_a_request(self, monkeypatch, solo):
        monkeypatch.setenv("RESEARCH_PROVIDER", "tavily")

        def explode(request: httpx.Request) -> httpx.Response:
            raise AssertionError("called the provider without a key")

        with pytest.raises(SearchError, match="TAVILY_API_KEY"):
            search("public question", client=stub(explode))

    def test_an_unkeyed_provider_is_skipped_without_a_request_when_chaining(
        self, monkeypatch
    ):
        """The keyless backends answer instead, and the keyed one is never
        called — a missing key must not become an outbound request that spends
        a round trip to be told 401."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "tavily")
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.host)
            return httpx.Response(200, text=DDG_HTML)

        provider, hits = websearch.search_with_provider("q", client=stub(handler))
        assert provider == "duckduckgo"
        assert len(hits) == 2
        assert "api.tavily.com" not in seen


# ── the DuckDuckGo parser ────────────────────────────────────────────────────


class TestDuckDuckGoParser:
    def test_pairs_each_link_with_its_snippet(self):
        hits = parse_duckduckgo(DDG_HTML, limit=10)
        assert [h.url for h in hits] == [
            "https://windsordrake.com/saas",
            "https://aventis-advisors.com/saas",
        ]
        assert hits[0].title == "2026 SaaS Valuation Multiples"
        assert "6 to 7x EV/Revenue" in hits[0].snippet

    def test_a_result_with_no_snippet_still_counts(self):
        """Dropping it would silently shorten every page of results, and a URL
        with no extract is still a citable source."""
        hits = parse_duckduckgo(DDG_HTML, limit=10)
        assert hits[1].snippet == ""
        assert hits[1].title == "SaaS Valuation Multiples"

    def test_markup_is_stripped_and_entities_decoded(self):
        hits = parse_duckduckgo(DDG_HTML, limit=10)
        assert "<b>" not in hits[0].snippet
        assert "&amp;" not in hits[0].snippet

    def test_limit_is_honoured(self):
        assert len(parse_duckduckgo(DDG_HTML, limit=1)) == 1

    def test_duplicate_urls_collapse(self):
        doubled = DDG_HTML + DDG_HTML
        assert len(parse_duckduckgo(doubled, limit=10)) == 2

    def test_the_redirect_wrapper_is_unwrapped(self):
        """A citation pointing at a duckduckgo.com redirector is useless in a
        report exhibit two years from now."""
        body = (
            "<a href=\"https://duckduckgo.com/l/?uddg=https%3A%2F%2Fsec.gov%2Ffiling"
            "&amp;rut=abc\" class='result-link'>Filing</a>"
        )
        assert parse_duckduckgo(body, limit=5)[0].url == "https://sec.gov/filing"

    def test_attribute_order_does_not_matter(self):
        """The endpoint emits class-before-href on some result types."""
        body = "<a class='result-link' href=\"https://sec.gov/x\">X</a>"
        assert parse_duckduckgo(body, limit=5)[0].url == "https://sec.gov/x"

    def test_non_http_hrefs_are_skipped(self):
        body = "<a href=\"javascript:void(0)\" class='result-link'>bad</a>"
        assert parse_duckduckgo(body, limit=5) == []

    @pytest.mark.parametrize(
        "body",
        ["", "<html><body>nothing here</body></html>", "<table><tr><td>", "not html at all"],
    )
    def test_unrecognised_markup_yields_nothing_rather_than_raising(self, body):
        """DuckDuckGo can change this page whenever it likes. Fewer results is
        a degraded answer; an exception is a 503 on a valuation."""
        assert parse_duckduckgo(body, limit=5) == []


class TestDuckDuckGoRequest:
    def test_happy_path(self):
        hits = search("public SaaS multiples", client=stub(ddg_ok))
        assert len(hits) == 2
        assert hits[0].url.startswith("https://")

    def test_recency_is_translated_to_the_endpoints_spelling(self):
        handler, seen = capturing(httpx.Response(200, text=DDG_HTML))
        search("q", recency="month", client=stub(handler))
        assert "df=m" in seen["content"]

    def test_unknown_recency_is_dropped_rather_than_sent(self):
        handler, seen = capturing(httpx.Response(200, text=DDG_HTML))
        search("q", recency="fortnight", client=stub(handler))
        assert "df=" not in seen["content"]

    def test_domains_are_folded_into_the_query(self):
        handler, seen = capturing(httpx.Response(200, text=DDG_HTML))
        search("q", domains=["sec.gov", "nasdaq.com"], client=stub(handler))
        assert "site%3Asec.gov" in seen["content"]
        assert "OR" in seen["content"]

    def test_a_non_200_is_an_error(self):
        with pytest.raises(SearchError, match="HTTP 418"):
            search("q", client=stub(lambda r: httpx.Response(418, text="teapot")))

    def test_an_empty_query_is_refused(self):
        with pytest.raises(SearchError, match="empty"):
            search("   ", client=stub(ddg_ok))

    def test_no_results_is_an_empty_list_not_an_error(self):
        """The provider answered; the public record just had nothing. That is a
        real research outcome, and `research.py` reports it as one."""
        assert search("q", client=stub(lambda r: httpx.Response(200, text="<html></html>"))) == []

    def test_max_results_env_caps_the_page(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_MAX_RESULTS", "1")
        assert len(search("q", client=stub(ddg_ok))) == 1


# ── the domain allowlist ─────────────────────────────────────────────────────


class TestDomainFilter:
    def test_a_single_domain_needs_no_parentheses(self):
        assert apply_domain_filter("multiples", ["sec.gov"]) == "multiples site:sec.gov"

    def test_several_domains_are_ored(self):
        """Without the OR an engine reads the sequence as AND and returns
        nothing — a filter that looks like an outage."""
        out = apply_domain_filter("multiples", ["sec.gov", "nasdaq.com"])
        assert out == "multiples (site:sec.gov OR site:nasdaq.com)"

    def test_the_list_is_capped(self):
        out = apply_domain_filter("q", [f"d{i}.example" for i in range(25)])
        assert out.count("site:") == MAX_DOMAINS

    @pytest.mark.parametrize("domains", [None, [], ["", "  "]])
    def test_nothing_usable_leaves_the_query_alone(self, domains):
        assert apply_domain_filter("multiples", domains) == "multiples"


# ── the keyed providers ──────────────────────────────────────────────────────


class TestBrave:
    @pytest.fixture(autouse=True)
    def _brave(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brv-123")

    def test_parses_the_web_results_block(self):
        body = {
            "web": {
                "results": [
                    {"url": "https://a.example", "title": "A", "description": "extract a"},
                    {"url": "https://b.example", "title": "B", "description": "extract b"},
                ]
            }
        }
        hits = search("q", client=stub(lambda r: httpx.Response(200, json=body)))
        assert hits == [
            SearchHit("https://a.example", "A", "extract a"),
            SearchHit("https://b.example", "B", "extract b"),
        ]

    def test_sends_the_subscription_token(self):
        handler, seen = capturing(httpx.Response(200, json={"web": {"results": []}}))
        search("q", client=stub(handler))
        assert seen["headers"]["x-subscription-token"] == "brv-123"

    def test_recency_is_translated(self):
        handler, seen = capturing(httpx.Response(200, json={"web": {"results": []}}))
        search("q", recency="week", client=stub(handler))
        assert "freshness=pw" in seen["url"]

    def test_a_rejected_key_is_surfaced(self):
        with pytest.raises(SearchError, match="HTTP 401"):
            search("q", client=stub(lambda r: httpx.Response(401, text="nope")))


class TestSerper:
    @pytest.fixture(autouse=True)
    def _serper(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "serper")
        monkeypatch.setenv("SERPER_API_KEY", "srp-123")

    def test_parses_the_organic_block(self):
        body = {"organic": [{"link": "https://a.example", "title": "A", "snippet": "s"}]}
        hits = search("q", client=stub(lambda r: httpx.Response(200, json=body)))
        assert hits == [SearchHit("https://a.example", "A", "s")]

    def test_sends_the_api_key_header(self):
        handler, seen = capturing(httpx.Response(200, json={"organic": []}))
        search("q", client=stub(handler))
        assert seen["headers"]["x-api-key"] == "srp-123"

    def test_recency_is_translated(self):
        handler, seen = capturing(httpx.Response(200, json={"organic": []}))
        search("q", recency="day", client=stub(handler))
        assert '"tbs": "qdr:d"' in seen["content"] or '"tbs":"qdr:d"' in seen["content"]


class TestTavily:
    @pytest.fixture(autouse=True)
    def _tavily(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "tavily")
        monkeypatch.setenv("TAVILY_API_KEY", "tvly-123")

    def test_parses_the_results_block(self):
        body = {"results": [{"url": "https://a.example", "title": "A", "content": "s"}]}
        hits = search("q", client=stub(lambda r: httpx.Response(200, json=body)))
        assert hits == [SearchHit("https://a.example", "A", "s")]

    def test_uses_the_native_allowlist_rather_than_site_clauses(self):
        """The one provider with a real allowlist parameter — spending query
        tokens on `site:` clauses instead would be strictly worse."""
        handler, seen = capturing(httpx.Response(200, json={"results": []}))
        search("q", domains=["sec.gov"], client=stub(handler))
        assert "include_domains" in seen["content"]
        assert "site:" not in seen["content"]


class TestMalformedProviderBodies:
    """Every level of these bodies is provider-controlled, so none is assumed."""

    @pytest.fixture(autouse=True)
    def _serper(self, monkeypatch, solo):
        monkeypatch.setenv("RESEARCH_PROVIDER", "serper")
        monkeypatch.setenv("SERPER_API_KEY", "srp-123")

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"organic": None},
            {"organic": "nope"},
            {"organic": [None, 42]},
            {"organic": [{"no_link": 1}]},
            {"organic": [{"link": ""}]},
        ],
    )
    def test_junk_yields_no_hits_rather_than_raising(self, body):
        assert search("q", client=stub(lambda r: httpx.Response(200, json=body))) == []

    def test_non_json_is_a_search_error(self):
        with pytest.raises(SearchError, match="non-JSON"):
            search("q", client=stub(lambda r: httpx.Response(200, text="<html>")))

    def test_a_non_object_body_is_a_search_error(self):
        with pytest.raises(SearchError, match="non-object"):
            search("q", client=stub(lambda r: httpx.Response(200, json=[1, 2])))

    def test_rows_without_a_usable_url_are_dropped_not_kept_as_blank_citations(self):
        body = {"organic": [{"link": "https://a.example"}, {"link": None}, {"link": "  "}]}
        hits = search("q", client=stub(lambda r: httpx.Response(200, json=body)))
        assert [h.url for h in hits] == ["https://a.example"]

    def test_duplicate_urls_collapse(self):
        body = {"organic": [{"link": "https://a.example"}] * 3}
        assert len(search("q", client=stub(lambda r: httpx.Response(200, json=body)))) == 1


# ── retries ──────────────────────────────────────────────────────────────────


class TestRetries:
    """One backend's retry policy, so the chain is pinned off throughout —
    otherwise the next provider answers and the retry count under test never
    gets the chance to be wrong."""

    @pytest.fixture(autouse=True)
    def _solo(self, solo):
        pass

    def test_a_transport_error_is_retried_then_surfaced(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        calls = {"n": 0}

        def boom(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            raise httpx.ConnectError("no route", request=request)

        with pytest.raises(SearchError, match="unreachable"):
            search("q", client=stub(boom))
        assert calls["n"] == websearch.MAX_RETRIES + 1

    def test_a_5xx_is_retried(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        calls = {"n": 0}

        def flaky(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(503, text="down")

        with pytest.raises(SearchError):
            search("q", client=stub(flaky))
        assert calls["n"] == websearch.MAX_RETRIES + 1

    def test_a_rate_limit_is_not_retried_because_it_is_a_refusal(self, monkeypatch):
        """429 used to be worth a second attempt. It is not any more: with a
        chain behind this backend, asking someone else is both a better answer
        and less load on the one that just said stop."""
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        calls = {"n": 0}

        def limited(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(429, text="slow down")

        with pytest.raises(SearchError, match="HTTP 429"):
            search("q", client=stub(limited))
        assert calls["n"] == 1

    def test_a_4xx_is_not_retried(self, monkeypatch):
        """A malformed query or a rejected key answers a second attempt the
        same way."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brv-123")
        calls = {"n": 0}

        def rejected(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(403, text="forbidden")

        with pytest.raises(SearchError, match="HTTP 403"):
            search("q", client=stub(rejected))
        assert calls["n"] == 1


# ── DuckDuckGo's anti-bot challenge ──────────────────────────────────────────

#: What the endpoint actually serves a challenged request: HTTP 202, with an
#: anomaly form where the results should be. Trimmed from a real response.
CHALLENGE_HTML = """
<html><body>
<iframe name="ifr" width="0" height="0" class="hidden"></iframe>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=lite&cc=botnet&st=1786210859"
      target="ifr" method="POST"></form>
</body></html>
"""


class TestAntiBotChallenge:
    """DuckDuckGo answers a blocked request 202 — a success code on a failure.

    Recognising it is the difference between telling an analyst "the public
    record has nothing on this" and telling an operator "we are blocked, set a
    provider key". Those need different people to do different things.
    """

    @pytest.fixture(autouse=True)
    def _solo(self, solo):
        pass

    def test_a_challenge_is_an_error_not_an_empty_result_set(self):
        challenged = stub(lambda r: httpx.Response(202, text=CHALLENGE_HTML))
        with pytest.raises(SearchError, match="anti-bot challenge"):
            search("q", client=challenged)

    def test_the_error_says_what_the_fix_is(self):
        """The operator needs the remedy, not just the symptom."""
        challenged = stub(lambda r: httpx.Response(202, text=CHALLENGE_HTML))
        with pytest.raises(SearchError) as caught:
            search("q", client=challenged)
        assert "RESEARCH_PROVIDER" in str(caught.value)

    def test_a_challenge_is_not_retried(self, monkeypatch):
        """It used to be retried once in case it was a burst. Asking again is
        the one response a bot challenge is entitled not to get, and there is
        now somewhere else to ask."""
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        calls = {"n": 0}

        def challenged(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(202, text=CHALLENGE_HTML)

        with pytest.raises(SearchError, match="anti-bot challenge"):
            search("q", client=stub(challenged))
        assert calls["n"] == 1

    def test_a_plain_202_without_the_challenge_markers_is_not_treated_as_blocked(self):
        """Only the anomaly page means blocked. A bare 202 is just a status."""
        plain = stub(lambda r: httpx.Response(202, text=DDG_HTML))
        with pytest.raises(SearchError) as caught:
            search("q", client=plain)
        assert "anti-bot" not in str(caught.value)

    def test_the_user_agent_identifies_the_service_rather_than_a_browser(self):
        """A provider is entitled to know what is calling it. The answer to
        being told no is RESEARCH_PROVIDER, not a better disguise."""
        handler, seen = capturing(httpx.Response(200, text=DDG_HTML))
        search("q", client=stub(handler))
        agent = seen["headers"]["user-agent"]
        assert "n409" in agent.lower()
        assert "Mozilla" not in agent


# ── SearXNG ──────────────────────────────────────────────────────────────────


class TestSearxng:
    @pytest.fixture(autouse=True)
    def _searxng(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "searxng")
        monkeypatch.setenv("SEARXNG_URL", "https://searx.example/")

    def test_parses_the_results_block(self):
        body = {"results": [{"url": "https://a.example", "title": "A", "content": "s"}]}
        hits = search("q", client=stub(lambda r: httpx.Response(200, json=body)))
        assert hits == [SearchHit("https://a.example", "A", "s")]

    def test_a_trailing_slash_on_the_instance_url_does_not_double_up(self):
        handler, seen = capturing(httpx.Response(200, json={"results": []}))
        search("q", client=stub(handler))
        assert seen["url"].startswith("https://searx.example/search?")

    def test_without_an_instance_it_refuses_rather_than_guessing_one(self, monkeypatch, solo):
        """Pointing an install at a stranger's server by default would be both
        rude and unreliable."""
        monkeypatch.delenv("SEARXNG_URL", raising=False)
        with pytest.raises(SearchError, match="SEARXNG_URL"):
            search("q", client=stub(lambda r: httpx.Response(200, json={})))

    def test_recency_is_passed_through(self):
        handler, seen = capturing(httpx.Response(200, json={"results": []}))
        search("q", recency="month", client=stub(handler))
        assert "time_range=month" in seen["url"]


# ── readiness ────────────────────────────────────────────────────────────────


class TestVerifyProvider:
    @pytest.fixture(autouse=True)
    def _fresh_cache(self):
        websearch.reset_check_cache()
        yield
        websearch.reset_check_cache()

    def test_a_working_default_provider_is_valid(self):
        assert verify_provider(client=stub(ddg_ok)).ok

    def test_the_result_is_cached(self):
        """/ready is polled constantly and the probe is a real search. On the
        keyless backend the scarce resource is the per-address allowance, so an
        uncached probe would get the service blocked for the analysts it is
        supposed to be reporting readiness for."""
        calls = {"n": 0}

        def counting(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, text=DDG_HTML)

        verify_provider(client=stub(counting))
        verify_provider(client=stub(counting))
        verify_provider(client=stub(counting))
        assert calls["n"] == 1

    def test_force_skips_the_cache(self):
        calls = {"n": 0}

        def counting(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, text=DDG_HTML)

        verify_provider(client=stub(counting))
        verify_provider(client=stub(counting), force=True)
        assert calls["n"] == 2

    def test_switching_provider_invalidates_the_cache(self, monkeypatch):
        """A cached 'duckduckgo works' must not be served as the answer for a
        Brave key an operator just set."""
        verify_provider(client=stub(ddg_ok))
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brv-1")
        status = verify_provider(client=stub(lambda r: httpx.Response(401, text="no")))
        assert status.state == "invalid"

    def test_a_blocked_default_provider_is_reported_not_hidden(self):
        blocked = stub(lambda r: httpx.Response(202, text=CHALLENGE_HTML))
        status = verify_provider(client=blocked)
        assert not status.ok
        assert "anti-bot challenge" in status.detail

    def test_a_missing_key_is_reported_without_a_round_trip(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "serper")

        def explode(request: httpx.Request) -> httpx.Response:
            raise AssertionError("probed the network without a key")

        status = verify_provider(client=stub(explode))
        assert status.state == "missing"
        assert "SERPER_API_KEY" in status.detail

    def test_a_rejected_key_reads_as_invalid_not_unreachable(self, monkeypatch):
        """An operator seeing 'unreachable' goes looking at the network; the
        distinction is the whole value of the field."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "wrong")
        status = verify_provider(client=stub(lambda r: httpx.Response(401, text="no")))
        assert status.state == "invalid"

    def test_an_unreachable_provider_is_reported_as_such(self):
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        assert verify_provider(client=stub(boom)).state == "unreachable"

    def test_zero_results_still_counts_as_working(self):
        """The provider answered. Readiness is about the provider, not about
        whether one probe query happened to match anything."""
        status = verify_provider(client=stub(lambda r: httpx.Response(200, text="<html></html>")))
        assert status.ok

    def test_a_wikipedia_refusal_is_not_zero_results(self, monkeypatch):
        """The rule above reads "did not raise" as "answered", which is right
        for every backend that reports a refusal with a status. MediaWiki does
        not: a `readonly` reply is a 200, so a backend that had refused every
        call for a week answered `valid (0 results)` here."""
        monkeypatch.setenv("RESEARCH_PROVIDER", "wikipedia")
        body = {"error": {"code": "readonly", "info": "…"}}
        status = verify_provider(client=stub(lambda r: httpx.Response(200, json=body)))
        assert status.state == "unreachable"
        assert "readonly" in status.detail


# ── Wikipedia ────────────────────────────────────────────────────────────────

#: A trimmed formatversion=2 response from the MediaWiki search API.
WIKI_JSON = {
    "query": {
        "search": [
            {
                "title": "Software as a service",
                "snippet": 'SaaS is a <span class="searchmatch">software</span> licensing model.',
            },
            {"title": "Valuation (finance)", "snippet": "Valuation is the process..."},
        ]
    }
}


class TestWikipedia:
    """The one backend that is keyless because the publisher intends it to be.

    Which is why it is the chain's terminator: it cannot be rate-limited into
    silence by the last analyst's session, so there is always somewhere for a
    search to end up.
    """

    @pytest.fixture(autouse=True)
    def _wikipedia(self, monkeypatch, solo):
        monkeypatch.setenv("RESEARCH_PROVIDER", "wikipedia")

    def test_it_needs_no_key(self):
        assert websearch.PROVIDER_KEYS["wikipedia"] is None
        assert is_configured() is True

    def test_titles_become_article_urls(self):
        hits = search("q", client=stub(lambda r: httpx.Response(200, json=WIKI_JSON)))
        assert [h.url for h in hits] == [
            "https://en.wikipedia.org/wiki/Software_as_a_service",
            "https://en.wikipedia.org/wiki/Valuation_(finance)",
        ]

    def test_the_snippet_markup_is_stripped(self):
        """It goes into a prompt, not a page — `searchmatch` spans would just
        be tokens the model has to ignore."""
        hits = search("q", client=stub(lambda r: httpx.Response(200, json=WIKI_JSON)))
        assert hits[0].snippet == "SaaS is a software licensing model."
        assert "<span" not in hits[0].snippet

    def test_the_query_reaches_the_search_api(self):
        handler, seen = capturing(httpx.Response(200, json=WIKI_JSON))
        search("saas multiples", client=stub(handler))
        assert "action=query" in seen["url"] and "list=search" in seen["url"]
        assert "srsearch=saas+multiples" in seen["url"]

    def test_it_identifies_itself_as_mediawiki_etiquette_asks(self):
        """MediaWiki's policy is an honest User-Agent with a contact URL. The
        one this service already sends satisfies it, which is the reason this
        backend needs no special-casing."""
        handler, seen = capturing(httpx.Response(200, json=WIKI_JSON))
        search("q", client=stub(handler))
        agent = seen["headers"]["user-agent"]
        assert "n409" in agent.lower() and "http" in agent.lower()

    @pytest.mark.parametrize(
        "body",
        [{}, {"query": None}, {"query": {}}, {"query": {"search": None}},
         {"query": {"search": [None, 7]}}, {"query": {"search": [{"title": ""}]}}],
    )
    def test_junk_yields_no_hits_rather_than_raising(self, body):
        assert search("q", client=stub(lambda r: httpx.Response(200, json=body))) == []

    def test_a_non_200_is_a_search_error(self):
        with pytest.raises(SearchError, match="wikipedia HTTP 500"):
            search("q", client=stub(lambda r: httpx.Response(500, text="boom")))

    @pytest.mark.parametrize("code", ["readonly", "ratelimited", "invalidparammix"])
    def test_a_refusal_wearing_a_200_is_a_search_error(self, code):
        """MediaWiki reports its own failures in the body and answers 200 while
        doing it, so the status check cannot see them. Without this the refusal
        arrives as a body with no `query` key and reads as "answered, nothing
        found" — the same 2xx-that-is-not-results that `is_challenge` exists to
        catch on DuckDuckGo's arm."""
        body = {"error": {"code": code, "info": "…"}}
        with pytest.raises(SearchError, match=f"wikipedia refused: {code}"):
            search("q", client=stub(lambda r: httpx.Response(200, json=body)))

    def test_an_unnamed_refusal_still_raises(self):
        for body in ({"error": {}}, {"error": {"code": "  "}}, {"error": {"code": 7}}):
            with pytest.raises(SearchError, match="wikipedia refused: unspecified"):
                search("q", client=stub(lambda r, b=body: httpx.Response(200, json=b)))

    def test_a_refusal_code_is_bounded_and_defanged_before_it_is_repeated(self):
        """The code is a remote party's bytes and the sentence carrying it is
        shown to an analyst.

        `research.py` wraps a `SearchError` as `search failed: {exc}`, the
        service answers a 503 with it as the `detail`, and the valuation
        service reads a non-opaque upstream `detail` as the upstream's own
        sentence — writing it to `network_items.error` and drawing it. The five
        arms beside this one already cut a provider's words at 200; this one
        was added without the cut, and none of the six touched the controls.
        """
        body = {"error": {"code": "z" * 900, "info": "…"}}
        with pytest.raises(SearchError) as caught:
            search("q", client=stub(lambda r: httpx.Response(200, json=body)))
        said = str(caught.value)
        assert len(said) < 250
        assert said.endswith("…")

        body = {"error": {"code": "read\u202eonly\x07", "info": "…"}}
        with pytest.raises(SearchError, match="wikipedia refused: readonly\\?"):
            search("q", client=stub(lambda r: httpx.Response(200, json=body)))

    def test_a_non_object_error_key_is_not_a_refusal(self):
        """Every level of this body is publisher-controlled; only the documented
        shape may end a search."""
        body = {"error": "nope", **WIKI_JSON}
        assert len(search("q", client=stub(lambda r: httpx.Response(200, json=body)))) == 2

    def test_warnings_beside_an_answer_do_not_discard_it(self):
        """`warnings` is MediaWiki noting a deprecated parameter next to results
        it did return. Raising on one would throw away usable hits over a note."""
        body = {"warnings": {"main": {"warnings": "deprecated"}}, **WIKI_JSON}
        assert len(search("q", client=stub(lambda r: httpx.Response(200, json=body)))) == 2

    def test_max_results_caps_the_page(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_MAX_RESULTS", "1")
        hits = search("q", client=stub(lambda r: httpx.Response(200, json=WIKI_JSON)))
        assert len(hits) == 1


# ── the chain ────────────────────────────────────────────────────────────────


class TestSearchChain:
    """RESEARCH_PROVIDER names where to start, not the only place to look."""

    def test_the_configured_provider_leads(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "wikipedia")
        assert search_chain()[0] == "wikipedia"

    def test_the_chain_ends_somewhere_keyless(self):
        """With no keys anywhere the chain still has to terminate at a backend
        that can answer, or the fallback is not a fallback."""
        chain = search_chain()
        assert chain[-1] == "wikipedia"
        assert all(websearch.PROVIDER_KEYS[p] is None for p in chain)

    def test_unkeyed_providers_are_left_out(self, monkeypatch):
        monkeypatch.setenv("SERPER_API_KEY", "srp-1")
        chain = search_chain()
        assert "serper" in chain
        assert "brave" not in chain and "tavily" not in chain

    def test_every_chain_member_is_a_known_provider(self):
        assert set(CHAIN_ORDER) == set(PROVIDERS)

    def test_pinning_the_chain_off_leaves_one_provider(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER_CHAIN", "0")
        assert search_chain() == ["duckduckgo"]

    def test_a_failing_provider_falls_through_to_the_next(self, monkeypatch):
        """The whole point. DuckDuckGo's challenge used to end the call; now it
        ends DuckDuckGo's turn."""
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.host)
            if "duckduckgo" in request.url.host:
                return httpx.Response(202, text=CHALLENGE_HTML)
            return httpx.Response(200, json=WIKI_JSON)

        provider, hits = search_with_provider("q", client=stub(handler))
        assert provider == "wikipedia"
        assert len(hits) == 2
        assert any("duckduckgo" in h for h in seen)

    def test_every_provider_failing_reports_every_reason(self, monkeypatch):
        """An operator debugging "research is down" needs to know it was down
        everywhere, and why in each place."""
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        with pytest.raises(SearchError) as caught:
            search("q", client=stub(lambda r: httpx.Response(500, text="down")))
        detail = str(caught.value)
        assert "duckduckgo" in detail and "wikipedia" in detail

    def test_the_whole_chain_failing_writes_one_warning_naming_itself(self, monkeypatch, caplog):
        """`search_chain_fallback` fires between two attempts and never on the
        one that ends the walk — so the moment "research is down" becomes true
        rather than "this provider is down" used to log nothing at all, with no
        `event` field for `log_degraded_events_total` (the counter every
        neighbouring failure in this module and in research.py already reports
        through) to see. A search backend broken in every configured way and
        one never called read the same from inside this process."""
        caplog.set_level(logging.WARNING, logger="websearch")
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        with pytest.raises(SearchError):
            search_with_provider("q", client=stub(lambda r: httpx.Response(500, text="down")))
        line = next(r for r in caplog.records if getattr(r, "event", None) == "search_chain_failed")
        assert line.levelno == logging.WARNING
        assert line.count == len(search_chain())

    def test_an_empty_result_ends_the_walk_rather_than_continuing_it(self, monkeypatch):
        """A backend that answered "nothing" has answered. Walking on would
        turn one honest "the record is thin here" into a hunt for any index
        willing to say something — which is how an obscure question acquires a
        citation it should not have."""
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, text="<html>no results</html>")

        provider, hits = search_with_provider("q", client=stub(handler))
        assert (provider, hits) == ("duckduckgo", [])
        assert calls["n"] == 1

    def test_a_refusal_at_the_terminator_is_reported_not_answered(self, monkeypatch):
        """The keyless chain ends at Wikipedia, and an empty result ends the
        walk — so a refusal read as "nothing found" is a research run that
        reports no sources, with nothing behind it to fall through to and no
        error anywhere saying why."""
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")

        def handler(request: httpx.Request) -> httpx.Response:
            if "duckduckgo" in request.url.host:
                return httpx.Response(202, text=CHALLENGE_HTML)
            return httpx.Response(200, json={"error": {"code": "readonly"}})

        with pytest.raises(SearchError) as caught:
            search_with_provider("q", client=stub(handler))
        assert "wikipedia refused: readonly" in str(caught.value)

    def test_wikipedia_is_dropped_from_a_chain_carrying_an_allowlist(self):
        """It cannot honour `site:`, and a citation from outside an allowlist is
        worse than one fewer citation — the allowlist is usually there because a
        client or a regulator asked for it."""
        assert "wikipedia" in search_chain()
        assert "wikipedia" not in search_chain(domains=["sec.gov"])
        assert NO_DOMAIN_FILTER == ("wikipedia",)


# ── cooldown ─────────────────────────────────────────────────────────────────


class TestCooldown:
    """A backend that says stop is not asked again for a while.

    This is the honest half of the anti-bot answer: the alternative on offer is
    `ddgs`, which defeats the challenge with randomised browser fingerprints.
    Backing off is the opposite of that — less load on the endpoint that
    objected, not a better disguise.
    """

    def test_a_challenge_benches_the_provider(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        search_with_provider(
            "q",
            client=stub(
                lambda r: httpx.Response(202, text=CHALLENGE_HTML)
                if "duckduckgo" in r.url.host
                else httpx.Response(200, json=WIKI_JSON)
            ),
        )
        assert websearch.in_cooldown("duckduckgo") is True
        assert websearch.cooldown_remaining("duckduckgo") > 0

    def test_a_benched_provider_is_skipped_without_a_request(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        websearch.begin_cooldown("duckduckgo")
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.host)
            return httpx.Response(200, json=WIKI_JSON)

        provider, _ = search_with_provider("q", client=stub(handler))
        assert provider == "wikipedia"
        assert not any("duckduckgo" in h for h in seen)

    def test_a_server_error_does_not_bench_anyone(self, monkeypatch):
        """A 500 is the provider failing, not refusing. Benching it for fifteen
        minutes would turn one bad minute into a lost afternoon."""
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        with pytest.raises(SearchError):
            search("q", client=stub(lambda r: httpx.Response(500, text="down")))
        assert websearch.in_cooldown("duckduckgo") is False

    def test_a_rate_limit_benches_the_provider(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        search_with_provider(
            "q",
            client=stub(
                lambda r: httpx.Response(429, text="slow down")
                if "duckduckgo" in r.url.host
                else httpx.Response(200, json=WIKI_JSON)
            ),
        )
        assert websearch.in_cooldown("duckduckgo") is True

    def test_the_cooldown_expires(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER_COOLDOWN_S", "0.05")
        websearch.begin_cooldown("duckduckgo")
        assert websearch.in_cooldown("duckduckgo") is True
        time.sleep(0.08)
        assert websearch.in_cooldown("duckduckgo") is False

    def test_a_zero_window_disables_benching(self, monkeypatch):
        """The off switch, for an operator who would rather see the error every
        time than have calls silently routed elsewhere."""
        monkeypatch.setenv("RESEARCH_PROVIDER_COOLDOWN_S", "0")
        websearch.begin_cooldown("duckduckgo")
        assert websearch.in_cooldown("duckduckgo") is False

    def test_the_reason_a_provider_was_skipped_is_in_the_error(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER_CHAIN", "0")
        websearch.begin_cooldown("duckduckgo")
        with pytest.raises(SearchError, match="cooling down"):
            search("q", client=stub(ddg_ok))


def test_no_browser_impersonating_dependency_is_installed():
    """`ddgs` (formerly `duckduckgo-search`) drives `primp` with
    impersonate="random" to defeat bot detection. The decision not to take that
    route is documented in `websearch.py` and asserted here, because it is the
    kind of thing that gets added later by someone fixing a flaky search.
    """
    for banned in ("ddgs", "duckduckgo_search", "primp"):
        assert importlib.util.find_spec(banned) is None, (
            f"{banned} is installed — see the module docstring in websearch.py; "
            "the answer to a bot challenge here is the chain, not a disguise"
        )


class TestIsWebUrl:
    """A hit's URL becomes an ``href`` on the research tab, so the scheme is
    asked once, in one place, for every backend."""

    @pytest.mark.parametrize(
        "url",
        [
            "https://sec.gov/x",
            "http://sec.gov/x",
            "HTTPS://SEC.GOV/x",
            "https://sec.gov/a?b=c#d",
        ],
    )
    def test_admits_a_web_url(self, url):
        assert is_web_url(url) is True

    @pytest.mark.parametrize(
        "url",
        [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "//sec.gov/x",
            "/x",
            "sec.gov/x",
            "",
            " https://sec.gov/x",
            "httpjavascript:alert(1)",
            # The prefix check `startswith("http")` admitted this one: not a
            # scheme, and `https?://` anchored is the difference.
            "httpx://sec.gov",
        ],
    )
    def test_refuses_everything_else(self, url):
        assert is_web_url(url) is False

    @pytest.mark.parametrize("gap", ["\t", "\n", "\r"])
    def test_refuses_a_scheme_split_by_what_the_url_parser_deletes(self, gap):
        """The browser deletes these before parsing, so `java<TAB>script:` is
        `javascript:` where it matters and something else to a prefix test."""
        assert is_web_url(f"java{gap}script:alert(1)") is False
        assert is_web_url(f"http{gap}s://sec.gov") is True


class TestHitsFromScheme:
    """The JSON backends (Brave, Serper, Tavily, SearXNG, Wikipedia) share one
    row reader, and it asked nothing about the scheme. SearXNG is the one a
    deployment points at an instance of its own."""

    def _rows(self, url):
        return [{"url": url, "title": "t", "description": "s"}]

    def test_drops_a_row_whose_url_is_not_a_url(self):
        hits = websearch._hits_from(
            self._rows("javascript:alert(1)"),
            url_key="url",
            title_key="title",
            snippet_key="description",
            limit=5,
        )
        assert hits == []

    def test_keeps_the_rows_beside_it(self):
        rows = self._rows("javascript:alert(1)") + self._rows("https://sec.gov/x")
        hits = websearch._hits_from(
            rows, url_key="url", title_key="title", snippet_key="description", limit=5
        )
        assert [h.url for h in hits] == ["https://sec.gov/x"]


class TestProviderWordsCost:
    """The 200-character bound is on the work as well as on the sentence.

    Round 385, methodology M8. Five of the six arms hand `_provider_words` the
    provider's whole response body (`resp.text`), and nothing on the way in
    bounds it — these calls read off an `httpx.Client` with no size ceiling.
    The first form cleaned all of it and cut afterwards: 359 ms and 49 MB of
    peak heap for a 5 MB error page, to keep 201 characters, in a Python loop
    that is the whole process waiting.

    Asserted as machinery, because the answer is identical either way — which
    is exactly why the tests written with the bound could not see this.
    """

    def test_a_huge_body_is_neither_walked_nor_copied_whole(self):
        import tracemalloc

        body = "<h1>502 Bad Gateway</h1>" + ("<p>filler</p>" * 160_000)
        assert len(body) > 2_000_000
        tracemalloc.start()
        try:
            said = websearch._provider_words(body)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        assert said == body[: websearch.MAX_PROVIDER_WORDS] + "\u2026"
        # The pre-fix form peaks at roughly ten times the body in per-character
        # strings and their pointers; this one holds the bound and nothing else.
        assert peak < 100_000, f"held {peak} bytes to keep {len(said)} characters"

    def test_a_body_that_fits_is_still_read_to_the_end(self):
        """The discriminator: a reader that merely stopped early passes above."""
        body = "searxng is read-only right now"
        assert websearch._provider_words(body) == body

    @pytest.mark.parametrize(
        "raw",
        [
            "   leading and trailing   ",
            "\n\tline breaks become spaces\n",
            "\x00\x1bother controls become question marks",
            "  ",
            "",
            "\u202egnp.exe",
            "a" + " " * 300 + "b",
            " " * 300 + "late text",
            "short" + " " * 300,
        ],
    )
    def test_the_strip_still_happens_where_the_bound_is_not_reached(self, raw):
        """`.strip()` is what makes this more than a slice, so it is pinned.

        Leading whitespace is dropped as the walk goes and an interior run is
        held aside until text follows it — the two halves of `.strip()`, done
        without a second pass. Each case here is one of the ways those differ
        from a plain prefix.
        """
        cleaned = "".join(
            ""
            if ch in websearch._BIDI_CONTROLS
            else (
                " "
                if ch.isspace()
                else ("?" if (ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F) else ch)
            )
            for ch in raw
        ).strip()
        expected = (
            cleaned
            if len(cleaned) <= websearch.MAX_PROVIDER_WORDS
            else cleaned[: websearch.MAX_PROVIDER_WORDS] + "\u2026"
        )
        # Nothing left over is not the empty string; see the case below.
        assert websearch._provider_words(raw) == (expected or websearch.NO_PROVIDER_WORDS)

    @pytest.mark.parametrize("raw", ["", "   ", "\n\t ", "\u202e\u200f", "\u2069  \u061c"])
    def test_a_provider_that_said_nothing_is_said_to_have_said_nothing(self, raw):
        """Round 387, methodology M19.

        Every call site writes this after a colon — `brave HTTP 502: {…}` — and
        an empty body is the ordinary shape of a proxy failing in front of a
        provider. Returning "" left the analyst a sentence ending on its own
        punctuation: `searxng HTTP 502: `. That reaches them, not just a log —
        `research.py` wraps a `SearchError` as `search failed: {exc}`, the
        service answers `/ai/v1/research` with it as a 503 `detail`, and the
        valuation service writes a non-opaque upstream detail to
        `network_items.error` and draws it in the problem document.
        """
        assert websearch._provider_words(raw) == websearch.NO_PROVIDER_WORDS

    def test_the_refusal_reads_as_a_sentence_when_the_body_is_empty(self):
        """The sentence, not only the fragment — this is what a reader gets."""
        said = websearch._provider_words("")
        assert f"searxng HTTP 502: {said}" == "searxng HTTP 502: (no message)"
        assert not f"searxng HTTP 502: {said}".endswith(": ")
