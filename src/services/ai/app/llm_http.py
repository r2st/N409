"""Provider-agnostic HTTP discipline shared by the LLM clients.

These started inside `openrouter.py` and moved here when a second provider
needed the same guarantees; `websearch.py` is the third. Nothing here knows about a
particular provider — it is the wall clock, the backoff and the soft integer
coercion that any of them would otherwise reinvent slightly differently.

The reason that matters is `limits.py`: the handlers are sync `def`s, so each
one holds a threadpool slot for its whole duration and no client disconnect
reclaims it. A provider having a slow afternoon takes the service down without
anyone attacking it, and it does so once per provider that forgot to bound
itself. One `Deadline`, imported.
"""

from __future__ import annotations

import email.utils
import math
import os
import threading
import time

import httpx

# One HTTP attempt's ceiling. `Deadline.attempt_timeout` never exceeds it.
TIMEOUT_S = 90.0
# Transient-failure retry policy. A connect/transport error or a 5xx is usually
# momentary, so retry with exponential backoff before giving up on a candidate.
# 4xx (including 429) is not retried here; the caller falls through to the next
# candidate instead.
#
# For 429 that fall-through is usually theatre, and knowing so is the point:
# OpenRouter's free allowance is counted against the *key*, so a spent quota
# refuses every model in the chain. The chain is still walked — a paid key, or a
# per-model limit, does make the next candidate worth trying — but when it comes
# back all-429 the client says "rate limited" rather than "everything is down",
# because those two want opposite things from whoever hears them.
MAX_RETRIES = 2
RETRY_BACKOFF_BASE_S = 0.5
# Below this there is no point starting an attempt; it would only time out.
MIN_ATTEMPT_S = 1.0


class DeadlineExceeded(Exception):
    """Raised when a whole-call budget ran out before anyone answered.

    Each provider re-raises this as its own error type so callers can keep
    catching one exception per provider.
    """


class Deadline:
    """One call's remaining wall clock.

    `TIMEOUT_S` bounds a single HTTP attempt, and a call makes many:
    MAX_RETRIES + 1 attempts against each of several candidates, plus backoff.
    With the defaults that is 3 x 3 x 90s + 4.5s of sleeping — 13.6 minutes of
    one thread, not the 90 seconds the threadpool was sized against.

    So the retry policy gets a wall clock as well as a count. Each attempt is
    given whatever is left rather than a fresh TIMEOUT_S, and once the budget is
    spent no further candidate is tried — the caller gets the accumulated
    errors, which is what it would have got at the end anyway.

    A budget of 0 means unbounded, which is what the policy used to be — kept
    configurable so an operator running a deliberately slow local model can turn
    the ceiling off rather than raise it repeatedly.
    """

    def __init__(self, budget_s: float, now: float | None = None) -> None:
        self.budget_s = budget_s
        self._start = time.monotonic() if now is None else now

    @property
    def unbounded(self) -> bool:
        return self.budget_s <= 0

    def remaining(self) -> float:
        if self.unbounded:
            return float("inf")
        return self.budget_s - (time.monotonic() - self._start)

    def attempt_timeout(self) -> float:
        """Timeout for the next HTTP attempt: what is left, capped at TIMEOUT_S."""
        return TIMEOUT_S if self.unbounded else min(TIMEOUT_S, self.remaining())

    def expired(self) -> bool:
        """True when too little is left to be worth starting another attempt."""
        return not self.unbounded and self.remaining() < MIN_ATTEMPT_S

    def sleep(self, seconds: float) -> bool:
        """Back off for `seconds`, trimmed to the budget. False if none is left."""
        if self.unbounded:
            time.sleep(seconds)
            return True
        allowed = min(seconds, self.remaining() - MIN_ATTEMPT_S)
        if allowed <= 0:
            return False
        time.sleep(allowed)
        return True


def backoff_sleep(attempt: int, deadline: Deadline) -> bool:
    """Exponential backoff between retries (attempt is 0-indexed)."""
    return deadline.sleep(RETRY_BACKOFF_BASE_S * (2**attempt))


def env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    """A float from the environment, falling back on anything unusable.

    Configuration is not an input to validate loudly: a typo'd budget should
    leave the service running on its default, not refuse to boot.
    """
    import os

    raw = os.environ.get(name)
    if raw:
        try:
            value = float(raw)
            if value >= minimum:
                return value
        except ValueError:
            pass
    return default


def env_int(name: str, default: int, *, minimum: int = 1) -> int:
    """An int from the environment, falling back on anything unusable."""
    import os

    raw = os.environ.get(name)
    if raw:
        try:
            value = int(raw)
            if value >= minimum:
                return value
        except ValueError:
            pass
    return default


