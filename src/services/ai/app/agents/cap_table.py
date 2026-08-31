"""Cap-Table Structuring Agent.

Parses articles of incorporation, charter, and cap-table documents into the
waterfall engine's ``share_classes`` schema. Multi-step:

  1. Identify — the model lists every security in the documents with its rights,
     citing the source document and a supporting quote for each value.
  2. Structure — the model converts that reading into the strict engine schema.
  3. Validate — deterministic in Python: coerce/whitelist every field so a
     hallucinated attribute can never reach the engine, then reconcile the
     computed share total against the stated one.

Engine schema (engine-wrapper/app/engine/waterfall.py):
  common   → {name, kind:"common",   shares}
  preferred→ {name, kind:"preferred",shares, preference, seniority,
              participating, conversion_ratio}  (+ participation cap metadata)
  option   → {name, kind:"option",   shares, strike}
"""

from __future__ import annotations

import json
from typing import Any

from . import _common as c

_KINDS = {"common", "preferred", "option"}

# How the model tends to spell each kind → the engine's canonical value.
_KIND_ALIASES = {
    "common": "common",
    "common stock": "common",
    "ordinary": "common",
    "ordinary shares": "common",
    "preferred": "preferred",
    "preferred stock": "preferred",
    "preference": "preferred",
    "series a": "preferred",
    "option": "option",
    "options": "option",
    "option pool": "option",
    "warrant": "option",
    "warrants": "option",
    "esop": "option",
}

_IDENTIFY_SYSTEM = (
    "You are a 409A cap-table analyst. You read a company's charter, articles of "
    "incorporation, and capitalization table and list every class of security "
    "with its economic rights. Report ONLY what the documents state; never "
    "invent share counts or preferences. Cite the source document and a short "
    "supporting quote for every value. Respond ONLY with JSON."
)

_STRUCTURE_SYSTEM = (
    "You convert an analyst's reading of a cap table into a strict machine "
    "schema for a valuation engine. Preserve the numbers exactly; do not add "
    "classes that were not identified. Respond ONLY with JSON."
)


def _shares(count: float) -> str:
    """A share count as an analyst reads it.

    `f"{n:g}"` was the spelling here and it switches to exponent notation above
    a million — which every share count on a cap table is. "parsed share total
    8e+06 does not reconcile with the stated total 5.0001e+06" is a validation
    issue that tells its reader neither figure, in the one place they are being
    asked to compare two numbers.
    """
    rounded = round(count, 4)
    if rounded == int(rounded):
        return f"{int(rounded):,}"
    return f"{rounded:,.4f}".rstrip("0").rstrip(".")


def _canon_kind(raw: Any) -> str | None:
    text = str(raw or "").strip().lower()
    if text in _KINDS:
        return text
    return _KIND_ALIASES.get(text)


