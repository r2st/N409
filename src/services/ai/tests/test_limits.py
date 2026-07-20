import importlib

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
