"""Shared plumbing for the analyst agents.

Re-exports the pipeline helpers (document loading + PII redaction, params/
calculation summarisation, prompt-registry overrides, number coercion, and the
degrade-to-notes JSON parse) so agents build on exactly the same conventions as
the M1 pipelines, and adds a couple of agent-specific utilities. ``chat`` is
imported here so tests can monkeypatch a single seam
(``agents._common.chat``) for every agent.
"""

from __future__ import annotations

from typing import Any

from ..anonymize import Redactor
from ..llm_router import chat
from ..openrouter import LlmResult
from ..pipelines import (
    _calculation_summary as calculation_summary,
)
from ..pipelines import (
    _corpus as corpus,
)
from ..pipelines import (
    _load_docs as load_docs,
)
from ..pipelines import (
    _params_summary as params_summary,
)
from ..pipelines import (
    _prompt_overrides as prompt_overrides,
)
from ..pipelines import (
    _redactor as redactor,
)
from ..pipelines import (
    _safe_result as safe_result,
)
from ..pipelines import (
    _subject as subject,
)
from ..pipelines import (
    _to_number as to_number,
)

__all__ = [
    "LlmResult",
    "Redactor",
    "ask",
    "calculation_summary",
    "chat",
    "clamp_confidence",
    "clean_str",
    "corpus",
    "load_docs",
    "params_summary",
    "prompt_overrides",
    "redactor",
    "safe_result",
    "str_list",
    "subject",
    "to_number",
]


def ask(red: Redactor, system: str, user: str, model: str | None = None) -> LlmResult:
    """The gate every agent prompt leaves through — see `pipelines._ask`.

    Spelled out here rather than re-exported so it resolves `chat` in this
    module, which is the single seam the agent tests monkeypatch. Importing the
    pipelines' copy would send every agent call to the real OpenRouter client
    the moment a test patched `_common.chat` and nothing else.
    """
    return chat(red.text(system), red.text(user), model=model)


def clean_str(value: Any, *, limit: int = 4000) -> str:
    """Coerce a model-emitted value to a trimmed string (never ``None``)."""
    if value is None:
        return ""
    return str(value).strip()[:limit]


#: The widest reading of a confidence score that is still a confidence score.
#: A model asked for 0-1 routinely answers on 0-100 instead, and that is a
#: different scale rather than a different claim — everything up to 100 folds.
#: Past it there is no scale left to guess at.
MAX_CONFIDENCE_SCALE = 100.0


def clamp_confidence(value: Any) -> float | None:
    """A confidence score as a fraction in [0, 1]; ``None`` when unusable.

    Out-of-range is refused, not clamped. Clamping is the right answer when a
    value is merely too precise for its field; it is the wrong one when the
    value says the model was not answering the question, because the clamp
    turns nonsense into the strongest reading of it. ``confidence: 9999``
    became ``1.0`` — displayed beside a hallucinated SIC code or an invented
    share-class citation as *maximum* confidence, which is the one thing the
    analyst most needs it not to say. ``-1`` became ``0.0``, which is a real
    score meaning "the model has none", and so was indistinguishable from a
    model that had said exactly that.

    ``None`` is the honest answer for both, and every surface already renders
    it: a non-numeric score has always returned it.
    """
    num = to_number(value)
    if num is None:
        return None
    if num < 0 or num > MAX_CONFIDENCE_SCALE:
        return None
    if num > 1:
        # Some models answer 0-100; fold that back into a fraction.
        return round(num / MAX_CONFIDENCE_SCALE, 4)
    return round(num, 4)


def str_list(value: Any, *, limit: int = 20, item_limit: int = 2000) -> list[str]:
    """Coerce a model value into a list of clean strings, dropping blanks."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value[:limit]:
        text = clean_str(item, limit=item_limit)
        if text:
            out.append(text)
    return out
