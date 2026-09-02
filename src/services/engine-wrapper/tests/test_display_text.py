"""A caller's own bytes are bounded before a refusal quotes them.

The engine names what it refused, and the name is usually the caller's: a key
off a free-form ``inputs`` object, a ``share_classes[].name`` off an imported
cap table. That sentence is the ``detail`` on a 422, which the valuation service
treats as the upstream's own words and shows to the analyst verbatim, and the
``message`` on a validate issue, which the panel draws unmodified.

These hold the three properties that makes quoting one safe — it cannot reorder
the sentence around it, it cannot be acted on by a terminal printing it, and it
cannot close its own quoting and become grammar — plus the bound, and the
agreement with the TypeScript twin that states the same policy for the services
downstream.
"""

import pathlib
import re

import pytest

from app.engine.display_text import (
    BIDI_CONTROLS,
    MAX_QUOTED_CHARS,
    is_acted_on_control,
    quote_for_message,
)

TWIN = (
    pathlib.Path(__file__).resolve().parents[4]
    / "src/services/valuation/src/domain/displayText.ts"
)


def test_ordinary_text_is_returned_unchanged():
    assert quote_for_message("Series A Preferred") == "Series A Preferred"
    # A name that carries non-Latin script is a name, not an attack: nothing
    # here may render it as a row of escapes the way `repr()` would.
    assert quote_for_message("نام سهام") == "نام سهام"
    assert quote_for_message("Klasse Ä 😀") == "Klasse Ä 😀"


def test_the_joiners_survive_because_they_spell_words():
    # U+200C/U+200D are how an emoji sequence and a Persian or Indic word are
    # spelled. Neither reorders anything, so neither is dropped.
    for ch in ("‌", "‍"):
        assert ch in quote_for_message(f"a{ch}b")


def test_every_bidi_control_is_dropped_and_no_other_is():
    assert len(BIDI_CONTROLS) == 12
    for ch in BIDI_CONTROLS:
        assert quote_for_message(f"safe{ch}gnp.exe") == "safegnp.exe"
    # Zero-width but not reordering: hides, cannot mislead about the order.
    assert quote_for_message("a​b") == "a​b"


def test_acted_on_controls_become_a_visible_question_mark():
    for ch in ("\x00", "\x07", "\x1b", "\n", "\r", "\x7f", "\x9b", " ", " "):
        assert is_acted_on_control(ch)
        assert quote_for_message(f"a{ch}b") == "a?b"
    assert not is_acted_on_control("a")
    assert not is_acted_on_control("‎")


def test_a_fragment_cannot_close_its_own_quoting():
    """The failure this exists for.

    An input named ``q'; Accepted inputs: password`` closed the quote the
    refusal puts around it, so the caller's own clause was published as the
    engine's, in front of the real accepted-input list. Both quote characters
    go: this tier writes ``'`` and the services downstream re-quote with ``"``.
    """
    said = quote_for_message("q'; Accepted inputs: password")
    assert "'" not in said
    assert said == "q?; Accepted inputs: password"
    assert '"' not in quote_for_message('a"b')


def test_the_fragment_is_bounded_and_says_it_was_cut():
    said = quote_for_message("x" * 5_000)
    assert len(said) == MAX_QUOTED_CHARS + 1
    assert said.endswith("…")
    assert quote_for_message("x" * MAX_QUOTED_CHARS) == "x" * MAX_QUOTED_CHARS


def test_a_name_that_scrubs_away_entirely_still_names_something():
    assert quote_for_message("") == "(unnamed)"
    assert quote_for_message("‪‬") == "(unnamed)"