def _normalize_class(raw: Any) -> tuple[dict | None, list[str]]:
    """Coerce one model-emitted class into the engine schema.

    Returns ``(class_or_None, issues)``. A class is dropped (None) only when it
    lacks the fields the engine strictly requires for its kind.
    """
    issues: list[str] = []
    if not isinstance(raw, dict):
        return None, ["dropped a non-object share class"]
    name = c.clean_str(raw.get("name"), limit=120)
    if not name:
        return None, ["dropped a share class with no name"]
    kind = _canon_kind(raw.get("kind"))
    if kind is None:
        return None, [f"'{name}': unrecognised kind {raw.get('kind')!r}, dropped"]
    shares = c.to_number(raw.get("shares"))
    if shares is None or shares <= 0:
        return None, [f"'{name}': missing or non-positive share count, dropped"]

    cls: dict[str, Any] = {"name": name, "kind": kind, "shares": shares}
    if kind == "preferred":
        pref = c.to_number(raw.get("preference"))
        if pref is None:
            pref = c.to_number(raw.get("liquidation_preference"))
        if pref is None or pref < 0:
            pref = 0.0
            issues.append(f"'{name}': no liquidation preference found, defaulted to 0")
        seniority = c.to_number(raw.get("seniority"))
        seniority_int = int(seniority) if seniority is not None and seniority >= 1 else 1
        ratio = c.to_number(raw.get("conversion_ratio"))
        conversion_ratio = ratio if ratio is not None and ratio > 0 else 1.0
        participating = bool(
            raw.get("participating")
            if raw.get("participating") is not None
            else raw.get("is_participating")
        )
        cls.update(
            preference=pref,
            seniority=seniority_int,
            participating=participating,
            conversion_ratio=conversion_ratio,
        )
        # The waterfall prices this rather than merely reporting it: a
        # participating class is uncapped precisely when `participation_cap` is
        # None (`waterfall.capped_drawing`), and an uncapped class keeps taking
        # its pro-rata share of every dollar above the preference where a capped
        # one stops. So None is an assertion, not an absence.
        participation = c.clean_str(raw.get("participation"), limit=40).lower()
        cap = c.to_number(raw.get("participation_cap"))
        if cap is not None:
            cls["participation_cap"] = cap
        elif participation == "uncapped":
            cls["participation_cap"] = None
        elif participation == "capped":
            # "capped" with no number is a combination the reading pass is
            # explicitly allowed to emit — the prompt asks for
            # `"participation": "capped|uncapped|none|null"` and a separate
            # `participation_cap` that may be null, and a term sheet naming a
            # cap the model cannot resolve to a figure lands here. Writing None
            # said "uncapped" to the waterfall, which is the one thing the
            # document had ruled out: the class then drew its full share of the
            # upside with no ceiling, taking proceeds that belong to common and
            # understating the common FMV this whole valuation concludes.
            # There is no cap to record, so the analyst has to supply it.
            issues.append(
                f"'{name}': participation is capped but no cap amount was read — "
                f"enter the cap, or the waterfall prices this class as uncapped"
            )
    elif kind == "option":
        strike = c.to_number(raw.get("strike"))
        if strike is None or strike <= 0:
            return None, [f"'{name}': option/warrant needs a positive strike, dropped"]
        cls["strike"] = strike
    return cls, issues


def _validate(
    share_classes: list[dict],
    total_stated: float | None,
    *,
    identified_count: int = 0,
    returned_count: int = 0,
) -> dict:
    """The deterministic third pass. See the module docstring.

    `identified_count` and `returned_count` are how many classes the reading
    step named and how many the structuring step returned. They are compared
    rather than merely recorded because the structuring prompt makes a promise
    — "do not add classes", "keep every number identical" — that nothing
    checked in either direction. A second model call that invents a class
    inflates the fully-diluted denominator every per-share figure is struck
    against; one that quietly omits a class deflates it. Neither leaves a trace
    otherwise: the reconciliation below only fires when the documents happened
    to state a fully-diluted total, and `total_shares_stated` is null on most
    charters.

    Counts, not names, because the two steps legitimately re-spell a class
    ("Series A Preferred Stock" → "Series A Preferred") and an issue an analyst
    cannot act on is worse than none. A count is exact.
    """
    computed = round(sum(cl["shares"] for cl in share_classes), 4)
    # The same table on the basis the identify prompt actually asks for.
    #
    # `total_shares_stated` is spelled "fully-diluted total the documents
    # state", and a fully-diluted total is an as-converted one: a charter
    # stating 12,000,000 fully diluted over 8,000,000 common and 2,000,000
    # Series A converting 2:1 is stating the converted count. The raw sum of
    # `shares` is 10,000,000, so the reconciliation below was comparing a figure
    # against a different figure's definition and calling the difference an
    # extraction error. The docstring's answer — "preferred convert
    # as-converted, so a tolerance beats an exact match" — is not one a
    # tolerance can give: a 2:1 ratio is 100% out, not 1%.
    #
    # Both bases are computed and agreement with either is agreement, which is
    # what `domain/capTable.validateCapTable` already does for the same question
    # about an uploaded sheet's totals row: a document is not asked to say which
    # basis it meant. Only preferred converts, matching the engine
    # (`waterfall._normalize` attaches a ratio to no other kind).
    converted = round(
        sum(
            cl["shares"] * (cl.get("conversion_ratio", 1.0) if cl["kind"] == "preferred" else 1.0)
            for cl in share_classes
        ),
        4,
    )
    issues: list[str] = []
    has_common = any(cl["kind"] == "common" for cl in share_classes)
    if not has_common:
        issues.append("no common class parsed — the engine requires at least one")
    if identified_count and returned_count and returned_count != identified_count:
        issues.append(
            f"the structuring step returned {returned_count} classes from the "
            f"{identified_count} the reading step identified — a class was "
            f"{'added' if returned_count > identified_count else 'lost'} between the "
            f"two passes; check the list against the documents before using it"
        )
    matches: bool | None = None
    if total_stated is not None and total_stated > 0:
        # A tolerance still, for rounding and for a charter that states the
        # total to the nearest thousand — but struck against each basis rather
        # than asked to absorb the difference between them.
        tolerance = max(1.0, 0.01 * total_stated)
        matches = (
            abs(computed - total_stated) <= tolerance or abs(converted - total_stated) <= tolerance
        )
        if not matches:
            basis = f" ({_shares(converted)} as converted)" if converted != computed else ""
            issues.append(
                f"parsed share total {_shares(computed)}{basis} does not reconcile "
                f"with the stated total {_shares(total_stated)}"
            )
    return {
        "share_total_computed": computed,
        # The as-converted count beside the raw one, so the analyst reading a
        # mismatch can see which basis the documents were stating.
        "share_total_as_converted": converted,
        "share_total_stated": total_stated,
        "reconciles": matches,
        "class_count": len(share_classes),
        "issues": issues,
    }


