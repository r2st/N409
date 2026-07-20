"""Assumption Recommendation Agent.

Recommends the key judgemental inputs to a 409A valuation — DLOM, approach
weights, time-to-exit, discount rate / WACC, and volatility — each with a
suggested value, an acceptable range, reasoning, and benchmark data points.

One structured call. The output is normalised into a stable list of
recommendation objects so the UI can render every input the same way regardless
of which the model actually addressed.
"""

from __future__ import annotations

import json
from typing import Any

from . import _common as c

# (key, label, what the model should ground the recommendation in)
RECOMMENDATIONS: tuple[tuple[str, str, str], ...] = (
    ("dlom", "Discount for Lack of Marketability",
     "company stage, revenue, and estimated time to a liquidity event; name the method (Chaffee/Finnerty/qualitative)"),
    ("approach_weights", "Approach Weights",
     "data quality and company stage; give weights for asset / OPM-backsolve / income / market that sum to 1"),
    ("time_to_exit", "Time to Exit (years)",
     "stage, capital raised, and sector norms for a liquidity event"),
    ("discount_rate", "Discount Rate / WACC",
     "a build-up: risk-free rate, equity risk premium, size premium, and company-specific risk"),
    ("volatility", "Equity Volatility",
     "the volatility implied by the comparable public companies over the expected holding period"),
)

_SYSTEM = (
    "You are a senior 409A valuation analyst recommending the judgemental "
    "assumptions for an engagement. For each assumption give a defensible point "
    "estimate, an acceptable range, the reasoning, and concrete benchmark data "
    "points (comparable companies, studies, or observed market data). Ground "
    "every recommendation in the company profile and comparable data provided; "
    "do not fabricate benchmarks. Respond ONLY with JSON."
)


def _profile_summary(payload: dict) -> str:
    profile = payload.get("company_profile")
    if isinstance(profile, dict) and profile:
        return json.dumps(profile, default=str)[:6000]
    return "(no structured company profile provided)"


def _comparable_summary(payload: dict) -> str:
    comps = payload.get("comparables")
    if isinstance(comps, (list, dict)) and comps:
        return json.dumps(comps, default=str)[:8000]
    return "(no comparable data provided)"


def _prior_summary(payload: dict) -> str:
    prior = payload.get("prior_valuations")
    if isinstance(prior, (list, dict)) and prior:
        return json.dumps(prior, default=str)[:4000]
    return "(no prior valuations)"


def _recommendations(doc: Any) -> list[dict]:
    raw = doc.get("recommendations") if isinstance(doc, dict) else None
    by_key = raw if isinstance(raw, dict) else {}
    out: list[dict] = []
    for key, label, _basis in RECOMMENDATIONS:
        entry = by_key.get(key)
        entry = entry if isinstance(entry, dict) else {}
        rng = entry.get("range")
        low = high = None
        if isinstance(rng, dict):
            low, high = c.to_number(rng.get("low")), c.to_number(rng.get("high"))
        elif isinstance(rng, list) and len(rng) == 2:
            low, high = c.to_number(rng[0]), c.to_number(rng[1])
        out.append(
            {
                "key": key,
                "label": label,
                "suggested_value": c.clean_str(entry.get("suggested_value") or entry.get("value"), limit=400),
                "range": {"low": low, "high": high},
                "reasoning": c.clean_str(entry.get("reasoning"), limit=2000),
                "benchmarks": c.str_list(entry.get("benchmarks"), limit=10, item_limit=500),
            }
        )
    return out


def run_assumptions(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}

    system, model = c.prompt_overrides(payload, _SYSTEM)
    spec = "\n".join(
        f'    "{k}": {{"suggested_value": "<value or %>", "range": {{"low": <n>, "high": <n>}}, "reasoning": "<why>", "benchmarks": ["<data point>", ...]}}  // {basis}'
        for k, _l, basis in RECOMMENDATIONS
    )
    user = f"""Company: {valuation.get("company_name")} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Params: {c.params_summary(params)}
Company profile: {_profile_summary(payload)}
Comparable data: {_comparable_summary(payload)}
Prior valuations: {_prior_summary(payload)}

Recommend each assumption. Return JSON:
{{
  "recommendations": {{
{spec}
  }},
  "notes": "<one paragraph on the biggest judgement calls>"
}}
Give numeric ranges. Cite real benchmarks from the comparable data where you can."""

    llm = c.chat(system, user, model=model)
    parsed = c.safe_result(llm)
    result = {
        "recommendations": _recommendations(parsed),
        "recommendation_keys": [k for k, _l, _b in RECOMMENDATIONS],
        "notes": c.clean_str(parsed.get("notes")) if isinstance(parsed, dict) else "",
    }
    return llm.model, result