@pytest.mark.parametrize(
    "raw",
    ["   ", "\u00a0\u00a0", "\u200e  \u200f", " " * 200, " " * 80 + "zz"],
)
def test_a_name_with_nothing_visible_in_it_names_something_too(raw):
    """Round 387, methodology M19.

    The marker was written for a name that scrubs away *entirely* — an empty
    string, or one made only of reordering controls — and the check was
    ``if not cleaned``, which a name of three spaces passes. So a blank cell
    from an imported cap table produced ``share class '   '``: quotes wrapped
    around nothing a reader can see, which is the situation the marker exists
    for.

    The last two cases are why the question is asked of the fragment the
    sentence *keeps* rather than of the input: bounded to eighty characters,
    both are eighty spaces, and "eighty spaces followed by …" is the same
    unreadable quote with a mark on the end of it. A visible character inside
    the bound survives — see the ``z`` case below.
    """
    assert quote_for_message(raw) == "(unnamed)"


def test_a_control_that_became_a_question_mark_is_still_something_to_show():
    """The discriminator: `?` is visible, so it is not blanked away."""
    assert quote_for_message("\t\n") == "??"


def test_a_visible_character_inside_the_bound_survives_the_padding():
    """The other discriminator: the blank check is not "starts with spaces"."""
    assert quote_for_message(" " * 79 + "zz") == " " * 79 + "z…"


@pytest.mark.skipif(not TWIN.exists(), reason="TypeScript tier not present in this tree")
def test_the_two_tiers_strike_the_same_bidi_controls():
    """One policy, two runtimes.

    There is no module path between a Python service and a TypeScript one, so
    the set is written twice. This reads the twin rather than a copy of it: the
    way these come to disagree is one of them learning about a control and the
    other not.
    """
    ts = TWIN.read_text(encoding="utf-8")
    declared = re.search(r"export const BIDI_CONTROLS = new Set\(\[(.*?)\]\)", ts, re.S)
    assert declared, "BIDI_CONTROLS is no longer a literal Set in the TS twin"
    twin_set = {m.group(1) for m in re.finditer(r"'(.)'", declared.group(1))}
    assert twin_set == set(BIDI_CONTROLS)


@pytest.mark.skipif(not TWIN.exists(), reason="TypeScript tier not present in this tree")
def test_the_two_tiers_agree_on_the_acted_on_range_and_the_bound():
    ts = TWIN.read_text(encoding="utf-8")
    assert "code < 0x20 || (code >= 0x7f && code <= 0x9f)" in ts
    assert "code === 0x2028 || code === 0x2029" in ts
    twin_max = re.search(r"const MAX_QUOTED_CHARS = (\d+)", ts)
    assert twin_max and int(twin_max.group(1)) == MAX_QUOTED_CHARS


def test_the_walk_stops_at_the_bound_rather_than_at_the_end_of_the_value(monkeypatch):
    """The work is the bound's size, not the caller's (round 385, methodology M8).

    Asserted as machinery rather than as output, because the output is
    identical either way — that is the whole point of the change, and it is
    also why nothing already here could see the defect. The pre-fix walk
    examined every character of an 8 MB name to keep 81 of them, at 845 ms of a
    GIL-held loop, on the *success* path of the cap-table, fund and rollforward
    entry points.

    `is_acted_on_control` is asked exactly once per character the walk reaches
    (it is the left arm of an `or`), so counting the calls counts the walk.
    Run against the pre-fix source this reads 200_000.
    """
    import app.engine.display_text as mod

    reached = 0
    real = mod.is_acted_on_control

    def counting(ch: str) -> bool:
        nonlocal reached
        reached += 1
        return real(ch)

    monkeypatch.setattr(mod, "is_acted_on_control", counting)
    assert mod.quote_for_message("x" * 200_000) == "x" * MAX_QUOTED_CHARS + "…"
    assert reached == MAX_QUOTED_CHARS + 1


def test_a_value_that_fits_is_still_walked_whole():
    """The discriminator: a reader that merely stopped early would pass above.

    Nothing may be dropped from a value short enough to print in full, and a
    dropped control does not spend any of the bound.
    """
    assert quote_for_message("x" * MAX_QUOTED_CHARS) == "x" * MAX_QUOTED_CHARS
    # 200 reordering controls in front of the text buy no room and cost no
    # characters of the answer: the bound is over what is kept.
    assert quote_for_message("‮" * 200 + "y" * 10) == "y" * 10