def _citations(identified: list, share_classes: list[dict], by_shown: dict) -> list[dict]:
    """Flatten per-field citations from the identify step, keeping only those
    tied to a class that survived structuring.

    `source_document` is the filename the model was shown, which is redacted;
    the analyst follows this citation back to a file in their own workspace, so
    it is mapped to the real name. A name we don't recognise is left as the
    model wrote it — already redacted, so a hallucinated one cannot leak."""
    kept = {cl["name"].lower() for cl in share_classes}
    out: list[dict] = []
    for entry in identified if isinstance(identified, list) else []:
        if not isinstance(entry, dict):
            continue
        cls_name = c.clean_str(entry.get("name"), limit=120)
        if cls_name.lower() not in kept:
            continue
        raw_cits = entry.get("citations")
        for cit in raw_cits if isinstance(raw_cits, list) else []:
            if not isinstance(cit, dict):
                continue
            shown = c.clean_str(cit.get("source_document"), limit=200)
            source = by_shown.get(shown)
            out.append(
                {
                    "class": cls_name,
                    "field": c.clean_str(cit.get("field"), limit=60),
                    "value": c.clean_str(cit.get("value"), limit=200),
                    "source_document": source.filename if source else shown,
                    "quote": c.clean_str(cit.get("quote"), limit=500),
                    "confidence": c.clamp_confidence(cit.get("confidence")),
                }
            )
    return out[:60]


