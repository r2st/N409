"""Engine wrapper — Python reimplementation of the R calculation engine (M1).

Exposes the versioned /engine/v1 contract (api-design.md §4). The original
plan wrapped the legacy R/Plumber engine; per the gap analysis the engine is
reimplemented natively in Python instead.
"""

import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from typing import Literal
from pydantic import BaseModel, Field

from .engine.approaches import EngineInputError
from .engine.compute import ENGINE_VERSION, compute
from .engine.validate import split_issues, validate_payload
from .errors import error_response, install_error_handlers, make_unhandled_error_middleware
from .internal_auth import enforce_token_configured, internal_token_middleware
from .limits import configure_threadpool, make_body_limit_middleware, max_body_bytes, threadpool_size
from .observability import configure_logging, make_request_context_middleware
from .ratelimit import limit_per_minute, make_rate_limit_middleware
from .engine.market_data import MAX_TICKERS
from .engine.market_data import lookup as market_lookup
from .engine.market_data import universe as market_universe
from .engine.market_universe import default_client, resolve_universe
from .engine.fund_valuation import (
    calibrate_implied_volatility,
    fund_valuation,
    lp_waterfall,
    roll_forward_mark,
)
from .engine.debt_valuation import rating_implied_spread, value_instrument
from .engine.comparables import comparable_analysis
from .engine.emi_csop import emi_csop_valuation
from .engine.esop import esop_share_value, repurchase_obligation
from .engine.fair_value_820 import fair_value_measurement
from .engine.gift_estate import gift_estate_valuation
from .engine.ifrs2 import ifrs2_valuation
from .engine.impairment import run_impairment_test
from .engine.intangibles import purchase_price_allocation, value_intangible
from .engine.qsbs import qsbs_eligibility
from .engine.smb import smb_valuation
from .engine.projection import project_financials
from .engine.rollforward import roll_forward
from .engine.sensitivity import sensitivity as run_sensitivity
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
# Per-caller request ceiling. Outside the token gate on purpose, so guessing at
# the shared secret is throttled too.
app.middleware("http")(make_rate_limit_middleware(limit_per_minute()))
# Last-resort 500 envelope. Inside request-context (so the request id is bound
# when it logs) and outside everything else (so it catches their failures too).
app.middleware("http")(make_unhandled_error_middleware(SERVICE))
# Structured access logging + x-request-id propagation (audit B-2 P3).
app.middleware("http")(make_request_context_middleware(SERVICE))
# Put the request id on the deliberate failures as well, so every error
# response this service can emit is traceable to a log line.
install_error_handlers(app)
enforce_token_configured()


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
    # Step-by-step record of the pipeline for the calculation inspector, under
    # `trace` on the response. Off by default so the flag is the caller's
    # decision rather than the engine's: the steps carry the engine's whole
    # working state — every approach's inputs, the cap table, the waterfall —
    # and the estimation and sensitivity callers that compute a figure to throw
    # away have no use for them. The valuation service does ask on every run,
    # for the reason its own call site gives: the run worth inspecting is
    # always one that already happened.
    trace: bool = False


class SensitivityRequest(BaseModel):
    params: dict = Field(default_factory=dict)
    inputs: dict = Field(default_factory=dict)
    # One-way levers (default: every lever the payload drives) and two-way
    # [row, col] lever pairs.
    parameters: list[str] | None = None
    two_way: list[list[str]] | None = None
    span: float = 0.20
    steps: int = 5


class MarketDataRequest(BaseModel):
    # Candidate tickers to verify (from the comparable-company AI agent).
    tickers: list = Field(default_factory=list)
    # None defers to the deployment's ENGINE_LIVE_UNIVERSE setting; False pins
    # the answer to the curated snapshot, which is what a caller reproducing an
    # earlier run wants.
    live: bool | None = None


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


class FundValuationRequest(BaseModel):
    positions: list = Field(default_factory=list)
    liabilities: float = 0.0
    lp_terms: dict | None = None


