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

import time

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
