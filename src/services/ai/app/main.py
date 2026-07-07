"""409.ai AI service — M1 pipelines (feature-gap P0 #2/#3).

Missing Data, Data Extraction and Public Comparables run through OpenRouter
free-tier models (OPENROUTER_API_KEY). The valuation service is the only
caller: it ships valuation context + params + base64 documents and persists
the result (with provenance) in ai_jobs.
"""

import os
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .openrouter import OpenRouterError, chat, configured_models
from .pipelines import PIPELINES

SERVICE = "ai"
VERSION = "0.2.0"
_started = time.monotonic()

app = FastAPI(title="n409-ai", version=VERSION)


class PipelineRequest(BaseModel):
    valuation: dict = Field(default_factory=dict)
    params: dict | None = None
    documents: list[dict] = Field(default_factory=list)
    # Prompt-registry override: {"system": str|None, "model": str|None}
    prompt: dict | None = None
    # Run options, e.g. {"anonymize": false} to skip the PII redaction step.
    options: dict = Field(default_factory=dict)


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
        "pipelines": sorted(PIPELINES),
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
    runner = PIPELINES.get(pipeline)
    if runner is None:
        raise HTTPException(status_code=404, detail=f"Unknown pipeline '{pipeline}'")
    try:
        model, result = runner(request.model_dump())
    except OpenRouterError as exc:
        # 503 → the valuation service records the job as failed and returns 502.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"Model output unusable: {exc}") from exc
    return PipelineResponse(model=model, result=result)
