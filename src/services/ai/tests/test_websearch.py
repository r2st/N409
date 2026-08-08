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

import httpx
import pytest

from app import websearch
from app.websearch import (
    MAX_DOMAINS,
    PROVIDERS,
    SearchError,
    SearchHit,
    apply_domain_filter,
    configured_provider,
    is_configured,
    parse_duckduckgo,
    search,
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
        "RESEARCH_MAX_RESULTS",
        "RESEARCH_CALL_BUDGET_S",
        "BRAVE_SEARCH_API_KEY",
        "SERPER_API_KEY",
        "TAVILY_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)
    yield


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

    def test_a_keyed_provider_without_its_key_is_unconfigured(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
        assert is_configured() is False
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brv-123")
        assert is_configured() is True

    def test_a_keyed_provider_refuses_before_making_a_request(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "tavily")

        def explode(request: httpx.Request) -> httpx.Response:
            raise AssertionError("called the provider without a key")

        with pytest.raises(SearchError, match="TAVILY_API_KEY"):
            search("public question", client=stub(explode))


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
    def _serper(self, monkeypatch):
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

    def test_a_rate_limit_is_retried(self, monkeypatch):
        """429 is the failure DuckDuckGo actually produces under load, and the
        one worth a second attempt — unlike a 4xx about the request itself."""
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        calls = {"n": 0}

        def limited(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(429, text="slow down")
            return httpx.Response(200, text=DDG_HTML)

        assert len(search("q", client=stub(limited))) == 2

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

    def test_a_challenge_is_retried_in_case_it_was_a_burst(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_CALL_BUDGET_S", "0")
        calls = {"n": 0}

        def challenged_then_ok(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(202, text=CHALLENGE_HTML)
            return httpx.Response(200, text=DDG_HTML)

        assert len(search("q", client=stub(challenged_then_ok))) == 2

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

    def test_without_an_instance_it_refuses_rather_than_guessing_one(self, monkeypatch):
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
