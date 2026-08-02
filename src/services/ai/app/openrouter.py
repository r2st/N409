"""OpenRouter chat-completion client (M1 — feature-gap P0 #2/#3).

All LLM traffic goes through OpenRouter free-tier models per project
direction. The client is deliberately tiny: one call shape (JSON in, JSON
out), model fallback, and explicit errors the valuation service can surface.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# Key introspection endpoint. Cheapest possible live proof that the configured
# key is real: no model is invoked, so it costs nothing and burns no quota.
OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"
# Every OpenRouter key carries this prefix. A key that doesn't is a copy/paste
# of some *other* provider's secret — catch it before spending a round trip.
KEY_PREFIX = "sk-or-"
KEY_CHECK_TIMEOUT_S = 10.0
# /ready is polled by systemd/uptime checks; re-probing OpenRouter on every hit
# would be both slow and rude. A minute of staleness is fine for readiness.
KEY_CHECK_TTL_S = 60.0
DEFAULT_MODELS = [
    "openai/gpt-oss-20b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "mistralai/mistral-small-3.2-24b-instruct:free",
]
TIMEOUT_S = 90.0
# Transient-failure retry policy (P2-8). A connect/transport error or a 5xx from
# OpenRouter is usually momentary, so retry the same model a couple of times with
# exponential backoff before falling through to the next candidate. 4xx (including
# 429 rate-limits) are not retried here — model fallback already handles those.
MAX_RETRIES = 2
RETRY_BACKOFF_BASE_S = 0.5
# httpx transport-layer failures (connect refused, DNS, timeouts, dropped
# sockets) all derive from TransportError — treat them as retryable "connect errors".
_RETRYABLE_HTTP_EXC = (httpx.TransportError,)
# Per-call output ceiling (audit B-2 P2). Free tiers cap exposure today, but a
# paid key + a runaway loop is uncapped without this. Override OPENROUTER_MAX_TOKENS.
DEFAULT_MAX_TOKENS = 2000

_log = logging.getLogger("openrouter")


class OpenRouterError(Exception):
    """Raised when every candidate model fails."""


class TokenBudgetExceeded(OpenRouterError):
    """Raised when the process-wide token budget is exhausted."""


@dataclass
class LlmResult:
    model: str
    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


def max_output_tokens() -> int:
    raw = os.environ.get("OPENROUTER_MAX_TOKENS")
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return DEFAULT_MAX_TOKENS


class _TokenBudget:
    """Best-effort, process-lifetime token accounting + optional hard cap.

    OPENROUTER_TOKEN_BUDGET (total tokens) guards against a runaway/abusive loop
    once a paid key is configured; 0/unset means unlimited. This is in-process
    (not cluster-wide) — a coarse safety net, not billing.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._used = 0

    @staticmethod
    def _cap() -> int:
        raw = os.environ.get("OPENROUTER_TOKEN_BUDGET")
        try:
            return max(0, int(raw)) if raw else 0
        except ValueError:
            return 0

    def check(self) -> None:
        cap = self._cap()
        if cap and self._used >= cap:
            raise TokenBudgetExceeded(
                f"OpenRouter token budget exhausted ({self._used}/{cap})"
            )

    def add(self, tokens: int) -> int:
        with self._lock:
            self._used += max(0, tokens)
            return self._used

    @property
    def used(self) -> int:
        return self._used


_budget = _TokenBudget()


def tokens_used() -> int:
    """Cumulative tokens consumed by this process (surfaced on /ready)."""
    return _budget.used


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


# ── API-key verification ─────────────────────────────────────────────────────
#
# A non-empty OPENROUTER_API_KEY used to be the whole readiness story, so a
# revoked, truncated or wrong-provider key read as "configured" and /ready
# returned 200 — the service only failed once a real valuation reached it, as a
# 503 in front of a paying customer. Boot and /ready now prove the key instead
# of assuming it: prefix check first (free), then one live introspection call.


