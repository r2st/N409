"""Body-size cap, request-id, threadpool sizing on the engine (audit B-2 P2/P3)."""

import importlib

from fastapi.testclient import TestClient

from app.limits import max_body_bytes, threadpool_size
from app.main import app

client = TestClient(app)


def test_max_body_bytes_and_threadpool_env(monkeypatch):
    monkeypatch.delenv("MAX_REQUEST_BODY_BYTES", raising=False)
    assert max_body_bytes(4096) == 4096
    monkeypatch.setenv("MAX_REQUEST_BODY_BYTES", "9000")
    assert max_body_bytes(4096) == 9000
    monkeypatch.delenv("THREADPOOL_MAX", raising=False)
    assert threadpool_size(40) == 40


def test_oversized_compute_request_is_rejected():
    res = client.post(
        "/engine/v1/compute",
        content="{}",
        headers={"content-type": "application/json", "content-length": str(16 * 1024 * 1024)},
    )
    assert res.status_code == 413


def test_health_echoes_request_id():
    res = client.get("/health", headers={"x-request-id": "engine-req-9"})
    assert res.status_code == 200
    assert res.headers["x-request-id"] == "engine-req-9"


def test_request_id_minted_when_absent():
    assert client.get("/health").headers.get("x-request-id")


def test_configure_threadpool_within_loop():
    import anyio

    from app.limits import configure_threadpool

    async def check() -> float:
        configure_threadpool(9)
        return anyio.to_thread.current_default_thread_limiter().total_tokens

    assert anyio.run(check) == 9


def test_startup_lifespan_runs():
    main = importlib.import_module("app.main")
    with TestClient(main.app) as c:
        assert c.get("/health").status_code == 200
