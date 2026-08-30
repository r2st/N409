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

from .http_client import new_client
from .llm_http import (
    DEFAULT_RETRY_AFTER_S,
    MAX_RETRIES,
    MAX_RETRY_AFTER_S,
    MIN_ATTEMPT_S,
    RETRY_BACKOFF_BASE_S,
    SUPPRESSED_FINISH_REASONS,
    TIMEOUT_S,
    TRUNCATED_FINISH_REASONS,
    BudgetExhausted as _BudgetExhausted,
    Deadline as _Deadline,
    DeadlineExceeded as _BaseDeadlineExceeded,
    TokenLedger,
    backoff_sleep as _backoff_sleep,
    clamp_wait as _clamp_wait_shared,
    estimate_tokens as _estimate_tokens,
    finish_reason as _read_finish_reason,
    retry_after_seconds as _read_retry_after,
    token_count as _token_count,
)

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
# Checked against OpenRouter's live model list on 2026-08-08. The two entries
# that used to sit below gpt-oss (llama-3.3-70b-instruct, mistral-small-3.2-24b)
# had stopped being offered on the free tier and answered every request 404, so
# the "fallback chain" was one working model wearing two dead round trips —
# a failure that costs latency on every call and only shows up as a slow day.
# Re-check this list when a free tier changes; `/ai/v1/models` serves it to the
# prompt picker, so a dead id here becomes a dead option in the UI too.
DEFAULT_MODELS = [
    "openai/gpt-oss-20b:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3-nano-30b-a3b:free",
]
# TIMEOUT_S, MAX_RETRIES, RETRY_BACKOFF_BASE_S, MIN_ATTEMPT_S and the whole-call
# deadline live in `llm_http` — the retry-and-wall-clock discipline is the same
# argument for every provider, and it is imported above rather than restated so
# a second provider cannot bound itself slightly differently.
DEFAULT_CALL_BUDGET_S = 150.0
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


# ── Why every model failed ───────────────────────────────────────────────────
#
# `chat` used to answer one way for every failure: OpenRouterError, which
# `main` turns into a 503. That is right for an outage and wrong for everything
# else, and "everything else" is what actually happens here daily. The free
# tier caps requests *per key*, so an exhausted quota 429s every candidate in
# the chain; a prompt larger than a model's context is a 400 that will be a 400
# forever; a retired free model id is a 404. All three arrived as
# "503 — All models failed", which the valuation service reads as a transient
# upstream and therefore *retries* (a second full chain, billed again) before
# counting the failure toward a circuit breaker that, five failures in, denies
# AI to every other engagement on the platform.
#
# So the failures that no retry can fix say so, in their own type. The base
# class is unchanged, which is what keeps every `except OpenRouterError` in the
# agents and the research fallback working exactly as before.


