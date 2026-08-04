"""Whole-call wall clock for the OpenRouter client.

TIMEOUT_S bounds one HTTP attempt, and `chat` makes many: MAX_RETRIES + 1
attempts against each candidate model, plus backoff. With the defaults that is
3 x 3 x 90s + 4.5s of sleeping — 13.6 minutes of one thread, not the 90 seconds
`limits.py` sized the threadpool against ("LLM calls block up to 90s"). The
handlers are sync `def`s, so each holds a slot in a pool of 40 for its whole
duration and no client disconnect reclaims it: a provider having a slow
afternoon takes the service down with nobody attacking it.
"""

import httpx
import pytest

from app import openrouter
from app.openrouter import (
    DEFAULT_CALL_BUDGET_S,
    MAX_RETRIES,
    TIMEOUT_S,
    LlmResult,
    OpenRouterError,
    _Deadline,
    call_budget_s,
    chat,
)


class _Response:
    def __init__(self, status_code=200, completion='{"ok": true}'):
        self.status_code = status_code
        self._completion = completion
        self.text = "error body" if status_code != 200 else completion

    def json(self):
        return {
            "model": "test/model",
            "choices": [{"message": {"content": self._completion}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        }


class _Clock:
    """A monotonic clock the test advances by hand, so no test really waits."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


class _SlowClient:
    """Burns `cost_s` of the fake clock per POST, then yields a scripted outcome."""

    def __init__(self, clock: _Clock, outcomes, cost_s: float):
        self._clock = clock
        self._outcomes = list(outcomes)
        self._cost = cost_s
        self.calls = 0
        self.timeouts: list[float] = []

    def post(self, url, headers=None, json=None, timeout=None):  # noqa: A002
        self.calls += 1
        self.timeouts.append(timeout)
        # A real attempt spends up to its timeout; a hung provider spends all of it.
        self._clock.now += min(self._cost, timeout if timeout is not None else self._cost)
        outcome = self._outcomes.pop(0) if self._outcomes else httpx.ConnectTimeout("hung")
        if isinstance(outcome, Exception):
            raise outcome
        return _Response(status_code=outcome) if isinstance(outcome, int) else outcome


@pytest.fixture
def clock(monkeypatch):
    c = _Clock()
    monkeypatch.setattr(openrouter.time, "monotonic", c.monotonic)
    monkeypatch.setattr(openrouter.time, "sleep", c.sleep)
    return c


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    monkeypatch.delenv("OPENROUTER_CALL_BUDGET_S", raising=False)
    openrouter._budget._used = 0
    yield
    openrouter._budget._used = 0


def _three_models(monkeypatch):
    monkeypatch.setattr(
        openrouter, "configured_models", lambda preferred=None: ["a/one", "b/two", "c/three"]
    )


# ── The budget itself ────────────────────────────────────────────────────────


def test_the_default_budget_is_shorter_than_the_old_worst_case():
    # What the retry policy used to be able to spend on one call.
    old_worst_case = 3 * (MAX_RETRIES + 1) * TIMEOUT_S
    assert old_worst_case > 800  # 13.6 minutes
    assert call_budget_s() == DEFAULT_CALL_BUDGET_S
    assert DEFAULT_CALL_BUDGET_S < old_worst_case


def test_the_budget_is_configurable_and_zero_means_unbounded(monkeypatch):
    monkeypatch.setenv("OPENROUTER_CALL_BUDGET_S", "42.5")
    assert call_budget_s() == 42.5
    monkeypatch.setenv("OPENROUTER_CALL_BUDGET_S", "0")
    assert call_budget_s() == 0
    assert _Deadline(0).unbounded is True
    assert _Deadline(0).expired() is False


@pytest.mark.parametrize("junk", ["", "abc", "-5", "nan-ish"])
def test_an_unusable_budget_setting_falls_back_to_the_default(monkeypatch, junk):
    monkeypatch.setenv("OPENROUTER_CALL_BUDGET_S", junk)
    assert call_budget_s() == DEFAULT_CALL_BUDGET_S


# ── What it bounds ───────────────────────────────────────────────────────────


def test_a_hung_provider_no_longer_holds_a_thread_for_thirteen_minutes(monkeypatch, clock):
    _three_models(monkeypatch)
    monkeypatch.setenv("OPENROUTER_CALL_BUDGET_S", "150")
    # Every attempt against every model hangs until its timeout.
    client = _SlowClient(clock, [], cost_s=TIMEOUT_S)
    start = clock.now
    with pytest.raises(OpenRouterError):
        chat("sys", "user", client=client)
    elapsed = clock.now - start
    assert elapsed <= 150 + TIMEOUT_S  # the last attempt may straddle the line
    # Previously: 9 attempts x 90s. Now the budget stops it well short.
    assert client.calls < 3 * (MAX_RETRIES + 1)


def test_each_attempt_gets_what_is_left_not_a_fresh_ninety_seconds(monkeypatch, clock):
    _three_models(monkeypatch)
    monkeypatch.setenv("OPENROUTER_CALL_BUDGET_S", "100")
    client = _SlowClient(clock, [], cost_s=TIMEOUT_S)
    with pytest.raises(OpenRouterError):
        chat("sys", "user", client=client)
    assert client.timeouts[0] == pytest.approx(90.0)  # capped at TIMEOUT_S
    # The second attempt cannot ask for another 90 — only what remains.
    assert client.timeouts[1] < TIMEOUT_S
    assert all(t <= TIMEOUT_S for t in client.timeouts)
    assert all(t > 0 for t in client.timeouts)


def test_a_later_model_is_not_started_once_the_budget_is_spent(monkeypatch, clock):
    _three_models(monkeypatch)
    monkeypatch.setenv("OPENROUTER_CALL_BUDGET_S", "95")
    client = _SlowClient(clock, [], cost_s=TIMEOUT_S)
    with pytest.raises(OpenRouterError, match="budget exhausted"):
        chat("sys", "user", client=client)
    # One full 90s attempt, then the 5s left over spent on a short retry rather
    # than wasted — and then nothing. The second and third models are never
    # dialled, which is the whole difference from 9 attempts at 90s each.
    assert client.calls == 2
    assert sum(client.timeouts) <= 95
    assert clock.now - 1000.0 <= 95


def test_the_error_still_names_every_model_that_was_tried(monkeypatch, clock):
    _three_models(monkeypatch)
    monkeypatch.setenv("OPENROUTER_CALL_BUDGET_S", "95")
    client = _SlowClient(clock, [], cost_s=TIMEOUT_S)
    with pytest.raises(OpenRouterError) as excinfo:
        chat("sys", "user", client=client)
    # A deadline is not a silent stop — the caller sees what happened to each.
    assert "a/one" in str(excinfo.value)
    assert "b/two" in str(excinfo.value)


# ── What it must not change ──────────────────────────────────────────────────


def test_a_prompt_answered_quickly_is_completely_unaffected(monkeypatch, clock):
    _three_models(monkeypatch)
    client = _SlowClient(clock, [_Response()], cost_s=0.2)
    result = chat("sys", "user", client=client)
    assert isinstance(result, LlmResult)
    assert client.calls == 1


def test_fallback_to_a_later_model_still_happens_within_budget(monkeypatch, clock):
    _three_models(monkeypatch)
    # First model 4xx (no retry), second answers — the ordinary fallback path.
    client = _SlowClient(clock, [429, _Response()], cost_s=1.0)
    result = chat("sys", "user", client=client)
    assert isinstance(result, LlmResult)
    assert client.calls == 2


def test_retries_still_happen_when_there_is_time_for_them(monkeypatch, clock):
    monkeypatch.setattr(openrouter, "configured_models", lambda preferred=None: ["solo/model"])
    client = _SlowClient(clock, [503, 503, _Response()], cost_s=1.0)
    result = chat("sys", "user", client=client)
    assert isinstance(result, LlmResult)
    assert client.calls == MAX_RETRIES + 1


def test_an_unbounded_budget_restores_the_old_exhaustive_behaviour(monkeypatch, clock):
    _three_models(monkeypatch)
    monkeypatch.setenv("OPENROUTER_CALL_BUDGET_S", "0")
    client = _SlowClient(clock, [], cost_s=TIMEOUT_S)
    with pytest.raises(OpenRouterError):
        chat("sys", "user", client=client)
    # Every model, every retry — for the operator running a deliberately slow
    # local model who would rather wait than tune the ceiling.
    assert client.calls == 3 * (MAX_RETRIES + 1)
    assert all(t == TIMEOUT_S for t in client.timeouts)
