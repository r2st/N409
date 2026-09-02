"""Per-caller request ceiling on the engine.

The threadpool bounds how much runs at once and the body cap bounds how large
one request is; neither bounds how *many* arrive. A caller that loops — a retry
storm, a batch job with a bug — could queue compute work without limit. These
tests pin the counter's arithmetic, the exemptions, and the headers a caller
needs to back off before it is cut off.
"""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors import install_error_handlers, make_unhandled_error_middleware
from app.main import app
from app.observability import make_request_context_middleware
from app.ratelimit import (
    DEFAULT_LIMIT_PER_MINUTE,
    FixedWindowRateLimiter,
    limit_per_minute,
    make_rate_limit_middleware,
)


class TestConfiguration:
    def test_defaults_when_unset(self, monkeypatch) -> None:
        monkeypatch.delenv("RATE_LIMIT_RPM", raising=False)
        assert limit_per_minute() == DEFAULT_LIMIT_PER_MINUTE
        assert limit_per_minute(240) == 240

    def test_reads_the_environment(self, monkeypatch) -> None:
        monkeypatch.setenv("RATE_LIMIT_RPM", "50")
        assert limit_per_minute() == 50

    def test_zero_disables(self, monkeypatch) -> None:
        monkeypatch.setenv("RATE_LIMIT_RPM", "0")
        assert limit_per_minute() == 0

    def test_negative_reads_as_off_not_as_unlimited(self, monkeypatch) -> None:
        # A typo'd `-1` must not become an admit-everything limiter.
        monkeypatch.setenv("RATE_LIMIT_RPM", "-1")
        assert limit_per_minute() == 0

    def test_garbage_falls_back_to_the_default(self, monkeypatch) -> None:
        monkeypatch.setenv("RATE_LIMIT_RPM", "lots")
        assert limit_per_minute(300) == 300

    def test_blank_falls_back_to_the_default(self, monkeypatch) -> None:
        monkeypatch.setenv("RATE_LIMIT_RPM", "   ")
        assert limit_per_minute(300) == 300

    def test_the_engine_default_is_generous_enough_for_real_work(self) -> None:
        # A valuation makes a handful of engine calls and a sensitivity grid is
        # one request; the ceiling is there to stop a loop, not a workload.
        assert DEFAULT_LIMIT_PER_MINUTE >= 600


