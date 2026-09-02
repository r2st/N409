"""Audit Defense Agent.

Given a completed valuation with its assumptions and methodology, anticipates
the challenges an IRS reviewer or financial-statement auditor is likely to raise
and drafts evidence-backed responses, plus a candid weakness assessment and a
list of documentation that would strengthen the position.

One structured call; the Q&A list and weakness/documentation lists are
normalised so the output is always renderable as a defense memo.
"""

from __future__ import annotations

import json
from typing import Any

from . import _common as c

MIN_CHALLENGES = 10
MAX_CHALLENGES = 15

_SYSTEM = (
    "You are a 409A valuation defense specialist preparing for an IRS or auditor "
    "examination. You anticipate the toughest challenges to a valuation and draft "
    "evidence-backed responses that cite the valuation's own data and methodology. "
    "Be candid about weaknesses — a defense memo that ignores them is useless. "
    "Do not invent facts not present in the valuation. Respond ONLY with JSON."
)

_SEVERITY = {"low", "medium", "high"}


def _challenges(doc: Any) -> list[dict]:
    raw = doc.get("challenges") if isinstance(doc, dict) else None
    out: list[dict] = []
    for entry in raw[:MAX_CHALLENGES] if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        question = c.clean_str(entry.get("question") or entry.get("challenge"), limit=800)
        if not question:
            continue
        severity = c.clean_str(entry.get("severity"), limit=20).lower()
        out.append(
            {
                "question": question,
                "response": c.clean_str(entry.get("response") or entry.get("answer"), limit=3000),
                "evidence": c.str_list(entry.get("evidence"), limit=8, item_limit=600),
                "severity": severity if severity in _SEVERITY else "medium",
                "topic": c.clean_str(entry.get("topic"), limit=80),
            }
        )
    return out


def _weaknesses(doc: Any) -> list[dict]:
    raw = doc.get("weaknesses") if isinstance(doc, dict) else None
    out: list[dict] = []
    for entry in raw[:15] if isinstance(raw, list) else []:
        if isinstance(entry, dict):
            area = c.clean_str(entry.get("area") or entry.get("weakness"), limit=200)
            if not area:
                continue
            out.append(
                {
                    "area": area,
                    "assessment": c.clean_str(entry.get("assessment") or entry.get("detail"), limit=1500),
                    "severity": (
                        c.clean_str(entry.get("severity"), limit=20).lower()
                        if c.clean_str(entry.get("severity"), limit=20).lower() in _SEVERITY
                        else "medium"
                    ),
                }
            )
        else:
            text = c.clean_str(entry, limit=1500)
            if text:
                out.append({"area": text, "assessment": "", "severity": "medium"})
    return out


def run_audit_defense(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}

    red = c.redactor(payload)
    system, model = c.prompt_overrides(payload, _SYSTEM)
    methodology = payload.get("methodology")
    methodology_str = (
        json.dumps(methodology, default=str)[:6000]
        if isinstance(methodology, dict) and methodology
        else "(infer methodology from the calculation)"
    )
    user = f"""Company: {c.subject(payload)} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Params / assumptions: {c.params_summary(params)}
Methodology: {methodology_str}
Calculation under defense: {c.calculation_summary(payload)}

Prepare the audit-defense memo. Return JSON:
{{
  "challenges": [{{"topic": "<e.g. DLOM>", "question": "<the challenge an examiner would raise>", "response": "<evidence-backed answer citing this valuation>", "evidence": ["<data point from the valuation>", ...], "severity": "low|medium|high"}}],
  "weaknesses": [{{"area": "<where the valuation is most vulnerable>", "assessment": "<why, and how exposed>", "severity": "low|medium|high"}}],
  "additional_documentation": ["<document or analysis that would strengthen the position>", ...],
  "overall_assessment": "<one paragraph on the overall defensibility>"
}}
Provide {MIN_CHALLENGES}-{MAX_CHALLENGES} challenges, ordered most to least likely."""

    llm = c.ask(red, system, user, model)
    parsed = c.safe_result(llm, "audit_defense")
    result = {
        "challenges": _challenges(parsed),
        "weaknesses": _weaknesses(parsed),
        "additional_documentation": c.str_list(
            parsed.get("additional_documentation") if isinstance(parsed, dict) else None,
            limit=15,
            item_limit=600,
        ),
        "overall_assessment": c.clean_str(parsed.get("overall_assessment"))
        if isinstance(parsed, dict)
        else "",
        "anonymization": red.report(),
    }
    return llm.model, result
