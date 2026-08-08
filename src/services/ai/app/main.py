"""409.ai AI service — M1 pipelines (feature-gap P0 #2/#3).

Missing Data, Data Extraction and Public Comparables run through OpenRouter
free-tier models (OPENROUTER_API_KEY). The valuation service is the only
caller: it ships valuation context + params + base64 documents and persists
the result (with provenance) in ai_jobs.
"""

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .agents import AGENT_PIPELINES
from .anonymize import AnonymizeInputError, Redactor
from .errors import install_error_handlers, make_unhandled_error_middleware
from .internal_auth import internal_token_middleware, warn_if_unset
from .limits import configure_threadpool, make_body_limit_middleware, max_body_bytes, threadpool_size
from .observability import configure_logging, make_request_context_middleware
from .openrouter import (
    OpenRouterError,
    chat,
    configured_models,
    tokens_used,
    verify_api_key,
)
from .output_schema import validate_result
from .perplexity import (
    ConfidentialityError,
    PerplexityError,
    RECENCY_FILTERS,
)
from .perplexity import is_configured as perplexity_configured
from .perplexity import research as perplexity_research
from .perplexity import verify_api_key as verify_perplexity_key
from .pipelines import PIPELINES
from .ratelimit import limit_per_minute, make_rate_limit_middleware

# The built-in M1 pipelines plus the analyst agents share one dispatch table
# and one route contract.
ALL_PIPELINES = {**PIPELINES, **AGENT_PIPELINES}

SERVICE = "ai"
VERSION = "0.2.0"
_started = time.monotonic()

# Documents arrive as base64 blobs; default the body cap generously (32 MB)
# but keep it bounded so an oversized `documents` array can't OOM the process.
_MAX_BODY_BYTES = max_body_bytes(32 * 1024 * 1024)

configure_logging(SERVICE)
_log = logging.getLogger(SERVICE)