@dataclass(frozen=True)
class KeyStatus:
    """Outcome of verifying OPENROUTER_API_KEY.

    ``state`` is one of:
      ``valid``       — OpenRouter accepted the key.
      ``missing``     — OPENROUTER_API_KEY is unset/empty.
      ``malformed``   — set, but not an OpenRouter key (wrong prefix).
      ``invalid``     — OpenRouter rejected it (revoked, typo'd, disabled).
      ``unreachable`` — OpenRouter could not be asked. The key may be fine, but
                        nothing this service does will work until it answers,
                        so readiness treats it as not-ready either way.
    """

    state: str
    detail: str

    @property
    def ok(self) -> bool:
        return self.state == "valid"


_key_lock = threading.Lock()
# (key, checked_at_monotonic, status) for the most recently verified key.
_key_cache: tuple[str, float, KeyStatus] | None = None


def reset_key_cache() -> None:
    """Drop the cached verification (used by tests and by boot's forced check)."""
    global _key_cache
    with _key_lock:
        _key_cache = None


def _cached_key_status(key: str) -> KeyStatus | None:
    with _key_lock:
        if (
            _key_cache is not None
            and _key_cache[0] == key
            and time.monotonic() - _key_cache[1] < KEY_CHECK_TTL_S
        ):
            return _key_cache[2]
    return None


def _cache_key_status(key: str, status: KeyStatus) -> None:
    global _key_cache
    with _key_lock:
        _key_cache = (key, time.monotonic(), status)


def _probe_key(key: str, client: httpx.Client | None = None) -> KeyStatus:
    """One cheap live call to OpenRouter's key-introspection endpoint."""
    owns_client = client is None
    http = client or httpx.Client(timeout=KEY_CHECK_TIMEOUT_S)
    try:
        try:
            resp = http.get(OPENROUTER_KEY_URL, headers={"Authorization": f"Bearer {key}"})
        except httpx.HTTPError as exc:
            return KeyStatus("unreachable", f"could not reach OpenRouter: {exc}")
        if resp.status_code in (401, 403):
            return KeyStatus(
                "invalid",
                f"OpenRouter rejected OPENROUTER_API_KEY (HTTP {resp.status_code})",
            )
        if resp.status_code != 200:
            return KeyStatus(
                "unreachable",
                f"unexpected HTTP {resp.status_code} from OpenRouter key endpoint",
            )
        try:
            body = resp.json()
        except ValueError:
            body = None
        # A 200 from the key endpoint is proof enough that the key works; the
        # body is only read for a nicer label. Anything unexpected in it —
        # non-JSON, or JSON that isn't the documented object — must not turn a
        # successful probe into an exception, because this runs on /ready and
        # an exception there is a 500 where the honest answer is "key valid".
        data = body.get("data") if isinstance(body, dict) else None
        label = (data.get("label") if isinstance(data, dict) else None) or "unlabelled"
        return KeyStatus("valid", f"OpenRouter accepted key '{label}'")
    finally:
        if owns_client:
            http.close()


def verify_api_key(
    *, client: httpx.Client | None = None, force: bool = False
) -> KeyStatus:
    """Verify OPENROUTER_API_KEY, memoising the live result for KEY_CHECK_TTL_S.

    ``force`` skips the cache (boot always wants a fresh answer).
    """
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        return KeyStatus("missing", "OPENROUTER_API_KEY is not set")
    if not key.startswith(KEY_PREFIX):
        return KeyStatus(
            "malformed",
            f"OPENROUTER_API_KEY does not start with '{KEY_PREFIX}' — "
            "that is not an OpenRouter key",
        )
    if not force:
        cached = _cached_key_status(key)
        if cached is not None:
            return cached
    status = _probe_key(key, client)
    _cache_key_status(key, status)
    return status


def _backoff_sleep(attempt: int) -> None:
    """Exponential backoff between retries (attempt is 0-indexed)."""
    time.sleep(RETRY_BACKOFF_BASE_S * (2**attempt))


def _post_once(
    http: httpx.Client, candidate: str, system: str, user: str
) -> httpx.Response:
    return http.post(
        OPENROUTER_URL,
        headers=_headers(),
        json={
            "model": candidate,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.1,
            # Cap output so a runaway completion can't burn the key.
            "max_tokens": max_output_tokens(),
        },
    )


