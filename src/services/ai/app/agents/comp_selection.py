"""Comparable Company Selection + Validation Agent.

Four steps, and the second of them is the one that changed:

  1. Suggest — the model proposes 8-12 guideline public companies (with tickers
     and reasoning) for the target's industry / revenue / stage.
  2. Screen — the engine ranks the *reference universe* against the target's own
     attributes (SIC proximity, scale, growth, margin) and returns scored
     candidates with a per-dimension breakdown. This is a second, independent
     source: it surfaces companies the model never mentioned, and it is the
     only part of the set that can answer "why this one and not that one" with
     something other than a sentence the model wrote.
  3. Verify — the model's tickers are checked against the engine's market-data
     endpoint. Unknown tickers are dropped; known ones come back with real SIC
     codes, market caps, and EV/Revenue & EV/EBITDA multiples.
  4. Refine — the model reviews the *actual* multiples across both sources and
     filters to the best 5-7 comps, justifying every inclusion and exclusion.

Every candidate carries its provenance (`sources`: screen, model, or both) and,
where the screen produced it, its score. A comp both sources reached is the
strongest kind of evidence in the set, and the report can say so.

If the engine is unreachable the agent degrades to the model's own suggestions
(clearly flagged ``verified: false``) rather than failing the run.
"""

from __future__ import annotations

import json
from typing import Any

from . import _common as c
from .engine import EngineError, screen_comparables, verify_tickers

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


_MARKET_FIELDS = (
    "sic_code",
    "sic_description",
    "sector",
    "market_cap",
    "ev_revenue",
    "ev_ebitda",
    "revenue",
    "revenue_growth",
    "ebitda_margin",
)


def _candidate(data: dict, *, name: str, ticker: str, source: str, rationale: str = "") -> dict:
    row = {
        "name": name,
        "ticker": ticker,
        "rationale": rationale,
        "verified": True,
        "sources": [source],
        **{field: data.get(field) for field in _MARKET_FIELDS},
    }
    # Only the screen produces a score; a model-only candidate has none, and
    # showing it as 0 would read as "scored badly" rather than "not scored".
    if "score" in data:
        row["score"] = data.get("score")
        row["score_breakdown"] = data.get("breakdown")
    return row


def _screen_target(params: dict, ctx: dict) -> dict:
    """The target attributes the engine screens on — only what is actually known.

    Sent sparse on purpose: the engine drops a dimension the target says
    nothing about and renormalises the weights, so an absent margin is not the
    same as a margin of zero.
    """
    revenue = ctx.get("revenue") or params.get("revenue_ltm")
    target = {
        "sic_code": ctx.get("sic_code") or params.get("sic_code"),
        "revenue": revenue,
        "revenue_growth": ctx.get("revenue_growth") or params.get("revenue_growth"),
        "ebitda_margin": ctx.get("ebitda_margin") or params.get("ebitda_margin"),
    }
    clean: dict = {}
    for key, value in target.items():
        if value in (None, ""):
            continue
        if key == "sic_code":
            code = c.clean_str(value, limit=10)
            if code:
                clean[key] = code
        else:
            num = c.to_number(value)
            if num is not None:
                clean[key] = num
    return clean


def _merge_verified(suggested: list[dict], verified: dict) -> tuple[list[dict], list[str]]:
    """Attach real market data to the tickers the engine recognised."""
    by_ticker = {c.clean_str(co.get("ticker"), limit=20).upper(): co for co in verified.get("companies", [])}
    merged: list[dict] = []
    for comp in suggested:
        data = by_ticker.get(comp["ticker"])
        if data is None:
            continue
        merged.append(
            _candidate(
                data,
                name=comp["name"],
                ticker=comp["ticker"],
                source="model",
                rationale=comp["rationale"],
            )
        )
    not_found = [str(t) for t in verified.get("not_found", [])]
    return merged, not_found


