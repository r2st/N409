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


def _methodology_summary(payload: dict) -> str:
    meth = payload.get("methodology")
    if isinstance(meth, dict) and meth:
        return json.dumps(meth, default=str)[:6000]
    return "(infer the methodology from the calculation results)"


def _sections(doc: Any) -> list[dict]:
    """Every SECTION key, in order, filled from the model or blanked."""
    raw = doc.get("sections") if isinstance(doc, dict) else None
    by_key = raw if isinstance(raw, dict) else {}
    out: list[dict] = []
    for key, title, _guidance in SECTIONS:
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

    system, model = c.prompt_overrides(payload, _SYSTEM)
    section_spec = "\n".join(f'  "{k}": "<{g}>"' for k, _t, g in SECTIONS)
    user = f"""Company: {valuation.get("company_name")} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Params: {c.params_summary(params)}
Methodology choices: {_methodology_summary(payload)}
Calculation results: {c.calculation_summary(payload)}

Draft the report narrative. Return JSON:
{{
  "sections": {{
{section_spec}
  }}
}}
Write each section as 2-4 professional paragraphs using the actual figures above.
If a section's approach did not carry weight, say so briefly rather than padding."""

    llm = c.chat(system, user, model=model)
    parsed = c.safe_result(llm)
    result = {
        "sections": _sections(parsed),
        "section_keys": [k for k, _t, _g in SECTIONS],
    }
    return llm.model, result
