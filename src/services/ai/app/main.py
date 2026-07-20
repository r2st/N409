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
from pydantic import BaseModel, ConfigDict, Field

from .agents import AGENT_PIPELINES
from .internal_auth import internal_token_middleware, warn_if_unset
from .limits import configure_threadpool, make_body_limit_middleware, max_body_bytes, threadpool_size
from .observability import configure_logging, make_request_context_middleware
from .openrouter import OpenRouterError, chat, configured_models, tokens_used
from .output_schema import validate_result
from .pipelines import PIPELINES

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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Sync handlers (LLM calls block up to 90s) run in this pool; make its size
    # a deliberate, tunable number rather than the implicit default (audit B-2 P2).
    configure_threadpool(threadpool_size())
    yield


app = FastAPI(title="n409-ai", version=VERSION, lifespan=lifespan)

# Middleware order (Starlette runs last-added first): request-context wraps
# everything so its access log captures 401/413 responses too.
# Shared-secret gate (audit B-1 P0): every non-health route requires the
# X-Internal-Token the valuation service injects. No-op until the secret is set.
app.middleware("http")(internal_token_middleware)
# Body-size cap (audit B-2 P2): reject oversized payloads before buffering.
app.middleware("http")(make_body_limit_middleware(_MAX_BODY_BYTES))
# Structured access logging + x-request-id propagation (audit B-2 P3).
app.middleware("http")(make_request_context_middleware(SERVICE))
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


class TestResponse(BaseModel):
    model: str
    content: str


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
def ready() -> dict:
    checks = {
        "openrouter_key": "configured" if os.environ.get("OPENROUTER_API_KEY") else "missing",
        "models": configured_models(),
        "tokens_used": tokens_used(),
    }
    return {"status": "ready", "checks": checks}


@app.get("/ai/v1/models")
def models() -> dict:
    """Model candidates for the Bot Prompts model picker (default chain first)."""
    return {"models": configured_models()}


@app.post("/ai/v1/test", response_model=TestResponse)
def test_prompt(request: TestRequest) -> TestResponse:
    """Dry-run a prompt (Bot Prompts 'test' button) — no persistence, no documents."""
    try:
        llm = chat(request.system, request.user, model=request.model)
    except OpenRouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return TestResponse(model=llm.model, content=llm.content)


@app.post("/ai/v1/pipelines/{pipeline}", response_model=PipelineResponse)
def run_pipeline(pipeline: str, request: PipelineRequest) -> PipelineResponse:
    runner = ALL_PIPELINES.get(pipeline)
    if runner is None:
        raise HTTPException(status_code=404, detail=f"Unknown pipeline '{pipeline}'")
    try:
        model, result = runner(request.model_dump())
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
