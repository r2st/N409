"""Roll-Forward Agent.

Compares a prior valuation against a new engagement's data and produces:

  - material changes since the prior valuation (rounds, revenue, cap table,
    market conditions),
  - a disposition for each assumption (update vs carry-forward, with reasoning),
  - pre-populated inputs for the new valuation, drawn from the prior plus the
    changes,
  - recommended adjustments.

One structured call. ``prepopulated_inputs`` is whitelisted to the engine input
fields (same guard as the extraction pipeline) so a hallucinated key can never
be carried into the next calculation.
"""

from __future__ import annotations

import json
from typing import Any

from ..pipelines import ENGINE_INPUT_FIELDS
from . import _common as c

_SYSTEM = (
    "You are a 409A valuation analyst rolling a prior valuation forward to a new "
    "engagement date. You identify what has materially changed, decide which "
    "assumptions to update versus carry forward, and pre-populate the new "
    "valuation's inputs. Base every carried-forward value on the prior valuation "
    "and every change on the new data; never invent figures. Respond ONLY with JSON."
)

_DISPOSITIONS = {"update", "carry_forward", "review"}


def _prior_summary(payload: dict) -> str:
    prior = payload.get("prior_valuation")
    if isinstance(prior, dict) and prior:
        return json.dumps(prior, default=str)[:12000]
    return "(no prior valuation provided)"


def _new_data_summary(payload: dict) -> str:
    new = payload.get("new_data")
    if isinstance(new, dict) and new:
        return json.dumps(new, default=str)[:8000]
    # Fall back to the current params/valuation context.
    ctx = {"valuation": payload.get("valuation"), "params": payload.get("params")}
    return json.dumps(ctx, default=str)[:8000]


def _changes(doc: Any) -> list[dict]:
    raw = doc.get("material_changes") if isinstance(doc, dict) else None
    out: list[dict] = []
    for entry in raw[:20] if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            text = c.clean_str(entry, limit=1000)
            if text:
                out.append({"area": text, "change": "", "impact": ""})
            continue
        area = c.clean_str(entry.get("area") or entry.get("category"), limit=120)
        change = c.clean_str(entry.get("change") or entry.get("description"), limit=1500)
        if not area and not change:
            continue
        out.append(
            {
                "area": area,
                "change": change,
                "impact": c.clean_str(entry.get("impact"), limit=800),
            }
        )
    return out


def _dispositions(doc: Any) -> list[dict]:
    raw = doc.get("assumption_dispositions") if isinstance(doc, dict) else None
    out: list[dict] = []
    for entry in raw[:30] if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        name = c.clean_str(entry.get("assumption") or entry.get("name"), limit=120)
        if not name:
            continue
        disp = c.clean_str(entry.get("disposition"), limit=20).lower()
        out.append(
            {
                "assumption": name,
                "disposition": disp if disp in _DISPOSITIONS else "review",
                "reasoning": c.clean_str(entry.get("reasoning"), limit=1200),
            }
        )
    return out


def _prepopulated_inputs(doc: Any) -> dict[str, float]:
    raw = doc.get("prepopulated_inputs") if isinstance(doc, dict) else None
    out: dict[str, float] = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            num = c.to_number(value)
            if key in ENGINE_INPUT_FIELDS and num is not None:
                out[key] = num
    return out


def run_roll_forward(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}

    system, model = c.prompt_overrides(payload, _SYSTEM)
    fields = ", ".join(sorted(ENGINE_INPUT_FIELDS))
    user = f"""Company: {valuation.get("company_name")} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Prior valuation summary: {_prior_summary(payload)}
New engagement data: {_new_data_summary(payload)}

Roll the valuation forward. Return JSON:
{{
  "material_changes": [{{"area": "<funding|revenue|cap_table|market|other>", "change": "<what changed>", "impact": "<effect on value>"}}],
  "assumption_dispositions": [{{"assumption": "<name>", "disposition": "update|carry_forward|review", "reasoning": "<why>"}}],
  "prepopulated_inputs": {{ /* only these engine keys, numbers only: {fields} */ }},
  "recommended_adjustments": ["<specific adjustment with reasoning>", ...],
  "summary": "<one paragraph: overall change since the prior valuation>"
}}
Carry forward what the new data does not contradict; update what it does."""

    llm = c.chat(system, user, model=model)
    parsed = c.safe_result(llm)
    result = {
        "material_changes": _changes(parsed),
        "assumption_dispositions": _dispositions(parsed),
        "prepopulated_inputs": _prepopulated_inputs(parsed),
        "recommended_adjustments": c.str_list(
            parsed.get("recommended_adjustments") if isinstance(parsed, dict) else None,
            limit=15,
            item_limit=800,
        ),
        "summary": c.clean_str(parsed.get("summary")) if isinstance(parsed, dict) else "",
    }
    return llm.model, result