def require_verified_key() -> bool:
    """Whether a bad OPENROUTER_API_KEY should abort startup outright.

    Off by default so a momentary OpenRouter outage can't stop the service from
    booting (it degrades instead: loud error log + /ready 503). Set
    AI_REQUIRE_OPENROUTER_KEY=1 in environments that would rather crash-loop
    than run without a working key.
    """
    return os.environ.get("AI_REQUIRE_OPENROUTER_KEY", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Sync handlers (LLM calls block up to 90s) run in this pool; make its size
    # a deliberate, tunable number rather than the implicit default (audit B-2 P2).
    configure_threadpool(threadpool_size())

    # Prove the key at boot rather than discovering it's dead on the first
    # customer valuation. Never silent: either we crash, or we log an error and
    # /ready reports 503 for as long as the key stays bad.
    status = verify_api_key(force=True)
    if status.ok:
        _log.info(
            "openrouter key verified",
            extra={"event": "openrouter_key", "status": status.state},
        )
    else:
        _log.error(
            "openrouter key check failed: %s",
            status.detail,
            extra={"event": "openrouter_key", "status": status.state},
        )
        if require_verified_key():
            raise RuntimeError(f"OpenRouter API key unusable: {status.detail}")
    yield


app = FastAPI(title="n409-ai", version=VERSION, lifespan=lifespan)

# Middleware order (Starlette runs last-added first): request-context wraps
# everything so its access log captures 401/413 responses too.
# Shared-secret gate (audit B-1 P0): every non-health route requires the
# X-Internal-Token the valuation service injects. No-op until the secret is set.
app.middleware("http")(internal_token_middleware)
# Body-size cap (audit B-2 P2): reject oversized payloads before buffering.
app.middleware("http")(make_body_limit_middleware(_MAX_BODY_BYTES))
# Per-caller request ceiling. Lower than the engine's: every pipeline here
# blocks on an LLM for up to 90 seconds and costs tokens, so a loop is both
# slower to notice and more expensive than a runaway compute. Outside the
# token gate on purpose, so guessing at the shared secret is throttled too.
app.middleware("http")(make_rate_limit_middleware(limit_per_minute(240)))
# Last-resort 500 envelope. Inside request-context (so the request id is bound
# when it logs) and outside everything else (so it catches their failures too).
app.middleware("http")(make_unhandled_error_middleware(SERVICE))
# Structured access logging + x-request-id propagation (audit B-2 P3).
app.middleware("http")(make_request_context_middleware(SERVICE))
# Put the request id on the deliberate failures as well, so every error
# response this service can emit is traceable to a log line.
install_error_handlers(app)
warn_if_unset()


class PipelineRequest(BaseModel):
    # Agents accept assorted context blocks (comp_context, company_profile,
    # comparables, methodology, prior_valuation, new_data, ...); allow extra
    # top-level keys through to the runner rather than enumerate every one.
    model_config = ConfigDict(extra="allow")

    valuation: dict = Field(default_factory=dict)
    params: dict | None = None
    documents: list[dict] = Field(default_factory=list)
    # Prompt-registry override: {"system": str|None, "model": str|None}
    prompt: dict | None = None
    # Run options, e.g. {"anonymize": false} to skip the PII redaction step.
    options: dict = Field(default_factory=dict)
    # 'qa'/'explain' context: the calculation under review and the valuation
    # service's deterministic check results.
    calculation: dict | None = None
    qa_checks: list[dict] = Field(default_factory=list)


class PipelineResponse(BaseModel):
    model: str
    result: dict


class TestRequest(BaseModel):
    system: str
    user: str
    model: str | None = None
    # Same escape hatch the pipelines expose, and ignored in production for the
    # same reason. Nested under `options` so one shape means one thing across
    # both routes.
    options: dict = Field(default_factory=dict)


class ResearchRequest(BaseModel):
    """A question about the *public* record — see `perplexity`'s docstring.

    There is deliberately no `documents`, no `valuation` and no `options`
    block: this route does not take client context, because everything it is
    handed goes to a live web search. A caller that wants a document
    summarised wants `/ai/v1/pipelines/...`, which redacts.
    """

    query: str = Field(min_length=1, max_length=4000)
    system: str | None = Field(default=None, max_length=4000)
    model: str | None = None
    # Bound the search to recent sources — a multiple from 2019 is worse than
    # no multiple when the question is what a sector trades at today.
    recency: str | None = None
    # Restrict to trusted publishers (SEC, exchanges, a firm's own sources).
    domains: list[str] = Field(default_factory=list, max_length=10)


class ResearchResponse(BaseModel):
    model: str
    content: str
    citations: list[dict]
    # False when Sonar answered without retrieving anything. The caller must
    # not quote an ungrounded answer in a report — see `ResearchResult.grounded`.
    grounded: bool
    tokens: int


class TestResponse(BaseModel):
    model: str
    content: str
    anonymization: dict = Field(default_factory=dict)


@app.get("/")
def root() -> dict:
    return {
        "service": SERVICE,
        "version": VERSION,
        "status": "ok",
        "pipelines": sorted(ALL_PIPELINES),
        "endpoints": [
            "/health",
            "/ready",
            "/docs",
            "/ai/v1/pipelines/{pipeline}",
            "/ai/v1/test",
            "/ai/v1/models",
            "/ai/v1/research",
        ],
    }


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": SERVICE,
        "version": VERSION,
        "uptime_s": int(time.monotonic() - _started),
    }


@app.get("/ready")
def ready() -> JSONResponse:
    """Readiness = the key actually works, not merely that a string is set.

    Result is memoised for KEY_CHECK_TTL_S inside verify_api_key, so frequent
    probes cost nothing. Anything other than `valid` is a 503: without a working
    key every pipeline this service exposes returns 503 anyway.
    """
    key = verify_api_key()
    checks = {
        "openrouter_key": key.state,
        "openrouter_key_detail": key.detail,
        "models": configured_models(),
        "tokens_used": tokens_used(),
    }
    # Perplexity is reported but does not gate readiness. It powers optional
    # web-grounded research; every pipeline this service exposes works without
    # it, so a lapsed research key must not take the valuation path down with
    # it. Unconfigured is therefore silent, and configured-but-broken is loud
    # in the body without being fatal — the state is here precisely so an
    # operator can see it before someone reports missing citations.
    if perplexity_configured():
        pplx = verify_perplexity_key()
        checks["perplexity_key"] = pplx.state
        checks["perplexity_key_detail"] = pplx.detail
    return JSONResponse(
        status_code=200 if key.ok else 503,
        content={"status": "ready" if key.ok else "unavailable", "checks": checks},
    )


