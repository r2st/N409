"""Revenue / expense projection → unlevered free cash flows for the DCF.

Produces the explicit-period FCFF stream that feeds ``income_dcf`` (the income
approach). Two projection modes:

- **growth**  — a top-down revenue growth rate (single rate or a per-year
  vector), with margins/ratios (COGS, OpEx, CapEx, ΔNWC) expressed as
  percentages of revenue.
- **driver**  — bottom-up: explicit per-year revenue, COGS, OpEx, D&A, CapEx
  and NWC values are supplied directly.

Free cash flow to the firm each year:

    EBIT   = Revenue − COGS − OpEx − D&A
    NOPAT  = EBIT · (1 − tax)
    FCFF   = NOPAT + D&A − CapEx − ΔNWC

A terminal value can be appended via the Gordon growth model or an exit
multiple; the returned ``free_cash_flows`` list plugs straight into the engine
DCF, and ``terminal_value`` is returned separately for transparency.
"""

from __future__ import annotations

import math

from .errors import EngineInputError

__all__ = ["project_financials", "terminal_value_gordon", "terminal_value_exit_multiple"]


def _num(value, name: str, *, nonneg: bool = False) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be a number") from None
    # Reject NaN/Inf at the boundary, as every other engine module does
    # (audit T-1 P3). Python's json.loads accepts the `NaN` and `Infinity`
    # literals, so these do arrive over the wire; unguarded they became NaN
    # cash flows that FastAPI then serialised as `null`, and the DCF came back
    # a successful 200 with holes in it.
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be a finite number")
    if nonneg and out < 0:
        raise EngineInputError(f"{name} must be >= 0")
    return out


def _finite(value: float, name: str) -> float:
    """Guard a *computed* figure, where finite inputs can still overflow.

    Compounding is the reachable case: fifteen years of a mistyped growth rate
    overflows to inf on its own, and inf − inf is NaN, so the projection ends
    up part astronomical and part null without a single non-finite input.
    """
    if not math.isfinite(value):
        raise EngineInputError(
            f"{name} overflowed to a non-finite value — check the growth and margin assumptions"
        )
    return value


def _rate_vector(rate, years: int, name: str) -> list[float]:
    """Normalize a scalar or per-year list of rates to a length-``years`` list."""
    if isinstance(rate, (list, tuple)):
        if len(rate) != years:
            raise EngineInputError(f"{name} list must have {years} entries (one per forecast year)")
        return [_num(x, f"{name}[]") for x in rate]
    return [_num(rate, name)] * years


def terminal_value_gordon(
    final_fcf: float,
    discount_rate: float,
    terminal_growth: float,
) -> float:
    """Gordon growth terminal value: FCF·(1+g) / (r − g)."""
    if discount_rate <= terminal_growth:
        raise EngineInputError("discount_rate must exceed terminal_growth")
    return final_fcf * (1.0 + terminal_growth) / (discount_rate - terminal_growth)


def terminal_value_exit_multiple(metric: float, multiple: float) -> float:
    """Exit-multiple terminal value: terminal metric (e.g. EBITDA) × multiple."""
    if multiple <= 0:
        raise EngineInputError("exit multiple must be positive")
    return metric * multiple