def _merge_sources(model_candidates: list[dict], screened: list[dict]) -> list[dict]:
    """One candidate list from both sources, most-corroborated first.

    A ticker both sources reached keeps the model's rationale *and* the
    screen's score — the two say different things and the refine step reads
    both. Ordering puts corroborated candidates first, then by score, so the
    prompt's head is the strongest evidence rather than whatever the model
    listed first.
    """
    by_ticker: dict[str, dict] = {}
    for comp in model_candidates:
        by_ticker[comp["ticker"]] = comp

    for row in screened:
        ticker = c.clean_str(row.get("ticker"), limit=20).upper()
        if not ticker:
            continue
        existing = by_ticker.get(ticker)
        if existing is None:
            by_ticker[ticker] = _candidate(
                row,
                name=c.clean_str(row.get("name"), limit=120) or ticker,
                ticker=ticker,
                source="screen",
            )
            continue
        # Corroborated: keep the model's sentence, take the screen's numbers.
        existing["sources"] = sorted({*existing.get("sources", []), "screen"})
        existing["score"] = row.get("score")
        existing["score_breakdown"] = row.get("breakdown")

    return sorted(
        by_ticker.values(),
        key=lambda r: (-len(r.get("sources", [])), -(r.get("score") or 0.0), r["ticker"]),
    )


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

    # ── Step 3: screen the universe independently of what the model recalled ──
    #
    # Failures here are not failures of the run. The screen is additive: the
    # engine refuses a screen with no target attributes at all (a 422, which
    # arrives as an EngineError), and that is the right answer rather than a
    # reason to abandon the model's set.
    screen: dict = {"selected": [], "screened_out": []}
    screen_ok = False
    screen_error: str | None = None
    screen_target = _screen_target(params, ctx)
    if engine_ok and screen_target:
        try:
            screen = screen_comparables(screen_target)
            screen_ok = True
        except EngineError as exc:
            screen_error = str(exc)

    if engine_ok:
        candidates = _merge_sources(candidates, screen.get("selected", []))
    else:
        # If the engine is down, fall back to the unverified suggestions so the
        # analyst still gets a starting set (flagged, no real multiples).
        candidates = [
            {**co, "verified": False, "sources": ["model"], "sic_code": None,
             "sic_description": None, "sector": None, "market_cap": None,
             "ev_revenue": None, "ev_ebitda": None}
            for co in suggested
        ]

    # ── Step 4: refine against the verified multiples ────────────────────────
    selected: list[dict] = []
    excluded: list[dict] = []
    refine_model = first.model
    if candidates:
        refine_user = f"""Target company: {_target_summary(valuation, params, ctx)}
Candidates with real market data. `sources` says where each came from: "model"
is a suggestion, "screen" is a quantitative match on the target's industry,
scale, growth and margin, and both together is the strongest evidence in the
set. `score` (0-1) and `score_breakdown` are the screen's, where it produced one.
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
        # The screen's own reporting. `screened_out` is the list of companies
        # the quantitative pass considered and rejected, with the dimension
        # that sank each — the half of a comp exhibit that is normally missing,
        # because "why not that one" is a question only the rejected list
        # answers.
        "screen": {
            "ran": screen_ok,
            "error": screen_error,
            "target": screen_target,
            "screened_out": screen.get("screened_out", []),
            "universe_size": screen.get("universe_size"),
            # The industry-appropriate multiple and the statistics behind it,
            # passed through so the market approach does not have to re-derive
            # what the engine already computed.
            "primary_multiple": screen.get("primary_multiple"),
            "multiples": screen.get("multiples"),
        },
        "sources": _source_summary(selected),
        "anonymization": red.report(),
    }
    return refine_model, result


def _source_summary(selected: list[dict]) -> dict:
    """How many of the final comps each source reached, and how many both did."""
    counts = {"model": 0, "screen": 0, "corroborated": 0}
    for comp in selected:
        sources = comp.get("sources") or []
        for source in ("model", "screen"):
            if source in sources:
                counts[source] += 1
        if len(sources) > 1:
            counts["corroborated"] += 1
    return counts


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
