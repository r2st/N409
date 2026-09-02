"""Company Profile Agent.

Drafts the structured company detail behind a report's "Company Overview and
Industry Analysis" section: what the business does, how it classifies (SIC and
NAICS), and the handful of scale metrics a valuation quotes.

## What it reads, and what it does not

It reads *the engagement's own uploaded documents* — the pitch deck, the
financials, the intake answers already extracted into params — through the same
redactor every other pipeline uses. It does not look the company up.

That is the whole design, not a limitation worked around. 409.ai's
``company_overview`` prompt asks Perplexity what the web says about the subject
of the valuation; this platform refuses that trade deliberately, and
``domain/research.ts`` is fenced so there is no code path from a client's name
to a search provider. A description drafted from the deck is also the better
input: a reviewer can follow it back to a document in the engagement, which is
exactly what a description recalled from a model's weights cannot offer.

So the model here never sees the company's name — ``[COMPANY]`` is what arrives
after redaction — and the prompt is written for that. "Summarise what this
company does" is answerable from a deck without knowing whose deck it is;
"tell me about Acme Robotics" is not, and is the question that invites the model
to fill a gap from memory.

## Why classification is a list

SIC and NAICS both come back as ranked candidates with a justification rather
than one code, because two codes are frequently defensible for the same
business and the analyst is the one who picks. The apply path takes the leading
candidate and stores the rest, so the choice stays visible and reversible.

Everything is normalised in Python: a code that is not digits is dropped rather
than stored, since a malformed SIC reaches the comparable screen and silently
ranks against nothing.
"""

from __future__ import annotations

import re
from typing import Any

from . import _common as c

_SYSTEM = (
    "You are a business analyst preparing the company section of a formal "
    "valuation report. You are given a company's own documents with identifying "
    "details removed; describe the business strictly from what those documents "
    "say. Never infer a fact from the company's identity — you have not been "
    "told it, and a detail you cannot point to in the documents does not belong "
    "in a valuation report. Where the documents do not answer something, leave "
    "it null rather than estimating. Respond ONLY with JSON."
)

#: How much of the corpus one profile call carries. Smaller than the cap-table
#: agent's 45k: this one wants the deck's narrative and the top of the
#: financials, not every row of a share ledger.
CORPUS_LIMIT = 30_000

#: Ranked classification candidates kept per scheme. More than three is a list
#: nobody reads to the end of, and the ranking is the point.
MAX_CODES = 3

#: How far down a returned list to look for those candidates. Bounds the work a
#: pathological response can cause without letting a few malformed entries at
#: the head hide the usable code behind them.
SCAN_LIMIT = 20

#: The scale figures a valuation report quotes. `key` is what the apply path
#: looks for, so these strings are load-bearing on both sides.
METRIC_KEYS = ("revenue", "employees", "founded_year", "stage", "business_model", "customers")

_SIC_RE = re.compile(r"^\d{2,4}$")
_NAICS_RE = re.compile(r"^\d{2,6}$")


def _codes(raw: Any, pattern: re.Pattern[str]) -> list[dict]:
    """Ranked, well-formed classification candidates.

    A code that is not digits of the right length is dropped rather than
    cleaned: the comparable screen ranks on the SIC and a malformed one matches
    no universe row, so it would present as "no comparable companies found"
    rather than as the bad input it is.

    The cap counts what survives, not what was offered. Truncating first would
    let three malformed entries spend the whole budget and return nothing —
    reading as "the documents did not classify this business" when the model in
    fact ranked a usable code fourth.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for entry in raw[:SCAN_LIMIT] if isinstance(raw, list) else []:
        if len(out) >= MAX_CODES:
            break
        if not isinstance(entry, dict):
            continue
        code = c.clean_str(entry.get("code"), limit=10).strip()
        if not pattern.match(code) or code in seen:
            continue
        seen.add(code)
        out.append(
            {
                "code": code,
                "title": c.clean_str(entry.get("title"), limit=300),
                "rationale": c.clean_str(entry.get("rationale"), limit=600),
            }
        )
    return out


def _metrics(raw: Any) -> list[dict]:
    """The scale figures, as a fixed list so the UI renders every one the same.

    A metric the documents did not answer comes back with a null value and its
    source empty, rather than being absent: "the deck does not say how many
    employees" is a finding an analyst acts on, and a missing key is one they
    never see.
    """
    by_key = raw if isinstance(raw, dict) else {}
    out: list[dict] = []
    for key in METRIC_KEYS:
        entry = by_key.get(key)
        entry = entry if isinstance(entry, dict) else {}
        value = c.clean_str(entry.get("value"), limit=300)
        out.append(
            {
                "key": key,
                "value": value or None,
                # The document the figure was read from. Without it the metric is
                # an assertion; with it, it is a citation an analyst can check.
                "source_document": c.clean_str(entry.get("source_document"), limit=300),
                "confidence": c.clamp_confidence(entry.get("confidence")),
            }
        )
    return out


def run_company_profile(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}

    red = c.redactor(payload)
    corpus, _, reviewed = c.load_corpus(payload, red, CORPUS_LIMIT)

    system, model = c.prompt_overrides(payload, _SYSTEM)
    metric_spec = ",\n".join(
        f'    "{key}": {{"value": "<as the documents state it, or null>", '
        f'"source_document": "<filename>", "confidence": <0-1>}}'
        for key in METRIC_KEYS
    )
    user = f"""Company: {c.subject(payload)} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Known parameters: {c.params_summary(params)}
The company's own documents:
{corpus}

Draft the company profile. Return JSON:
{{
  "business_description": "<2-3 paragraphs: what the company does, who it sells to, how it makes money, its stage and traction — strictly from the documents>",
  "industry": "<the industry in plain English, one short phrase>",
  "sic_codes": [{{"code": "<2-4 digits>", "title": "<official title>", "rationale": "<one line>"}}],
  "naics_codes": [{{"code": "<2-6 digits>", "title": "<official title>", "rationale": "<one line>"}}],
  "key_metrics": {{
{metric_spec}
  }},
  "documents_used": ["<filename>", ...],
  "gaps": ["<a fact the company section needs that the documents do not contain>", ...],
  "confidence": <0-1 overall>
}}
Rank the classification candidates most likely first. Leave any value the documents do not support null — do not estimate one."""

    llm = c.ask(red, system, user, model)
    parsed = c.safe_result(llm, "company_profile")
    doc = parsed if isinstance(parsed, dict) else {}

    sic = _codes(doc.get("sic_codes"), _SIC_RE)
    naics = _codes(doc.get("naics_codes"), _NAICS_RE)
    result = {
        "business_description": c.clean_str(doc.get("business_description"), limit=8000),
        "industry": c.clean_str(doc.get("industry"), limit=200),
        "sic_codes": sic,
        "naics_codes": naics,
        # The leading candidate, lifted out so the apply path and the UI do not
        # each have to decide what "the" code is and disagree.
        "sic_code": sic[0]["code"] if sic else None,
        "naics_code": naics[0]["code"] if naics else None,
        "key_metrics": _metrics(doc.get("key_metrics")),
        "documents_reviewed": [d.filename for d in reviewed],
        "documents_used": c.str_list(doc.get("documents_used"), limit=20, item_limit=300),
        # What the profile still needs. This is the half an analyst acts on:
        # a description with three gaps named is a to-do list, and one with none
        # named is a claim of completeness the agent has not earned.
        "gaps": c.str_list(doc.get("gaps"), limit=12, item_limit=500),
        "confidence": c.clamp_confidence(doc.get("confidence")),
        "anonymization": red.report(),
    }
    return llm.model, result
