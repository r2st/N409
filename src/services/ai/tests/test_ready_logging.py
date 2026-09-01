"""What a failing readiness check leaves behind (R337, methodology M11).

`/ready` publishes check names and pass/fail to anybody and the *reasons* only
to a caller holding the internal token (round 74). That split is right, and it
made the journal the operator's channel — which is why a failing check is
logged at all: "an operator who can no longer read it off /ready has to be able
to read it off the journal instead".

Only the gating check was. Three of the four verdicts this endpoint reports —
research, search, Bedrock — are optional on purpose: a lapsed key for any of
them must not take the valuation path down, so none of them changes the status
code. Which also meant none of them changed anything an operator would ever
see. The reason lives behind a token, the pass/fail lives in a 200 body nobody
reads, this service exposes no `/metrics` at all, and the journal — the one
durable channel of the three — said nothing.
"""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import openrouter
from app.main import app
from app.observability import JsonLogFormatter
from app.openrouter import KeyStatus

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_key_cache():
    openrouter.reset_key_cache()
    yield
    openrouter.reset_key_cache()


def _good_key(monkeypatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-9f3aa1b2c3d4e5f6")
    monkeypatch.setattr(
        openrouter,
        "_probe_key",
        lambda key, client=None: KeyStatus("valid", "OpenRouter accepted key"),
    )


def _search(monkeypatch, state: str) -> None:
    monkeypatch.setattr("app.main.search_configured", lambda: True)
    monkeypatch.setattr(
        "app.main.verify_search_provider",
        lambda: SimpleNamespace(state=state, detail=f"search is {state}"),
    )


def _ready_lines(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if getattr(r, "event", None) == "ready"]


def test_a_healthy_probe_writes_nothing(monkeypatch, caplog):
    _good_key(monkeypatch)
    _search(monkeypatch, "valid")
    with caplog.at_level(logging.WARNING):
        assert client.get("/ready").status_code == 200
    assert _ready_lines(caplog) == []


def test_an_optional_dependency_that_has_lapsed_is_said_out_loud(monkeypatch, caplog):
    """The case that was silent in all three channels at once."""
    _good_key(monkeypatch)
    _search(monkeypatch, "unreachable")
    with caplog.at_level(logging.WARNING):
        res = client.get("/ready")

    # Unchanged, and deliberately so: search is optional and a load balancer
    # must not pull this service out over it.
    assert res.status_code == 200
    lines = _ready_lines(caplog)
    assert len(lines) == 1
    assert lines[0].failed == "search"
    # Says which kind of line it is, so a reader can tell "we are down" from
    # "we are degraded" without inferring it from the check's name.
    assert lines[0].gating is False


def test_the_gating_failure_still_says_it_is_the_gating_one(monkeypatch, caplog):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-revoked")
    monkeypatch.setattr(
        openrouter,
        "_probe_key",
        lambda key, client=None: KeyStatus("invalid", "OpenRouter rejected the key"),
    )
    _search(monkeypatch, "valid")
    with caplog.at_level(logging.WARNING):
        assert client.get("/ready").status_code == 503

    lines = _ready_lines(caplog)
    assert len(lines) == 1
    assert lines[0].failed == "openrouter_key"
    assert lines[0].gating is True


def test_two_failures_are_one_event(monkeypatch, caplog):
    """They are read together; a probe finding two problems is not two events."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-revoked")
    monkeypatch.setattr(
        openrouter,
        "_probe_key",
        lambda key, client=None: KeyStatus("invalid", "OpenRouter rejected the key"),
    )
    _search(monkeypatch, "invalid")
    with caplog.at_level(logging.WARNING):
        assert client.get("/ready").status_code == 503

    lines = _ready_lines(caplog)
    assert len(lines) == 1
    assert lines[0].failed == "openrouter_key,search"


def test_the_two_fields_survive_the_formatter(monkeypatch, caplog):
    """Present on the record is not the same as present on the line (R338, M8-adjacent).

    ``_EXTRA_KEYS`` is an allowlist, so a key the formatter does not name is
    dropped in silence — and every assertion above reads the ``LogRecord``,
    which carries the attribute whether or not anything ever writes it out.
    ``failed`` and ``gating`` were both unlisted, so the line this module exists
    to produce went to disk saying only that *something* was wrong, and the two
    tests above passed the whole time.

    Asserted through the formatter, which is the only place the difference is
    visible.
    """
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-revoked")
    monkeypatch.setattr(
        openrouter,
        "_probe_key",
        lambda key, client=None: KeyStatus("invalid", "OpenRouter rejected the key"),
    )
    _search(monkeypatch, "valid")
    with caplog.at_level(logging.WARNING):
        assert client.get("/ready").status_code == 503

    line = json.loads(JsonLogFormatter().format(_ready_lines(caplog)[0]))
    assert line["failed"] == "openrouter_key"
    assert line["gating"] is True
