import importlib
import logging

from fastapi.testclient import TestClient

from app.limits import max_body_bytes, threadpool_size
from app.main import app

client = TestClient(app)


def test_max_body_bytes_reads_env(monkeypatch):
    monkeypatch.delenv("MAX_REQUEST_BODY_BYTES", raising=False)
    assert max_body_bytes(1000) == 1000
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "2048")
    assert max_body_bytes(1000) == 2048
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "not-a-number")
    assert max_body_bytes(1000) == 1000
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "0")
    assert max_body_bytes(1000) == 1000


def test_threadpool_size_reads_env(monkeypatch):
    monkeypatch.delenv("THREADPOOL_MAX", raising=False)
    assert threadpool_size(40) == 40
    monkeypatch.setenv("THREADPOOL_MAX", "12")
    assert threadpool_size(40) == 12
    monkeypatch.setenv("THREADPOOL_MAX", "-3")
    assert threadpool_size(40) == 40


def test_oversized_request_is_rejected_with_413():
    # A Content-Length just over the cap is refused before the body is buffered.
    big = "x" * 50
    res = client.post(
        "/ai/v1/pipelines/extract",
        content=big,
        headers={"content-type": "application/json", "content-length": str(64 * 1024 * 1024)},
    )
    assert res.status_code == 413
    assert "exceeds" in res.json()["detail"]


def test_invalid_content_length_is_rejected():
    res = client.post(
        "/ai/v1/test",
        content="{}",
        headers={"content-type": "application/json", "content-length": "abc"},
    )
    assert res.status_code == 400


def test_normal_request_passes_the_limit():
    # A small body under the cap reaches the (unknown-pipeline) 404 handler.
    res = client.post("/ai/v1/pipelines/does-not-exist", json={"valuation": {}})
    assert res.status_code == 404


def test_configure_threadpool_sets_capacity():
    import anyio

    from app.limits import configure_threadpool

    async def check() -> float:
        configure_threadpool(17)
        return anyio.to_thread.current_default_thread_limiter().total_tokens

    assert anyio.run(check) == 17


def test_startup_lifespan_runs_without_error():
    # Entering the TestClient context runs the lifespan (threadpool sizing).
    main = importlib.import_module("app.main")
    with TestClient(main.app) as c:
        assert c.get("/health").status_code == 200


def _chunks(total_bytes: int, chunk_bytes: int = 1024 * 1024):
    """A body streamed in pieces — httpx sends this without a Content-Length."""
    sent = 0
    while sent < total_bytes:
        size = min(chunk_bytes, total_bytes - sent)
        sent += size
        yield b"x" * size


def test_chunked_request_over_the_cap_is_rejected(monkeypatch):
    # No Content-Length to read, so the cap has to come from counting the body
    # as it arrives. Before this was enforced the whole 40 MB was buffered and
    # handed to the JSON parser, which is the OOM the cap exists to prevent.
    res = client.post(
        "/ai/v1/pipelines/extract",
        content=_chunks(40 * 1024 * 1024),
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 413
    assert "exceeds" in res.json()["detail"]


def test_chunked_request_under_the_cap_still_reaches_the_route():
    # The metered body must be replayed intact — a legitimate chunked caller
    # sees its payload, not an empty one.
    res = client.post(
        "/ai/v1/pipelines/does-not-exist",
        content=iter([b'{"valuation": ', b'{"id": "v1"}}']),
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 404
    assert "does-not-exist" in res.json()["detail"]


def test_negative_content_length_is_rejected():
    # `int("-1") > limit` is False, so a negative length slipped past the
    # comparison instead of being read as the malformed header it is.
    res = client.post(
        "/ai/v1/test",
        content="{}",
        headers={"content-type": "application/json", "content-length": "-1"},
    )
    assert res.status_code == 400


def test_bodyless_methods_skip_the_meter():
    # GET carries no body; it must not pay for an extra receive() round-trip.
    assert client.get("/health").status_code == 200


def test_a_rejected_limit_setting_says_so(monkeypatch, caplog):
    # Falling back to the default rather than raising is deliberate: both
    # readers run during start-up, and an unhandled ValueError here is a service
    # that will not boot because somebody wrote "8MB" in a unit file. Falling
    # back *silently* is the other half of the problem — the operator who raised
    # the cap is running on the old one with nothing to disagree with them.
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "8MB")
    monkeypatch.setenv("THREADPOOL_MAX", "0")
    with caplog.at_level(logging.WARNING, logger="limits"):
        assert max_body_bytes(1000) == 1000
        assert threadpool_size(40) == 40
    named = {r.getMessage().split(" ")[0] for r in caplog.records}
    assert named == {"MAX_REQUEST_BODY_BYTES", "THREADPOOL_MAX"}
    assert {r.detail for r in caplog.records} == {"8MB", "0"}


def test_a_valid_setting_logs_nothing(monkeypatch, caplog):
    # A warning on every boot is a warning nobody reads.
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "2048")
    monkeypatch.delenv("THREADPOOL_MAX", raising=False)
    with caplog.at_level(logging.WARNING, logger="limits"):
        assert max_body_bytes(1000) == 2048
        assert threadpool_size(40) == 40
    assert caplog.records == []
