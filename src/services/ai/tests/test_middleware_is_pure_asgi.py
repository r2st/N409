"""The seven middleware layers must stay pure ASGI (R377, performance).

``@app.middleware("http")`` is Starlette's ``BaseHTTPMiddleware``, and its
convenience — ``call_next`` handing the layer a fully-formed ``Response`` — is
bought with a per-request, per-layer ``anyio`` task group and a pair of memory
object streams. Not one of these seven ever used it: they short-circuit with
their own response, they replace ``receive``, or they read the status and add
headers on ``http.response.start``. See ``app/asgi.py``.

Measured on this box, a bare FastAPI ``/health`` is 0.29 ms; with the seven
layers as ``BaseHTTPMiddleware`` it was 1.27 ms and as pure ASGI it is 0.40.

**These assertions are about the work, not the answer.** Every response this
service sends is byte-identical either way — the behaviour is pinned by
``test_security_headers.py``, ``test_ratelimit.py``, ``test_errors.py`` and
``test_internal_auth.py``, all of which passed unchanged across the rewrite. So
the only thing that can catch a regression here is the machinery itself: the
task groups a request creates, and the classes on the stack.
"""

from __future__ import annotations

import anyio
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

from app.main import app as real_app


@pytest.fixture
def count_task_groups(monkeypatch):
    """Count ``anyio.create_task_group()`` calls made while a request is served.

    ``starlette.middleware.base`` reaches the factory through the ``anyio``
    module object, so patching the attribute there is patching the one it
    calls.
    """
    real = anyio.create_task_group
    calls = {"n": 0}

    def counting(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(anyio, "create_task_group", counting)
    return calls


def _seven_layer_basehttp_app() -> FastAPI:
    """The shape this service had: seven ``BaseHTTPMiddleware`` pass-throughs.

    The discriminator for the counter above. A test that only asserted "zero
    task groups" on the real app would pass just as happily if the counter
    were broken, so the same counter has to *see* the old shape.
    """
    app = FastAPI()

    @app.get("/health")
    def _health() -> dict:
        return {"status": "ok"}

    for _ in range(7):

        async def _passthrough(request: Request, call_next):  # pragma: no cover - shape only
            return await call_next(request)

        app.middleware("http")(_passthrough)

    return app


class TestNoLayerBuffersTheResponse:
    def test_a_request_creates_no_middleware_task_group(self, count_task_groups) -> None:
        with TestClient(real_app) as client:
            client.get("/health")  # warm the lifespan and any one-off setup
            count_task_groups["n"] = 0
            assert client.get("/health").status_code == 200
        assert count_task_groups["n"] == 0

    def test_a_request_carrying_a_body_creates_none_either(self, count_task_groups) -> None:
        # The body cap replaces `receive` on this path, which is the one layer
        # that has to touch the request rather than the response. A 422 from
        # the schema is a fine subject: it still travels the whole stack.
        with TestClient(real_app) as client:
            client.post("/ai/v1/tag", json={})
            count_task_groups["n"] = 0
            client.post("/ai/v1/tag", json={})
        assert count_task_groups["n"] == 0

    def test_the_counter_sees_the_shape_this_replaced(self, count_task_groups) -> None:
        # Without this the assertions above would pass over a broken counter.
        with TestClient(_seven_layer_basehttp_app()) as client:
            client.get("/health")
            count_task_groups["n"] = 0
            client.get("/health")
        assert count_task_groups["n"] == 7


class TestTheStackItself:
    def _built(self):
        return real_app.build_middleware_stack()

    def _chain(self) -> list[object]:
        chain: list[object] = []
        node = self._built()
        seen = 0
        while node is not None and seen < 64:
            chain.append(node)
            node = getattr(node, "app", None)
            seen += 1
        return chain

    def test_no_layer_is_a_base_http_middleware(self) -> None:
        offenders = [type(n).__name__ for n in self._chain() if isinstance(n, BaseHTTPMiddleware)]
        assert offenders == []

    def test_all_seven_layers_are_still_registered(self) -> None:
        # Vacuity guard: `no BaseHTTPMiddleware` is also true of a stack that
        # lost its middleware entirely, which is the way this rewrite could
        # have gone wrong silently.
        assert len(real_app.user_middleware) == 7

    def test_every_registered_layer_is_a_factory_not_a_coroutine(self) -> None:
        # `add_middleware` calls `cls(app, ...)`; a coroutine function handed to
        # it builds a stack that fails at the first request rather than here.
        import inspect

        for middleware in real_app.user_middleware:
            assert not inspect.iscoroutinefunction(middleware.cls), middleware
