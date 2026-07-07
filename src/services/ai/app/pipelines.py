"""M1 AI pipelines: missing-data detection, data extraction, public comparables.

Each pipeline builds a prompt from the valuation + params + document corpus,
calls OpenRouter, and normalizes the completion to a stable result schema the
valuation service persists in ai_jobs.result.
"""

from __future__ import annotations

import json
from typing import Any

from .documents import extract_texts, render_corpus
from .openrouter import LlmResult, chat, extract_json

# Fields the extraction pipeline may emit — everything else is dropped so a
# hallucinated key can never reach the calculation engine.
ENGINE_INPUT_FIELDS = {
    "shares_outstanding_common",
    "shares_outstanding_preferred",
    "options_outstanding",
    "liquidation_preference",
    "last_round_post_money",
    "last_round_price_per_share",
    "cash",
    "debt",
    "revenue_ltm",
    "revenue_ntm",
    "ebitda_ltm",
    "volatility",
    "risk_free_rate",
}

REQUIRED_CHECKLIST = [
    ("cap_table", "Capitalization table (share classes, counts, preferences)"),
    ("income_statement", "Income statement / P&L"),
    ("balance_sheet", "Balance sheet (cash, debt, assets)"),
    ("projections", "Financial projections / forecast"),
    ("articles_of_incorporation", "Articles of incorporation (liquidation preferences)"),
    ("option_grants", "Option grants / equity plan details"),
]

PARAM_CHECKLIST = [
    ("revenue_status", "Revenue status (pre/post revenue)"),
    ("exit_timeline", "Expected exit timeline"),
    ("weight_opm", "Approach weights"),
    ("dlom_method", "DLOM method"),
]


def _params_summary(params: dict | None) -> str:
    if not params:
        return "(no params set)"
    keep = {
        k: v
        for k, v in params.items()
        if k
        in {
            "revenue_status",
            "exit_timeline",
            "last_round_date",
            "weight_asset",
            "weight_opm",
            "weight_income",
            "weight_market",
            "dloc",
            "dlom_method",
            "market_method",
            "market_horizon",
            "business_overview",
        }
        and v is not None
    }
    return json.dumps(keep, default=str) if keep else "(no params set)"