def token_count(value: object) -> int:
    """A usage counter as a non-negative int; 0 when the field is unusable.

    A completion has already succeeded by the time this runs, so junk in the
    accounting fields must not discard it — `int()` on a non-numeric raises.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return 0
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


# ── Completion truncation ────────────────────────────────────────────────────
#
# Every provider here speaks the chat-completions shape, and every one of them
# reports "I ran out of output room" the same way: a `finish_reason` on the
# first choice. It lives here rather than in one client because the consequence
# is provider-independent — a completion stopped at the cap is a *partial
# success*, and a caller that cannot see the difference reports half an answer
# as a whole one.

#: `finish_reason` values that mean the model stopped at the output cap rather
#: than because it had finished. Spelled several ways across providers.
TRUNCATED_FINISH_REASONS = frozenset({"length", "max_tokens", "MAX_TOKENS"})


def finish_reason(data: dict) -> str | None:
    """Why the model stopped, if it said. Every level is provider-controlled."""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    reason = first.get("finish_reason")
    return reason if isinstance(reason, str) and reason else None


def completion_truncated(data: dict) -> bool:
    """True when the body says the answer was cut off at the output cap."""
    return finish_reason(data) in TRUNCATED_FINISH_REASONS


def stop_reason(data: dict) -> str | None:
    """Why the model stopped, for the Converse shape (Bedrock).

    The same fact under a different spelling: Converse puts it at the top level
    as `stopReason` rather than on a choice, and calls the cap case
    `max_tokens`. Kept beside `finish_reason` rather than in the Bedrock client
    so the two readers of the one concept sit together — a provider added
    without one of these produces `LlmResult.truncated == False` for every
    answer it ever gives, which is a guard that reads as passing.
    """
    reason = data.get("stopReason")
    return reason if isinstance(reason, str) and reason else None


# ── "When, then" ─────────────────────────────────────────────────────────────
#
# A provider that refuses with 429 usually says when it will serve us again,
# and that answer is worth carrying the whole way out rather than re-guessed at
# each hop. Shared rather than per-client for the reason the readers above are:
# the second provider to refuse this way would otherwise either invent its own
# clamp or, far more likely, quote no wait at all.

# The longest wait worth passing on. A provider that says "come back in three
# days" is telling an operator something, not telling a client to hold the tab
# open, and an unbounded number here rides out to an HTTP header.
MAX_RETRY_AFTER_S = 3600.0
# What a 429 carrying no `Retry-After` is reported as. A free tier's window is a
# day and its headers are inconsistent about saying so, so this is not a
# prediction — it is the shortest interval at which asking again is polite.
DEFAULT_RETRY_AFTER_S = 60.0


def clamp_wait(seconds: float) -> float | None:
    """A wait we are willing to quote: positive, finite, and under the ceiling."""
    if not math.isfinite(seconds) or seconds <= 0:
        return None
    return min(seconds, MAX_RETRY_AFTER_S)


def retry_after_seconds(resp: httpx.Response) -> float | None:
    """How long the provider asked us to wait, in seconds, or None.

    Three spellings, because the providers here use all three depending on which
    upstream refused: `Retry-After` (RFC 9110 — a delta in seconds *or* an
    HTTP-date), which is also what Bedrock sends on a `ThrottlingException`, and
    `X-RateLimit-Reset` (an epoch, in milliseconds, which is what OpenRouter's
    free-tier daily counter reports).
    """
    headers = resp.headers
    raw = headers.get("retry-after")
    if raw:
        try:
            return clamp_wait(float(raw.strip()))
        except ValueError:
            pass
        try:
            when = email.utils.parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            when = None
        if when is not None:
            return clamp_wait(when.timestamp() - time.time())
    reset = headers.get("x-ratelimit-reset")
    if reset:
        try:
            # Epoch milliseconds. A value that is plainly seconds instead (too
            # small to be a millisecond epoch) is read as seconds rather than
            # reported as a wait of half a century.
            value = float(reset.strip())
        except ValueError:
            return None
        epoch_s = value / 1000 if value > 1e11 else value
        return clamp_wait(epoch_s - time.time())
    return None


# ── Spend accounting ─────────────────────────────────────────────────────────
#
# Two providers answer prompts here, and both cost money on somebody's account.
# The ledger lived inside `openrouter` with an OpenRouter-shaped name, so
# Bedrock — the provider that is *always* billed, against the operator's own AWS
# account — spent outside it entirely: `/ready` reported a lifetime spend of
# zero however hard the service had been working, and the ceiling documented as
# "the one guard against a runaway loop once a paid key is configured" did not
# apply to the only key that is certainly paid.
#
# One ledger class, one instance per provider, each with its own env-named cap:
# the counts stay separable (an operator asking what OpenRouter cost this
# process gets that answer, not a sum), and neither provider's ceiling is
# spent by the other's traffic.

#: Characters per token, for the estimate below. Deliberately crude: this feeds a
#: safety cap, not an invoice.
CHARS_PER_TOKEN = 4


def estimate_tokens(*texts: str) -> int:
    """A rough token count for text nobody counted for us.

    `usage` is optional in every completion shape here and providers omit it —
    free tiers routinely, and a billed provider on a bad response. Coerced to 0,
    those calls leave the ledger exactly where they found it, so the token
    ceiling is unenforceable against precisely the calls least accounted for.
    """
    return max(1, math.ceil(sum(len(t) for t in texts) / CHARS_PER_TOKEN))


class BudgetExhausted(Exception):
    """Raised when a provider's process-lifetime token ceiling is spent.

    Each provider re-raises this as its own error type, so callers keep
    catching one exception per provider.
    """


class TokenLedger:
    """Best-effort, process-lifetime token accounting + optional hard cap.

    `cap_env` (total tokens) guards against a runaway/abusive loop; 0/unset
    means unlimited. In-process, not cluster-wide — a coarse safety net, not
    billing.
    """

    def __init__(self, cap_env: str) -> None:
        self.cap_env = cap_env
        self._lock = threading.Lock()
        self._used = 0

    def cap(self) -> int:
        raw = os.environ.get(self.cap_env)
        try:
            return max(0, int(raw)) if raw else 0
        except ValueError:
            return 0

    def check(self) -> None:
        cap = self.cap()
        if cap and self._used >= cap:
            raise BudgetExhausted(f"{self.cap_env} exhausted ({self._used}/{cap})")

    def add(self, tokens: int) -> int:
        with self._lock:
            self._used += max(0, tokens)
            return self._used

    def reset(self) -> None:
        """Drop the running total (tests only)."""
        with self._lock:
            self._used = 0

    @property
    def used(self) -> int:
        return self._used
