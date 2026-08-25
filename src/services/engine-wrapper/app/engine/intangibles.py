"""Intangible-asset valuation methods (features: PPA / ASC 805, IP Valuation).

One module for both report types because the math is the same four methods —
what differs is orchestration: an IP engagement values one asset; a purchase
price allocation values every identifiable intangible and takes goodwill as
the residual against the consideration transferred.

Methods:
  - relief_from_royalty: PV of after-tax royalties the owner avoids paying
    (trade names, patents, licensed technology);
  - meem (multi-period excess earnings): PV of after-tax earnings attributable
    to the subject asset after charges for the contributory assets that helped
    earn them (customer relationships, core technology);
  - with_and_without: PV of the cash-flow differential between scenarios with
    and without the asset (non-competes);
  - cost_approach: replacement cost less obsolescence (assembled workforce,
    internal-use software).

Each income method grosses the value up by the tax amortization benefit (TAB):
a buyer amortizes purchased intangibles over 15 years (IRC §197), and the PV
of that shield is part of fair value under ASC 805. The TAB multiplier is the
fixed point  step-up = 1 / (1 − t·A)  where A is the PV of straight-line
amortization at the discount rate.

Every method echoes the rates it ran on under ``assumptions``. They are inputs,
so the result had no reason to carry them until a reader needed one: the
discount rate, the royalty rate and the tax rate are the three figures a
reviewer checks a relief-from-royalty conclusion against, and the report exhibit
had nothing to read. They are echoed *after* validation rather than as passed,
because ``_rate`` and ``_tax`` normalise — 25 and 0.25 are both accepted and the
figure a reader has to see is the one the arithmetic used.

Pure and deterministic; the FastAPI surface (main.py) wraps these.
"""

from __future__ import annotations

import math

from .compounding import compound_factor
from .errors import EngineInputError

# IRC §197 amortization period for purchased intangibles.
TAX_AMORTIZATION_YEARS = 15

# Forecast bound shared with the DCF approach (projection.MAX_FORECAST_YEARS is
# 50); customer attrition schedules legitimately run longer than an equity DCF,
# but 100 years of rows is past any defensible attrition tail.
MAX_SCHEDULE_YEARS = 100


def _num(
    value, name: str, *, minimum: float | None = None, maximum: float | None = None
) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"{name} must be a number") from exc
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be finite")
    if minimum is not None and out < minimum:
        raise EngineInputError(f"{name} must be >= {minimum}")
    if maximum is not None and out > maximum:
        raise EngineInputError(f"{name} must be <= {maximum}")
    return out


def _finite(value: float, name: str) -> float:
    if not math.isfinite(value):
        raise EngineInputError(f"{name} overflowed to a non-finite value — check the input magnitudes")
    return value


def _flows(values, name: str) -> list[float]:
    if not isinstance(values, list) or not values:
        raise EngineInputError(f"{name} must be a non-empty list")
    if len(values) > MAX_SCHEDULE_YEARS:
        raise EngineInputError(f"{name} accepts at most {MAX_SCHEDULE_YEARS} years; got {len(values)}")
    return [_num(v, f"{name}[{i}]") for i, v in enumerate(values)]


def _rate(value, name: str) -> float:
    out = _num(value, name)
    if out <= 0:
        raise EngineInputError(f"{name} must be positive")
    if out >= 1.0 and out < 2.0:
        # 0.25 and 25 are both plausible spellings of 25%; 1.20 is neither a
        # credible discount rate nor a credible percentage-as-integer.
        raise EngineInputError(f"{name} looks neither like a decimal rate nor a percentage: {out}")
    if out >= 2.0:
        out = out / 100.0
    return out


def _tax(value) -> float:
    out = _num(value, "tax_rate", minimum=0.0)
    if out >= 1.0:
        out = out / 100.0
    if out >= 1.0:
        raise EngineInputError("tax_rate must be below 100%")
    return out


