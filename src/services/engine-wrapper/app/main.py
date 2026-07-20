"""Engine wrapper — Python reimplementation of the R calculation engine (M1).

Exposes the versioned /engine/v1 contract (api-design.md §4). The original
plan wrapped the legacy R/Plumber engine; per the gap analysis the engine is
reimplemented natively in Python instead.
"""

import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .engine.approaches import EngineInputError
from .engine.compute import ENGINE_VERSION, compute
from .engine.market_data import lookup as market_lookup
from .engine.market_data import universe as market_universe

SERVICE = "engine-wrapper"
_started = time.monotonic()

app = FastAPI(title="n409-engine-wrapper", version=ENGINE_VERSION)


class ComputeRequest(BaseModel):
    params: dict = Field(default_factory=dict)
    inputs: dict = Field(default_factory=dict)
    # Per-subsystem recalculation: approaches to compute fresh + the previous
    # run's results.approaches to reuse for everything else.
    recompute: list[str] | None = None
    prior_approaches: dict | None = None


class MarketDataRequest(BaseModel):
    # Candidate tickers to verify (from the comparable-company AI agent).
    tickers: list = Field(default_factory=list)


@app.get("/")
def root() -> dict:
    return {
        "service": SERVICE,
        "version": ENGINE_VERSION,
        "status": "ok",
        "contract": "engine/v1",
        "endpoints": [
            "/health",
            "/ready",
            "/docs",
            "/engine/v1/health",
            "/engine/v1/compute",
            "/engine/v1/market-data",
        ],
    }


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": SERVICE,
        "version": ENGINE_VERSION,
        "uptime_s": int(time.monotonic() - _started),
    }


@app.get("/ready")
def ready() -> dict:
    return {"status": "ready", "checks": {"engine": ENGINE_VERSION}}


@app.get("/engine/v1/health")
def engine_health() -> dict:
    return {"status": "ok", "engine_version": ENGINE_VERSION, "contract": "engine/v1"}


@app.post("/engine/v1/compute")
def engine_compute(request: ComputeRequest) -> dict:
    try:
        return compute(
            request.params,
            request.inputs,
            recompute=request.recompute,
            prior_approaches=request.prior_approaches,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/engine/v1/market-data")
def market_data_universe() -> dict:
    """The comparable-company reference universe (illustrative snapshot)."""
    companies = market_universe()
    return {"companies": companies, "count": len(companies)}


@app.post("/engine/v1/market-data")
def market_data(request: MarketDataRequest) -> dict:
    """Verify candidate tickers and return their SIC codes, market caps, and
    trading multiples so the comparable-company agent works from real figures."""
    try:
        return market_lookup(request.tickers)
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
