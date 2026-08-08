"""/ai/v1/research — the route contract.

The status codes carry meaning the valuation service acts on: 503 is "the
provider is having a moment, the job failed, retry is reasonable"; 422 is "this
request is wrong and will stay wrong". Putting the confidentiality refusal in
the second bucket is deliberate — retrying it would forward the same client
text again.
"""

import pytest
from fastapi.testclient import TestClient

from app import research as research_mod
from app.main import app
from app.websearch import ProviderStatus

client = TestClient(app)

ANSWER = "Median EV/Revenue was 6.2x in Q2 2026 [1]."


def _ok_key():
    return type("S", (), {"state": "valid", "detail": "ok", "ok": True})()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Default provider, no keys — the state a fresh install boots in.

    The route must serve research from here, because that is the whole point of
    dropping the paid provider.
    """
    for var in ("RESEARCH_PROVIDER", "BRAVE_SEARCH_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    yield


@pytest.fixture
def answered(monkeypatch):
    """Stub the provider at the module boundary the route calls through."""

    def fake(query, **kwargs):
        return research_mod.ResearchResult(
            model="duckduckgo+openai/gpt-oss-20b:free",
            content=ANSWER,
            citations=[research_mod.Citation("https://example.com/idx", "SaaS index")],
            prompt_tokens=10,
            completion_tokens=20,
        )

    monkeypatch.setattr("app.main.run_research", fake)


def test_returns_answer_and_citations(answered):
    res = client.post("/ai/v1/research", json={"query": "What do public SaaS firms trade at?"})
    assert res.status_code == 200
    body = res.json()
    assert body["content"].startswith("Median EV/Revenue")
    assert body["citations"] == [
        {"url": "https://example.com/idx", "title": "SaaS index", "date": ""}
    ]
    assert body["grounded"] is True
    assert body["tokens"] == 30


def test_available_by_default_with_no_key_configured(answered):
    """The regression that would undo the rewrite: research going back to being
    an opt-in that needs a billing relationship to switch on."""
    assert client.post("/ai/v1/research", json={"query": "anything public"}).status_code == 200


def test_503_when_the_selected_provider_is_unconfigured(monkeypatch):
    monkeypatch.setenv("RESEARCH_PROVIDER", "brave")
    res = client.post("/ai/v1/research", json={"query": "anything public"})
    assert res.status_code == 503
    assert "brave" in res.json()["detail"]


def test_422_on_client_text(monkeypatch):
    """The refusal must not read as a transient failure, or the valuation
    service would queue a retry that sends the same text again."""

    def refuse(query, **kwargs):
        raise research_mod.ConfidentialityError("redaction placeholder [COMPANY]")

    monkeypatch.setattr("app.main.run_research", refuse)
    res = client.post("/ai/v1/research", json={"query": "Tell me about [COMPANY]"})
    assert res.status_code == 422


def test_503_on_provider_failure(monkeypatch):
    def fail(query, **kwargs):
        raise research_mod.ResearchError("search failed: duckduckgo unreachable")

    monkeypatch.setattr("app.main.run_research", fail)
    res = client.post("/ai/v1/research", json={"query": "anything public"})
    assert res.status_code == 503


def test_an_ungrounded_answer_still_returns_200(monkeypatch):
    """A question the public record does not cover is a real answer, not an
    outage. The `grounded` flag is what keeps it out of a report."""

    def empty(query, **kwargs):
        return research_mod.ResearchResult(
            model="duckduckgo", content=research_mod.NO_RESULTS_ANSWER
        )

    monkeypatch.setattr("app.main.run_research", empty)
    res = client.post("/ai/v1/research", json={"query": "anything public"})
    assert res.status_code == 200
    assert res.json()["grounded"] is False
    assert res.json()["citations"] == []


def test_422_on_unknown_recency(answered):
    res = client.post(
        "/ai/v1/research", json={"query": "anything public", "recency": "fortnight"}
    )
    assert res.status_code == 422


@pytest.mark.parametrize("recency", ["day", "week", "month", "year"])
def test_accepts_each_recency_filter(answered, recency):
    res = client.post("/ai/v1/research", json={"query": "anything", "recency": recency})
    assert res.status_code == 200


def test_rejects_an_empty_query(answered):
    assert client.post("/ai/v1/research", json={"query": ""}).status_code == 422


def test_rejects_an_oversized_query(answered):
    res = client.post("/ai/v1/research", json={"query": "x" * 5000})
    assert res.status_code == 422


def test_rejects_too_many_domains(answered):
    res = client.post(
        "/ai/v1/research",
        json={"query": "anything", "domains": [f"d{i}.example" for i in range(20)]},
    )
    assert res.status_code == 422


def test_route_takes_no_document_or_valuation_context(answered):
    """Extra keys are ignored rather than forwarded: this route has no client
    context by design, and `ResearchRequest` does not allow extras through the
    way `PipelineRequest` deliberately does."""
    res = client.post(
        "/ai/v1/research",
        json={"query": "anything public", "documents": [{"name": "captable.xlsx"}]},
    )
    assert res.status_code == 200


def test_research_is_advertised_on_root():
    assert "/ai/v1/research" in client.get("/").json()["endpoints"]


class TestReadiness:
    def test_the_search_provider_is_always_named(self, monkeypatch):
        """Reported unconditionally, because the default needs no key and so is
        always configured — an operator has to be able to see which index this
        installation searches before someone reports missing citations."""
        monkeypatch.setattr("app.main.verify_search_provider", lambda: ProviderStatus("valid", "ok"))
        monkeypatch.setattr("app.main.verify_api_key", _ok_key)
        checks = client.get("/ready").json()["checks"]
        assert checks["search_provider"] == "duckduckgo"
        assert checks["search"] == "valid"

    def test_an_unconfigured_keyed_provider_is_named_but_not_probed(self, monkeypatch):
        monkeypatch.setenv("RESEARCH_PROVIDER", "serper")
        monkeypatch.setattr("app.main.verify_api_key", _ok_key)

        def explode():
            raise AssertionError("probed a provider with no key")

        monkeypatch.setattr("app.main.verify_search_provider", explode)
        checks = client.get("/ready").json()["checks"]
        assert checks["search_provider"] == "serper"
        assert "search" not in checks

    def test_a_broken_search_provider_does_not_take_the_service_down(self, monkeypatch):
        """Every pipeline works without research. A search provider having a
        bad day must not stop the valuation path from running."""
        monkeypatch.setattr(
            "app.main.verify_search_provider",
            lambda: ProviderStatus("unreachable", "could not reach duckduckgo"),
        )
        monkeypatch.setattr("app.main.verify_api_key", _ok_key)
        res = client.get("/ready")
        assert res.status_code == 200
        assert res.json()["checks"]["search"] == "unreachable"