def tax_amortization_benefit(discount_rate: float, tax_rate: float, years: int = TAX_AMORTIZATION_YEARS) -> float:
    """TAB step-up multiplier: 1 / (1 − t·A), A = PV of 1/n per year for n years.

    Mid-year convention is deliberately not applied here — the schedules below
    discount at full-year ends, and the TAB must use the same convention as the
    cash flows it grosses up or the step-up is inconsistent with the base value.
    """
    if years <= 0:
        raise EngineInputError("tab.years must be positive")
    annuity = sum(1.0 / compound_factor(discount_rate, y, "tab.discount_rate") for y in range(1, years + 1))
    shield = tax_rate * annuity / years
    if shield >= 1.0:
        raise EngineInputError("tab step-up is unbounded — tax_rate × amortization PV reached 100%")
    return 1.0 / (1.0 - shield)


def relief_from_royalty(
    *,
    revenues: list[float],
    royalty_rate: float,
    tax_rate: float,
    discount_rate: float,
    terminal_growth: float | None = None,
    include_tab: bool = True,
) -> dict:
    """PV of after-tax avoided royalties, optionally with a Gordon terminal value."""
    revs = _flows(revenues, "rfr.revenues")
    royalty = _num(royalty_rate, "rfr.royalty_rate", minimum=0.0, maximum=1.0)
    tax = _tax(tax_rate)
    rate = _rate(discount_rate, "rfr.discount_rate")

    rows = []
    pv_total = 0.0
    for year, revenue in enumerate(revs, start=1):
        pretax = revenue * royalty
        after_tax = pretax * (1.0 - tax)
        factor = compound_factor(rate, year, "rfr.discount_rate")
        pv = after_tax / factor
        pv_total += pv
        rows.append(
            {
                "year": year,
                "revenue": revenue,
                "royalty_savings": pretax,
                "after_tax": after_tax,
                "pv": _finite(pv, "rfr.pv"),
            }
        )

    pv_terminal = 0.0
    if terminal_growth is not None:
        growth = _num(terminal_growth, "rfr.terminal_growth")
        if rate <= growth:
            raise EngineInputError("rfr.discount_rate must exceed terminal_growth")
        last_after_tax = revs[-1] * royalty * (1.0 - tax)
        terminal = last_after_tax * (1.0 + growth) / (rate - growth)
        pv_terminal = _finite(terminal / compound_factor(rate, len(revs), "rfr.discount_rate"), "rfr.pv_terminal")

    base_value = _finite(pv_total + pv_terminal, "rfr.value")
    tab = tax_amortization_benefit(rate, tax) if include_tab else 1.0
    return {
        "method": "relief_from_royalty",
        "assumptions": {
            "royalty_rate": royalty,
            "tax_rate": tax,
            "discount_rate": rate,
            "terminal_growth": growth if terminal_growth is not None else None,
        },
        "schedule": rows,
        "pv_explicit": _finite(pv_total, "rfr.pv_explicit"),
        "pv_terminal": pv_terminal,
        "value_before_tab": base_value,
        "tab_multiplier": tab,
        "fair_value": _finite(base_value * tab, "rfr.fair_value"),
    }


def meem(
    *,
    revenues: list[float],
    attrition_rate: float = 0.0,
    ebit_margin: float,
    contributory_charges_pct: float,
    tax_rate: float,
    discount_rate: float,
    include_tab: bool = True,
) -> dict:
    """Multi-period excess earnings: earnings of the subject asset after CACs.

    ``revenues`` is the *total* revenue forecast; ``attrition_rate`` decays the
    portion attributable to the existing asset (year 1 keeps a full mid-year
    cohort: survival is compounded from year 1, i.e. (1−a)^(year−1)).
    ``contributory_charges_pct`` is the aggregate CAC as a fraction of
    attributable revenue (working capital, fixed assets, workforce, trade name
    returns), the form the analyst worksheet reduces its asset-by-asset charges
    to.
    """
    revs = _flows(revenues, "meem.revenues")
    attrition = _num(attrition_rate, "meem.attrition_rate", minimum=0.0, maximum=1.0)
    margin = _num(ebit_margin, "meem.ebit_margin", minimum=-1.0, maximum=1.0)
    cac = _num(contributory_charges_pct, "meem.contributory_charges_pct", minimum=0.0, maximum=1.0)
    tax = _tax(tax_rate)
    rate = _rate(discount_rate, "meem.discount_rate")

    rows = []
    pv_total = 0.0
    for year, revenue in enumerate(revs, start=1):
        survival = (1.0 - attrition) ** (year - 1)
        attributable = revenue * survival
        ebit = attributable * margin
        after_tax = ebit * (1.0 - tax)
        excess = after_tax - attributable * cac
        factor = compound_factor(rate, year, "meem.discount_rate")
        pv = excess / factor
        pv_total += pv
        rows.append(
            {
                "year": year,
                "revenue": revenue,
                "survival": survival,
                "attributable_revenue": attributable,
                "ebit": ebit,
                "after_tax_earnings": after_tax,
                "contributory_charge": attributable * cac,
                "excess_earnings": excess,
                "pv": _finite(pv, "meem.pv"),
            }
        )

    base_value = _finite(pv_total, "meem.value")
    tab = tax_amortization_benefit(rate, tax) if include_tab else 1.0
    return {
        "method": "meem",
        "assumptions": {
            "attrition_rate": attrition,
            "ebit_margin": margin,
            "contributory_charges_pct": cac,
            "tax_rate": tax,
            "discount_rate": rate,
        },
        "schedule": rows,
        "value_before_tab": base_value,
        "tab_multiplier": tab,
        "fair_value": _finite(base_value * tab, "meem.fair_value"),
    }