def run_cap_table(payload: dict) -> tuple[str, dict]:
    red = c.redactor(payload)
    docs, _ = c.load_docs(payload, red)
    corpus, by_shown, reviewed = c.corpus(docs, red, 45000)

    identify_system, model = c.prompt_overrides(payload, _IDENTIFY_SYSTEM)
    identify_user = f"""Company: {c.subject(payload)}
Documents (charter / articles / cap table):
{corpus}

List every class of security. Return JSON:
{{
  "classes": [{{
    "name": "<e.g. Series A Preferred>",
    "kind": "common|preferred|option",
    "shares": <number>,
    "liquidation_preference": <total $ preference|null>,
    "seniority": <1=most senior|null>,
    "participation": "capped|uncapped|none|null",
    "participation_cap": <multiple or $ cap|null>,
    "conversion_ratio": <number|null>,
    "strike": <per-share strike for options|null>,
    "citations": [{{"field": "<shares|liquidation_preference|...>", "value": "<as written>", "source_document": "<filename>", "quote": "<short quote>", "confidence": <0-1>}}]
  }}],
  "total_shares_stated": <fully-diluted total the documents state|null>,
  "notes": "<one paragraph on anything ambiguous>"
}}
Only include values the documents actually contain."""

    first = c.ask(red, identify_system, identify_user, model)
    identified_doc = c.safe_result(first)
    identified_raw = identified_doc.get("classes") if isinstance(identified_doc, dict) else None
    # A non-list here is a model answering off-contract, and `len(identified)` is
    # now load-bearing — a dict of classes would count its keys and reconcile
    # against nothing meaningful.
    identified = identified_raw if isinstance(identified_raw, list) else []
    total_stated = (
        c.to_number(identified_doc.get("total_shares_stated"))
        if isinstance(identified_doc, dict)
        else None
    )

    structure_user = f"""An analyst identified these securities:
{json.dumps(identified, default=str)[:20000]}

Convert them to the valuation engine schema. Return JSON:
{{
  "share_classes": [
    {{"name": "<name>", "kind": "common", "shares": <number>}},
    {{"name": "<name>", "kind": "preferred", "shares": <number>, "preference": <total $>, "seniority": <int>=1>, "participating": <bool>, "conversion_ratio": <number>, "participation_cap": <number|null>}},
    {{"name": "<name>", "kind": "option", "shares": <number>, "strike": <per-share $>}}
  ]
}}
Keep every number identical to the input. 'preference' is the TOTAL preference
in dollars. Lower seniority number = paid first. Do not add classes."""

    second = c.ask(red, _STRUCTURE_SYSTEM, structure_user, model)
    structured = c.safe_result(second)
    raw_classes = (
        structured.get("share_classes") if isinstance(structured, dict) else None
    ) or []

    share_classes: list[dict] = []
    all_issues: list[str] = []
    # Two entries for one class is the failure this loop has to catch, because
    # nothing downstream can. The engine takes the list as given, so a "Series A
    # Preferred" returned twice is 2,000,000 shares counted as 4,000,000: the
    # fully-diluted denominator every per-share figure divides by, doubled by a
    # model repeating itself. It is also invisible — the reconciliation against
    # `total_shares_stated` is the only thing that would notice, and most
    # charters state no fully-diluted total, so `reconciles` comes back null and
    # the run reads as clean.
    #
    # Kind travels in the key: an option pool named after the class it sits under
    # is a real cap table, and refusing that would drop a class the documents do
    # contain. A repeat of the same name *and* kind is not.
    seen: set[tuple[str, str]] = set()
    for raw in raw_classes[:40]:
        cls, issues = _normalize_class(raw)
        all_issues.extend(issues)
        if cls is None:
            continue
        key = (cls["name"].strip().lower(), cls["kind"])
        if key in seen:
            # Dropped rather than merged: two rows for one class disagreeing on
            # a share count is a reading the analyst has to settle, and silently
            # keeping either one would be this code making that call.
            all_issues.append(
                f"'{cls['name']}': returned twice as a {cls['kind']} class — the "
                f"second entry ({_shares(cls['shares'])} shares) was dropped; check "
                f"the share count against the documents"
            )
            continue
        seen.add(key)
        share_classes.append(cls)

    validation = _validate(
        share_classes,
        total_stated,
        identified_count=len(identified),
        returned_count=len(raw_classes),
    )
    validation["issues"] = [*all_issues, *validation["issues"]][:20]

    result = {
        "share_classes": share_classes,
        "citations": _citations(identified, share_classes, by_shown),
        "validation": validation,
        "notes": c.clean_str(identified_doc.get("notes"))
        if isinstance(identified_doc, dict)
        else "",
        "documents_reviewed": [d.filename for d in reviewed],
        "anonymization": red.report(),
    }
    # Model of record is the structuring call (what produced the schema).
    return second.model, result