def _to_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace(",", "").replace("$", "").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def run_missing_data(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    docs = extract_texts(payload.get("documents") or [])
    uploaded_kinds = {d.kind for d in docs}
    params = payload.get("params") or {}

    # Deterministic part: checklist vs uploaded kinds + unset params.
    missing_docs = [
        {"kind": kind, "label": label, "source": "checklist"}
        for kind, label in REQUIRED_CHECKLIST
        if kind not in uploaded_kinds
    ]
    missing_params = [
        {"field": field, "label": label, "source": "checklist"}
        for field, label in PARAM_CHECKLIST
        if params.get(field) is None
    ]

    system = (
        "You are a 409A valuation analyst assistant. You review what a client has "
        "uploaded and identify what is still missing to complete a defensible "
        "valuation. Respond ONLY with JSON."
    )
    user = f"""Company: {valuation.get("company_name")} ({valuation.get("kind")} valuation)
Params already set: {_params_summary(params)}
Uploaded documents:
{render_corpus(docs)[:30000]}

Review the uploaded material. Return JSON:
{{
  "gaps": [{{"item": "<what is missing or incomplete>", "why": "<one sentence>", "severity": "blocking|important|nice_to_have"}}],
  "notes": "<one-paragraph overall assessment>"
}}
Only list gaps you can justify from the documents (e.g. a cap table with no
preference amounts, projections without expenses). Maximum 10 gaps."""

    llm = chat(system, user)
    parsed = _safe_result(llm)
    gaps = parsed.get("gaps") if isinstance(parsed, dict) else None
    result = {
        "missing_documents": missing_docs,
        "missing_params": missing_params,
        "gaps": gaps if isinstance(gaps, list) else [],
        "notes": parsed.get("notes", "") if isinstance(parsed, dict) else "",
        "documents_reviewed": [d.filename for d in docs],
    }
    return llm.model, result


def run_extract(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    docs = extract_texts(payload.get("documents") or [])

    system = (
        "You are a financial data extraction engine for 409A valuations. Extract "
        "ONLY values explicitly present in the documents. Never invent numbers. "
        "All monetary amounts in plain units (dollars, not thousands). Respond ONLY with JSON."
    )
    user = f"""Company: {valuation.get("company_name")} (currency {valuation.get("currency", "USD")})
Documents:
{render_corpus(docs)[:45000]}

Extract what is present. Return JSON:
{{
  "engine_inputs": {{
    "shares_outstanding_common": <number|null>,
    "shares_outstanding_preferred": <number|null>,
    "options_outstanding": <number|null>,
    "liquidation_preference": <number|null>,
    "last_round_post_money": <number|null>,
    "last_round_price_per_share": <number|null>,
    "cash": <number|null>,
    "debt": <number|null>,
    "revenue_ltm": <number|null>,
    "revenue_ntm": <number|null>,
    "ebitda_ltm": <number|null>
  }},
  "extractions": [{{"field": "<engine_inputs key>", "value": <number>, "source_document": "<filename>", "quote": "<short supporting quote>", "confidence": <0-1>}}]
}}
Use null for anything not found. ebitda may be negative."""

    llm = chat(system, user)
    parsed = _safe_result(llm)
    raw_inputs = parsed.get("engine_inputs") if isinstance(parsed, dict) else None
    engine_inputs: dict[str, float] = {}
    if isinstance(raw_inputs, dict):
        for key, value in raw_inputs.items():
            num = _to_number(value)
            if key in ENGINE_INPUT_FIELDS and num is not None:
                engine_inputs[key] = num
    extractions = parsed.get("extractions") if isinstance(parsed, dict) else None
    result = {
        "engine_inputs": engine_inputs,
        "extractions": extractions if isinstance(extractions, list) else [],
        "documents_reviewed": [d.filename for d in docs],
    }
    return llm.model, result


def run_comparables(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}
    docs = extract_texts(payload.get("documents") or [])

    system = (
        "You are a valuation analyst finding guideline public companies "
        "(market approach / GPC method). Suggest liquid, well-known public "
        "companies in the same or adjacent business. Multiples are EV/Revenue "
        "and EV/EBITDA estimates typical for the sector — mark them as "
        "estimates. Respond ONLY with JSON."
    )
    overview = params.get("business_overview") or ""
    user = f"""Company: {valuation.get("company_name")}
Business overview: {overview or "(none provided)"}
Countries served: {valuation.get("service_countries")}
Document excerpts (for business context only):
{render_corpus(docs)[:15000]}

Return JSON:
{{
  "comparables": [{{"name": "<public company>", "ticker": "<symbol>", "rationale": "<one sentence>", "revenue_multiple": <number>, "ebitda_multiple": <number|null>}}],
  "sector": "<one-line sector classification>",
  "caveats": "<one sentence on reliability of these multiples>"
}}
5 to 8 comparables, ordered by relevance."""

    llm = chat(system, user)
    parsed = _safe_result(llm)
    comparables = []
    if isinstance(parsed, dict) and isinstance(parsed.get("comparables"), list):
        for comp in parsed["comparables"][:10]:
            if not isinstance(comp, dict) or not comp.get("name"):
                continue
            comparables.append(
                {
                    "name": str(comp.get("name")),
                    "ticker": str(comp.get("ticker") or ""),
                    "rationale": str(comp.get("rationale") or ""),
                    "revenue_multiple": _to_number(comp.get("revenue_multiple")),
                    "ebitda_multiple": _to_number(comp.get("ebitda_multiple")),
                }
            )
    result = {
        "comparables": comparables,
        "sector": parsed.get("sector", "") if isinstance(parsed, dict) else "",
        "caveats": parsed.get("caveats", "") if isinstance(parsed, dict) else "",
    }
    return llm.model, result


def _safe_result(llm: LlmResult) -> dict | list:
    try:
        return extract_json(llm.content)
    except ValueError:
        return {"notes": llm.content[:1000]}


PIPELINES = {
    "missing_data": run_missing_data,
    "extract": run_extract,
    "comparables": run_comparables,
}
