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

__all__ = [
    "project_financials",
    "terminal_value_gordon",
    "terminal_value_exit_multiple",
    "MAX_FORECAST_YEARS",
]

# The forecast horizon, which sizes eight parallel per-year lists and the
# `projections` array returned alongside them. `years` arrived as an unbounded
# int off the wire: `{"years": 3000000, "revenue_growth": 0}` is 122 bytes and
# was measured at nine seconds and 3.6 GB resident, before the response is even
# serialised. A positive growth rate happens to overflow out of it around year
# 7,300 — but a flat or negative one does not, so the guard that looked like a
# bound was only ever an accident of the arithmetic.
#
# An explicit DCF forecast period is five to ten years and a long one is
# thirty; a hundred is past any defensible horizon and still projects
# instantly.
MAX_FORECAST_YEARS = 100


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


def _check_horizon(n: int) -> None:
    """Refuse a forecast horizon past anything a DCF defensibly projects."""
    if n > MAX_FORECAST_YEARS:
        raise EngineInputError(
            f"years must be <= {MAX_FORECAST_YEARS} (a DCF forecast period is 5-10 years); got {n}"
        )


def _finite(value: float, name: str, hint: str = "check the growth and margin assumptions") -> float:
    """Guard a *computed* figure, where finite inputs can still overflow.

    Compounding is the reachable case: fifteen years of a mistyped growth rate
    overflows to inf on its own, and inf − inf is NaN, so the projection ends
    up part astronomical and part null without a single non-finite input.

    `hint` is what the caller should go and look at, and it is not the same for
    every figure here: a runaway forecast line is the growth and the margins,
    while a terminal value that overflows on a perfectly ordinary forecast is
    the perpetuity's own denominator.
    """
    if not math.isfinite(value):
        raise EngineInputError(f"{name} overflowed to a non-finite value — {hint}")
    return value


def _rate_vector(rate, years: int, name: str, *, above_minus_one: bool = False) -> list[float]:
    """Normalize a scalar or per-year list of rates to a length-``years`` list.

    ``above_minus_one`` is for the rates that *compound* — see
    ``_check_growth``. The margin and ratio vectors do not compound and are
    deliberately left unbounded: a negative ``capex_pct`` is a disposal and a
    negative ``nwc_pct`` is deferred revenue funding the business, both of which
    a real forecast carries.
    """
    if isinstance(rate, (list, tuple)):
        if len(rate) != years:
            raise EngineInputError(f"{name} list must have {years} entries (one per forecast year)")
        values = [_num(x, f"{name}[]") for x in rate]
        if above_minus_one:
            for i, value in enumerate(values):
                _check_growth(value, f"{name}[{i}]")
        return values
    value = _num(rate, name)
    if above_minus_one:
        _check_growth(value, name)
    return [value] * years


def _check_growth(rate: float, name: str) -> None:
    """Refuse a growth rate below −100%, which does not compound.

    ``revenue`` is built by multiplying the prior year by ``(1 + g)``, so a
    growth rate below −1 makes the multiplier negative and the projected
    revenue line *alternates sign*: on a $1,000,000 base at g = −150% the
    forecast reads −$500,000, $250,000, −$125,000, $62,500, −$31,250, and every
    line derived from it — COGS, EBITDA, the free cash flows the DCF is then
    handed — inherits the alternation, so the odd years show a *positive*
    EBITDA struck on negative revenue.

    None of it raised. ``_finite`` sees only finite numbers, and the DCF that
    consumes ``free_cash_flows`` has no way to know the stream came from a
    revenue line that went negative. So a single mistyped rate — a percentage
    where a fraction was meant, ``-150`` for "down 1.5%" — produced a complete,
    plausible-looking, entirely fictional forecast on a 200.

    Exactly −1 is kept: revenue goes to zero at the first forecast year and
    stays there, which is a wind-down and is monotone. It is the same floor
    ``comparables.comparable_analysis`` applies to its target growth
    (``minimum=-1.0``) and ``intangibles`` to its terminal growth.
    """
    if rate < -1.0:
        raise EngineInputError(
            f"{name} must be >= -1 (i.e. no worse than -100%); got {rate:g} — a growth rate below "
            "-100% does not compound, it flips the sign of the projected revenue every year; "
            "check the rate is a fraction (-0.15), not a percentage (-15)"
        )


def _sequence(vals, name: str) -> list:
    """A per-year line, as a list, or an error naming the field that isn't one.

    ``len(vals)`` and ``for x in vals`` were reached directly, so ``cogs: 5``
    left as a bare ``TypeError: object of type 'int' has no len()``. That is a
    422 either way — ``main.py`` maps ``TypeError`` — but the detail an analyst
    saw was a Python internal with no field in it, and a dict or a string got
    silently iterated over its keys or its characters instead.
    """
    if isinstance(vals, (str, bytes)) or not isinstance(vals, (list, tuple)):
        raise EngineInputError(f"{name} must be a list of one figure per forecast year")
    return list(vals)


