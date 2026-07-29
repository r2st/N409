"""OPENROUTER_API_KEY verification (prefix check + live introspection).

Before this, a non-empty key was treated as a working key: a revoked secret, a
truncated paste or an OpenAI key all reported "configured" on /ready, and the
service only failed once a customer valuation reached OpenRouter.
"""

import httpx
import pytest

from app import openrouter
from app.openrouter import KEY_PREFIX, KeyStatus, verify_api_key


class _Response:
    def __init__(self, status_code=200, payload=None, bad_json=False):
        self.status_code = status_code
        self._payload = payload if payload is not None else {"data": {"label": "ci-key"}}
        self._bad_json = bad_json

    def json(self):
        if self._bad_json:
            raise ValueError("not json")
        return self._payload


class _StubClient:
    """Records the introspection GET and returns a scripted outcome."""

    def __init__(self, outcome):
        self._outcome = outcome
        self.calls: list[tuple[str, dict]] = []

    def get(self, url, headers=None):
        self.calls.append((url, headers or {}))
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


@pytest.fixture(autouse=True)
def _clear_cache():
    openrouter.reset_key_cache()
    yield
    openrouter.reset_key_cache()


def test_missing_key_is_reported_as_missing(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    status = verify_api_key()
    assert status.state == "missing"
    assert not status.ok


def test_blank_key_is_missing_not_malformed(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "   ")
    assert verify_api_key().state == "missing"


def test_wrong_prefix_is_rejected_without_a_network_call(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-proj-abc123")
    stub = _StubClient(_Response())
    status = verify_api_key(client=stub)
    assert status.state == "malformed"
    assert KEY_PREFIX in status.detail
    # The prefix check is free — it must short-circuit before the HTTP call.
    assert stub.calls == []


def test_valid_key_probes_the_key_endpoint_with_a_bearer_header(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-abcdef")
    stub = _StubClient(_Response(payload={"data": {"label": "prod-key"}}))
    status = verify_api_key(client=stub)
    assert status.ok
    assert status.state == "valid"
    assert "prod-key" in status.detail
    url, headers = stub.calls[0]
    assert url == openrouter.OPENROUTER_KEY_URL
    assert headers["Authorization"] == "Bearer sk-or-v1-abcdef"


@pytest.mark.parametrize("code", [401, 403])
def test_rejected_key_is_invalid(monkeypatch, code):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-revoked")
    status = verify_api_key(client=_StubClient(_Response(status_code=code)))
    assert status.state == "invalid"
    assert not status.ok
    assert str(code) in status.detail


def test_unexpected_status_is_unreachable_not_valid(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-abcdef")
    status = verify_api_key(client=_StubClient(_Response(status_code=500)))
    assert status.state == "unreachable"
    assert not status.ok


def test_transport_failure_is_unreachable(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-abcdef")
    status = verify_api_key(client=_StubClient(httpx.ConnectError("dns")))
    assert status.state == "unreachable"
    assert "could not reach OpenRouter" in status.detail


def test_unparseable_body_still_counts_as_valid(monkeypatch):
    """A 200 from the key endpoint proves the key; the body shape is cosmetic."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-abcdef")
    status = verify_api_key(client=_StubClient(_Response(bad_json=True)))
    assert status.ok
    assert "unlabelled" in status.detail


def test_result_is_cached_between_calls(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-abcdef")
    stub = _StubClient(_Response())
    assert verify_api_key(client=stub).ok
    assert verify_api_key(client=stub).ok
    assert len(stub.calls) == 1


def test_force_bypasses_the_cache(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-abcdef")
    stub = _StubClient(_Response())
    verify_api_key(client=stub)
    verify_api_key(client=stub, force=True)
    assert len(stub.calls) == 2


def test_rotating_the_key_invalidates_the_cache(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-first")
    stub = _StubClient(_Response())
    verify_api_key(client=stub)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-second")
    verify_api_key(client=stub)
    assert len(stub.calls) == 2
    assert stub.calls[1][1]["Authorization"] == "Bearer sk-or-v1-second"


def test_boot_raises_only_when_the_key_is_required(monkeypatch):
    from app.main import require_verified_key

    monkeypatch.delenv("AI_REQUIRE_OPENROUTER_KEY", raising=False)
    assert require_verified_key() is False
    monkeypatch.setenv("AI_REQUIRE_OPENROUTER_KEY", "1")
    assert require_verified_key() is True
    monkeypatch.setenv("AI_REQUIRE_OPENROUTER_KEY", "0")
    assert require_verified_key() is False


def test_key_status_ok_is_valid_only():
    assert KeyStatus("valid", "").ok
    for state in ("missing", "malformed", "invalid", "unreachable"):
        assert not KeyStatus(state, "").ok
