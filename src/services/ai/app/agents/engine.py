"""Minimal client for the engine-wrapper endpoints the comp agent needs.

Two calls, and they are two *independent sources of candidates* rather than one
call and a helper:

  * ``verify_tickers`` checks the tickers a model proposes against real
    reference data before those multiples are allowed to shape a valuation;
  * ``screen_comparables`` asks the engine to rank the reference universe
    against the target's own attributes, which produces candidates the model
    never mentioned. A comp set that can only contain what a model recalled is
    a comp set with a recall-shaped hole in it.

Kept deliberately tiny and side-effect free so tests can monkeypatch either
without any network.
"""

from __future__ import annotations

import os

import httpx

ENGINE_TIMEOUT_S = 20.0


class EngineError(Exception):
    """Raised when the engine market-data lookup cannot be completed."""


def _engine_url() -> str:
    return os.environ.get("ENGINE_URL", "http://127.0.0.1:3003").rstrip("/")


def _post(path: str, body: dict, label: str, *, client: httpx.Client | None = None) -> dict:
    """POST to the engine and return its JSON object, or raise EngineError.

    Every failure mode converts, because both callers degrade rather than
    crash. A 200 in particular is not a promise of JSON: an ingress or proxy in
    front of the engine answers with an HTML error page and a 200 of its own,
    and a truncated body decodes no better. JSONDecodeError is a ValueError,
    not an httpx.HTTPError, so it used to sail past the transport guard and
    straight out of this module — where the caller catches only EngineError, so
    the comp-selection agent crashed on a bad gateway instead of degrading to
    model-only multiples, which is the entire reason this converts.
    """
    owns = client is None
    http = client or httpx.Client(timeout=ENGINE_TIMEOUT_S)
    try:
        resp = http.post(f"{_engine_url()}{path}", json=body)
    except httpx.HTTPError as exc:
        raise EngineError(f"{label} request failed: {exc}") from exc
    finally:
        if owns:
            http.close()
    if resp.status_code != 200:
        raise EngineError(f"{label} HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise EngineError(f"{label} returned a non-JSON body: {exc}") from exc
    if not isinstance(data, dict):
        raise EngineError(f"{label} returned a non-object body")
    return data


def verify_tickers(tickers: list[str], *, client: httpx.Client | None = None) -> dict:
    """Verify candidate tickers via POST /engine/v1/market-data.

    Returns the engine payload: ``{"companies": [...], "not_found": [...],
    "count": n}``. Raises EngineError on any transport/HTTP failure so the agent
    can degrade to model-only multiples rather than crash.
    """
    if not tickers:
        return {"companies": [], "not_found": [], "count": 0}
    data = _post("/engine/v1/market-data", {"tickers": tickers}, "market-data", client=client)
    data.setdefault("companies", [])
    data.setdefault("not_found", [])
    return data


def screen_comparables(target: dict, *, client: httpx.Client | None = None) -> dict:
    """Rank the reference universe against the target via POST /engine/v1/comparables.

    ``target`` carries whatever is known — sic_code, revenue, revenue_growth,
    ebitda_margin. The engine refuses a screen with none of them, which is the
    right answer: a ranking with nothing to rank against is noise wearing a
    score. That refusal arrives as a 422 and converts to EngineError here, so
    the agent simply proceeds with the model's suggestions alone.
    """
    if not target:
        return {"selected": [], "screened_out": []}
    data = _post("/engine/v1/comparables", {"inputs": target}, "comparables", client=client)
    data.setdefault("selected", [])
    data.setdefault("screened_out", [])
    return data
