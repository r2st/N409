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
        # Participation-cap metadata (engine ignores it; the analyst wants it).
        participation = c.clean_str(raw.get("participation"), limit=40).lower()
        cap = c.to_number(raw.get("participation_cap"))
        if cap is not None:
            cls["participation_cap"] = cap
        elif participation in {"capped", "uncapped"}:
            cls["participation_cap"] = None if participation == "uncapped" else cap
    elif kind == "option":
        strike = c.to_number(raw.get("strike"))
        if strike is None or strike <= 0:
            return None, [f"'{name}': option/warrant needs a positive strike, dropped"]
        cls["strike"] = strike
    return cls, issues


def _validate(share_classes: list[dict], total_stated: float | None) -> dict:
    computed = round(sum(cl["shares"] for cl in share_classes), 4)
    issues: list[str] = []
    has_common = any(cl["kind"] == "common" for cl in share_classes)
    if not has_common:
        issues.append("no common class parsed — the engine requires at least one")
    matches: bool | None = None
    if total_stated is not None and total_stated > 0:
        # Preferred convert as-converted, so a tolerance beats an exact match.
        matches = abs(computed - total_stated) <= max(1.0, 0.01 * total_stated)
        if not matches:
            issues.append(
                f"parsed share total {computed:g} does not reconcile with the "
                f"stated total {total_stated:g}"
            )
    return {
        "share_total_computed": computed,
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
    corpus, by_shown = c.corpus(docs, red, 45000)

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
    identified = (
        identified_doc.get("classes") if isinstance(identified_doc, dict) else None
    ) or []
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
    for raw in raw_classes[:40]:
        cls, issues = _normalize_class(raw)
        all_issues.extend(issues)
        if cls is not None:
            share_classes.append(cls)

    validation = _validate(share_classes, total_stated)
    validation["issues"] = [*all_issues, *validation["issues"]][:20]

    result = {
        "share_classes": share_classes,
        "citations": _citations(identified, share_classes, by_shown),
        "validation": validation,
        "notes": c.clean_str(identified_doc.get("notes"))
        if isinstance(identified_doc, dict)
        else "",
        "documents_reviewed": [d.filename for d in docs],
        "anonymization": red.report(),
    }
    # Model of record is the structuring call (what produced the schema).
    return second.model, result
