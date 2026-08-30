"""A research write-up cut off at the output cap, on both provider paths.

Round 216, methodology M5. R197 read `finish_reason` for the first time and
made a truncated *pipeline* completion a refusal, which worked because a
pipeline's answer is JSON and half a JSON object does not parse. Research is the
half of the LLM surface with no parse to fail: the answer is free text, so a
completion that stopped mid-sentence arrived as a 200 carrying real prose and
real citations, and nothing anywhere contradicted it.

What that costs is specific. `ResearchResult.grounded` was true, so the row was
listed in the report's sources exhibit and handed to the narrative agent as
material to draft a 409A's market discussion from — with the second half of its
last claim missing. A multiple truncated after its first digit is still a
number, and it is a number in a report next to a URL that does not say it.

Both providers stop differently and so are answered differently:

  * the fallback degrades exactly as an unavailable synthesis model does — the
    retrieved sources are kept, `synthesized=False`, and the partial text is
    discarded rather than carried where a drafting step could read half a claim;
  * Perplexity raises, because on that path there is somewhere better to go: a
    `PerplexityError` is what `research` falls back to the keyless path on, and
    that path asks the same question again under its own cap.
"""

import httpx
import pytest

from app import perplexity
from app import research as research_mod
from app.openrouter import LlmResult
from app.research import TRUNCATED_ANSWER, research
from app.websearch import SearchHit

HITS = [
    SearchHit("https://a.example/saas", "SaaS multiples 2026", "Public SaaS trades at 6-8x ARR."),
    SearchHit("https://b.example/index", "Sector index", "Median EV/Revenue of 6.4x."),
]

#: What a cut-off write-up looks like: a claim whose figure lost its tail.
HALF_AN_ANSWER = "Public SaaS trades at a median EV/Revenue of 6"

PPLX_KEY = "pplx-0123456789abcdef"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in (
        "RESEARCH_PROVIDER",
        "RESEARCH_PROVIDER_CHAIN",
        "RESEARCH_MAX_RESULTS",
        "RESEARCH_SYNTHESIS_MODEL",
        "PERPLEXITY_API_KEY",
        "PERPLEXITY_MODEL",
        "PERPLEXITY_CALL_BUDGET_S",
    ):
        monkeypatch.delenv(var, raising=False)
    perplexity.reset_key_cache()
    yield
    perplexity.reset_key_cache()


@pytest.fixture
def found(monkeypatch):
    """Retrieval succeeds. Only the synthesis half is in question here."""
    monkeypatch.setattr(
        research_mod.websearch,
        "search_with_provider",
        lambda q, **kw: ("duckduckgo", list(HITS)),
    )


def _truncated_chat(system, user, *, model=None, client=None):
    return LlmResult(
        model="openai/gpt-oss-20b:free",
        content=HALF_AN_ANSWER,
        prompt_tokens=40,
        completion_tokens=512,
        finish_reason="length",
    )


