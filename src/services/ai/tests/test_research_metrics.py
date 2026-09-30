"""The research path's own RED, and the token counter it made honest (R450, M11).

R444 instrumented `llm_router.chat` and recorded, in as many words, that this
module was outside it: research "deliberately calls `openrouter.chat` directly
… so it is *not* covered by this and remains a known, separate gap".

Three things followed from that, and this suite holds each of them:

* Every degradation on this path answers **200**, so the route's own RED reads
  healthy through a lapsed Sonar key, an index that found nothing and a
  synthesis model that refused. `research_requests_total` is the series that
  can tell those apart.
* One observation per **attempt**. A query Sonar refuses and DuckDuckGo answers
  reports twice, which is what gives a lapsed key a denominator.
* The synthesis tokens are billed to the OpenRouter account whose ledger
  `llm_token_budget_used_total` samples, and reached `llm_tokens_total` through
  nothing. The gauge and the counter drifted apart by the cost of this feature.
"""

import pytest

from app import perplexity
from app import research as research_mod
from app.openrouter import LlmResult, OpenRouterError
from app.perplexity import PerplexityError
from app.research import ResearchError, ResearchResult, research, set_research_metrics_sink
from app.research_types import Citation
from app.websearch import SearchError, SearchHit

PPLX_KEY = "pplx-0123456789abcdef"

HITS = [
    SearchHit("https://a.example/saas", "SaaS multiples 2026", "Public SaaS trades at 6-8x ARR."),
    SearchHit("https://b.example/index", "Sector index", "Median EV/Revenue of 6.4x."),
]

ANSWER = "Public SaaS trades at 6-8x ARR [1], with a 6.4x median [2]."


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    installed = research_mod._metrics_sink
    for var in (
        "RESEARCH_PROVIDER",
        "RESEARCH_PROVIDER_CHAIN",
        "RESEARCH_SYNTHESIS_MODEL",
        "PERPLEXITY_API_KEY",
        "PERPLEXITY_MODEL",
    ):
        monkeypatch.delenv(var, raising=False)
    perplexity.reset_key_cache()
    yield
    perplexity.reset_key_cache()
    # Restore whatever was installed rather than nulling: `app.main` installs
    # the real sink at import, and a suite that clears it takes the service's
    # own instrumentation away from every test file that runs after this one.
    # See `test_llm_router_metrics.py`, where exactly that silently disarmed
    # R444's assertion on `/metrics` under a whole-suite run.
    set_research_metrics_sink(installed)


@pytest.fixture
def sink():
    calls = []
    set_research_metrics_sink(lambda **kwargs: calls.append(kwargs))
    return calls


@pytest.fixture
def searched(monkeypatch):
    """The fallback's retrieval leg, answering with two hits from duckduckgo."""

    def fake_search(query, **kwargs):
        return "duckduckgo", list(HITS)

    monkeypatch.setattr(research_mod.websearch, "search_with_provider", fake_search)


def _synthesis(monkeypatch, result):
    def fake_chat(system, user, *, model=None, client=None):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(research_mod, "chat", fake_chat)


# ── the fallback path ────────────────────────────────────────────────────────


def test_an_answered_fallback_reports_path_outcome_latency_and_tokens(sink, searched, monkeypatch):
    _synthesis(
        monkeypatch,
        LlmResult(model="openai/gpt-oss-20b:free", content=ANSWER, prompt_tokens=40, completion_tokens=120),
    )
    result = research("2026 median EV/Revenue for public SaaS")
    assert result.grounded
    [call] = sink
    assert call["path"] == "fallback"
    assert call["outcome"] == "answered"
    # The account the tokens are billed to, so they land on the same
    # `llm_tokens_total{provider=...}` series the ledger gauge counts against.
    # Not the search backend: duckduckgo bills nothing and has no ledger.
    assert call["provider"] == "openrouter"
    assert call["prompt_tokens"] == 40
    assert call["completion_tokens"] == 120
    assert call["duration_s"] >= 0


def test_a_sources_only_result_is_unsynthesized_and_bills_nothing(sink, searched, monkeypatch):
    """The commonest degradation on a free-tier account: retrieval succeeded,
    the write-up did not, and the caller still gets a 200."""
    _synthesis(monkeypatch, OpenRouterError("daily allowance exhausted"))
    result = research("2026 median EV/Revenue for public SaaS")
    assert not result.synthesized
    [call] = sink
    assert call["path"] == "fallback"
    assert call["outcome"] == "unsynthesized"
    assert call["prompt_tokens"] == 0
    assert call["completion_tokens"] == 0


def test_an_empty_index_is_unsourced_rather_than_answered(sink, monkeypatch):
    """A 200 carrying no citations. Indistinguishable from an answer at the
    route, and a run of them is a retrieval backend serving empty pages."""
    monkeypatch.setattr(research_mod.websearch, "search_with_provider", lambda q, **k: ("duckduckgo", []))
    research("a question the public record does not cover")
    [call] = sink
    assert call["outcome"] == "unsourced"


def test_a_failed_search_is_its_own_outcome(sink, monkeypatch):
    """`search_failed` apart from `unsynthesized`: one is a search backend
    down, the other an LLM account out of allowance, and the remedies are two
    different people's afternoons."""

    def explode(query, **kwargs):
        raise SearchError("every backend refused")

    monkeypatch.setattr(research_mod.websearch, "search_with_provider", explode)
    with pytest.raises(ResearchError):
        research("anything")
    [call] = sink
    assert call["path"] == "fallback"
    assert call["outcome"] == "search_failed"


