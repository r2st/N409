"""What each request model will accept, and where its ceiling actually is.

This service's models bound almost everything they take — a research query at
4,000 characters, an anonymize body at 200,000, its document list at 20, its
`domains` list at 10 — and the exceptions are the interesting part, because an
unbounded field's real ceiling is the 32 MiB request cap and nothing else.

The shape is the cross-tier one: the valuation service caps a stored system
prompt at 20,000 characters and the `/prompts/:id/test` sample input at 20,000,
so `/ai/v1/test` looked bounded from the only caller it has. It was not bounded
by anything on this side, which means the receiver's maximum was whatever the
sender happened to enforce at the time. Both fields are redacted before they
leave (~0.42s per 3.4 MB, holding the GIL) and then posted to the provider in
full, to be told the context is too long after the transfer.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import MAX_TEST_PROMPT_CHARS, app
from app.openrouter import LlmResult

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _stub_provider(monkeypatch):
    """No real model call. Stubbed rather than refused, so "the schema accepted
    this" is a 200 that can be told apart from every other non-422 there is."""
    monkeypatch.setattr(
        "app.main.chat",
        lambda *_a, **_kw: LlmResult(model="stub", content="ok"),
    )


class TestPromptLength:
    def test_a_prompt_at_the_bound_is_not_refused_by_the_schema(self):
        res = client.post(
            "/ai/v1/test",
            json={"system": "s", "user": "u" * MAX_TEST_PROMPT_CHARS},
        )
        assert res.status_code == 200

    def test_a_user_message_past_the_bound_is_422(self):
        res = client.post(
            "/ai/v1/test",
            json={"system": "s", "user": "u" * (MAX_TEST_PROMPT_CHARS + 1)},
        )
        assert res.status_code == 422

    def test_a_system_prompt_past_the_bound_is_422(self):
        res = client.post(
            "/ai/v1/test",
            json={"system": "s" * (MAX_TEST_PROMPT_CHARS + 1), "user": "u"},
        )
        assert res.status_code == 422

    def test_the_bound_clears_what_the_only_caller_can_send(self):
        """The valuation service caps both halves at 20,000 characters
        (`routes/prompts.ts`). A ceiling at or below that would refuse a
        legitimate prompt; this one is deliberately double, so it bounds the
        wire without becoming a second opinion about prompt length."""
        assert MAX_TEST_PROMPT_CHARS >= 40_000


class TestResearchDomains:
    """`max_length` on a list says nothing about what is in it."""

    def test_ten_ordinary_domains_are_accepted(self):
        res = client.post(
            "/ai/v1/research",
            json={"query": "sector multiples", "domains": [f"d{i}.sec.gov" for i in range(10)]},
        )
        # 503 when no provider is configured — anything but a schema refusal.
        assert res.status_code != 422

    def test_a_domain_longer_than_dns_carries_is_refused(self):
        res = client.post(
            "/ai/v1/research",
            json={"query": "sector multiples", "domains": ["x" * 254]},
        )
        assert res.status_code == 422

    def test_the_list_length_bound_still_holds(self):
        res = client.post(
            "/ai/v1/research",
            json={"query": "q", "domains": [f"d{i}.example.com" for i in range(11)]},
        )
        assert res.status_code == 422
