"""ASGI type aliases and the one rule every middleware here now follows.

The seven layers this service stacks were written with FastAPI's
``@app.middleware("http")`` decorator, which is Starlette's
``BaseHTTPMiddleware``. That class buys a convenience — ``call_next`` hands the
middleware a fully-formed ``Response`` object — with a per-request, per-layer
``anyio`` task group and a pair of memory object streams, because a response
that a middleware may inspect has to be decoupled from the task producing it.

Measured on this box: a bare FastAPI ``/health`` is 0.29 ms, one
``BaseHTTPMiddleware`` layer makes it 0.45, and seven make it 1.09. Seven
*pure-ASGI* layers make it 0.32. The convenience was never used: not one of
these seven reads or rewrites a response **body**. They short-circuit with
their own response (the token gate's 401, the body cap's 413, the limiter's
429), they replace ``receive`` (the body cap's replay), or they observe the
status and add headers on ``http.response.start``. All three are what plain
ASGI is for.

So each ``make_*_middleware`` now returns a *factory* — ``(app) -> app`` —
rather than an ``(request, call_next)`` coroutine, and ``main.py`` registers it
with ``app.add_middleware(...)`` instead of ``app.middleware("http")(...)``.
The two register identically (``add_middleware`` inserts at the front of the
user stack and the stack is built in reverse), so **the ordering comments in
main.py still mean what they say**: last added is outermost.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]