class FundWaterfallRequest(BaseModel):
    committed_capital: float = 0.0
    contributed_capital: float = 0.0
    distributable: float = 0.0
    preferred_return_rate: float = 0.08
    years: float = 1.0
    carry_pct: float = 0.20
    gp_catch_up: bool = True
    management_fees_paid: float = 0.0
    gp_distributions_to_date: float = 0.0


class FundCalibrateRequest(BaseModel):
    round_price_per_share: float
    total_equity_value: float
    strike: float
    time_to_exit_years: float
    risk_free_rate: float
    preferred_shares: float
    fully_diluted_shares: float


class FundRollForwardRequest(BaseModel):
    prior_fair_value: float
    method: str = "index"
    index_return: float | None = None
    accretion_rate: float | None = None
    periods: float = 1.0
    new_calibrated_value: float | None = None


class DebtValuationRequest(BaseModel):
    instrument_type: str  # bond | term_loan | credit_spread | convertible | safe
    params: dict = Field(default_factory=dict)


class RatingSpreadRequest(BaseModel):
    rating: str


class QsbsRequest(BaseModel):
    # Passed through to qsbs_eligibility(**inputs); see qsbs.qsbs_eligibility.
    inputs: dict = Field(default_factory=dict)


class IntangibleRequest(BaseModel):
    method: str  # relief_from_royalty | meem | with_and_without | cost_approach
    params: dict = Field(default_factory=dict)


class PpaRequest(BaseModel):
    # Passed through to purchase_price_allocation(**inputs).
    inputs: dict = Field(default_factory=dict)


class ImpairmentRequest(BaseModel):
    test: str  # goodwill | indefinite_lived | long_lived
    params: dict = Field(default_factory=dict)


class EsopRequest(BaseModel):
    # Level-of-value inputs; see esop.esop_share_value.
    inputs: dict = Field(default_factory=dict)
    # Optional repurchase-obligation projection; see esop.repurchase_obligation.
    # fmv_per_share defaults to the concluded per-share value from `inputs`.
    repurchase: dict | None = None


class SmbRequest(BaseModel):
    # Passed through to smb_valuation(**inputs).
    inputs: dict = Field(default_factory=dict)


class EmiCsopRequest(BaseModel):
    scheme: Literal["emi", "csop"]
    params: dict = Field(default_factory=dict)


class ComparablesRequest(BaseModel):
    # Passed through to comparable_analysis(**inputs); see comparables.
    inputs: dict = Field(default_factory=dict)


class FairValue820Request(BaseModel):
    # Passed through to fair_value_measurement(**inputs); see fair_value_820.
    inputs: dict = Field(default_factory=dict)


class GiftEstateRequest(BaseModel):
    # Passed through to gift_estate_valuation(**inputs); see gift_estate.
    inputs: dict = Field(default_factory=dict)


class Ifrs2Request(BaseModel):
    # Passed through to ifrs2_valuation(**inputs); see ifrs2.
    inputs: dict = Field(default_factory=dict)


class MarketFeedRequest(BaseModel):
    """Live market-data request.

    ``tickers`` and ``metrics`` are typed and bounded rather than bare lists.
    A bare ``list`` accepts any element, and the feed client keys its memo on
    ``("multiples", ticker, date)`` — so ``{"tickers": [[]]}`` reached
    ``key in self.cache`` with an unhashable tuple and died there, answering a
    malformed request with a 500 instead of the 422 it is. The length cap is
    the other half: the multiples path fetches once per ticker, and the body
    limit alone would let one request queue hundreds of thousands of them.
    """

    kind: Literal["prices", "financials", "multiples"]
    ticker: str | None = None
    tickers: list[str] | None = Field(default=None, max_length=MAX_TICKERS)
    start: str | None = None
    end: str | None = None
    metrics: list[str] | None = Field(default=None, max_length=32)
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
            "/engine/v1/validate",
            "/engine/v1/compute",
            "/engine/v1/sensitivity",
            "/engine/v1/market-data",
            "/engine/v1/market-feed",
            "/engine/v1/volatility",
            "/engine/v1/wacc",
            "/engine/v1/projection",
            "/engine/v1/rollforward",
            "/engine/v1/qsbs",
            "/engine/v1/intangible",
            "/engine/v1/ppa",
            "/engine/v1/impairment",
            "/engine/v1/esop",
            "/engine/v1/smb",
            "/engine/v1/emi-csop",
            "/engine/v1/comparables",
            "/engine/v1/fair-value-820",
            "/engine/v1/gift-estate",
            "/engine/v1/ifrs2",
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


