"""OpenRouter chat-completion client (M1 — feature-gap P0 #2/#3).

All LLM traffic goes through OpenRouter free-tier models per project
direction. The client is deliberately tiny: one call shape (JSON in, JSON
out), model fallback, and explicit errors the valuation service can surface.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODELS = [
    "openai/gpt-oss-20b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "mistralai/mistral-small-3.2-24b-instruct:free",
]
TIMEOUT_S = 90.0


class OpenRouterError(Exception):
    """Raised when every candidate model fails."""


@dataclass
class LlmResult:
    model: str
    content: str


def configured_models(preferred: str | None = None) -> list[str]:
    """Candidate models in fallback order; `preferred` (a per-prompt registry
    binding) outranks the env override, which outranks the defaults."""
    models = list(DEFAULT_MODELS)
    override = os.environ.get("OPENROUTER_MODEL")
    if override:
        models = [override, *[m for m in models if m != override]]
    if preferred:
        models = [preferred, *[m for m in models if m != preferred]]
    return models


def _headers() -> dict[str, str]:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise OpenRouterError("OPENROUTER_API_KEY is not configured")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        # OpenRouter attribution headers (optional but polite)
        "HTTP-Referer": "https://n409.internal",
        "X-Title": "N409 valuation platform",
    }


def chat(
    system: str, user: str, *, model: str | None = None, client: httpx.Client | None = None
) -> LlmResult:
    """Runs the prompt against the first model that answers.

    Free-tier models rate-limit aggressively; falling through the list keeps
    the pipelines usable without paid keys. `model` pins a preferred model
    (from the prompt registry) at the head of the fallback chain.
    """
    owns_client = client is None
    http = client or httpx.Client(timeout=TIMEOUT_S)
    errors: list[str] = []
    try:
        for candidate in configured_models(preferred=model):
            try:
                resp = http.post(
                    OPENROUTER_URL,
                    headers=_headers(),
                    json={
                        "model": candidate,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": user},
                        ],
                        "temperature": 0.1,
                    },
                )
            except httpx.HTTPError as exc:
                errors.append(f"{candidate}: {exc}")
                continue
            if resp.status_code != 200:
                errors.append(f"{candidate}: HTTP {resp.status_code} {resp.text[:200]}")
                continue
            data = resp.json()
            choices = data.get("choices") or []
            content = (choices[0].get("message") or {}).get("content") if choices else None
            if not content:
                errors.append(f"{candidate}: empty completion")
                continue
            return LlmResult(model=data.get("model", candidate), content=content)
        raise OpenRouterError("All models failed: " + " | ".join(errors))
    finally:
        if owns_client:
            http.close()


def extract_json(content: str) -> dict | list:
    """Pulls the first JSON object/array out of a completion.

    Free models love to wrap JSON in markdown fences or prose; be forgiving.
    """
    fenced = re.search(r"```(?:json)?\s*(.+?)```", content, re.DOTALL)
    candidate = fenced.group(1).strip() if fenced else content.strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass
    # Last resort: widest brace/bracket span.
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start = candidate.find(open_ch)
        end = candidate.rfind(close_ch)
        if start != -1 and end > start:
            try:
                return json.loads(candidate[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError(f"Model returned no parseable JSON: {content[:200]!r}")
