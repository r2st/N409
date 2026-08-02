"""Comparable Company Selection + Validation Agent.

Three steps:

  1. Suggest — the model proposes 8-12 guideline public companies (with tickers
     and reasoning) for the target's industry / revenue / stage.
  2. Verify — the proposed tickers are checked against the engine's market-data
     endpoint. Unknown tickers are dropped; known ones come back with real SIC
     codes, market caps, and EV/Revenue & EV/EBITDA multiples.
  3. Refine — the model reviews the *actual* multiples and filters to the best
     5-7 comps, justifying every inclusion and exclusion.

If the engine is unreachable the agent degrades to the model's own suggestions
(clearly flagged ``verified: false``) rather than failing the run.
"""

from __future__ import annotations

import json
from typing import Any

from . import _common as c
from .engine import EngineError, verify_tickers

_SUGGEST_SYSTEM = (
    "You are a valuation analyst building a guideline-public-company set for the "
    "market approach (GPC method). Propose liquid, well-known public companies "
    "in the same or an adjacent business to the target. Give each a real stock "
    "ticker and a one-sentence rationale. Respond ONLY with JSON."
)

_REFINE_SYSTEM = (
    "You are a valuation analyst finalising a comparable-company set. You are "
    "given candidates with REAL market data (SIC code, market cap, EV/Revenue, "
    "EV/EBITDA). Select the 5-7 most defensible comps and justify each choice. "
    "Prefer companies whose size, growth and business model match the target; "
    "exclude outliers on multiple or scale, explaining why. Respond ONLY with JSON."
)

MIN_SELECTED = 5
MAX_SELECTED = 7
MAX_SUGGESTED = 12


def _target_summary(valuation: dict, params: dict, ctx: dict) -> str:
    fields = {
        "company_name": valuation.get("company_name"),
        "industry": ctx.get("industry") or params.get("industry"),
        "sector": ctx.get("sector"),
        "revenue": ctx.get("revenue") or params.get("revenue_ltm"),
        "stage": ctx.get("stage") or params.get("revenue_status"),
        "description": ctx.get("description") or params.get("business_overview"),
        "service_countries": valuation.get("service_countries"),
    }
    return json.dumps({k: v for k, v in fields.items() if v not in (None, "")}, default=str)


def _suggested_comps(doc: Any) -> list[dict]:
    comps = doc.get("comparables") if isinstance(doc, dict) else None
    out: list[dict] = []
    for comp in comps[:MAX_SUGGESTED] if isinstance(comps, list) else []:
        if not isinstance(comp, dict):
            continue
        name = c.clean_str(comp.get("name"), limit=120)
        ticker = c.clean_str(comp.get("ticker"), limit=20).upper()
        if not name or not ticker:
            continue
        out.append(
            {
                "name": name,
                "ticker": ticker,
                "rationale": c.clean_str(comp.get("rationale"), limit=500),
            }
        )
    return out


def _merge_verified(suggested: list[dict], verified: dict) -> tuple[list[dict], list[str]]:
    """Attach real market data to the tickers the engine recognised."""
    by_ticker = {c.clean_str(co.get("ticker"), limit=20).upper(): co for co in verified.get("companies", [])}
    merged: list[dict] = []
    for comp in suggested:
        data = by_ticker.get(comp["ticker"])
        if data is None:
            continue
        merged.append(
            {
                "name": comp["name"],
                "ticker": comp["ticker"],
                "rationale": comp["rationale"],
                "sic_code": data.get("sic_code"),
                "sic_description": data.get("sic_description"),
                "sector": data.get("sector"),
                "market_cap": data.get("market_cap"),
                "ev_revenue": data.get("ev_revenue"),
                "ev_ebitda": data.get("ev_ebitda"),
                "verified": True,
            }
        )
    not_found = [str(t) for t in verified.get("not_found", [])]
    return merged, not_found


def _selected(doc: Any, verified_by_ticker: dict[str, dict]) -> list[dict]:
    rows = doc.get("selected") if isinstance(doc, dict) else None
    out: list[dict] = []
    seen: set[str] = set()
    for row in rows[:MAX_SELECTED] if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        ticker = c.clean_str(row.get("ticker"), limit=20).upper()
        base = verified_by_ticker.get(ticker)
        if base is None or ticker in seen:
            continue  # only ever select from the verified set
        seen.add(ticker)
        out.append({**base, "justification": c.clean_str(row.get("justification"), limit=1500)})
    return out


