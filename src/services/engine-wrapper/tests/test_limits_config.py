"""Body cap and threadpool sizing — the configuration reads, and a disconnect.

`test_hardening.py` covers the happy path of both env readers and the 413 an
over-long Content-Length earns. What was never exercised is what happens when
the environment is *wrong* rather than absent: a `THREADPOOL_MAX` of "forty", a
`MAX_REQUEST_BODY_BYTES` of "0". Both are deployment mistakes rather than
attacks, and both must land on the documented default rather than crashing the
process at import — these run during startup, so an unhandled ValueError here is
a service that will not boot.

Also covered: the streaming reader's disconnect branch. A client that hangs up
mid-body sends `http.disconnect` instead of a further `http.request`, and the
reader has to stop and hand back what it has rather than loop waiting for more.
"""

import json
import logging

import anyio
import pytest

from app.limits import _read_capped, max_body_bytes, threadpool_size
from app.observability import JsonLogFormatter


# ── max_body_bytes ───────────────────────────────────────────────────────────


def test_body_cap_falls_back_when_the_variable_is_absent_or_blank(monkeypatch):
    monkeypatch.delenv("MAX_REQUEST_BODY_BYTES", raising=False)
    assert max_body_bytes(4096) == 4096
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "")
    assert max_body_bytes(4096) == 4096
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "   ")
    assert max_body_bytes(4096) == 4096


def test_a_non_numeric_body_cap_falls_back_rather_than_raising(monkeypatch):
    # This is read at startup. An unhandled ValueError would be a service that
    # does not boot because someone wrote "8MB" in a unit file.
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "8MB")
    assert max_body_bytes(4096) == 4096


def test_a_non_positive_body_cap_falls_back(monkeypatch):
    # Zero would refuse every request with a body; a negative one is nonsense.
    # Neither is a cap the operator can have meant.
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "0")
    assert max_body_bytes(4096) == 4096
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "-1")
    assert max_body_bytes(4096) == 4096


def test_a_valid_body_cap_is_honoured(monkeypatch):
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "12345")
    assert max_body_bytes(4096) == 12345


# ── threadpool_size ──────────────────────────────────────────────────────────


def test_threadpool_size_falls_back_when_absent_or_blank(monkeypatch):
    monkeypatch.delenv("THREADPOOL_MAX", raising=False)
    assert threadpool_size(40) == 40
    monkeypatch.setenv("THREADPOOL_MAX", "")
    assert threadpool_size(40) == 40


def test_a_non_numeric_threadpool_size_falls_back(monkeypatch):
    monkeypatch.setenv("THREADPOOL_MAX", "forty")
    assert threadpool_size(40) == 40


def test_a_non_positive_threadpool_size_falls_back(monkeypatch):
    # A pool of zero threads runs no sync handler at all — every `def` route
    # would hang. The default is the only safe reading.
    monkeypatch.setenv("THREADPOOL_MAX", "0")
    assert threadpool_size(40) == 40
    monkeypatch.setenv("THREADPOOL_MAX", "-8")
    assert threadpool_size(40) == 40


def test_a_valid_threadpool_size_is_honoured(monkeypatch):
    monkeypatch.setenv("THREADPOOL_MAX", "64")
    assert threadpool_size(40) == 64


# ── _read_capped ─────────────────────────────────────────────────────────────


class _ScriptedReceive:
    """The one thing `_read_capped` takes: an ASGI `receive` callable."""

    def __init__(self, messages):
        self._messages = list(messages)

    async def __call__(self):
        return self._messages.pop(0)


def _read(messages, limit):
    return anyio.run(lambda: _read_capped(_ScriptedReceive(messages), limit))


def test_a_body_within_the_cap_is_buffered_for_replay():
    messages = [
        {"type": "http.request", "body": b"abc", "more_body": True},
        {"type": "http.request", "body": b"de", "more_body": False},
    ]
    assert _read(messages, 10) == messages


def test_a_single_unchunked_message_ends_the_read():
    # No `more_body` key at all is the common shape, and means "that was it".
    messages = [{"type": "http.request", "body": b"abc"}]
    assert _read(messages, 10) == messages