def with_and_without(
    *,
    cash_flows_with: list[float],
    cash_flows_without: list[float],
    tax_rate: float,
    discount_rate: float,
    include_tab: bool = True,
) -> dict:
    """PV of the scenario differential (non-competes, key contracts)."""
    with_flows = _flows(cash_flows_with, "www.cash_flows_with")
    without_flows = _flows(cash_flows_without, "www.cash_flows_without")
    if len(with_flows) != len(without_flows):
        raise EngineInputError(
            "www.cash_flows_with and www.cash_flows_without must cover the same years; "
            f"got {len(with_flows)} vs {len(without_flows)}"
        )
    tax = _tax(tax_rate)
    rate = _rate(discount_rate, "www.discount_rate")

    rows = []
    pv_total = 0.0
    for year, (w, wo) in enumerate(zip(with_flows, without_flows), start=1):
        differential = (w - wo) * (1.0 - tax)
        pv = differential / compound_factor(rate, year, "www.discount_rate")
        pv_total += pv
        rows.append(
            {
                "year": year,
                "with": w,
                "without": wo,
                "after_tax_differential": differential,
                "pv": _finite(pv, "www.pv"),
            }
        )

    base_value = _finite(pv_total, "www.value")
    tab = tax_amortization_benefit(rate, tax) if include_tab else 1.0
    return {
        "method": "with_and_without",
        "assumptions": {
            "tax_rate": tax,
            "discount_rate": rate,
        },
        "schedule": rows,
        "value_before_tab": base_value,
        "tab_multiplier": tab,
        "fair_value": _finite(base_value * tab, "www.fair_value"),
    }


def cost_approach(
    *,
    replacement_cost: float,
    physical_obsolescence_pct: float = 0.0,
    functional_obsolescence_pct: float = 0.0,
    economic_obsolescence_pct: float = 0.0,
    developer_profit_pct: float = 0.0,
    opportunity_cost_pct: float = 0.0,
) -> dict:
    """Replacement cost new, plus entrepreneurial incentives, less obsolescence.

    Obsolescence factors compound multiplicatively — each is a fraction of the
    value remaining after the previous, which is how the layers are estimated
    (a functionally obsolete system's economic shortfall is measured against
    its already-reduced utility, not against cost new).
    """
    cost = _num(replacement_cost, "cost.replacement_cost", minimum=0.0)
    profit = _num(developer_profit_pct, "cost.developer_profit_pct", minimum=0.0, maximum=1.0)
    opportunity = _num(opportunity_cost_pct, "cost.opportunity_cost_pct", minimum=0.0, maximum=1.0)
    base = cost * (1.0 + profit + opportunity)
    remaining = base
    layers = {}
    for label, pct in (
        ("physical", physical_obsolescence_pct),
        ("functional", functional_obsolescence_pct),
        ("economic", economic_obsolescence_pct),
    ):
        fraction = _num(pct, f"cost.{label}_obsolescence_pct", minimum=0.0, maximum=1.0)
        layers[label] = remaining * fraction
        remaining -= layers[label]
    return {
        "method": "cost_approach",
        "assumptions": {
            "developer_profit_pct": profit,
            "opportunity_cost_pct": opportunity,
            "obsolescence_pct": {
                label: _num(pct, f"cost.{label}_obsolescence_pct", minimum=0.0, maximum=1.0)
                for label, pct in (
                    ("physical", physical_obsolescence_pct),
                    ("functional", functional_obsolescence_pct),
                    ("economic", economic_obsolescence_pct),
                )
            },
        },
        "replacement_cost_new": _finite(base, "cost.replacement_cost_new"),
        "obsolescence": layers,
        "fair_value": _finite(remaining, "cost.fair_value"),
    }


