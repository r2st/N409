"""M1 AI pipelines: missing-data detection, data extraction, public comparables.

Each pipeline builds a prompt from the valuation + params + document corpus,
calls OpenRouter, and normalizes the completion to a stable result schema the
valuation service persists in ai_jobs.result.
"""

from __future__ import annotations

import json
from typing import Any

from .anonymize import anonymization_enforced, redact
from .documents import DocText, extract_texts, render_corpus
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


def _prompt_overrides(payload: dict, default_system: str) -> tuple[str, str | None]:
    """(system_prompt, model) — the valuation service ships the registry row
    (Bot Prompts view) as payload["prompt"]; fall back to the built-in."""
    prompt = payload.get("prompt")
    if not isinstance(prompt, dict):
        return default_system, None
    system = prompt.get("system")
    model = prompt.get("model")
    return (
        system if isinstance(system, str) and system.strip() else default_system,
        model if isinstance(model, str) and model.strip() else None,
    )


def _known_entities(payload: dict) -> tuple[list[str], list[str]]:
    """(company_names, person_names) the caller already knows. The subject
    company name always comes through on the valuation; callers may pass more
    via options.known_companies / options.known_people."""
    valuation = payload.get("valuation") or {}
    options = payload.get("options") or {}
    companies: list[str] = [str(valuation["company_name"])] if valuation.get("company_name") else []
    companies += [str(c) for c in (options.get("known_companies") or []) if c]
    people = [str(p) for p in (options.get("known_people") or []) if p]
    return companies, people


