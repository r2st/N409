"""Prose for a free-form inputs object a calculation cannot be called with.

Nine endpoints take an open ``inputs``/``params`` object and splat it into an
engine entry point. When the object does not fit the signature, CPython raises
the ``TypeError`` — and its wording used to be the whole answer the caller got,
because the route puts the exception's text straight into the 422's ``detail``
and the valuation service shows an upstream ``detail`` to the analyst verbatim::

    invalid params for emi: share_values() missing 2 required keyword-only
    arguments: 'equity_value' and 'total_shares'

That sentence is a language runtime's rather than this product's. It names an
internal function nobody called, spells the problem in Python's vocabulary
("keyword-only arguments"), and never says what the calculation *does* accept,
which is the one thing somebody holding a free-form object needs.

:func:`describe_unbindable` answers the same question in the endpoint's own
terms and answers it *before* the call, so a ``TypeError`` that escapes
afterwards is known to be about a value rather than a name.
"""

import difflib
import functools
import inspect
from collections.abc import Mapping
from typing import Callable, Iterable, Sequence

from .display_text import quote_for_message

# How many names a clause lists before it counts the rest. A refusal stops
# being read once it stops fitting where the UI puts it, and `project_financials`
# accepts 22 inputs.
MAX_NAMED = 10

_KEYWORD_KINDS = (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)


# Bounded rather than unbounded: the estate's entry points number in the tens,
# and a cache keyed on a callable should not be able to grow without one.
@functools.lru_cache(maxsize=128)
def _signature_names(fn: Callable) -> tuple[tuple[str, ...], tuple[str, ...], bool]:
    """(accepted, required, takes_var_keyword) for one entry point.

    Cached on the callable: the entry points are module-level and fixed, and
    this runs on the request path of every endpoint that takes a free-form
    object. Tuples rather than lists so a caller cannot mutate the cached
    answer.
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):  # builtins, C callables
        return ((), (), True)
    accepted: list[str] = []
    required: list[str] = []
    var_keyword = False
    for p in sig.parameters.values():
        if p.kind is inspect.Parameter.VAR_KEYWORD:
            var_keyword = True
            continue
        if p.kind not in _KEYWORD_KINDS:
            continue
        accepted.append(p.name)
        if p.default is inspect.Parameter.empty:
            required.append(p.name)
    return (tuple(accepted), tuple(required), var_keyword)


def _listed(names: Sequence[str]) -> str:
    """Up to MAX_NAMED names, then a count of the rest."""
    named = list(names[:MAX_NAMED])
    hidden = len(names) - len(named)
    listed = ", ".join(named)
    if hidden > 0:
        listed += f" (and {hidden} more)"
    return listed


# How alike two names must be before one is offered as what the other meant.
NEAR_MISS_CUTOFF = 0.7


def _too_long_to_match(length: int, longest_accepted: int) -> bool:
    """Whether no accepted name can reach ``NEAR_MISS_CUTOFF`` against this one.

    ``difflib`` scores a pair at most ``2 * min(la, lb) / (la + lb)`` — its own
    ``real_quick_ratio``, which is the first of the three tests
    ``get_close_matches`` applies and depends on nothing but the two lengths.
    Rearranged for the longer side: a candidate beyond
    ``longest * (2 - cutoff) / cutoff`` is out of reach of every accepted name,
    whatever its characters are. So the answer is the answer ``difflib`` would
    have given, arrived at before its query index is built rather than after.
    """
    if longest_accepted <= 0:
        return True
    return length > longest_accepted * (2 - NEAR_MISS_CUTOFF) / NEAR_MISS_CUTOFF


def _unknown_clause(unknown: Sequence[str], accepted: Sequence[str]) -> str:
    """The names this calculation does not have, quoted back at the caller.

    ``MAX_NAMED`` bounds how many are named and `quote_for_message` bounds what
    each one may be. Both halves are needed: the name is a key off the caller's
    own JSON object, so it is as long and as strange as they care to make it,
    and this sentence is shown to an analyst verbatim.

    The near miss is matched against the *raw* name — a spelling this
    calculation might have meant is about the bytes sent, not about their
    display form — and only the accepted name it finds is printed, which came
    from a signature here. See :mod:`app.engine.display_text`.

    A NAME TOO LONG TO BE A MISSPELLING IS NOT OFFERED TO ``difflib`` AT ALL
    (round 385, methodology M8). ``get_close_matches`` indexes its query before
    it compares anything — ``SequenceMatcher.set_seq2`` builds a position list
    per distinct character of the whole string — and the query here is a key
    off the caller's own JSON object, bounded only by the 8 MB body ceiling.
    One 1 MB name cost 249 ms and 40 MB of peak heap to conclude what
    :func:`_too_long_to_match` concludes from two integers, and ``MAX_NAMED``
    of them are asked per refusal.
    """
    parts = []
    longest = max((len(a) for a in accepted), default=0)
    for name in unknown[:MAX_NAMED]:
        near = [] if _too_long_to_match(len(name), longest) else difflib.get_close_matches(
            name, accepted, n=1, cutoff=NEAR_MISS_CUTOFF
        )
        shown = quote_for_message(name)
        parts.append(f"no input named '{shown}'" + (f" (did you mean '{near[0]}'?)" if near else ""))
    hidden = len(unknown) - len(parts)
    if hidden > 0:
        parts.append(f"and {hidden} more unrecognised name{'' if hidden == 1 else 's'}")
    return "; ".join(parts)


def describe_unbindable(
    fns: Callable | Iterable[Callable],
    params: object,
    *,
    provided: Iterable[str] = (),
) -> str | None:
    """What is wrong with ``params`` as a call into ``fns``, or None if nothing is.

    ``fns`` may be several entry points when the endpoint splits one object
    between them (the EMI/CSOP route sends the value keys to ``share_values``
    and the rest to the scheme's qualification check): a name is accepted if
    any of them accepts it, and required if any of them requires it.

    ``provided`` names parameters the engine fills in itself, so they are
    neither expected from the caller nor offered to them.
    """
    if not isinstance(params, Mapping):
        return "the inputs must be an object"

    callables = [fns] if callable(fns) else list(fns)
    supplied = set(provided)
    accepted: list[str] = []
    required: list[str] = []
    var_keyword = False
    for fn in callables:
        fn_accepted, fn_required, fn_var = _signature_names(fn)
        var_keyword = var_keyword or fn_var
        for name in fn_accepted:
            if name not in supplied and name not in accepted:
                accepted.append(name)
        for name in fn_required:
            if name not in supplied and name not in required:
                required.append(name)

    given = {str(k) for k in params}
    unknown = [] if var_keyword else sorted(given.difference(accepted))
    missing = [name for name in required if name not in given]
    if not unknown and not missing:
        return None

    clauses = []
    if unknown:
        clauses.append(_unknown_clause(unknown, accepted))
    if missing:
        noun = "input" if len(missing) == 1 else "inputs"
        clauses.append(f"missing required {noun} " + ", ".join(f"'{m}'" for m in missing))
    sentence = "; ".join(clauses)
    if accepted:
        sentence += f". Accepted inputs: {_listed(sorted(accepted))}"
    return sentence
