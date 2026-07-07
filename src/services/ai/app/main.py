"""409.ai AI service skeleton (issue #1).

M2 (#11-#15) adds the gateway, provider adapters, anonymization gate,
pipelines, and the prompt registry here. Per project direction, LLM calls go
through OpenRouter (free-tier models) — configured via OPENROUTER_API_KEY.
"""

import os
import time

from fastapi import FastAPI

SERVICE = "ai"
VERSION = "0.1.0"
_started = time.monotonic()

app = FastAPI(title="n409-ai", version=VERSION)


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
    # No hard dependencies yet; M2 adds provider/API-key checks.
    checks = {"openrouter_key": "configured" if os.environ.get("OPENROUTER_API_KEY") else "missing"}
    return {"status": "ready", "checks": checks}