def _excluded(doc: Any) -> list[dict]:
    rows = doc.get("excluded") if isinstance(doc, dict) else None
    out: list[dict] = []
    for row in rows[:MAX_SUGGESTED] if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        ticker = c.clean_str(row.get("ticker"), limit=20).upper()
        reason = c.clean_str(row.get("reason"), limit=800)
        if ticker or reason:
            out.append({"ticker": ticker, "name": c.clean_str(row.get("name"), limit=120), "reason": reason})
    return out


def run_comp_selection(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}
    raw_ctx = payload.get("comp_context")
    ctx = raw_ctx if isinstance(raw_ctx, dict) else {}
    red = c.redactor(payload)

    # ── Step 1: suggest ──────────────────────────────────────────────────────
    suggest_system, model = c.prompt_overrides(payload, _SUGGEST_SYSTEM)
    suggest_user = f"""Target company: {_target_summary(valuation, params, ctx)}

Propose 8 to 12 guideline public companies. Return JSON:
{{
  "comparables": [{{"name": "<public company>", "ticker": "<symbol>", "rationale": "<one sentence>"}}],
  "sector": "<one-line sector classification>"
}}
Use real, currently-listed tickers. Order by relevance."""
    first = c.ask(red, suggest_system, suggest_user, model)
    suggest_doc = c.safe_result(first)
    suggested = _suggested_comps(suggest_doc)
    sector = c.clean_str(suggest_doc.get("sector")) if isinstance(suggest_doc, dict) else ""

    # ── Step 2: verify against real market data ──────────────────────────────
    engine_ok = True
    engine_error: str | None = None
    try:
        verified = verify_tickers([co["ticker"] for co in suggested])
    except EngineError as exc:
        engine_ok = False
        engine_error = str(exc)
        verified = {"companies": [], "not_found": []}

    candidates, not_found = _merge_verified(suggested, verified)

    # If the engine is down, fall back to the unverified suggestions so the
    # analyst still gets a starting set (flagged, no real multiples).
    if not engine_ok:
        candidates = [
            {**co, "verified": False, "sic_code": None, "sic_description": None,
             "sector": None, "market_cap": None, "ev_revenue": None, "ev_ebitda": None}
            for co in suggested
        ]

    # ── Step 3: refine against the verified multiples ────────────────────────
    selected: list[dict] = []
    excluded: list[dict] = []
    refine_model = first.model
    if candidates:
        refine_user = f"""Target company: {_target_summary(valuation, params, ctx)}
Verified candidates with real market data:
{json.dumps(candidates, default=str)[:20000]}

Select the {MIN_SELECTED}-{MAX_SELECTED} most defensible comps. Return JSON:
{{
  "selected": [{{"ticker": "<symbol>", "justification": "<2-3 sentences: why this comp belongs, referencing its multiples/scale/business>"}}],
  "excluded": [{{"ticker": "<symbol>", "name": "<name>", "reason": "<why it was left out>"}}]
}}
Select ONLY from the candidate tickers above."""
        second = c.ask(red, _REFINE_SYSTEM, refine_user, model)
        refine_model = second.model
        refine_doc = c.safe_result(second)
        by_ticker = {co["ticker"]: co for co in candidates}
        selected = _selected(refine_doc, by_ticker)
        excluded = _excluded(refine_doc)

    # Guardrail: if the model selected nothing usable, fall back to the top
    # verified candidates so the run still yields a comp set.
    if not selected and candidates:
        selected = [
            {**co, "justification": ""} for co in candidates[:MAX_SELECTED]
        ]

    multiples = _multiples_summary(selected)
    result = {
        "selected": selected,
        "excluded": excluded,
        "candidates": candidates,
        "not_found_tickers": not_found,
        "sector": sector,
        "multiples_summary": multiples,
        "market_data_verified": engine_ok,
        "engine_error": engine_error,
        "anonymization": red.report(),
    }
    return refine_model, result


def _multiples_summary(selected: list[dict]) -> dict:
    """Median EV/Revenue and EV/EBITDA across the selected, verified comps."""
    import statistics

    def _median(key: str) -> float | None:
        vals = [co[key] for co in selected if isinstance(co.get(key), (int, float)) and co[key] > 0]
        return round(statistics.median(vals), 3) if vals else None

    return {
        "count": len(selected),
        "ev_revenue_median": _median("ev_revenue"),
        "ev_ebitda_median": _median("ev_ebitda"),
    }
