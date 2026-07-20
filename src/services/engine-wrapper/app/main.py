"""Engine wrapper — Python reimplementation of the R calculation engine (M1).

Exposes the versioned /engine/v1 contract (api-design.md §4). The original
plan wrapped the legacy R/Plumber engine; per the gap analysis the engine is
reimplemented natively in Python instead.
"""

import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .engine.approaches import EngineInputError
from .engine.compute import ENGINE_VERSION, compute
from .internal_auth import internal_token_middleware, warn_if_unset
from .limits import configure_threadpool, make_body_limit_middleware, max_body_bytes, threadpool_size
from .observability import configure_logging, make_request_context_middleware
from .engine.market_data import lookup as market_lookup
from .engine.market_data import universe as market_universe
from .engine.market_feed import MarketFeedClient
from .engine.projection import project_financials
from .engine.rollforward import roll_forward
from .engine.volatility import estimate_volatility
from .engine.wacc import compute_wacc

SERVICE = "engine-wrapper"
_started = time.monotonic()

# Compute payloads are JSON (params + inputs), far smaller than the AI service's
# document blobs; cap at 8 MB to bound memory (audit B-2 P2).
_MAX_BODY_BYTES = max_body_bytes(8 * 1024 * 1024)

configure_logging(SERVICE)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # CPU-bound compute holds a thread for its duration; make the pool size a
    # deliberate, tunable number rather than the implicit default (audit B-2 P2).
    configure_threadpool(threadpool_size())
    yield


app = FastAPI(title="n409-engine-wrapper", version=ENGINE_VERSION, lifespan=lifespan)

# Middleware order (Starlette runs last-added first): request-context is
# outermost so its access log captures 401/413 responses too.
# Shared-secret gate (audit B-1 P0): every non-health route requires the
# X-Internal-Token the valuation service injects. No-op until the secret is set.
app.middleware("http")(internal_token_middleware)
# Body-size cap (audit B-2 P2): reject oversized payloads before buffering.
app.middleware("http")(make_body_limit_middleware(_MAX_BODY_BYTES))
# Structured access logging + x-request-id propagation (audit B-2 P3).
app.middleware("http")(make_request_context_middleware(SERVICE))
warn_if_unset()


class ComputeRequest(BaseModel):
    params: dict = Field(default_factory=dict)
    inputs: dict = Field(default_factory=dict)
    # Per-subsystem recalculation: approaches to compute fresh + the previous
    # run's results.approaches to reuse for everything else.
    recompute: list[str] | None = None
    prior_approaches: dict | None = None
    # Estimation autopilot: run the volatility / WACC / comparables engines to
    # pre-fill their manual inputs before computing (manual values still win).
    auto_volatility: bool = False
    auto_wacc: bool = False
    auto_comparables: bool = False


class MarketDataRequest(BaseModel):
    # Candidate tickers to verify (from the comparable-company AI agent).
    tickers: list = Field(default_factory=list)


class VolatilityRequest(BaseModel):
    comparables: list = Field(default_factory=list)
    method: str = "historical"
    time_to_exit_years: float | None = None
    periods_per_year: int = 252
    manual_override: float | None = None


class WaccRequest(BaseModel):
    # Passed through to compute_wacc(**inputs); see wacc.compute_wacc.
    inputs: dict = Field(default_factory=dict)


class ProjectionRequest(BaseModel):
    inputs: dict = Field(default_factory=dict)


class RollForwardRequest(BaseModel):
    prior_results: dict = Field(default_factory=dict)
    prior_valuation_date: str
    new_valuation_date: str
    prior_inputs: dict | None = None
    updated_inputs: dict | None = None
    annual_accretion: float | None = None
    value_adjustments: list | None = None
    new_round_post_money: float | None = None


class MarketFeedRequest(BaseModel):
    kind: str  # "prices" | "financials" | "multiples"
    ticker: str | None = None
    tickers: list | None = None
    start: str | None = None
    end: str | None = None
    metrics: list | None = None
    date: str | None = None
    fallback: dict | None = None


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
            "/engine/v1/market-feed",
            "/engine/v1/volatility",
            "/engine/v1/wacc",
            "/engine/v1/projection",
            "/engine/v1/rollforward",
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
            auto_volatility=request.auto_volatility,
            auto_wacc=request.auto_wacc,
            auto_comparables=request.auto_comparables,
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


# ── Standalone estimation engines (callable independently of /compute) ────────
# A single shared client memoizes live fetches across requests within a process.
_market_feed = MarketFeedClient()


@app.post("/engine/v1/volatility")
def engine_volatility(request: VolatilityRequest) -> dict:
    """Estimate equity volatility from comparable-company price series."""
    try:
        return estimate_volatility(
            request.comparables,
            method=request.method,
            time_to_exit_years=request.time_to_exit_years,
            periods_per_year=request.periods_per_year,
            manual_override=request.manual_override,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/wacc")
def engine_wacc(request: WaccRequest) -> dict:
    """Build the cost of equity (modified CAPM) and blend into WACC."""
    try:
        return compute_wacc(**request.inputs)
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TypeError as exc:  # unexpected/duplicate kwargs from the inputs dict
        raise HTTPException(status_code=422, detail=f"invalid wacc inputs: {exc}") from exc


@app.post("/engine/v1/projection")
def engine_projection(request: ProjectionRequest) -> dict:
    """Project revenue/expenses into unlevered free cash flows for the DCF."""
    try:
        return project_financials(**request.inputs)
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TypeError as exc:
        raise HTTPException(status_code=422, detail=f"invalid projection inputs: {exc}") from exc


@app.post("/engine/v1/rollforward")
def engine_rollforward(request: RollForwardRequest) -> dict:
    """Roll a prior valuation forward to a new date with change detection."""
    try:
        return roll_forward(
            request.prior_results,
            prior_valuation_date=request.prior_valuation_date,
            new_valuation_date=request.new_valuation_date,
            prior_inputs=request.prior_inputs,
            updated_inputs=request.updated_inputs,
            annual_accretion=request.annual_accretion,
            value_adjustments=request.value_adjustments,
            new_round_post_money=request.new_round_post_money,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/market-feed")
def market_feed(request: MarketFeedRequest) -> dict:
    """Fetch live comparable data (prices/financials/multiples) via yfinance.

    Returns ``source == "fallback"`` with a warning when the live source is
    unavailable, so the pipeline degrades gracefully rather than failing."""
    kind = request.kind
    if kind == "prices":
        if not (request.ticker and request.start and request.end):
            raise HTTPException(status_code=422, detail="prices needs ticker, start, end")
        return _market_feed.get_historical_prices(
            request.ticker, request.start, request.end, fallback=request.fallback
        )
    if kind == "financials":
        if not request.ticker:
            raise HTTPException(status_code=422, detail="financials needs ticker")
        return _market_feed.get_company_financials(request.ticker, fallback=request.fallback)
    if kind == "multiples":
        if not request.tickers:
            raise HTTPException(status_code=422, detail="multiples needs tickers")
        return _market_feed.get_company_multiples(
            request.tickers, request.metrics, request.date, fallback=request.fallback
        )
    raise HTTPException(status_code=422, detail="kind must be 'prices', 'financials' or 'multiples'")