def terminal_value_gordon(
    final_fcf: float,
    discount_rate: float,
    terminal_growth: float,
) -> float:
    """Gordon growth terminal value: FCF·(1+g) / (r − g).

    ``terminal_growth`` has a floor as well as the ``r > g`` ceiling, and only
    the ceiling was here. A perpetual growth rate below −100% is not a steep
    decline; it is a sign flip in the perpetuity's very first period, and
    the formula reports it as one: ``(1 + g)`` goes negative while ``(r − g)``
    stays positive, so a *positive* final cash flow capitalises to a *negative*
    terminal value. On a flat $100 forecast at a 15% discount rate the terminal
    value falls from $0.88 at g = −99% to $0.00 at g = −100% — both right, a
    business shrinking that fast is worth nothing — and then to −$30.30 at
    g = −150% and −$63.49 at g = −300%, converging on −$100 as g → −∞. It is
    not merely implausible, it is wrong in direction: the limit is zero.

    Nothing downstream could catch it. ``r > g`` is trivially satisfied by any
    rate below −1, ``validate`` only warns when terminal growth is *too high*
    (above long-run GDP), and ``income_dcf`` adds the negative terminal PV to a
    healthy explicit period and returns a smaller-but-positive enterprise value
    — a silently understated conclusion on a 200, which is exactly what a
    negative terminal value is worth catching for.

    Exactly −1 is kept, and is the floor rather than the first refusal: it is
    the zero tail — the flow stops at the horizon and the terminal value is
    $0.00, which is a thing a forecast means to say. That is the same bound
    ``intangibles.relief_from_royalty`` already applies to its own terminal
    growth (``minimum=-1.0``), and this is the DCF's perpetuity agreeing with
    it rather than holding the one opinion the engine had not written down.
    """
    if terminal_growth < -1.0:
        raise EngineInputError(
            f"terminal_growth must be >= -1 (i.e. no worse than -100%); got {terminal_growth:g} — "
            "a perpetuity shrinking faster than 100% a year capitalises a positive cash flow "
            "into a negative terminal value; use -1 for a flow that stops at the horizon"
        )
    if discount_rate <= terminal_growth:
        raise EngineInputError("discount_rate must exceed terminal_growth")
    return final_fcf * (1.0 + terminal_growth) / (discount_rate - terminal_growth)


def terminal_value_exit_multiple(metric: float, multiple: float) -> float:
    """Exit-multiple terminal value: terminal metric (e.g. EBITDA) × multiple.

    The metric must be positive, which is the same rule ``approaches.income_dcf``
    applies to ``income.terminal_metric``. Without it a forecast whose terminal
    year loses money returned a *negative* terminal value here, an analyst
    adopted it as the engagement's cash flows, and the calculation then refused
    the very figures this endpoint had just handed them.
    """
    if multiple <= 0:
        raise EngineInputError("exit multiple must be positive")
    if metric <= 0:
        raise EngineInputError(
            f"the terminal-year metric must be positive to strike an exit multiple "
            f"against it (got {metric:g}) — use the Gordon terminal value instead"
        )
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
        if isinstance(n, bool) or not isinstance(n, int):
            # `years: 1.5` reached `[rate] * 1.5` as a bare TypeError rather
            # than an error naming the field that was wrong.
            raise EngineInputError("years must be an integer")
        if n < 1:
            raise EngineInputError("growth method needs years (or a revenue_growth list)")
        _check_horizon(n)
        growth_vec = _rate_vector(revenue_growth, n, "revenue_growth", above_minus_one=True)
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
        rev_series = [_num(x, "revenue[]") for x in _sequence(revenue, "revenue")]
        n = len(rev_series)
        if n < 1:
            raise EngineInputError("revenue list must be non-empty")
        _check_horizon(n)

        def _line(vals, name: str) -> list[float]:
            if vals is None:
                return [0.0] * n
            items = _sequence(vals, name)
            if len(items) != n:
                raise EngineInputError(f"{name} must have {n} entries to match revenue")
            return [_num(x, f"{name}[]") for x in items]

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

    # `None` here means "no terminal value was asked for", and that is the whole
    # reason both branches below are guarded rather than left to overflow.
    # `round(inf, 2)` is `inf`, which FastAPI serialises as `null` — so an
    # overflowed Gordon perpetuity came back on a 200 as the same `null` a
    # `terminal_method: "none"` run returns, and no consumer can tell the two
    # apart. `_finite` is already applied to the projected revenue and to every
    # free cash flow for exactly this reason; the terminal value is the third
    # computed figure in this function and was the one it stopped short of.
    terminal_value: float | None = None
    if terminal_method == "gordon":
        if discount_rate is None:
            raise EngineInputError("gordon terminal value needs discount_rate")
        terminal_value = round(
            _finite(
                terminal_value_gordon(
                    free_cash_flows[-1],
                    _num(discount_rate, "discount_rate"),
                    _num(terminal_growth, "terminal_growth"),
                ),
                "the Gordon terminal value",
                "check the final free cash flow, and that the discount rate is "
                "far enough above the terminal growth rate",
            ),
            2,
        )
    elif terminal_method == "exit_multiple":
        if exit_multiple is None:
            raise EngineInputError("exit_multiple terminal value needs exit_multiple")
        # Anything that was not the string "ebitda" fell through to revenue.
        # `exit_metric: "EBITDA"` therefore struck the multiple on the terminal
        # year's revenue and reported it as an EBITDA exit — on the sample
        # forecast, 8 x 1,210 where 8 x 363 was asked for, a terminal value
        # 3.3x too high with nothing in the response saying so. The set is
        # closed and small, so an unrecognised member is an error.
        if exit_metric not in ("ebitda", "revenue"):
            raise EngineInputError(f"exit_metric must be 'ebitda' or 'revenue'; got {exit_metric!r}")
        metric_val = projections[-1]["ebitda"] if exit_metric == "ebitda" else projections[-1]["revenue"]
        terminal_value = round(
            _finite(
                terminal_value_exit_multiple(metric_val, _num(exit_multiple, "exit_multiple")),
                "the exit-multiple terminal value",
                "check the exit multiple and the terminal-year metric it is struck on",
            ),
            2,
        )
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