def project_financials(
    *,
    method: str = "growth",
    years: int | None = None,
    base_revenue: float | None = None,
    revenue_growth=None,
    cogs_pct=None,
    opex_pct=None,
    da_pct=None,
    capex_pct=None,
    nwc_pct=None,
    prior_nwc: float | None = None,
    revenue=None,
    cogs=None,
    opex=None,
    da=None,
    capex=None,
    nwc=None,
    tax_rate: float = 0.21,
    terminal_method: str | None = None,
    terminal_growth: float = 0.0,
    discount_rate: float | None = None,
    exit_multiple: float | None = None,
    exit_metric: str = "ebitda",
) -> dict:
    """Project ``years`` of financials and derive unlevered FCFF per year.

    Returns per-line projections, the ``free_cash_flows`` list, and an optional
    ``terminal_value``. Percentages are fractions of revenue (0.60 = 60%).
    """
    tax_rate = _num(tax_rate, "tax_rate", nonneg=True)
    if not 0.0 <= tax_rate < 1.0:
        raise EngineInputError("tax_rate must be in [0, 1)")

    if method == "growth":
        if base_revenue is None or revenue_growth is None:
            raise EngineInputError("growth method needs base_revenue and revenue_growth")
        base = _num(base_revenue, "base_revenue")
        if base <= 0:
            raise EngineInputError("base_revenue must be positive")
        growth = revenue_growth if isinstance(revenue_growth, (list, tuple)) else None
        n = years if years is not None else (len(growth) if growth is not None else None)
        if not n or n < 1:
            raise EngineInputError("growth method needs years (or a revenue_growth list)")
        growth_vec = _rate_vector(revenue_growth, n, "revenue_growth")
        cogs_vec = _rate_vector(cogs_pct if cogs_pct is not None else 0.0, n, "cogs_pct")
        opex_vec = _rate_vector(opex_pct if opex_pct is not None else 0.0, n, "opex_pct")
        da_vec = _rate_vector(da_pct if da_pct is not None else 0.0, n, "da_pct")
        capex_vec = _rate_vector(capex_pct if capex_pct is not None else 0.0, n, "capex_pct")
        nwc_vec = _rate_vector(nwc_pct if nwc_pct is not None else 0.0, n, "nwc_pct")

        rev_series: list[float] = []
        prev_rev = base
        for year, g in enumerate(growth_vec, start=1):
            prev_rev = _finite(prev_rev * (1.0 + g), f"projected revenue in year {year}")
            rev_series.append(prev_rev)

        cogs_series = [rev_series[i] * cogs_vec[i] for i in range(n)]
        opex_series = [rev_series[i] * opex_vec[i] for i in range(n)]
        da_series = [rev_series[i] * da_vec[i] for i in range(n)]
        capex_series = [rev_series[i] * capex_vec[i] for i in range(n)]
        # NWC level each year = pct · revenue; ΔNWC vs the prior level.
        nwc_level = [rev_series[i] * nwc_vec[i] for i in range(n)]
        prior = _num(prior_nwc, "prior_nwc") if prior_nwc is not None else base * nwc_vec[0]
    elif method == "driver":
        if revenue is None:
            raise EngineInputError("driver method needs an explicit revenue list")
        rev_series = [_num(x, "revenue[]") for x in revenue]
        n = len(rev_series)
        if n < 1:
            raise EngineInputError("revenue list must be non-empty")

        def _line(vals, name: str) -> list[float]:
            if vals is None:
                return [0.0] * n
            if len(vals) != n:
                raise EngineInputError(f"{name} must have {n} entries to match revenue")
            return [_num(x, f"{name}[]") for x in vals]

        cogs_series = _line(cogs, "cogs")
        opex_series = _line(opex, "opex")
        da_series = _line(da, "da")
        capex_series = _line(capex, "capex")
        nwc_level = _line(nwc, "nwc")
        prior = _num(prior_nwc, "prior_nwc") if prior_nwc is not None else nwc_level[0]
    else:
        raise EngineInputError("method must be 'growth' or 'driver'")

    projections: list[dict] = []
    free_cash_flows: list[float] = []
    prev_nwc = prior
    for i in range(n):
        ebit = rev_series[i] - cogs_series[i] - opex_series[i] - da_series[i]
        ebitda = ebit + da_series[i]
        nopat = ebit * (1.0 - tax_rate)
        delta_nwc = nwc_level[i] - prev_nwc
        fcf = _finite(nopat + da_series[i] - capex_series[i] - delta_nwc, f"free cash flow in year {i + 1}")
        prev_nwc = nwc_level[i]
        free_cash_flows.append(round(fcf, 2))
        projections.append(
            {
                "year": i + 1,
                "revenue": round(rev_series[i], 2),
                "cogs": round(cogs_series[i], 2),
                "opex": round(opex_series[i], 2),
                "ebitda": round(ebitda, 2),
                "da": round(da_series[i], 2),
                "ebit": round(ebit, 2),
                "nopat": round(nopat, 2),
                "capex": round(capex_series[i], 2),
                "delta_nwc": round(delta_nwc, 2),
                "fcff": round(fcf, 2),
            }
        )

    terminal_value: float | None = None
    if terminal_method == "gordon":
        if discount_rate is None:
            raise EngineInputError("gordon terminal value needs discount_rate")
        terminal_value = round(
            terminal_value_gordon(free_cash_flows[-1], _num(discount_rate, "discount_rate"), _num(terminal_growth, "terminal_growth")),
            2,
        )
    elif terminal_method == "exit_multiple":
        if exit_multiple is None:
            raise EngineInputError("exit_multiple terminal value needs exit_multiple")
        metric_val = projections[-1]["ebitda"] if exit_metric == "ebitda" else projections[-1]["revenue"]
        terminal_value = round(terminal_value_exit_multiple(metric_val, _num(exit_multiple, "exit_multiple")), 2)
    elif terminal_method not in (None, "none"):
        raise EngineInputError("terminal_method must be 'gordon', 'exit_multiple' or None")

    return {
        "method": method,
        "years": n,
        "tax_rate": round(tax_rate, 4),
        "projections": projections,
        "free_cash_flows": free_cash_flows,
        "terminal_method": terminal_method,
        "terminal_value": terminal_value,
    }
