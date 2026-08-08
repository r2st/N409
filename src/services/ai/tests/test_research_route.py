"""/ai/v1/research — the route contract.

The status codes carry meaning the valuation service acts on: 503 is "the
provider is having a moment, the job failed, retry is reasonable"; 422 is "this
request is wrong and will stay wrong". Putting the confidentiality refusal in
the second bucket is deliberate — retrying it would forward the same client
text again.
"""

import pytest
from fastapi.testclient import TestClient

from app import perplexity
from app.main import app

client = TestClient(app)

BODY = {
    "model": "sonar",
    "choices": [{"message": {"content": "Median EV/Revenue was 6.2x in Q2 2026."}}],
    "search_results": [{"title": "SaaS index", "url": "https://example.com/idx"}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 20},
}


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-testkey")
    perplexity.reset_key_cache()
    yield
    perplexity.reset_key_cache()


@pytest.fixture
def answered(monkeypatch):
    """Stub the provider at the module boundary the route calls through."""

    def fake(query, **kwargs):
        return perplexity.ResearchResult(
            model="sonar",
            content="Median EV/Revenue was 6.2x in Q2 2026.",
            citations=[perplexity.Citation("https://example.com/idx", "SaaS index")],
            prompt_tokens=10,
            completion_tokens=20,
        )

    monkeypatch.setattr("app.main.perplexity_research", fake)


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


def test_503_when_unconfigured(monkeypatch):
    monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
    res = client.post("/ai/v1/research", json={"query": "anything public"})
    assert res.status_code == 503
    assert "PERPLEXITY_API_KEY" in res.json()["detail"]


def test_422_on_client_text(monkeypatch):
    """The refusal must not read as a transient failure, or the valuation
    service would queue a retry that sends the same text again."""

    def refuse(query, **kwargs):
        raise perplexity.ConfidentialityError("redaction placeholder [COMPANY]")

    monkeypatch.setattr("app.main.perplexity_research", refuse)
    res = client.post("/ai/v1/research", json={"query": "Tell me about [COMPANY]"})
    assert res.status_code == 422


def test_503_on_provider_failure(monkeypatch):
    def fail(query, **kwargs):
        raise perplexity.PerplexityError("perplexity unreachable: no route")

    monkeypatch.setattr("app.main.perplexity_research", fail)
    res = client.post("/ai/v1/research", json={"query": "anything public"})
    assert res.status_code == 503


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
    def test_perplexity_state_is_reported_when_configured(self, monkeypatch):
        monkeypatch.setattr(
            "app.main.verify_perplexity_key",
            lambda: perplexity.KeyStatus("valid", "Perplexity accepted the key"),
        )
        monkeypatch.setattr(
            "app.main.verify_api_key",
            lambda: type("S", (), {"state": "valid", "detail": "ok", "ok": True})(),
        )
        checks = client.get("/ready").json()["checks"]
        assert checks["perplexity_key"] == "valid"

    def test_absent_when_unconfigured(self, monkeypatch):
        monkeypatch.delenv("PERPLEXITY_API_KEY", raising=False)
        monkeypatch.setattr(
            "app.main.verify_api_key",
            lambda: type("S", (), {"state": "valid", "detail": "ok", "ok": True})(),
        )
        assert "perplexity_key" not in client.get("/ready").json()["checks"]

    def test_a_broken_research_key_does_not_take_the_service_down(self, monkeypatch):
        """Every pipeline works without Perplexity. A lapsed research key must
        not stop the valuation path from running."""
        monkeypatch.setattr(
            "app.main.verify_perplexity_key",
            lambda: perplexity.KeyStatus("invalid", "Perplexity rejected the key"),
        )
        monkeypatch.setattr(
            "app.main.verify_api_key",
            lambda: type("S", (), {"state": "valid", "detail": "ok", "ok": True})(),
        )
        res = client.get("/ready")
        assert res.status_code == 200
        assert res.json()["checks"]["perplexity_key"] == "invalid"