@app.get("/ai/v1/models")
def models() -> dict:
    """Model candidates for the Bot Prompts model picker (default chain first)."""
    return {"models": configured_models()}


@app.post("/ai/v1/research", response_model=ResearchResponse)
def research(request: ResearchRequest) -> ResearchResponse:
    """Web-grounded research with citations (Perplexity Sonar).

    Separate from the pipelines because it is the one route whose whole purpose
    is to send its input *outward* to a search engine. The pipelines redact so
    the subject of a 409A never leaves the trust boundary; this route has no
    client context to redact, and refuses anything bearing the redactor's
    placeholders — which would mean client text had been routed here through
    some path nobody intended.

    503 when the provider is unavailable or unconfigured, matching what the
    valuation service already does with an OpenRouterError. 422 for the
    confidentiality refusal, because that is a caller bug with a fixable
    request, not a provider outage to retry.
    """
    if not perplexity_configured():
        raise HTTPException(
            status_code=503,
            detail="PERPLEXITY_API_KEY is not configured — web-grounded research unavailable",
        )
    if request.recency is not None and request.recency not in RECENCY_FILTERS:
        raise HTTPException(
            status_code=422,
            detail=f"recency must be one of {list(RECENCY_FILTERS)}",
        )
    kwargs: dict = {
        "model": request.model,
        "recency": request.recency,
        "domains": request.domains or None,
    }
    if request.system:
        kwargs["system"] = request.system
    try:
        result = perplexity_research(request.query, **kwargs)
    except ConfidentialityError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except PerplexityError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return ResearchResponse(**result.as_dict())


@app.post("/ai/v1/test", response_model=TestResponse)
def test_prompt(request: TestRequest) -> TestResponse:
    """Dry-run a prompt (Bot Prompts 'test' button) — no persistence, no documents.

    Redacted like any other prompt. "No documents" is not the same as no client
    data: the point of the box is to iterate on prompt wording against input
    that behaves like the real thing, so what ops pastes into it *is* a chunk of
    somebody's cap table or a founder's business overview. This was the one
    route left that reached OpenRouter without passing anything through the
    redactor, and being ad-hoc and unpersisted made it the one nothing recorded
    either.

    Without the subject company on the request there is no known-entity list, so
    only the regex layer applies here — emails, phones, SSN/EIN, addresses,
    honorific-led names. The report says what was struck rather than merely that
    redaction ran, because an operator tuning prompt wording has to be able to
    tell "the model handled this badly" from "the model never saw it".
    """
    try:
        red = Redactor.for_request(request.options)
        llm = chat(red.text(request.system), red.text(request.user), model=request.model)
    except AnonymizeInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OpenRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return TestResponse(model=llm.model, content=llm.content, anonymization=red.report())


@app.post("/ai/v1/pipelines/{pipeline}", response_model=PipelineResponse)
def run_pipeline(pipeline: str, request: PipelineRequest) -> PipelineResponse:
    runner = ALL_PIPELINES.get(pipeline)
    if runner is None:
        raise HTTPException(status_code=404, detail=f"Unknown pipeline '{pipeline}'")
    try:
        model, result = runner(request.model_dump())
    except AnonymizeInputError as exc:
        # An input problem, not a model problem — 422 names the field to fix.
        # Must precede the ValueError arm below, which reads as "the model said
        # something unusable" and would mislabel this one.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OpenRouterError as exc:
        # 503 → the valuation service records the job as failed and returns 502.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"Model output unusable: {exc}") from exc
    # Non-fatal output-shape check (audit B-2 P3): surface contract drift.
    issues = validate_result(pipeline, result)
    if issues:
        logging.getLogger(SERVICE).warning(
            "pipeline output failed shape validation",
            extra={"event": "output_schema", "path": pipeline, "status": "; ".join(issues)},
        )
    return PipelineResponse(model=model, result=result)