def _post_with_retry(
    http: httpx.Client, candidate: str, system: str, user: str
) -> httpx.Response:
    """POST to one model, retrying transient failures (connect errors / 5xx).

    Returns the final response (which may still be a non-200 the caller must
    handle) or raises the last transport error after exhausting retries.
    """
    last_exc: httpx.HTTPError | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = _post_once(http, candidate, system, user)
        except _RETRYABLE_HTTP_EXC as exc:
            last_exc = exc
            if attempt < MAX_RETRIES:
                _log.warning(
                    "llm connect error, retrying",
                    extra={"event": "llm_retry", "path": candidate, "status": attempt},
                )
                _backoff_sleep(attempt)
                continue
            raise
        if resp.status_code >= 500 and attempt < MAX_RETRIES:
            _log.warning(
                "llm 5xx, retrying",
                extra={"event": "llm_retry", "path": candidate, "status": resp.status_code},
            )
            _backoff_sleep(attempt)
            continue
        return resp
    # Unreachable: the loop either returns a response or raises, but satisfy typing.
    raise last_exc if last_exc else OpenRouterError(f"{candidate}: retries exhausted")


def _completion_text(data: dict) -> str:
    """The assistant text out of a chat-completions body, or "" if it isn't there.

    Every level here is model-controlled, so none of it is assumed: `choices`
    may be absent or not a list, its first entry may not be an object, and
    `message.content` may be missing or a non-string. A "" return means "this
    candidate did not answer", which the caller already knows how to handle.
    """
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    return content if isinstance(content, str) else ""


def _token_count(value: object) -> int:
    """A usage counter as a non-negative int; 0 when the field is unusable."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return 0
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


def chat(
    system: str, user: str, *, model: str | None = None, client: httpx.Client | None = None
) -> LlmResult:
    """Runs the prompt against the first model that answers.

    Free-tier models rate-limit aggressively; falling through the list keeps
    the pipelines usable without paid keys. `model` pins a preferred model
    (from the prompt registry) at the head of the fallback chain.
    """
    # Fail fast before spending anything if the budget is already exhausted.
    _budget.check()
    owns_client = client is None
    http = client or httpx.Client(timeout=TIMEOUT_S)
    errors: list[str] = []
    try:
        for candidate in configured_models(preferred=model):
            try:
                resp = _post_with_retry(http, candidate, system, user)
            except httpx.HTTPError as exc:
                errors.append(f"{candidate}: {exc}")
                continue
            if resp.status_code != 200:
                errors.append(f"{candidate}: HTTP {resp.status_code} {resp.text[:200]}")
                continue
            # Everything from here down is one candidate's *answer*, and an
            # unusable answer is this loop's whole reason to exist: record why
            # and let the next model try. Before this guard a 200 carrying a
            # proxy's HTML error page raised JSONDecodeError, and a body that
            # was valid JSON of the wrong shape raised AttributeError — neither
            # an OpenRouterError, so both escaped `chat` entirely and skipped
            # the remaining healthy candidates instead of falling through to
            # them. Callers catch OpenRouterError; an escape is a 500.
            try:
                data = resp.json()
            except ValueError as exc:
                errors.append(f"{candidate}: non-JSON body ({exc})")
                continue
            if not isinstance(data, dict):
                errors.append(f"{candidate}: non-object body ({type(data).__name__})")
                continue
            content = _completion_text(data)
            if not content:
                errors.append(f"{candidate}: empty completion")
                continue
            usage = data.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            # A completion already succeeded; junk in the accounting fields must
            # not discard it. `int()` on a non-numeric raises, so coerce softly.
            prompt_tokens = _token_count(usage.get("prompt_tokens"))
            completion_tokens = _token_count(usage.get("completion_tokens"))
            self_total = prompt_tokens + completion_tokens
            cumulative = _budget.add(self_total)
            # `model` is echoed by the provider and lands in job records and
            # audit trails; fall back to the candidate we asked for unless it
            # comes back as an actual string.
            served_by = data.get("model")
            served_by = served_by if isinstance(served_by, str) and served_by else candidate
            _log.info(
                "llm usage",
                extra={
                    "event": "llm_usage",
                    "path": served_by,
                    "status": self_total,
                    "duration_ms": cumulative,
                },
            )
            return LlmResult(
                model=served_by,
                content=content,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )
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
