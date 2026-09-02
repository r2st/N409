"""A caller's own bytes, prepared for a sentence a person reads.

The engine's refusals name the thing they refused — the input, the share class,
the weight — because naming it is the difference between "this cap table is
invalid" and "this class of it is". But the name is the caller's: it arrives in
a free-form ``inputs`` object, or as ``share_classes[].name`` off an imported
cap table, and it is as long as they like and made of whatever they like.

Where that sentence goes is what makes it worth bounding. A ``detail`` on a 422
is read by the valuation service as the upstream's own words
(``InternalServiceError.opaque`` is false for it), written to
``network_items.error`` on the engagement, and drawn to the analyst in a problem
document; the ``message`` on a ``/engine/v1/validate`` issue is drawn in the
validation panel unmodified. Both are also printed by whatever terminal a
``curl`` caller is looking at and repeated into a partner's integration log.

This is the twin of ``quoteForMessage`` in
``src/services/valuation/src/domain/displayText.ts`` and holds to the same three
rules, for the same reasons stated at length there. It exists as a second copy
rather than an import because there is no module path between a Python service
and a TypeScript one; ``tests/test_display_text.py`` pins the two policies to
each other by reading that file.

``repr()`` is the reason most of this tier is already safe and is not a
replacement for it: it escapes the controls but does not bound the length, does
not touch the quote, and renders a legitimate non-Latin name as a row of
``\\uXXXX`` escapes.
"""

# A character that reorders the text around it rather than being text: the
# bidirectional embeddings and overrides (U+202A-U+202E), the isolates
# (U+2066-U+2069) and the three marks (U+061C, U+200E, U+200F).
#
# Dropped rather than replaced. They are zero-width, so a substitution puts
# visible junk into a legitimate Arabic or Hebrew name that carries a mark for
# ordinary reasons, and a control has no inert spelling to collapse to. The
# zero-width joiners (U+200C/U+200D) are deliberately absent: they are how an
# emoji sequence and a Persian or Indic word are spelled, and neither reorders
# anything.
BIDI_CONTROLS = frozenset(
    "؜‎‏‪‫‬‭‮⁦⁧⁨⁩"
)

# How much of an untrusted fragment a message keeps.
#
# The receiving hop already cuts an upstream `detail` at 500 characters
# (`UPSTREAM_DETAIL_CHARS` in clients/internal.ts), so without a bound here the
# caller decides what survives that cut: three padded names ahead of the
# accepted-input list evict the only actionable half of the sentence. 80 is the
# TS twin's bound.
MAX_QUOTED_CHARS = 80

# What a refusal calls a name with nothing visible left in it. The TS twin's
# literal, and `test_display_text.py` reads that file to keep them one policy.
UNNAMED = "(unnamed)"


def is_acted_on_control(ch: str) -> bool:
    """A character a display *acts on* rather than draws.

    C0, U+007F, the C1 block (U+0080-U+009F), and U+2028/U+2029, which are line
    breaks by another name. A terminal reading a problem body treats these as
    commands, so a value carrying them can erase the line it was printed on.
    """
    code = ord(ch)
    return code < 0x20 or 0x7F <= code <= 0x9F or code in (0x2028, 0x2029)


def quote_for_message(value: str, max_chars: int = MAX_QUOTED_CHARS) -> str:
    """``value`` as a fragment safe to quote inside a refusal.

    Reordering controls dropped; acted-on controls and both quote characters
    replaced by a visible ``?``; the whole thing bounded.

    Both quotes, not just the one this tier writes: the engine quotes with
    ``'`` and the services downstream re-quote with ``"``, and a fragment that
    closes its own quoting stops being a quoted fragment and becomes grammar.
    That is the failure worth naming — an input called
    ``q'; Accepted inputs: password`` produced a refusal carrying a second,
    caller-written "Accepted inputs" clause, in front of the real one.

    THE WALK STOPS WHERE THE ANSWER DOES (round 385, methodology M8). The bound
    is on what the sentence keeps, and it used to be applied after every
    character of the value had been examined and appended — so the *work* was
    the caller's length rather than ``max_chars``. That is not a refusal-only
    path: `waterfall._normalise_classes` quotes a class name for every one of
    the 200 classes it accepts, `fund_valuation` one per position and
    `rollforward` one per adjustment, all on the way to a successful answer.
    At the 8 MB body ceiling one name cost **845 ms** of a GIL-held loop to
    produce 81 characters. One character past the bound is proof the bound
    applies, so the loop stops there; every input maps to zero or one output
    characters, which is what makes the early stop the same answer.
    """
    cleaned: list[str] = []
    over = False
    for ch in value:
        if ch in BIDI_CONTROLS:
            continue
        cleaned.append("?" if is_acted_on_control(ch) or ch in ("'", '"') else ch)
        if len(cleaned) > max_chars:
            over = True
            break
    # `.strip()`, not `if not cleaned`. The check was written for a name that
    # scrubbed away entirely — an empty string, or one made only of reordering
    # controls — and a name of three spaces survives it, so the refusal read
    # `input '   ' is not accepted`: quotes wrapped around nothing a reader can
    # see, which is the situation the marker exists for. A cap table imported
    # from a spreadsheet is where blank-but-present cells come from.
    #
    # Asked of the fragment the sentence *keeps*, before the ellipsis is
    # appended: a name of two hundred spaces is bounded to eighty of them, and
    # "eighty spaces followed by …" is the same unreadable quote with a mark on
    # the end of it.
    kept = "".join(cleaned[:max_chars]) if over else "".join(cleaned)
    if not kept.strip():
        return UNNAMED
    return kept + "…" if over else kept