def _load_docs(payload: dict) -> tuple[list[DocText], dict]:
    """Extract document texts, redacting PII first (remaining-gaps §2 — the
    cap-table anonymization step) unless options.anonymize is switched off.

    Named-entity redaction (company + known person names) supplements the
    regexes so a cap table's most identifying fields don't leave the trust
    boundary. In production the anonymize=false escape hatch is ignored
    (audit B-1 P1)."""
    docs = extract_texts(payload.get("documents") or [])
    options = payload.get("options") or {}
    enforced = anonymization_enforced()
    if not enforced and not options.get("anonymize", True):
        return docs, {"applied": False, "redacted": {}}
    companies, people = _known_entities(payload)
    totals: dict[str, int] = {}
    for doc in docs:
        doc.text, counts = redact(doc.text, company_names=companies, person_names=people)
        for category, n in counts.items():
            totals[category] = totals.get(category, 0) + n
    return docs, {"applied": True, "redacted": totals, "enforced": enforced}


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
    docs, anonymization = _load_docs(payload)
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

    system, model = _prompt_overrides(
        payload,
        "You are a 409A valuation analyst assistant. You review what a client has "
        "uploaded and identify what is still missing to complete a defensible "
        "valuation. Respond ONLY with JSON.",
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

    llm = chat(system, user, model=model)
    parsed = _safe_result(llm)
    gaps = parsed.get("gaps") if isinstance(parsed, dict) else None
    result = {
        "missing_documents": missing_docs,
        "missing_params": missing_params,
        "gaps": gaps if isinstance(gaps, list) else [],
        "notes": parsed.get("notes", "") if isinstance(parsed, dict) else "",
        "documents_reviewed": [d.filename for d in docs],
        "anonymization": anonymization,
    }
    return llm.model, result


def run_extract(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    docs, anonymization = _load_docs(payload)

    system, model = _prompt_overrides(
        payload,
        "You are a financial data extraction engine for 409A valuations. Extract "
        "ONLY values explicitly present in the documents. Never invent numbers. "
        "All monetary amounts in plain units (dollars, not thousands). Respond ONLY with JSON.",
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

    llm = chat(system, user, model=model)
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
        "anonymization": anonymization,
    }
    return llm.model, result


def run_comparables(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}
    docs, anonymization = _load_docs(payload)

    system, model = _prompt_overrides(
        payload,
        "You are a valuation analyst finding guideline public companies "
        "(market approach / GPC method). Suggest liquid, well-known public "
        "companies in the same or adjacent business. Multiples are EV/Revenue "
        "and EV/EBITDA estimates typical for the sector — mark them as "
        "estimates. Respond ONLY with JSON.",
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

    llm = chat(system, user, model=model)
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
        "anonymization": anonymization,
    }
    return llm.model, result


def run_summarize(payload: dict) -> tuple[str, dict]:
    """Summarize Attachments (remaining-gaps §2 "AI actions & pipelines")."""
    valuation = payload.get("valuation") or {}
    docs, anonymization = _load_docs(payload)

    system, model = _prompt_overrides(
        payload,
        "You are a 409A valuation analyst assistant. Summarize each uploaded "
        "attachment for the analyst working the engagement: what the document "
        "is, what it says, and the figures that matter for a valuation. "
        "Never invent numbers. Respond ONLY with JSON.",
    )
    user = f"""Company: {valuation.get("company_name")} ({valuation.get("kind")} valuation)
Documents:
{render_corpus(docs)[:45000]}

Return JSON:
{{
  "summaries": [{{"filename": "<document filename>", "summary": "<2-4 sentences>", "key_figures": ["<figure with label>", ...]}}],
  "overall": "<one-paragraph synthesis across all documents>"
}}
One entry per document, in the order given. key_figures only for values
actually present in that document (share counts, preferences, cash, revenue)."""

    llm = chat(system, user, model=model)
    parsed = _safe_result(llm)
    by_filename = {d.filename: d for d in docs}
    summaries = []
    if isinstance(parsed, dict) and isinstance(parsed.get("summaries"), list):
        for entry in parsed["summaries"][:20]:
            if not isinstance(entry, dict) or not entry.get("filename"):
                continue
            filename = str(entry.get("filename"))
            doc = by_filename.get(filename)
            key_figures = entry.get("key_figures")
            summaries.append(
                {
                    "filename": filename,
                    "kind": doc.kind if doc else "other",
                    "summary": str(entry.get("summary") or ""),
                    "key_figures": [str(f) for f in key_figures[:10]]
                    if isinstance(key_figures, list)
                    else [],
                }
            )
    result = {
        "summaries": summaries,
        "overall": parsed.get("overall", "") if isinstance(parsed, dict) else "",
        "documents_reviewed": [d.filename for d in docs],
        "anonymization": anonymization,
    }
    return llm.model, result


QA_SEVERITIES = {"info", "warn", "fail"}
QA_VERDICTS = {"pass", "warn", "fail"}


def _calculation_summary(payload: dict) -> str:
    """Compact JSON of the calculation under review (results + key inputs)."""
    calc = payload.get("calculation")
    if not isinstance(calc, dict):
        return "(no calculation provided)"
    keep = {
        "equity_value": calc.get("equity_value"),
        "fmv_per_share": calc.get("fmv_per_share"),
        "results": calc.get("results"),
        "inputs": calc.get("inputs"),
    }
    return json.dumps(keep, default=str)[:20000]


def run_qa(payload: dict) -> tuple[str, dict]:
    """Output QA reviewer (IMPROVEMENTS_RESEARCH §4.3): judges a finished
    calculation for reasonableness and internal consistency. The valuation
    service runs its deterministic checks first and ships them along; the
    reviewer looks for what rules can't catch. The verdict only ever
    tightens the deterministic outcome — the caller enforces that."""
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}
    checks = payload.get("qa_checks") or []

    system, model = _prompt_overrides(
        payload,
        "You are a senior 409A valuation reviewer performing quality assurance "
        "before delivery. Be skeptical: look for inconsistent figures, "
        "implausible assumptions, and results that would not survive an IRS or "
        "auditor challenge. Do not repeat findings the deterministic checks "
        "already flagged. Respond ONLY with JSON.",
    )
    user = f"""Company: {valuation.get("company_name")} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Params: {_params_summary(params)}
Calculation under review: {_calculation_summary(payload)}
Deterministic checks already run: {json.dumps(checks, default=str)[:8000]}

Review the calculation. Return JSON:
{{
  "findings": [{{"area": "<inputs|assumptions|outputs|consistency>", "finding": "<one sentence>", "severity": "info|warn|fail"}}],
  "assessment": "<one-paragraph overall judgement>",
  "verdict": "pass|warn|fail"
}}
"fail" only for defects that make the result indefensible. Maximum 10 findings."""

    llm = chat(system, user, model=model)
    parsed = _safe_result(llm)
    findings = []
    if isinstance(parsed, dict) and isinstance(parsed.get("findings"), list):
        for entry in parsed["findings"][:10]:
            if not isinstance(entry, dict) or not entry.get("finding"):
                continue
            severity = entry.get("severity")
            findings.append(
                {
                    "area": str(entry.get("area") or "outputs"),
                    "finding": str(entry.get("finding")),
                    "severity": severity if severity in QA_SEVERITIES else "info",
                }
            )
    verdict = parsed.get("verdict") if isinstance(parsed, dict) else None
    if verdict not in QA_VERDICTS:
        # Derive from findings when the model skipped/mangled the verdict.
        severities = {f["severity"] for f in findings}
        verdict = "fail" if "fail" in severities else "warn" if "warn" in severities else "pass"
    result = {
        "findings": findings,
        "assessment": str(parsed.get("assessment", "")) if isinstance(parsed, dict) else "",
        "verdict": verdict,
    }
    return llm.model, result


def run_explain(payload: dict) -> tuple[str, dict]:
    """Plain-English report summary (IMPROVEMENTS_RESEARCH §4.5): explains the
    methodology and result to a founder with no valuation background."""
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}

    system, model = _prompt_overrides(
        payload,
        "You explain 409A valuations to startup founders in plain English. "
        "No jargon without a one-clause explanation. Describe only what is in "
        "the provided data — never invent figures. This is not legal, tax or "
        "financial advice and must not read as such. Respond ONLY with JSON.",
    )
    user = f"""Company: {valuation.get("company_name")} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Params: {_params_summary(params)}
Calculation: {_calculation_summary(payload)}

Explain this valuation to the company's founder. Return JSON:
{{
  "summary": "<2-3 plain-English paragraphs: what was concluded and what it means>",
  "methodology": [{{"approach": "<name>", "weight": <0-1|null>, "explanation": "<1-2 sentences on what it does and why it was used>"}}],
  "drivers": ["<key factor that moved the value>", ...],
  "caveats": "<one sentence on limits of this explanation>"
}}
Only include approaches that actually carried weight. Maximum 6 drivers."""

    llm = chat(system, user, model=model)
    parsed = _safe_result(llm)
    methodology = []
    if isinstance(parsed, dict) and isinstance(parsed.get("methodology"), list):
        for entry in parsed["methodology"][:6]:
            if not isinstance(entry, dict) or not entry.get("approach"):
                continue
            methodology.append(
                {
                    "approach": str(entry.get("approach")),
                    "weight": _to_number(entry.get("weight")),
                    "explanation": str(entry.get("explanation") or ""),
                }
            )
    drivers = parsed.get("drivers") if isinstance(parsed, dict) else None
    result = {
        "summary": str(parsed.get("summary", "")) if isinstance(parsed, dict) else "",
        "methodology": methodology,
        "drivers": [str(d) for d in drivers[:6]] if isinstance(drivers, list) else [],
        "caveats": str(parsed.get("caveats", "")) if isinstance(parsed, dict) else "",
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
    "summarize": run_summarize,
    "qa": run_qa,
    "explain": run_explain,
}