@app.post("/engine/v1/validate")
def engine_validate(request: ComputeRequest) -> dict:
    """Pre-flight: every problem with a payload at once, without computing.

    Lets the caller show an analyst the full list of blocking errors and
    review warnings — each with a dotted field path — before the compute →
    fix → compute loop starts.
    """
    errors, warnings = split_issues(
        validate_payload(
            request.params,
            request.inputs,
            recompute=request.recompute,
            prior_approaches=request.prior_approaches,
            auto_volatility=request.auto_volatility,
            auto_wacc=request.auto_wacc,
            auto_comparables=request.auto_comparables,
        )
    )
    return {
        "engine_version": ENGINE_VERSION,
        "ok": not errors,
        "errors": [i.as_dict() for i in errors],
        "warnings": [i.as_dict() for i in warnings],
    }


@app.post("/engine/v1/compute", response_model=None)
def engine_compute(request: ComputeRequest) -> JSONResponse | dict:
    # Pre-flight first: a payload with several problems reports all of them in
    # one round trip instead of one per attempt. The structured issues ride
    # alongside the string `detail` the client already understands.
    errors, warnings = split_issues(
        validate_payload(
            request.params,
            request.inputs,
            recompute=request.recompute,
            prior_approaches=request.prior_approaches,
            auto_volatility=request.auto_volatility,
            auto_wacc=request.auto_wacc,
            auto_comparables=request.auto_comparables,
        )
    )
    if errors:
        return error_response(
            422,
            _issue_summary(errors),
            issues=[i.as_dict() for i in errors],
            warnings=[i.as_dict() for i in warnings],
        )
    try:
        result = compute(
            request.params,
            request.inputs,
            recompute=request.recompute,
            prior_approaches=request.prior_approaches,
            auto_volatility=request.auto_volatility,
            auto_wacc=request.auto_wacc,
            auto_comparables=request.auto_comparables,
            trace=request.trace,
        )
    except EngineInputError as exc:
        # Validation missed it (autopilot-derived inputs, a deeper numeric
        # guard); the fail-fast message is still the truth.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    # Successful runs carry their review warnings so the caller can persist
    # them with the calculation and show a reviewer what to look at.
    result["warnings"] = [i.as_dict() for i in warnings]
    return result


def _issue_summary(errors: list) -> str:
    """One-line `detail` for clients that only read the string."""
    head = errors[0].message
    extra = len(errors) - 1
    return head if extra <= 0 else f"{head} (and {extra} more input problem{'s' if extra > 1 else ''})"