def test_a_body_over_the_cap_is_abandoned_rather_than_drained():
    # None means "refuse", and the remaining chunks are never read — which is
    # what bounds the memory this middleware can be made to hold.
    messages = [
        {"type": "http.request", "body": b"a" * 8, "more_body": True},
        {"type": "http.request", "body": b"a" * 8, "more_body": True},
        {"type": "http.request", "body": b"a" * 8, "more_body": False},
    ]
    receive = _ScriptedReceive(messages)
    assert anyio.run(lambda: _read_capped(receive, 10)) is None
    assert len(receive._messages) == 1  # the third chunk was never asked for


def test_the_cap_is_exclusive_at_the_boundary():
    exact = [{"type": "http.request", "body": b"a" * 10, "more_body": False}]
    assert _read(exact, 10) == exact
    over = [{"type": "http.request", "body": b"a" * 11, "more_body": False}]
    assert _read(over, 10) is None


def test_a_client_that_hangs_up_mid_body_stops_the_read():
    # `http.disconnect` is what an ASGI server sends when the client goes away.
    # Nothing further is coming, so looping for another `http.request` would
    # block a worker on a connection that no longer exists.
    messages = [
        {"type": "http.request", "body": b"abc", "more_body": True},
        {"type": "http.disconnect"},
    ]
    assert _read(messages, 100) == messages


def test_an_immediate_disconnect_yields_just_that_message():
    assert _read([{"type": "http.disconnect"}], 100) == [{"type": "http.disconnect"}]


# ── The middleware end to end ────────────────────────────────────────────────


@pytest.mark.parametrize("header", ["not-a-number", "-1"])
def test_a_malformed_content_length_is_a_400_not_a_413(header):
    # A header that cannot be parsed, or a negative one that would slip under
    # the `>` comparison, is a bad request — not an over-size one.
    from fastapi.testclient import TestClient

    from app.main import app

    res = TestClient(app).post(
        "/engine/v1/compute",
        content="{}",
        headers={"content-type": "application/json", "content-length": header},
    )
    assert res.status_code == 400


# ── the operator is told ─────────────────────────────────────────────────────


def test_a_rejected_body_cap_is_logged_rather_than_silently_dropped(monkeypatch, caplog):
    # Falling back is right; falling back silently is not. The operator who set
    # MAX_REQUEST_BODY_BYTES=8MB has a service running on the old cap and,
    # before this, nothing anywhere that disagreed with them.
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "8MB")
    with caplog.at_level(logging.WARNING, logger="limits"):
        assert max_body_bytes(4096) == 4096
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert "MAX_REQUEST_BODY_BYTES" in record.getMessage()
    assert record.detail == "8MB"
    # `limit`, not `status`: 4096 is a configured ceiling and never an HTTP
    # status, and this field is read alongside the access log's own `status`.
    assert record.limit == 4096
    # Asserted through the formatter rather than off the record, because that is
    # the step this test could not see: `detail` was passed by the call site,
    # read back here, and dropped on the floor by the allowlist in between.
    assert json.loads(JsonLogFormatter().format(record))["detail"] == "8MB"


def test_a_non_positive_body_cap_is_logged_too(monkeypatch, caplog):
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "0")
    with caplog.at_level(logging.WARNING, logger="limits"):
        assert max_body_bytes(4096) == 4096
    assert [r.detail for r in caplog.records] == ["0"]


def test_a_rejected_threadpool_size_is_logged(monkeypatch, caplog):
    monkeypatch.setenv("THREADPOOL_MAX", "forty")
    with caplog.at_level(logging.WARNING, logger="limits"):
        assert threadpool_size(40) == 40
    assert "THREADPOOL_MAX" in caplog.records[0].getMessage()
    assert caplog.records[0].detail == "forty"


def test_an_absent_or_valid_setting_logs_nothing(monkeypatch, caplog):
    # A warning on every boot is a warning nobody reads.
    monkeypatch.delenv("MAX_REQUEST_BODY_BYTES", raising=False)
    monkeypatch.setenv("THREADPOOL_MAX", "64")
    with caplog.at_level(logging.WARNING, logger="limits"):
        assert max_body_bytes(4096) == 4096
        assert threadpool_size(40) == 64
    assert caplog.records == []
