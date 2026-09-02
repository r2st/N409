"""Report Narrative Drafting Agent.

Turns a finished valuation calculation into the prose sections of a 409A report.
One structured generation call; the section list is fixed and enforced in Python
so the report template always receives the same keys, and each requested section
that the model omits comes back as an empty string rather than a missing key.
"""

from __future__ import annotations

import json
from typing import Any

from . import _common as c

# (key, human title, guidance shown to the model)
SECTIONS: tuple[tuple[str, str, str], ...] = (
    ("executive_summary", "Executive Summary",
     "the engagement, the concluded fair market value per share, the valuation date, and the standard of value"),
    ("company_overview", "Company Overview and Industry Analysis",
     "what the company does, its stage and traction, and the industry it competes in"),
    ("valuation_methodology", "Valuation Methodology",
     "which approaches were used, why they fit this company, and how they were weighted"),
    ("market_approach", "Market Approach Analysis",
     "the guideline public companies selected, the selection rationale, and the multiples applied"),
    ("income_approach", "Income Approach Analysis",
     "the projection assumptions and the discount-rate / WACC build-up"),
    ("allocation_methodology", "Allocation Methodology",
     "the OPM and/or PWERM rationale and the allocation of equity value to the common shares"),
    ("dlom_analysis", "Discount for Lack of Marketability",
     "the DLOM method chosen, the factors considered, and the resulting discount"),
    ("conclusion", "Conclusion and Fair Market Value",
     "the reconciliation across approaches and the final concluded fair market value per common share"),
)

_SYSTEM = (
    "You are a senior 409A valuation analyst drafting the narrative sections of "
    "a formal valuation report. Write in a professional, defensible third-person "
    "tone suitable for an IRS or auditor review. Use the specific figures from "
    "the calculation provided; never invent numbers or cite data that is not "
    "given. Each section is 2-4 paragraphs. Respond ONLY with JSON."
)


def sections_for(payload: dict) -> tuple[tuple[str, str, str], ...]:
    """The section list this run drafts, as (key, title, guidance).

    The valuation service resolves the narrative prompt library (migration
    0114 — base rows plus the report type's overrides) and ships the winners
    as `narrative_sections`. That is what makes a QSBS memorandum come back
    with four statutory tests instead of a DLOM discussion.

    `SECTIONS` remains the fallback, and deliberately so: a database that has
    not run 0114, or a caller that sends nothing, should still get a complete
    409A narrative rather than a report with no prose in it. Rows missing a key
    or guidance are skipped rather than drafted as an untitled blank.
    """
    raw = payload.get("narrative_sections")
    if not isinstance(raw, list):
        return SECTIONS

    resolved: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = c.clean_str(item.get("key"), limit=200).strip()
        guidance = c.clean_str(item.get("guidance"), limit=4000).strip()
        if not key or not guidance or key in seen:
            continue
        seen.add(key)
        title = c.clean_str(item.get("label"), limit=300).strip() or key.replace("_", " ").title()
        resolved.append((key, title, guidance))

    return tuple(resolved) if resolved else SECTIONS


def _methodology_summary(payload: dict) -> str:
    meth = payload.get("methodology")
    if isinstance(meth, dict) and meth:
        return json.dumps(meth, default=str)[:6000]
    return "(infer the methodology from the calculation results)"


#: How many research answers ride along, and how much of each. A narrative call
#: already carries the calculation, the params and the section library; an
#: unbounded research block would crowd them out of the context window, and the
#: sections that read research are the ones that would lose.
MAX_RESEARCH_ITEMS = 8
MAX_RESEARCH_CHARS = 2500
MAX_CITATIONS_PER_ITEM = 8


def research_block(payload: dict) -> str:
    """Web-grounded market research for this engagement, as prompt text.

    The valuation service ships the live `market_research` rows (migration
    0116) as `market_research`, already filtered to the grounded ones — an
    answer produced without retrieved citations was written from the model's
    weights, and quoting one in a report next to sourced claims is precisely the
    failure `research.py` declines to call the model at all to prevent.

    The URLs travel with the text on purpose. The drafted narrative's value over
    the model's own recollection is that a reviewer can follow the source, so a
    research paragraph arriving without its citations would be worth less than
    no research at all: it would read as authoritative and be uncheckable.
    """
    raw = payload.get("market_research")
    if not isinstance(raw, list) or not raw:
        return ""

    lines: list[str] = []
    for item in raw[:MAX_RESEARCH_ITEMS]:
        if not isinstance(item, dict):
            continue
        answer = c.clean_str(item.get("answer"), limit=MAX_RESEARCH_CHARS)
        if not answer:
            continue
        topic = c.clean_str(item.get("topic"), limit=100) or "research"
        region = c.clean_str(item.get("region"), limit=20)
        retrieved = c.clean_str(item.get("retrieved_at"), limit=40)
        header = f"[{topic} · {region}]" if region else f"[{topic}]"
        if retrieved:
            header = f"{header} retrieved {retrieved[:10]}"
        lines.append(f"{header}\n{answer}")

        cites = item.get("citations")
        if isinstance(cites, list):
            urls: list[str] = []
            for cite in cites[:MAX_CITATIONS_PER_ITEM]:
                url = cite.get("url") if isinstance(cite, dict) else cite
                url = c.clean_str(url, limit=400)
                if url:
                    urls.append(url)
            if urls:
                lines.append("Sources: " + "; ".join(urls))

    if not lines:
        return ""
    return (
        "\n\nMarket research retrieved from public sources (cite these URLs where you "
        "use them; do not assert a figure that is not in this block or the calculation):\n"
        + "\n\n".join(lines)
    )