class TestTheFallbackPath:
    @pytest.fixture
    def truncated(self, monkeypatch, found):
        monkeypatch.setattr(research_mod, "chat", _truncated_chat)
        return research("public question")

    def test_it_is_not_grounded_so_no_report_can_quote_it(self, truncated):
        """The invariant. `grounded` is what the sources exhibit and the
        narrative thread gate on, and half a claim must reach neither."""
        assert truncated.grounded is False

    def test_it_reports_as_unsynthesised(self, truncated):
        """Reusing the flag rather than adding a second one: the stored row, the
        route and the tab already carry `synthesized`, and "no usable write-up
        came back" is one fact whichever way it happened."""
        assert truncated.synthesized is False

    def test_the_half_written_answer_is_not_carried_in_the_content(self, truncated):
        """The whole point. A drafting step reading `content` cannot tell that a
        sentence stopped early, so the partial text does not travel in the field
        a report quotes from."""
        assert truncated.content == TRUNCATED_ANSWER
        assert HALF_AN_ANSWER not in truncated.content

    def test_the_standin_names_the_cap_and_the_fix(self, truncated):
        assert "output cap" in truncated.content
        assert "OPENROUTER_MAX_TOKENS" in truncated.content

    def test_the_sources_survive(self, truncated):
        """Retrieval is the expensive, rate-limited half and it succeeded."""
        assert [c.url for c in truncated.citations] == [h.url for h in HITS]

    def test_the_tokens_spent_are_still_reported(self, truncated):
        """The call was billed whether or not its answer was usable."""
        assert truncated.total_tokens == 552

    def test_the_model_field_still_names_who_wrote_it(self, truncated):
        """Unlike the unsynthesised case there *was* a model, and which one ran
        out of room is the first question asked of a truncated answer."""
        assert truncated.model == "duckduckgo+openai/gpt-oss-20b:free"

    def test_a_finished_answer_is_untouched(self, monkeypatch, found):
        """The guard reads `finish_reason`, not the length of the text."""

        def complete(system, user, *, model=None, client=None):
            return LlmResult(
                model="openai/gpt-oss-20b:free",
                content="Public SaaS trades at 6-8x ARR [1].",
                finish_reason="stop",
            )

        monkeypatch.setattr(research_mod, "chat", complete)
        out = research("public question")
        assert out.grounded is True
        assert out.content == "Public SaaS trades at 6-8x ARR [1]."

    def test_a_silent_finish_reason_is_not_treated_as_truncation(self, monkeypatch, found):
        """Plenty of free models never send one. Refusing those answers would
        take the whole feature offline on exactly the accounts it exists for."""

        def quiet(system, user, *, model=None, client=None):
            return LlmResult(model="m", content="Median EV/Revenue is 6.4x [2].")

        monkeypatch.setattr(research_mod, "chat", quiet)
        assert research("public question").grounded is True


def _pplx(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


PPLX_TRUNCATED = {
    "model": "sonar",
    "choices": [{"message": {"content": HALF_AN_ANSWER}, "finish_reason": "length"}],
    "search_results": [{"title": "Sonar source", "url": "https://sonar.example/idx"}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 512},
}


class TestThePerplexityPath:
    @pytest.fixture
    def keyed(self, monkeypatch):
        monkeypatch.setenv("PERPLEXITY_API_KEY", PPLX_KEY)
        perplexity.reset_key_cache()
        yield
        perplexity.reset_key_cache()

    def test_a_truncated_sonar_answer_falls_back_to_the_search_path(
        self, keyed, monkeypatch, found
    ):
        """Not a degradation here, a fall-through: the keyless path asks the
        same question again under its own cap, and usually finishes it."""

        def complete(system, user, *, model=None, client=None):
            return LlmResult(model="openai/gpt-oss-20b:free", content="A finished answer [1].")

        monkeypatch.setattr(research_mod, "chat", complete)
        out = research(
            "public question",
            perplexity_client=_pplx(lambda r: httpx.Response(200, json=PPLX_TRUNCATED)),
        )
        assert out.model.startswith("duckduckgo+")
        assert out.grounded is True
        assert HALF_AN_ANSWER not in out.content

    def test_the_half_answer_never_reaches_a_caller_even_if_both_paths_stop_short(
        self, keyed, monkeypatch, found
    ):
        monkeypatch.setattr(research_mod, "chat", _truncated_chat)
        out = research(
            "public question",
            perplexity_client=_pplx(lambda r: httpx.Response(200, json=PPLX_TRUNCATED)),
        )
        assert out.grounded is False
        assert out.content == TRUNCATED_ANSWER

    def test_a_finished_sonar_answer_still_wins(self, keyed, monkeypatch):
        def explode(*args, **kwargs):
            raise AssertionError("fell back while Perplexity was working")

        monkeypatch.setattr(research_mod.websearch, "search_with_provider", explode)
        body = {**PPLX_TRUNCATED, "choices": [{"message": {"content": "Whole."}, "finish_reason": "stop"}]}
        out = research("public question", perplexity_client=_pplx(lambda r: httpx.Response(200, json=body)))
        assert out.content == "Whole."
        assert out.grounded is True
