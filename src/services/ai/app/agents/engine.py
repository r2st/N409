"""Minimal client for the engine-wrapper's market-data endpoint.

Only the comparable-company agent needs the engine: it verifies the tickers a
model proposes against real reference data before those multiples are allowed
to shape a valuation. Kept deliberately tiny and side-effect free so tests can
monkeypatch ``verify_tickers`` without any network.
"""

from __future__ import annotations

import os

import httpx

ENGINE_TIMEOUT_S = 20.0


class EngineError(Exception):
    """Raised when the engine market-data lookup cannot be completed."""


def _engine_url() -> str:
    return os.environ.get("ENGINE_URL", "http://127.0.0.1:3003").rstrip("/")


def verify_tickers(tickers: list[str], *, client: httpx.Client | None = None) -> dict:
    """Verify candidate tickers via POST /engine/v1/market-data.

    Returns the engine payload: ``{"companies": [...], "not_found": [...],
    "count": n}``. Raises EngineError on any transport/HTTP failure so the agent
    can degrade to model-only multiples rather than crash.
    """
    if not tickers:
        return {"companies": [], "not_found": [], "count": 0}
    owns = client is None
    http = client or httpx.Client(timeout=ENGINE_TIMEOUT_S)
    url = f"{_engine_url()}/engine/v1/market-data"
    try:
        resp = http.post(url, json={"tickers": tickers})
    except httpx.HTTPError as exc:
        raise EngineError(f"market-data request failed: {exc}") from exc
    finally:
        if owns:
            http.close()
    if resp.status_code != 200:
        raise EngineError(f"market-data HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if not isinstance(data, dict):
        raise EngineError("market-data returned a non-object body")
    data.setdefault("companies", [])
    data.setdefault("not_found", [])
    return data