class RateLimited(OpenRouterError):
    """Every candidate refused with 429 — the key's allowance, not an outage.

    `retry_after_s` is the provider's own answer to "when, then" when it gave
    one, so the refusal can carry a `retry-after` the whole way out to the
    client instead of being re-guessed at each hop.
    """

    def __init__(self, message: str, retry_after_s: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class AuthenticationFailed(OpenRouterError):
    """OpenRouter rejected the key itself (401/403).

    Not separated in order to be handled differently — a service whose key is
    revoked *is* unavailable, and 503 stays the honest status. It is separated
    so the log and the readiness detail can say which of the two 503s this is,
    because one needs an operator and the other needs patience.
    """


class RequestRejected(OpenRouterError):
    """A 4xx that no retry and no other candidate can turn into an answer.

    Context length exceeded (400/413), an unknown or retired model id (404):
    the request as built cannot be served, and the fix is in the request.
    """

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class LlmResult:
    model: str
    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    #: Why the model stopped, verbatim, or None when it did not say.
    finish_reason: str | None = None

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def truncated(self) -> bool:
        """True when the answer was cut off at the output cap.

        A truncated completion is a *partial success*, and partial successes
        were the failure mode this property exists to end: the caller got a
        200, some text, and no way to tell that the rest of the sentence — or
        the rest of the JSON — was never written. `pipelines._safe_result`
        turned the unparseable remains into an empty result set and the job
        was recorded as having succeeded.
        """
        return self.finish_reason in TRUNCATED_FINISH_REASONS

    @property
    def suppressed(self) -> bool:
        """True when the provider withheld the answer rather than the model finishing it.

        The twin of `truncated`, and it arrives looking even more like a
        success: a content filter returns the fragment written before it
        tripped, and a Bedrock guardrail returns its own message in place of
        the model's. Either way the text in `content` is not what was asked
        for, and nothing downstream can tell — which is the whole argument
        `truncated` was added on.
        """
        return self.finish_reason in SUPPRESSED_FINISH_REASONS


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


#: This provider's share of the process's spend, and its own ceiling.
#: `TokenLedger` lives in `llm_http` because Bedrock needs one too and had none —
#: see the note there.
_budget = TokenLedger("OPENROUTER_TOKEN_BUDGET")


def _check_budget() -> None:
    """Refuse before spending anything when the ceiling is already reached."""
    try:
        _budget.check()
    except _BudgetExhausted as exc:
        raise TokenBudgetExceeded(str(exc)) from exc


def tokens_used() -> int:
    """Cumulative OpenRouter tokens consumed by this process (on /ready)."""
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
    http = client or new_client(timeout=KEY_CHECK_TIMEOUT_S)
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


def call_budget_s() -> float:
    """Wall-clock ceiling for one `chat` (OPENROUTER_CALL_BUDGET_S); 0 disables."""
    raw = os.environ.get("OPENROUTER_CALL_BUDGET_S")
    if raw:
        try:
            value = float(raw)
            if value >= 0:
                return value
        except ValueError:
            pass
    return DEFAULT_CALL_BUDGET_S


class DeadlineExceeded(OpenRouterError, _BaseDeadlineExceeded):
    """Raised when the whole-call budget ran out before any model answered.

    Both bases on purpose: callers here catch `OpenRouterError`, and the shared
    `Deadline` in `llm_http` raises the provider-agnostic one.
    """


def _post_once(
    http: httpx.Client, candidate: str, system: str, user: str, timeout: float
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
        timeout=timeout,
    )


def _post_with_retry(
    http: httpx.Client, candidate: str, system: str, user: str, deadline: _Deadline
) -> httpx.Response:
    """POST to one model, retrying transient failures (connect errors / 5xx).

    Returns the final response (which may still be a non-200 the caller must
    handle) or raises the last transport error after exhausting retries.

    Every attempt is given what is left of the call's budget rather than a fresh
    TIMEOUT_S, and a retry that the budget cannot pay for is not taken — so the
    retries multiply against one ceiling instead of against each other.
    """
    last_exc: httpx.HTTPError | None = None
    for attempt in range(MAX_RETRIES + 1):
        if deadline.expired():
            raise last_exc if last_exc else DeadlineExceeded(f"{candidate}: call budget exhausted")
        try:
            resp = _post_once(http, candidate, system, user, deadline.attempt_timeout())
        except _RETRYABLE_HTTP_EXC as exc:
            last_exc = exc
            if attempt < MAX_RETRIES and _backoff_sleep(attempt, deadline):
                _log.warning(
                    "llm connect error, retrying",
                    extra={"event": "llm_retry", "model": candidate, "attempt": attempt},
                )
                continue
            raise
        if resp.status_code >= 500 and attempt < MAX_RETRIES and _backoff_sleep(attempt, deadline):
            _log.warning(
                "llm 5xx, retrying",
                extra={
                    "event": "llm_retry",
                    "model": candidate,
                    "attempt": attempt,
                    "status": resp.status_code,
                },
            )
            continue
        return resp
    # Unreachable: the loop either returns a response or raises, but satisfy typing.
    raise last_exc if last_exc else OpenRouterError(f"{candidate}: retries exhausted")


# The retry-after ceiling, the default, and the header reader itself live in
# `llm_http`: a provider that refuses with 429 says when it will serve us again
# in one of three spellings, and that is not an OpenRouter fact. Re-exported
# here under the names this module has always used so `main` and the tests keep
# importing them from one place.
# CHARS_PER_TOKEN and the estimate that uses it are shared the same way.
_retry_after_seconds = _read_retry_after
_clamp_wait = _clamp_wait_shared


def _finish_reason(data: dict) -> str | None:
    """Why the model stopped, if it said. Shared with the other providers —
    every level is model-controlled, so `llm_http` assumes none of it."""
    return _read_finish_reason(data)


def _classify(
    errors: list[str], statuses: list[int | None], retry_after_s: float | None = None
) -> OpenRouterError:
    """The exception that says *why* the whole chain failed.

    `statuses` has one entry per candidate the loop got to, `None` where that
    candidate never produced a status at all (a refused connection, a spent
    budget, a 200 carrying nothing usable). The rules read off that:

    * A 401/403 anywhere is the key, and the key is the same for every
      candidate — no fallback was ever going to help.
    * Otherwise a verdict is only drawn when *every* candidate answered, and
      answered 4xx. A chain where one model 429'd and another was unreachable
      is not "rate limited"; it is a bad afternoon, and the generic error is
      the honest one.
    * All-429 is the quota. Any other all-4xx mix is a request the provider
      will not serve however many times it is sent.
    """
    joined = "All models failed: " + " | ".join(errors)
    if any(status in (401, 403) for status in statuses):
        return AuthenticationFailed(joined)
    if not statuses or any(status is None for status in statuses):
        return OpenRouterError(joined)
    if not all(400 <= status < 500 for status in statuses):  # type: ignore[operator]
        return OpenRouterError(joined)
    if all(status == 429 for status in statuses):
        return RateLimited(joined, retry_after_s or DEFAULT_RETRY_AFTER_S)
    return RequestRejected(joined, next((s for s in statuses if s != 429), None))


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


def chat(
    system: str, user: str, *, model: str | None = None, client: httpx.Client | None = None
) -> LlmResult:
    """Runs the prompt against the first model that answers.

    Free-tier models rate-limit aggressively; falling through the list keeps
    the pipelines usable without paid keys. `model` pins a preferred model
    (from the prompt registry) at the head of the fallback chain.
    """
    # Fail fast before spending anything if the budget is already exhausted.
    _check_budget()
    owns_client = client is None
    http = client or new_client(timeout=TIMEOUT_S)
    deadline = _Deadline(call_budget_s())
    errors: list[str] = []
    # One entry per candidate the loop reached: its HTTP status, or None when it
    # never produced one. `_classify` reads this to tell an exhausted quota from
    # an outage; see the note there for why None is not the same as a failure.
    statuses: list[int | None] = []
    # The soonest any candidate said it would serve us again.
    retry_after_s: float | None = None
    try:
        for candidate in configured_models(preferred=model):
            # Falling through to another model is only worth it if there is time
            # to hear back from it. Without this the candidate list multiplied
            # the per-attempt timeout instead of sharing one ceiling with it.
            if deadline.expired():
                errors.append(f"{candidate}: skipped, call budget exhausted")
                statuses.append(None)
                break
            try:
                resp = _post_with_retry(http, candidate, system, user, deadline)
            except (httpx.HTTPError, DeadlineExceeded) as exc:
                # DeadlineExceeded lands here rather than escaping, so the caller
                # still gets the full tally of what was tried and why.
                errors.append(f"{candidate}: {exc}")
                statuses.append(None)
                continue
            if resp.status_code != 200:
                errors.append(f"{candidate}: HTTP {resp.status_code} {resp.text[:200]}")
                statuses.append(resp.status_code)
                if resp.status_code == 429:
                    wait = _retry_after_seconds(resp)
                    if wait is not None and (retry_after_s is None or wait < retry_after_s):
                        retry_after_s = wait
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
                statuses.append(None)
                continue
            if not isinstance(data, dict):
                errors.append(f"{candidate}: non-object body ({type(data).__name__})")
                statuses.append(None)
                continue
            content = _completion_text(data)
            if not content:
                errors.append(f"{candidate}: empty completion")
                statuses.append(None)
                continue
            usage = data.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            # A completion already succeeded; junk in the accounting fields must
            # not discard it. `int()` on a non-numeric raises, so coerce softly.
            prompt_tokens = _token_count(usage.get("prompt_tokens"))
            completion_tokens = _token_count(usage.get("completion_tokens"))
            self_total = prompt_tokens + completion_tokens
            # A model that reported nothing still spent something. The estimate
            # goes to the budget only — `LlmResult` keeps the counters exactly as
            # they arrived, so nothing downstream can mistake a guess for a
            # measurement. See `_estimate_tokens`.
            estimated = self_total == 0
            billed = _estimate_tokens(system, user, content) if estimated else self_total
            cumulative = _budget.add(billed)
            finish_reason = _finish_reason(data)
            if finish_reason in SUPPRESSED_FINISH_REASONS:
                _log.warning(
                    "llm completion withheld by a content filter",
                    extra={
                        "event": "llm_suppressed",
                        "model": candidate,
                        "detail": finish_reason,
                    },
                )
            if finish_reason in TRUNCATED_FINISH_REASONS:
                # Worth a line of its own: the caller may well accept this
                # answer, and the operator who has to raise OPENROUTER_MAX_TOKENS
                # has no other way to learn that it is being hit.
                _log.warning(
                    "llm completion truncated at the output cap",
                    extra={
                        "event": "llm_truncated",
                        "model": candidate,
                        "tokens": max_output_tokens(),
                        "detail": finish_reason,
                    },
                )
            # `model` is echoed by the provider and lands in job records and
            # audit trails; fall back to the candidate we asked for unless it
            # comes back as an actual string.
            served_by = data.get("model")
            served_by = served_by if isinstance(served_by, str) and served_by else candidate
            _log.info(
                "llm usage",
                extra={
                    "event": "llm_usage",
                    "model": served_by,
                    "tokens": billed,
                    "tokens_total": cumulative,
                    "detail": "estimated" if estimated else "reported",
                },
            )
            return LlmResult(
                model=served_by,
                content=content,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                finish_reason=finish_reason,
            )
        raise _classify(errors, statuses, retry_after_s)
    finally:
        if owns_client:
            http.close()


def extract_json(content: str) -> object:
    """Pulls the first JSON value out of a completion.

    Free models love to wrap JSON in markdown fences or prose; be forgiving.

    Deliberately unopinionated about the *shape*, and typed to say so: this used
    to be annotated `dict | list`, which was a claim rather than a check —
    `json.loads` happily returns a string, a number, a bool or `None`, and each
    of those reached a caller that had been told it could not. Which shapes are
    acceptable is a question about the prompt that asked, so it belongs to the
    caller; `pipelines._safe_result` is where every prompt in this service has
    its answer ("an object") enforced.
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