@app.post("/engine/v1/sensitivity")
def engine_sensitivity(request: SensitivityRequest) -> dict:
    """One-way + two-way sensitivity of the common FMV to the key assumptions."""
    try:
        return run_sensitivity(
            request.params,
            request.inputs,
            parameters=request.parameters,
            two_way=request.two_way,
            span=request.span,
            steps=request.steps,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/engine/v1/market-data")
def market_data_universe(live: bool | None = None) -> dict:
    """The comparable-company reference universe.

    Live where the market feed answered and the curated snapshot where it did
    not; ``provenance`` says which, and every row carries its own
    ``figures_source``/``figures_as_of`` pair.
    """
    resolution = resolve_universe(live=live)
    companies = market_universe(resolution.companies)
    return {
        "companies": companies,
        "count": len(companies),
        "provenance": resolution.provenance(),
    }


@app.post("/engine/v1/market-data")
def market_data(request: MarketDataRequest) -> dict:
    """Verify candidate tickers and return their SIC codes, market caps, and
    trading multiples so the comparable-company agent works from real figures."""
    resolution = resolve_universe(live=request.live)
    try:
        return {
            **market_lookup(request.tickers, companies=resolution.companies),
            "provenance": resolution.provenance(),
        }
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ── Standalone estimation engines (callable independently of /compute) ────────


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


@app.post("/engine/v1/fund-valuation")
def engine_fund_valuation(request: FundValuationRequest) -> dict:
    """ASC 820 fund NAV: mark each position, level it, and roll up (+ waterfall)."""
    try:
        return fund_valuation(
            {"positions": request.positions, "liabilities": request.liabilities, "lp_terms": request.lp_terms}
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/fund-waterfall")
def engine_fund_waterfall(request: FundWaterfallRequest) -> dict:
    """LP distribution waterfall (ROC, preferred return, catch-up, carry, clawback)."""
    try:
        return lp_waterfall(
            committed_capital=request.committed_capital,
            contributed_capital=request.contributed_capital,
            distributable=request.distributable,
            preferred_return_rate=request.preferred_return_rate,
            years=request.years,
            carry_pct=request.carry_pct,
            gp_catch_up=request.gp_catch_up,
            management_fees_paid=request.management_fees_paid,
            gp_distributions_to_date=request.gp_distributions_to_date,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/fund-calibrate")
def engine_fund_calibrate(request: FundCalibrateRequest) -> dict:
    """Backsolve the OPM implied volatility that reproduces the last round."""
    try:
        return calibrate_implied_volatility(
            round_price_per_share=request.round_price_per_share,
            total_equity_value=request.total_equity_value,
            strike=request.strike,
            time_to_exit_years=request.time_to_exit_years,
            risk_free_rate=request.risk_free_rate,
            preferred_shares=request.preferred_shares,
            fully_diluted_shares=request.fully_diluted_shares,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/fund-rollforward")
def engine_fund_rollforward(request: FundRollForwardRequest) -> dict:
    """Roll a prior position mark to a new measurement date."""
    try:
        return roll_forward_mark(
            prior_fair_value=request.prior_fair_value,
            method=request.method,
            index_return=request.index_return,
            accretion_rate=request.accretion_rate,
            periods=request.periods,
            new_calibrated_value=request.new_calibrated_value,
        )
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/debt-valuation")
def engine_debt_valuation(request: DebtValuationRequest) -> dict:
    """Fair-value a debt/credit instrument (bond, term loan, convertible, SAFE)."""
    try:
        return value_instrument(request.instrument_type, request.params)
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (KeyError, TypeError) as exc:  # missing/extra params from the dict
        raise HTTPException(status_code=422, detail=f"invalid debt params: {exc}") from exc


@app.post("/engine/v1/debt-rating-spread")
def engine_debt_rating_spread(request: RatingSpreadRequest) -> dict:
    """Implied credit spread (decimal) for a letter rating."""
    try:
        return {"rating": request.rating.upper(), "spread": rating_implied_spread(request.rating)}
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _engine_input_kwargs(fn, inputs: dict, label: str) -> dict:
    """Call an engine entry point on a free-form inputs dict, mapping the two
    failure shapes to 422: EngineInputError from the engine's own validation,
    TypeError from unexpected/missing keyword names."""
    try:
        return fn(**inputs)
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TypeError as exc:
        raise HTTPException(status_code=422, detail=f"invalid {label} inputs: {exc}") from exc


@app.post("/engine/v1/qsbs")
def engine_qsbs(request: QsbsRequest) -> dict:
    """IRC §1202 QSBS eligibility: per-test breakdown, exclusion %, gain cap."""
    return _engine_input_kwargs(qsbs_eligibility, request.inputs, "qsbs")


@app.post("/engine/v1/intangible")
def engine_intangible(request: IntangibleRequest) -> dict:
    """Value one intangible asset (RFR, MEEM, with/without, cost approach)."""
    try:
        return value_intangible(request.method, request.params)
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/ppa")
def engine_ppa(request: PpaRequest) -> dict:
    """ASC 805 purchase price allocation with goodwill as the residual."""
    return _engine_input_kwargs(purchase_price_allocation, request.inputs, "ppa")


@app.post("/engine/v1/impairment")
def engine_impairment(request: ImpairmentRequest) -> dict:
    """ASC 350/360 impairment tests (goodwill, indefinite-lived, long-lived)."""
    try:
        return run_impairment_test(request.test, request.params)
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/esop")
def engine_esop(request: EsopRequest) -> dict:
    """ESOP level-of-value chain, optionally with the repurchase obligation."""
    result = _engine_input_kwargs(esop_share_value, request.inputs, "esop")
    if request.repurchase is not None:
        repurchase_inputs = dict(request.repurchase)
        # The projection prices redemptions at the value this run concluded
        # unless the caller deliberately overrides it.
        repurchase_inputs.setdefault("fmv_per_share", result["fmv_per_share"])
        result["repurchase_obligation"] = _engine_input_kwargs(
            repurchase_obligation, repurchase_inputs, "repurchase"
        )
    return result


@app.post("/engine/v1/smb")
def engine_smb(request: SmbRequest) -> dict:
    """SMB fair market value (SDE, capitalization of earnings, multiples)."""
    return _engine_input_kwargs(smb_valuation, request.inputs, "smb")


@app.post("/engine/v1/emi-csop")
def engine_emi_csop(request: EmiCsopRequest) -> dict:
    """UK EMI/CSOP: UMV and AMV per share plus scheme qualification checks."""
    try:
        return emi_csop_valuation(request.scheme, request.params)
    except EngineInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/engine/v1/comparables")
def engine_comparables(request: ComparablesRequest) -> dict:
    """Screen and score guideline public companies, with multiple statistics."""
    return _engine_input_kwargs(comparable_analysis, request.inputs, "comparables")


@app.post("/engine/v1/fair-value-820")
def engine_fair_value_820(request: FairValue820Request) -> dict:
    """ASC 820 measurement: hierarchy levelling, NAV expedient, Level 3 rollforward."""
    return _engine_input_kwargs(fair_value_measurement, request.inputs, "fair-value-820")


@app.post("/engine/v1/gift-estate")
def engine_gift_estate(request: GiftEstateRequest) -> dict:
    """Gift & estate: pro rata → DLOC → DLOM → taxable gift, with Rev. Rul. 59-60 coverage."""
    return _engine_input_kwargs(gift_estate_valuation, request.inputs, "gift-estate")


@app.post("/engine/v1/ifrs2")
def engine_ifrs2(request: Ifrs2Request) -> dict:
    """IFRS 2 share-based payment: grant-date fair value, attribution, remeasurement."""
    return _engine_input_kwargs(ifrs2_valuation, request.inputs, "ifrs2")


@app.post("/engine/v1/market-feed")
def market_feed(request: MarketFeedRequest) -> dict:
    """Fetch live comparable data (prices/financials/multiples) via yfinance.

    Returns ``source == "fallback"`` with a warning when the live source is
    unavailable, so the pipeline degrades gracefully rather than failing."""
    kind = request.kind
    if kind == "prices":
        if not (request.ticker and request.start and request.end):
            raise HTTPException(status_code=422, detail="prices needs ticker, start, end")
        return default_client().get_historical_prices(
            request.ticker, request.start, request.end, fallback=request.fallback
        )
    if kind == "financials":
        if not request.ticker:
            raise HTTPException(status_code=422, detail="financials needs ticker")
        return default_client().get_company_financials(request.ticker, fallback=request.fallback)
    if kind == "multiples":
        if not request.tickers:
            raise HTTPException(status_code=422, detail="multiples needs tickers")
        return default_client().get_company_multiples(
            request.tickers, request.metrics, request.date, fallback=request.fallback
        )
    raise AssertionError(f"unreachable: kind={request.kind!r}")  # Pydantic Literal covers this
