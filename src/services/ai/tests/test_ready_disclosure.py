"""`/ready` must not describe the inside of the estate to whoever asks (round 74).

The three Fastify services have gated readiness *reasons* behind the internal
token since 304c0e0. The Python pair were never brought along, and the AI
service is the one where that mattered most: its healthy 200 carried
``OpenRouter accepted key '<label>'``, and an OpenRouter key's label is by
convention a prefix of the key itself.

These tests pin both halves of the split — what a public probe may see, and
that an operator holding the secret still gets everything in one request.
"""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import openrouter
from app.main import app
from app.openrouter import KeyStatus
from readiness import OPERATOR_TOKEN, operator_ready

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_key_cache():
    openrouter.reset_key_cache()
    yield
    openrouter.reset_key_cache()


def _stub_search(monkeypatch, state: str = "valid", detail: str = "ok") -> None:
    """Keep the optional search probe off the network — it is a real query."""
    monkeypatch.setattr(
        "app.main.verify_search_provider",
        lambda: SimpleNamespace(state=state, detail=detail),
    )


def _good_key(monkeypatch, label: str = "sk-or-v1-9f3a") -> None:
    """A verifying key whose OpenRouter label is a prefix of the key itself.

    Not a contrived string: that is what the label looks like for a key created
    without being named, which is the common case and was the leak.
    """
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-9f3aa1b2c3d4e5f6")
    monkeypatch.setattr(
        openrouter,
        "_probe_key",
        lambda key, client=None: KeyStatus("valid", f"OpenRouter accepted key '{label}'"),
    )


class TestPublicBody:
    def test_the_healthy_body_does_not_carry_the_key_label(self, monkeypatch):
        _good_key(monkeypatch)
        _stub_search(monkeypatch)
        res = client.get("/ready")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "ready"
        # The bug, stated as an assertion: no substring of the credential, and
        # no field that could ever hold one.
        assert "sk-or-v1" not in res.text
        assert "openrouter_key_detail" not in body["checks"]
        assert body["checks"]["openrouter_key"] == "ok"

    def test_a_failure_reports_that_it_failed_and_not_why(self, monkeypatch):
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-revoked")
        monkeypatch.setattr(
            openrouter,
            "_probe_key",
            lambda key, client=None: KeyStatus(
                "invalid", "OpenRouter rejected OPENROUTER_API_KEY (HTTP 401)"
            ),
        )
        _stub_search(monkeypatch)
        res = client.get("/ready")
        # The status code is the part a load balancer acts on and is unchanged.
        assert res.status_code == 503
        body = res.json()
        assert body["status"] == "unavailable"
        assert body["checks"]["openrouter_key"] == "failed"
        assert "401" not in res.text
        assert "rejected" not in res.text

    def test_an_unreachable_provider_does_not_publish_the_host_it_dialled(self, monkeypatch):
        """`unreachable` carries the httpx exception, which names host and port."""
        _stub_search(monkeypatch)
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-fine")
        monkeypatch.setattr(
            openrouter,
            "_probe_key",
            lambda key, client=None: KeyStatus(
                "unreachable",
                "could not reach OpenRouter: [Errno 111] Connection refused to openrouter.ai:443",
            ),
        )
        res = client.get("/ready")
        assert res.status_code == 503
        assert "openrouter.ai" not in res.text
        assert "Connection refused" not in res.text

    def test_the_model_chain_and_token_counter_are_not_public(self, monkeypatch):
        """Which models this installation pays for, and in what order to try
        them, is a map of the deployment rather than a readiness verdict."""
        _good_key(monkeypatch)
        _stub_search(monkeypatch)
        checks = client.get("/ready").json()["checks"]
        assert "models" not in checks
        assert "tokens_used" not in checks
        assert "search_provider" not in checks

    def test_build_sha_is_still_public(self, monkeypatch):
        """Unchanged on purpose: infra/deploy.sh reads it to confirm what
        landed, and it is already on the public /health of every service."""
        _good_key(monkeypatch)
        _stub_search(monkeypatch)
        assert "build_sha" in client.get("/ready").json()


class TestOperatorBody:
    def test_the_token_holder_still_gets_every_reason(self, monkeypatch):
        _good_key(monkeypatch, label="ci-key")
        _stub_search(monkeypatch)
        body = operator_ready(client, monkeypatch).json()
        checks = body["checks"]
        assert checks["openrouter_key"] == "valid"
        assert "ci-key" in checks["openrouter_key_detail"]
        assert checks["models"]
        assert "tokens_used" in checks

    def test_a_wrong_token_is_treated_as_the_public(self, monkeypatch):
        _good_key(monkeypatch)
        _stub_search(monkeypatch)
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", OPERATOR_TOKEN)
        res = client.get("/ready", headers={"X-Internal-Token": OPERATOR_TOKEN + "x"})
        assert res.status_code == 200
        assert "openrouter_key_detail" not in res.json()["checks"]

    def test_a_non_ascii_token_is_refused_rather_than_raising(self, monkeypatch):
        """`tokens_match` compares bytes precisely so this cannot 500 — the same
        trap the route gate hit. Asserted here too because this is a second,
        independent caller of it."""
        _good_key(monkeypatch)
        _stub_search(monkeypatch)
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", OPERATOR_TOKEN)
        # Sent as bytes: httpx refuses to encode a non-ASCII header value, and
        # the byte is the whole point — this is what arrives off a real wire.
        res = client.get("/ready", headers={"X-Internal-Token": "café".encode("latin-1")})
        assert res.status_code == 200
        assert "openrouter_key_detail" not in res.json()["checks"]

    def test_with_no_secret_configured_nobody_is_an_operator(self, monkeypatch):
        """The disclosure rule runs opposite to the access rule: an unset secret
        means "nobody is authorized", not "everybody is". An installation that
        has not configured one is the least able to afford the leak."""
        _good_key(monkeypatch)
        _stub_search(monkeypatch)
        monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
        res = client.get("/ready", headers={"X-Internal-Token": "anything"})
        assert res.status_code == 200
        assert "openrouter_key_detail" not in res.json()["checks"]


class TestOptionalProviders:
    def test_an_optional_provider_failure_is_public_as_failed_but_still_200(self, monkeypatch):
        """Readiness gating is unchanged by the split: only the OpenRouter key
        decides the code, and a lapsed search provider is reported, not fatal."""
        _good_key(monkeypatch)
        _stub_search(monkeypatch, "unreachable", "duckduckgo timed out")
        res = client.get("/ready")
        assert res.status_code == 200
        assert res.json()["checks"]["search"] == "failed"
        assert "duckduckgo" not in res.text