_METHODS = {
    "relief_from_royalty": relief_from_royalty,
    "meem": meem,
    "with_and_without": with_and_without,
    "cost_approach": cost_approach,
}


def value_intangible(method, params) -> dict:
    """Dispatch one intangible to its method (the IP-valuation entry point)."""
    fn = _METHODS.get(str(method))
    if fn is None:
        raise EngineInputError(
            f"unknown intangible method {method!r}; expected one of {sorted(_METHODS)}"
        )
    if not isinstance(params, dict):
        raise EngineInputError("intangible params must be an object")
    try:
        return fn(**params)
    except TypeError as exc:
        # Unexpected/missing kwargs from the free-form params dict.
        raise EngineInputError(f"invalid params for {method}: {exc}") from exc


def purchase_price_allocation(
    *,
    consideration_transferred: float,
    net_working_capital: float = 0.0,
    fixed_assets: float = 0.0,
    other_tangible_assets: float = 0.0,
    assumed_liabilities: float = 0.0,
    deferred_revenue_haircut: float = 0.0,
    intangibles: list[dict],
) -> dict:
    """ASC 805 allocation: value each intangible, take goodwill as the residual.

    ``intangibles`` rows are {"name", "method", "params"}. Goodwill =
    consideration − (tangible net assets + Σ intangible fair values). A
    negative residual is reported as a bargain-purchase gain rather than
    negative goodwill, because that is what ASC 805-30-25-2 makes of it.
    """
    consideration = _num(consideration_transferred, "ppa.consideration_transferred", minimum=0.0)
    if consideration <= 0:
        raise EngineInputError("ppa.consideration_transferred must be positive")
    nwc = _num(net_working_capital, "ppa.net_working_capital")
    fixed = _num(fixed_assets, "ppa.fixed_assets")
    other = _num(other_tangible_assets, "ppa.other_tangible_assets")
    liabilities = _num(assumed_liabilities, "ppa.assumed_liabilities", minimum=0.0)
    haircut = _num(deferred_revenue_haircut, "ppa.deferred_revenue_haircut")
    if not isinstance(intangibles, list) or not intangibles:
        raise EngineInputError("ppa.intangibles must be a non-empty list")
    if len(intangibles) > 50:
        raise EngineInputError("ppa.intangibles accepts at most 50 assets")

    valued = []
    total_intangibles = 0.0
    for i, row in enumerate(intangibles):
        if not isinstance(row, dict):
            raise EngineInputError(f"ppa.intangibles[{i}] must be an object")
        name = str(row.get("name") or f"intangible_{i + 1}")
        result = value_intangible(row.get("method"), row.get("params") or {})
        valued.append({"name": name, **result})
        total_intangibles += result["fair_value"]

    tangible_net_assets = nwc + fixed + other - liabilities - haircut
    identifiable_net_assets = tangible_net_assets + total_intangibles
    residual = consideration - identifiable_net_assets

    return {
        "consideration_transferred": consideration,
        "tangible_net_assets": _finite(tangible_net_assets, "ppa.tangible_net_assets"),
        "intangibles": valued,
        "total_intangible_value": _finite(total_intangibles, "ppa.total_intangible_value"),
        "identifiable_net_assets": _finite(identifiable_net_assets, "ppa.identifiable_net_assets"),
        "goodwill": _finite(max(residual, 0.0), "ppa.goodwill"),
        "bargain_purchase_gain": _finite(max(-residual, 0.0), "ppa.bargain_purchase_gain"),
    }