#: How much of the drafted profile rides along. The description is the bulk of
#: it and is already capped at 8k by the agent that wrote it; this bounds a
#: hand-edited one so the profile cannot crowd the calculation out of the
#: context window — the figures are what the sections are graded on.
MAX_PROFILE_CHARS = 6000


def profile_block(payload: dict) -> str:
    """The company's structured profile, as prompt text.

    The `company_overview` section has always been asked for "what the company
    does, its stage and traction, and the industry it competes in" with nothing
    in front of the model that says any of it — the calculation carries share
    counts and discount rates, not a business description. So the section was
    drafted from whatever the params implied, which is how a company overview
    ends up describing a generic company at that revenue.

    The valuation service ships `company_profiles` (migration 0151) here when a
    row exists. It travels through the redactor with everything else: the
    description was itself drafted from redacted documents, and a hand-edited
    one can easily have had the company's name typed back into it.
    """
    raw = payload.get("company_profile")
    if not isinstance(raw, dict):
        return ""
    fields = (
        ("business_description", "What the company does"),
        ("industry", "Industry"),
        ("sic_code", "SIC"),
        ("naics_code", "NAICS"),
        ("revenue_range", "Revenue range"),
        ("employee_count", "Employees"),
        ("founded_on", "Founded"),
    )
    lines = []
    for key, label in fields:
        value = c.clean_str(raw.get(key), limit=MAX_PROFILE_CHARS)
        if value:
            lines.append(f"{label}: {value}")
    if not lines:
        return ""
    return (
        "\n\nThe company's profile, as recorded on the engagement (use it for the "
        "company and industry discussion; do not contradict it):\n" + "\n".join(lines)
    )


def _sections(doc: Any, spec: tuple[tuple[str, str, str], ...]) -> list[dict]:
    """Every requested key, in order, filled from the model or blanked."""
    raw = doc.get("sections") if isinstance(doc, dict) else None
    by_key = raw if isinstance(raw, dict) else {}
    out: list[dict] = []
    for key, title, _guidance in spec:
        out.append(
            {
                "key": key,
                "title": title,
                "body": c.clean_str(by_key.get(key), limit=8000),
            }
        )
    return out


def run_report_narrative(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}

    red = c.redactor(payload)
    system, model = c.prompt_overrides(payload, _SYSTEM)
    spec = sections_for(payload)
    section_spec = "\n".join(f'  "{k}": "<{g}>"' for k, _t, g in spec)
    user = f"""Company: {c.subject(payload)} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Params: {c.params_summary(params)}
Methodology choices: {_methodology_summary(payload)}
Calculation results: {c.calculation_summary(payload)}{profile_block(payload)}{research_block(payload)}

Draft the report narrative. Return JSON:
{{
  "sections": {{
{section_spec}
  }}
}}
Write each section as 2-4 professional paragraphs using the actual figures above.
If a section's approach did not carry weight, say so briefly rather than padding."""

    llm = c.ask(red, system, user, model)
    parsed = c.safe_result(llm, "report_narrative")
    result = {
        "sections": _sections(parsed, spec),
        "section_keys": [k for k, _t, _g in spec],
        # What the draft was written against, recorded on the job. Without it,
        # "which research was in front of the model" is answerable only by
        # comparing timestamps against an append-only table that has since moved
        # on — and that is the first question asked of a cited paragraph.
        "research_topics": _research_topics(payload),
        "anonymization": red.report(),
    }
    return llm.model, result


def _research_topics(payload: dict) -> list[str]:
    raw = payload.get("market_research")
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw[:MAX_RESEARCH_ITEMS]:
        if not isinstance(item, dict):
            continue
        topic = c.clean_str(item.get("topic"), limit=100)
        region = c.clean_str(item.get("region"), limit=20)
        if topic:
            out.append(f"{topic}:{region}" if region else topic)
    return out