class TestCounter:
    def test_admits_up_to_the_limit_then_denies(self) -> None:
        limiter = FixedWindowRateLimiter(limit=3, window_s=60)
        assert [limiter.check("a", now=1000.0)[0] for _ in range(3)] == [True, True, True]
        assert limiter.check("a", now=1000.0)[0] is False

    def test_reports_shrinking_headroom(self) -> None:
        limiter = FixedWindowRateLimiter(limit=3, window_s=60)
        assert [limiter.check("a", now=1000.0)[1] for _ in range(4)] == [2, 1, 0, 0]

    def test_the_window_rolls_over(self) -> None:
        limiter = FixedWindowRateLimiter(limit=2, window_s=60)
        limiter.check("a", now=1000.0)
        limiter.check("a", now=1000.0)
        assert limiter.check("a", now=1030.0)[0] is False  # still inside
        assert limiter.check("a", now=1060.0)[0] is True  # window elapsed

    def test_reset_is_the_window_start_plus_the_window(self) -> None:
        limiter = FixedWindowRateLimiter(limit=2, window_s=60)
        _, _, first = limiter.check("a", now=1000.0)
        _, _, second = limiter.check("a", now=1030.0)
        assert first == 1060.0
        # The second request is inside the first window, so it does not extend
        # it — a fixed window resets on a clock, not on the last request.
        assert second == 1060.0

    def test_callers_are_counted_separately(self) -> None:
        limiter = FixedWindowRateLimiter(limit=1, window_s=60)
        assert limiter.check("a", now=1000.0)[0] is True
        assert limiter.check("b", now=1000.0)[0] is True
        assert limiter.check("a", now=1000.0)[0] is False

    def test_a_limit_of_one_still_admits_one(self) -> None:
        limiter = FixedWindowRateLimiter(limit=1, window_s=60)
        allowed, remaining, _ = limiter.check("a", now=1000.0)
        assert (allowed, remaining) == (True, 0)

    def test_expired_windows_do_not_accumulate_forever(self) -> None:
        limiter = FixedWindowRateLimiter(limit=5, window_s=1)
        for i in range(10_050):
            limiter.check(f"ip-{i}", now=1000.0 + i)
        # The sweep runs on insert once the map is large; the exact survivor
        # count is an implementation detail, the bound is not.
        assert limiter.tracked_keys <= 10_000

    def test_is_safe_under_concurrent_callers(self) -> None:
        # Sync FastAPI handlers run in a threadpool, so the counter is touched
        # from several threads at once; a lost update would over-admit.
        import threading

        limiter = FixedWindowRateLimiter(limit=500, window_s=60)
        admitted: list[bool] = []
        lock = threading.Lock()

        def hammer() -> None:
            local = [limiter.check("shared")[0] for _ in range(100)]
            with lock:
                admitted.extend(local)

        threads = [threading.Thread(target=hammer) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sum(admitted) == 500  # exactly the budget, no more and no fewer


@pytest.fixture
def limited_client() -> TestClient:
    """An app wired like the real one but with a limit small enough to reach."""
    limited = FastAPI()

    @limited.get("/engine/v1/thing")
    def _thing() -> dict:
        return {"ok": True}

    @limited.get("/health")
    def _health() -> dict:
        return {"status": "ok"}

    limited.add_middleware(make_rate_limit_middleware(2, window_s=60))
    limited.add_middleware(make_unhandled_error_middleware("engine-wrapper"))
    limited.add_middleware(make_request_context_middleware("engine-wrapper"))
    install_error_handlers(limited)
    return TestClient(limited)


class TestMiddleware:
    def test_the_third_request_is_refused(self, limited_client: TestClient) -> None:
        assert limited_client.get("/engine/v1/thing").status_code == 200
        assert limited_client.get("/engine/v1/thing").status_code == 200
        assert limited_client.get("/engine/v1/thing").status_code == 429

    def test_the_refusal_says_how_long_to_wait(self, limited_client: TestClient) -> None:
        res = [limited_client.get("/engine/v1/thing") for _ in range(3)][-1]
        assert res.status_code == 429
        assert 1 <= int(res.headers["retry-after"]) <= 60
        assert "Rate limit exceeded" in res.json()["detail"]

    def test_the_refusal_is_traceable_like_every_other_error(
        self, limited_client: TestClient
    ) -> None:
        headers = {"x-request-id": "flood-1"}
        res = [limited_client.get("/engine/v1/thing", headers=headers) for _ in range(3)][-1]
        assert res.status_code == 429
        assert res.json()["request_id"] == "flood-1"
        assert res.headers["x-request-id"] == "flood-1"

    def test_headroom_is_reported_on_success_not_only_on_refusal(
        self, limited_client: TestClient
    ) -> None:
        # A caller should be able to back off before it is cut off.
        first = limited_client.get("/engine/v1/thing")
        assert first.headers["x-ratelimit-limit"] == "2"
        assert first.headers["x-ratelimit-remaining"] == "1"
        assert int(first.headers["x-ratelimit-reset"]) > 0

    def test_health_checks_are_never_throttled(self, limited_client: TestClient) -> None:
        # A limiter that 429s the load balancer's probe pulls the service out of
        # rotation exactly when it is busiest.
        for _ in range(20):
            assert limited_client.get("/health").status_code == 200
        # And the probes did not spend the caller's budget either.
        assert limited_client.get("/engine/v1/thing").status_code == 200

    def test_refusals_are_logged_as_warnings(
        self, limited_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.WARNING):
            for _ in range(3):
                limited_client.get("/engine/v1/thing")
        exceeded = [r for r in caplog.records if getattr(r, "event", None) == "ratelimit_exceeded"]
        assert len(exceeded) == 1
        assert exceeded[0].path == "/engine/v1/thing"

    def test_disabled_limiter_admits_everything(self) -> None:
        unlimited = FastAPI()

        @unlimited.get("/engine/v1/thing")
        def _thing() -> dict:
            return {"ok": True}

        unlimited.add_middleware(make_rate_limit_middleware(0))
        client = TestClient(unlimited)
        assert all(client.get("/engine/v1/thing").status_code == 200 for _ in range(50))

    def test_disabled_limiter_advertises_no_headers(self) -> None:
        unlimited = FastAPI()

        @unlimited.get("/engine/v1/thing")
        def _thing() -> dict:
            return {"ok": True}

        unlimited.add_middleware(make_rate_limit_middleware(0))
        res = TestClient(unlimited).get("/engine/v1/thing")
        assert "x-ratelimit-limit" not in res.headers


class TestRealApp:
    """The shipped app is limited, and generously enough not to affect the suite."""

    def test_normal_traffic_is_not_throttled(self) -> None:
        client = TestClient(app)
        assert all(client.get("/engine/v1/health").status_code == 200 for _ in range(30))

    def test_compute_answers_carry_the_headroom_headers(self) -> None:
        res = TestClient(app).post("/engine/v1/compute", json={"params": {}, "inputs": {}})
        # 422 for an empty payload — the point is that the limiter ran and
        # annotated the answer, whatever the answer was.
        assert res.headers["x-ratelimit-limit"] == str(DEFAULT_LIMIT_PER_MINUTE)
