"""Per-prompt provider routing (design §12.2, P2-21).

409.ai binds each prompt to a provider chosen for the job. N409 has had the
per-prompt `model` column since the Bot Prompts registry shipped, and one
provider to point it at. This is the dispatch that makes the column mean what
it looks like it means.

Routing is by model id and nothing else, because the model id is the only thing
the prompt registry carries and the only thing an operator picking from the
model dropdown chooses. A `bedrock/` prefix routes to Bedrock; everything else
goes to OpenRouter, which stays the default so an installation that has never
heard of Bedrock behaves exactly as it did.

`research.py` is deliberately *not* in this table. It answers a different
question — one about the public record, with citations — and is reached through
its own route with its own confidentiality gate. Folding it in here would make
it reachable from `pipelines._ask`, which is the one thing its module docstring
exists to prevent. That it now synthesises through `openrouter.chat` does not
change this: the outbound leg is the *search*, and the search provider is only
ever reached from behind that gate.
"""

from __future__ import annotations

import logging
import time
from typing import Callable

_log = logging.getLogger(__name__)

from . import bedrock, openrouter
from .openrouter import (
    AuthenticationFailed,
    LlmResult,
    OpenRouterError,
    RateLimited,
    RequestRejected,
)

#: Per-call latency/outcome/token reporting, installed by `main.py` once the
#: metrics registry exists. None in every unit test that calls `chat()`
#: directly — the same shape as `observability.set_degraded_event_sink`, so a
#: caller with nothing installed logs exactly as it always did.
#:
#: R444, methodology M11. The router was the one choke point every prompt call
#: passes through and the one place that reported nothing at all: `llm_usage`
#: is an `info` line (below `log_degraded_events_total`'s WARNING floor) and
#: the three provider token ledgers only ever reached `/ready`'s JSON body,
#: which nothing scrapes or alerts on. Latency was not reported anywhere —
#: `http_request_duration_seconds` times the whole pipeline route, documents
#: and anonymization included, with no `model` label to tell one candidate's
#: latency from another's.
_metrics_sink: Callable[..., None] | None = None


def set_llm_metrics_sink(sink: Callable[..., None] | None) -> None:
    """Install the callback `chat()` reports every call to.

    Called with keyword arguments `provider`, `model`, `outcome`,
    `duration_s`, `prompt_tokens`, `completion_tokens`. Null clears it, which
    is what a test does between cases.
    """
    global _metrics_sink
    _metrics_sink = sink


def provider_for(model: str | None) -> str:
    """Which provider owns this model id: 'bedrock' or 'openrouter'."""
    return "bedrock" if bedrock.handles(model) else "openrouter"


def _outcome_for(exc: Exception) -> str:
    """The metrics label for a failed call.

    The same three-way split `main.py`'s status mapping already draws
    (`RateLimited` → 429, `AuthenticationFailed`/plain `OpenRouterError` → 503,
    `RequestRejected` → 422), so a dashboard built off this counter groups
    calls the same way the HTTP layer already does.
    """
    if isinstance(exc, RateLimited):
        return "rate_limited"
    if isinstance(exc, AuthenticationFailed):
        return "auth_failed"
    if isinstance(exc, RequestRejected):
        return "request_rejected"
    return "error"


def _report(
    provider: str, model: str, duration_s: float, outcome: str, result: LlmResult | None
) -> None:
    """Tell the sink, if one is installed. Never lets a broken sink cost the
    call it is reporting on — the same guarantee `observability._count_degraded`
    gives its counter."""
    if _metrics_sink is None:
        return
    try:
        _metrics_sink(
            provider=provider,
            model=model,
            outcome=outcome,
            duration_s=duration_s,
            prompt_tokens=result.prompt_tokens if result is not None else 0,
            completion_tokens=result.completion_tokens if result is not None else 0,
        )
    except Exception:  # noqa: BLE001 - a broken metrics sink must not cost a call
        _log.debug("LLM metrics sink raised", exc_info=True)


def chat(
    system: str, user: str, *, model: str | None = None, client=None
) -> LlmResult:
    """Run a prompt against whichever provider its model id names.

    Bedrock failures are re-raised as `OpenRouterError` on the way out. That
    looks like a wart and is deliberate: every caller in this service catches
    `OpenRouterError` as "the LLM could not answer", and a second exception
    type would mean either editing every call site or — far more likely — a
    Bedrock failure escaping as an unhandled 500 from the one code path nobody
    exercised. The message keeps the provider's own wording, so what an
    operator reads still says Bedrock.

    Which *subclass* is not a wart either — see `_as_openrouter_error`. The
    verdict a provider drew is the whole input to the status `main` answers,
    and Bedrock's used to be discarded on the way through here.
    """
    provider = provider_for(model)
    label = model or "default"
    started = time.monotonic()
    try:
        if bedrock.handles(model):
            try:
                result = bedrock.chat(system, user, model=model, client=client)
            except bedrock.BedrockError as exc:
                raise _as_openrouter_error(exc) from exc
        else:
            result = openrouter.chat(system, user, model=model, client=client)
    except Exception as exc:
        _report(provider, label, time.monotonic() - started, _outcome_for(exc), None)
        raise
    _report(provider, label, time.monotonic() - started, "success", result)
    return result


def _as_openrouter_error(exc: bedrock.BedrockError) -> OpenRouterError:
    """The Bedrock verdict, wearing the type this service's handlers read.

    Flattening every one of them to the base class was not merely untidy: the
    status `main` picks comes off the type, so a `ThrottlingException` — the
    routine one, on the provider that is always billed — arrived as 503, was
    retried by `clients/internal.ts` at full price, and counted toward a
    breaker shared by every engagement. The mapping is one line per verdict so
    a provider added later has somewhere obvious to join.
    """
    message = str(exc)
    if isinstance(exc, bedrock.BedrockRateLimited):
        return RateLimited(message, exc.retry_after_s)
    if isinstance(exc, bedrock.BedrockAuthenticationFailed):
        return AuthenticationFailed(message)
    if isinstance(exc, bedrock.BedrockRequestRejected):
        return RequestRejected(message, exc.status)
    return OpenRouterError(message)


def configured_models(preferred: str | None = None) -> list[str]:
    """Every candidate an operator may bind a prompt to.

    OpenRouter's chain first, then Bedrock when it is configured: the free-tier
    chain is what an unconfigured installation must keep defaulting to, and a
    billed provider should never become the default by being listed first.

    `preferred` is hoisted to the head whichever provider owns it, so the model
    picker shows a prompt's current binding at the top of its own list even
    when that binding is for a provider whose defaults do not include it.
    """
    models = openrouter.configured_models()
    models.extend(m for m in bedrock.configured_models() if m not in models)
    if preferred:
        models = [preferred, *[m for m in models if m != preferred]]
    return models
