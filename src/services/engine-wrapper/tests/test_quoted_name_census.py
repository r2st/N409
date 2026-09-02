"""Every name this tier quotes back at a caller goes through the bound.

A refusal that names what it refused is better than one that does not, and the
name is usually the caller's own bytes — a key off a free-form ``inputs``
object, a ``share_classes[].name`` off an imported cap table, a comparable's
ticker. R383 found four things such a name could do to the sentence quoting it:
close its own quoting and become a clause beside it, reorder the text around
it, be acted on by the terminal printing it, and — because the receiving hop
cuts an upstream ``detail`` at 500 characters — decide which half of the
sentence the analyst gets to read.

That was fixed at eleven sites. This is the part that keeps it fixed: the next
refusal written in the same shape fails here rather than shipping. It asserts
the fact rather than a spelling — what may appear between the single quotes of
a message is a value that has been through :func:`quote_for_message`, a
variable named for having been, or one of the exemptions below, each of which
is a value this tier produced rather than one it was handed.
"""

import ast
import pathlib
import re

ENGINE = pathlib.Path(__file__).resolve().parents[1] / "app" / "engine"

# A `'{...}'` inside a message: a name being quoted at whoever reads it.
QUOTED = re.compile(r"'\{([^{}]+)\}'")

# What may sit there besides a `quote_for_message(...)` call. Each is a string
# this tier chose, not one a caller sent, and the reason is the entry.
EXEMPT = {
    # Read off a signature in this process by `_signature_names`.
    "near[0]": "kwargs_refusal: an accepted parameter name, from a signature here",
    "m": "kwargs_refusal: a required parameter name, from a signature here",
}

# The naming convention the census reads: a variable holding the display copy
# of a caller's name is called `shown`, or `shown_<something>`. The raw value
# keeps the plain name, because it is usually load-bearing — the key an
# allocation is returned under, the label echoed back in a step.
SHOWN = re.compile(r"^shown(_[a-z_]+)?$")


def _sources() -> list[pathlib.Path]:
    return sorted(p for p in ENGINE.glob("*.py") if p.name != "display_text.py")


def test_the_census_can_see_the_sites_it_is_about():
    """A census that has stopped matching passes by having nothing to ask.

    `'{...}'` is the shape the finding was in; if a refactor moves the messages
    to another spelling this stops being evidence of anything, so the count is
    pinned loosely rather than left to be zero.
    """
    found = sum(len(QUOTED.findall(p.read_text())) for p in _sources())
    assert found >= 25, f"only {found} quoted names in {ENGINE} — has the shape moved?"


def test_every_quoted_name_is_bounded_before_it_is_quoted():
    unbounded: list[str] = []
    for path in _sources():
        for n, line in enumerate(path.read_text().split("\n"), 1):
            for match in QUOTED.finditer(line):
                expr = match.group(1).strip()
                if "quote_for_message" in expr or SHOWN.match(expr) or expr in EXEMPT:
                    continue
                unbounded.append(f"{path.name}:{n}: '{{{expr}}}'")
    assert not unbounded, (
        "a refusal quotes a name nothing bounded — put it through "
        "quote_for_message, or name the variable `shown` if it already is:\n"
        + "\n".join(unbounded)
    )


def test_the_display_copy_never_becomes_the_stored_one():
    """`shown` is for prose; the raw name is what the calculation returns.

    The other direction of the same mistake: scrubbing the value the engine
    keys its output by, so two classes whose names differ only in a control
    character silently become one. Every `shown = quote_for_message(x)` must
    leave `x` itself alone.
    """
    for path in _sources():
        source = path.read_text()
        # Scoped to the modules that have the bound. `shown` is an ordinary
        # English word and a module with no display copy to hold is not making
        # this mistake — `market_universe.provenance` uses it for the warnings
        # it is about to print.
        if "from .display_text import quote_for_message" not in source:
            continue
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                continue
            target = node.targets[0]
            if not isinstance(target, ast.Name) or not SHOWN.match(target.id):
                continue
            call = node.value
            if isinstance(call, ast.BoolOp):  # `shown_label = shown or "…"`
                continue
            if isinstance(call, ast.IfExp):  # `shown = quote_for_message(x) if x else ""`
                call = call.body
            assert isinstance(call, ast.Call), f"{path.name}:{node.lineno}: not a call"
            assert getattr(call.func, "id", None) == "quote_for_message", (
                f"{path.name}:{node.lineno}: a `shown` variable that is not the bounded copy"
            )