def test_the_requested_synthesis_model_is_the_label(sink, searched, monkeypatch):
    """R444's rule, kept identical here: the *requested* id, bounded by
    configuration, and the same on the failure path as on the success one — not
    whichever candidate an OpenRouter chain answered with."""
    monkeypatch.setenv("RESEARCH_SYNTHESIS_MODEL", "meta/llama-3.1-8b")
    _synthesis(
        monkeypatch,
        LlmResult(model="some/other-candidate", content=ANSWER, prompt_tokens=1, completion_tokens=2),
    )
    research("2026 median EV/Revenue for public SaaS")
    [call] = sink
    assert call["model"] == "meta/llama-3.1-8b"


def test_an_unset_synthesis_model_reports_default_not_none(sink, searched, monkeypatch):
    """`None` means "walk the chain". A label of the string "None" would be a
    series named after a Python repr; "default" is what `llm_router` writes for
    the same state, and the two labels have to mean the same thing."""
    _synthesis(monkeypatch, LlmResult(model="a/b", content=ANSWER, prompt_tokens=1, completion_tokens=1))
    research("2026 median EV/Revenue for public SaaS")
    [call] = sink
    assert call["model"] == "default"


# ── the primary path, and the attempt-per-observation rule ───────────────────


def test_sonar_answering_reports_the_primary_path_and_its_own_provider(sink, monkeypatch):
    monkeypatch.setenv("PERPLEXITY_API_KEY", PPLX_KEY)
    perplexity.reset_key_cache()
    monkeypatch.setattr(
        research_mod.perplexity,
        "research",
        lambda query, **kwargs: ResearchResult(
            model="sonar",
            content=ANSWER,
            citations=[Citation(url="https://a.example/saas")],
            prompt_tokens=11,
            completion_tokens=22,
        ),
    )
    research("2026 median EV/Revenue for public SaaS")
    [call] = sink
    assert call["path"] == "primary"
    assert call["outcome"] == "answered"
    # The label `llm_token_budget_used_total` already publishes the Perplexity
    # ledger under, so the counter and that gauge name the same account.
    assert call["provider"] == "research_primary"
    assert call["prompt_tokens"] == 11


def test_a_lapsed_key_reports_both_the_failure_and_the_fallback_that_covered_it(
    sink, searched, monkeypatch
):
    """The finding, in one case. Sonar is configured and failing, the caller
    gets a 200 from DuckDuckGo, and before this the only trace was a `warning`
    no rule in `alerts.yml` selected.

    Two observations, not one: a `primary` failure count with no `fallback`
    beside it cannot separate "Sonar is down" from "nobody asked a research
    question today"."""
    monkeypatch.setenv("PERPLEXITY_API_KEY", PPLX_KEY)
    perplexity.reset_key_cache()

    def refuse(query, **kwargs):
        raise PerplexityError("401 Unauthorized")

    monkeypatch.setattr(research_mod.perplexity, "research", refuse)
    _synthesis(monkeypatch, LlmResult(model="a/b", content=ANSWER, prompt_tokens=5, completion_tokens=6))
    result = research("2026 median EV/Revenue for public SaaS")
    assert result.grounded
    primary, fallback = sink
    assert (primary["path"], primary["outcome"]) == ("primary", "provider_failed")
    assert primary["prompt_tokens"] == 0
    assert (fallback["path"], fallback["outcome"]) == ("fallback", "answered")


def test_a_confidentiality_refusal_from_the_provider_is_still_counted(sink, monkeypatch):
    """`assert_public` already ran, so reaching this means the gate has moved or
    a second one disagrees with it. An attempt that left no count behind would
    make the denominator quietly short of the truth."""
    monkeypatch.setenv("PERPLEXITY_API_KEY", PPLX_KEY)
    perplexity.reset_key_cache()

    def refuse(query, **kwargs):
        raise research_mod.ConfidentialityError("placeholder reached the provider")

    monkeypatch.setattr(research_mod.perplexity, "research", refuse)
    with pytest.raises(research_mod.ConfidentialityError):
        research("a fine question")
    [call] = sink
    assert (call["path"], call["outcome"]) == ("primary", "refused")


# ── the sink contract ────────────────────────────────────────────────────────


def test_no_sink_installed_leaves_the_call_working(searched, monkeypatch):
    """The default state outside a running service, and what every unit test
    that calls `research()` directly has always relied on."""
    set_research_metrics_sink(None)
    _synthesis(monkeypatch, LlmResult(model="a/b", content=ANSWER, prompt_tokens=1, completion_tokens=1))
    assert research("2026 median EV/Revenue for public SaaS").grounded


def test_a_broken_sink_does_not_cost_the_call_it_is_reporting_on(searched, monkeypatch):
    """This observes a path that has already done the expensive, billed half of
    its work. A recorder must never be the reason that is thrown away."""
    set_research_metrics_sink(lambda **kwargs: (_ for _ in ()).throw(RuntimeError("sink is down")))
    _synthesis(monkeypatch, LlmResult(model="a/b", content=ANSWER, prompt_tokens=1, completion_tokens=1))
    assert research("2026 median EV/Revenue for public SaaS").grounded


def test_a_broken_sink_does_not_swallow_the_original_failure(monkeypatch):
    set_research_metrics_sink(lambda **kwargs: (_ for _ in ()).throw(RuntimeError("sink is down")))

    def explode(query, **kwargs):
        raise SearchError("every backend refused")

    monkeypatch.setattr(research_mod.websearch, "search_with_provider", explode)
    with pytest.raises(ResearchError):
        research("anything")
