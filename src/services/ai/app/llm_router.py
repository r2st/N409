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

from . import bedrock, openrouter
from .openrouter import LlmResult, OpenRouterError


def provider_for(model: str | None) -> str:
    """Which provider owns this model id: 'bedrock' or 'openrouter'."""
    return "bedrock" if bedrock.handles(model) else "openrouter"


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
    """
    if bedrock.handles(model):
        try:
            return bedrock.chat(system, user, model=model, client=client)
        except bedrock.BedrockError as exc:
            raise OpenRouterError(str(exc)) from exc
    return openrouter.chat(system, user, model=model, client=client)


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
