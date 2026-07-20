"""Analyst AI agents for the N409 409A valuation platform.

Six multi-step / structured agents that go beyond the M1 extraction pipelines:

- cap_table        — parse charter/articles/cap-table docs into the engine's
                     share_classes schema, with citations and confidence.
- comp_selection   — suggest guideline public companies, verify their tickers
                     against real market data, then filter to a defensible set.
- report_narrative — draft the prose sections of a 409A report from a finished
                     calculation.
- assumptions      — recommend DLOM / weights / time-to-exit / discount-rate /
                     volatility with ranges, reasoning and benchmarks.
- audit_defense    — anticipate IRS/auditor challenges and draft evidence-backed
                     responses plus a weakness assessment.
- roll_forward     — diff a prior valuation against new data and pre-populate the
                     next engagement's inputs.

Each agent is registered under AGENT_PIPELINES with the same
``run(payload) -> (model, result)`` contract as the built-in pipelines, so the
FastAPI route and the valuation service treat them identically.
"""

from __future__ import annotations

from .assumptions import run_assumptions
from .audit_defense import run_audit_defense
from .cap_table import run_cap_table
from .comp_selection import run_comp_selection
from .report_narrative import run_report_narrative
from .roll_forward import run_roll_forward

AGENT_PIPELINES = {
    "cap_table": run_cap_table,
    "comp_selection": run_comp_selection,
    "report_narrative": run_report_narrative,
    "assumptions": run_assumptions,
    "audit_defense": run_audit_defense,
    "roll_forward": run_roll_forward,
}

__all__ = ["AGENT_PIPELINES"]
