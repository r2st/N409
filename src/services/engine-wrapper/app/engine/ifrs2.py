"""IFRS 2 Share-based Payment.

Close enough to ASC 718 to be dangerous, and different in the two places that
decide the charge:

  - **which conditions live in the fair value.** IFRS 2.21 puts *market*
    conditions (a TSR hurdle, a share-price target) into the grant-date fair
    value, and IFRS 2.21A does the same for non-vesting conditions. IFRS 2.19
    keeps *service* and *non-market performance* conditions out of it, and
    handles them through the estimate of how many awards will vest. The
    consequence is the one thing a reviewer checks: an award with a market
    condition is expensed **even if the condition is never met**, provided
    service is rendered — there is no true-up. An award with a non-market
    condition that fails is trued up to nil. Getting these the wrong way round
    misstates the charge in opposite directions;

  - **remeasurement.** Equity-settled awards are measured once, at grant date,
    and never remeasured (IFRS 2.11-13). Cash-settled awards are liabilities
    remeasured to fair value at every reporting date with the change in profit
    or loss (IFRS 2.30-33). Treating a cash-settled award as equity-settled
    freezes a liability that is supposed to move.

Also here because IFRS 2 differs from US GAAP on it: IFRS 2.IG11 *requires*
graded (accelerated) attribution for awards vesting in instalments. ASC 718
permits a straight-line election; IFRS 2 does not, so a straight-line request
on a graded award is answered and flagged rather than silently accepted.

Pure and deterministic. Grant-date fair value is computed with the Black-Scholes
primitives in `bs.py`, or supplied directly when a lattice or Monte Carlo model
was used for a market condition the closed form cannot carry.
"""

from __future__ import annotations

import math

from .bs import bs_call, discount_factor
from .errors import EngineInputError

SETTLEMENTS = {"equity_settled", "cash_settled"}
VESTING_CONDITIONS = {"service", "performance_non_market", "market"}
ATTRIBUTIONS = {"graded", "straight_line"}

MAX_VESTING_YEARS = 10.0
# Instalment count for a graded award: one tranche per vesting year unless the
# caller says otherwise. Bounded so a fat-fingered term cannot fan out.
MAX_TRANCHES = 40


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


def _choice(value, name: str, allowed: set[str], default: str | None = None) -> str:
    raw = str(value if value is not None else (default or "")).strip().lower()
    if raw not in allowed:
        raise EngineInputError(f"{name} must be one of {', '.join(sorted(allowed))}")
    return raw


def grant_date_fair_value(
    *,
    share_price: float,
    exercise_price: float,
    expected_term_years: float,
    expected_volatility: float,
    risk_free_rate: float,
    dividend_yield: float = 0.0,
    market_condition_discount: float = 0.0,
) -> float:
    """Per-award fair value: Black-Scholes on the dividend-adjusted spot.

    ``market_condition_discount`` is the haircut a lattice or Monte Carlo model
    put on the closed form for a market condition (IFRS 2.21). It belongs
    *inside* the fair value, which is the whole point of the paragraph, so it
    is applied here rather than to the expense.
    """
    s = _num(share_price, "ifrs2.share_price", minimum=0.0)
    k = _num(exercise_price, "ifrs2.exercise_price", minimum=0.0)
    t = _num(expected_term_years, "ifrs2.expected_term_years", minimum=0.0, maximum=50.0)
    sigma = _num(expected_volatility, "ifrs2.expected_volatility", minimum=0.0, maximum=5.0)
    r = _num(risk_free_rate, "ifrs2.risk_free_rate", minimum=-1.0, maximum=1.0)
    q = _num(dividend_yield, "ifrs2.dividend_yield", minimum=0.0, maximum=1.0)
    haircut = _num(
        market_condition_discount, "ifrs2.market_condition_discount", minimum=0.0, maximum=0.99
    )

    # A dividend-paying underlying is handled by discounting the spot, which is
    # the standard adjustment and keeps `bs_call` free of a q argument.
    adjusted_spot = s * discount_factor(q, t)
    return bs_call(adjusted_spot, k, t, r, sigma) * (1.0 - haircut)


def _tranches(vesting_years: float, count: int) -> list[float]:
    """Vesting dates for a graded award: equal instalments over the period."""
    return [vesting_years * (i + 1) / count for i in range(count)]


def expense_schedule(
    *,
    total_fair_value: float,
    vesting_years: float,
    attribution: str,
    tranches: int,
) -> list[dict]:
    """Cumulative expense by the end of each year of the vesting period.

    Graded attribution (IFRS 2.IG11) treats each instalment as its own award
    over its own period, which front-loads the charge: the tranche vesting in
    year 1 is expensed entirely in year 1, while the year-4 tranche spreads
    over four. Straight-line spreads the whole grant evenly.
    """
    if vesting_years <= 0:
        # Vested at grant — the whole charge is immediate (IFRS 2.14).
        return [{"year": 0, "cumulative_pct": 1.0, "cumulative": total_fair_value, "period": total_fair_value}]

    years = max(1, math.ceil(vesting_years - 1e-9))
    schedule: list[dict] = []
    previous = 0.0
    for year in range(1, years + 1):
        elapsed = min(float(year), vesting_years)
        if attribution == "graded":
            per_tranche = 1.0 / tranches
            pct = sum(
                per_tranche * min(elapsed / vest, 1.0)
                for vest in _tranches(vesting_years, tranches)
            )
        else:
            pct = elapsed / vesting_years
        pct = min(pct, 1.0)
        cumulative = total_fair_value * pct
        schedule.append(
            {
                "year": year,
                "cumulative_pct": pct,
                "cumulative": cumulative,
                "period": cumulative - previous,
            }
        )
        previous = cumulative
    return schedule


def ifrs2_valuation(
    *,
    settlement: str = "equity_settled",
    vesting_condition: str = "service",
    options_granted: float = 1.0,
    vesting_years: float = 0.0,
    attribution: str | None = None,
    tranches: int | None = None,
    grant_date: str | None = None,
    # Either the model inputs...
    share_price: float | None = None,
    exercise_price: float | None = None,
    expected_term_years: float | None = None,
    expected_volatility: float | None = None,
    risk_free_rate: float | None = None,
    dividend_yield: float = 0.0,
    market_condition_discount: float = 0.0,
    # ...or a fair value from a lattice/Monte Carlo model run elsewhere.
    fair_value_per_award: float | None = None,
    # Forfeiture estimate for service / non-market performance conditions only.
    # ``None`` is "nobody estimated one", which is not the same claim as an
    # estimate of nil: IFRS 2.19-20 measures the expense on the number of
    # awards *expected* to vest, so 0% is the substantive assertion that every
    # award will. The arithmetic treats the two alike — it has to assume
    # something — but the result says which one it was, so the deliverable can
    # stop printing an unmade estimate as a determination.
    expected_forfeiture_rate: float | None = None,
    # Remeasurement date fair value, for cash-settled awards.
    current_fair_value_per_award: float | None = None,
) -> dict:
    """Grant-date fair value, the expense it produces, and the true-up rules."""
    settle = _choice(settlement, "ifrs2.settlement", SETTLEMENTS, "equity_settled")
    condition = _choice(
        vesting_condition, "ifrs2.vesting_condition", VESTING_CONDITIONS, "service"
    )
    awards = _num(options_granted, "ifrs2.options_granted", minimum=0.0)
    period = _num(vesting_years, "ifrs2.vesting_years", minimum=0.0, maximum=MAX_VESTING_YEARS)

    if fair_value_per_award is not None:
        per_award = _num(fair_value_per_award, "ifrs2.fair_value_per_award", minimum=0.0)
        model = "supplied"
    else:
        missing = [
            name
            for name, value in (
                ("share_price", share_price),
                ("exercise_price", exercise_price),
                ("expected_term_years", expected_term_years),
                ("expected_volatility", expected_volatility),
                ("risk_free_rate", risk_free_rate),
            )
            if value is None
        ]
        if (
            missing
            or share_price is None
            or exercise_price is None
            or expected_term_years is None
            or expected_volatility is None
            or risk_free_rate is None
        ):
            raise EngineInputError(
                "ifrs2 needs either fair_value_per_award or the model inputs; missing: "
                + ", ".join(missing)
            )
        per_award = grant_date_fair_value(
            share_price=share_price,
            exercise_price=exercise_price,
            expected_term_years=expected_term_years,
            expected_volatility=expected_volatility,
            risk_free_rate=risk_free_rate,
            dividend_yield=dividend_yield,
            market_condition_discount=market_condition_discount,
        )
        model = "black_scholes"

    # IFRS 2.21 vs 2.19 — the split that decides whether a failed condition is
    # trued up. A market condition is already paid for in `per_award`.
    market_condition = condition == "market"
    forfeiture_determined = expected_forfeiture_rate is not None
    forfeiture = (
        _num(expected_forfeiture_rate, "ifrs2.expected_forfeiture_rate", minimum=0.0, maximum=1.0)
        if forfeiture_determined
        else 0.0
    )
    if market_condition and forfeiture > 0:
        raise EngineInputError(
            "ifrs2: a market condition is reflected in the grant-date fair value "
            "(IFRS 2.21), so it must not also be estimated as a forfeiture — "
            "use expected_forfeiture_rate only for service or non-market conditions"
        )
    expected_to_vest = awards * (1.0 - forfeiture)

    grant_date_total = per_award * awards
    total_expense = per_award * expected_to_vest

    requested = _choice(attribution, "ifrs2.attribution", ATTRIBUTIONS, "graded")
    tranche_count = (
        int(_num(tranches, "ifrs2.tranches", minimum=1, maximum=MAX_TRANCHES))
        if tranches is not None
        else max(1, min(MAX_TRANCHES, math.ceil(period - 1e-9))) if period > 0 else 1
    )
    graded_required = requested == "straight_line" and tranche_count > 1

    schedule = expense_schedule(
        total_fair_value=total_expense,
        vesting_years=period,
        attribution=requested,
        tranches=tranche_count,
    )

    remeasurement: dict | None = None
    if settle == "cash_settled":
        current = (
            _num(
                current_fair_value_per_award,
                "ifrs2.current_fair_value_per_award",
                minimum=0.0,
            )
            if current_fair_value_per_award is not None
            else per_award
        )
        current_total = current * expected_to_vest
        remeasurement = {
            "required": True,
            "current_fair_value_per_award": current,
            "current_total": current_total,
            "change_in_liability": current_total - total_expense,
            "basis": (
                "cash-settled awards are liabilities remeasured to fair value at each "
                "reporting date, with the change recognised in profit or loss (IFRS 2.30-33)"
            ),
        }
    else:
        remeasurement = {
            "required": False,
            "basis": (
                "equity-settled awards are measured at grant-date fair value and are "
                "not subsequently remeasured (IFRS 2.11-13)"
            ),
        }

    return {
        "grant_date": grant_date,
        "settlement": settle,
        "vesting_condition": condition,
        "model": model,
        "fair_value_per_award": per_award,
        "options_granted": awards,
        "grant_date_fair_value_total": grant_date_total,
        "expected_forfeiture_rate": forfeiture,
        "forfeiture_determined": forfeiture_determined,
        "expected_to_vest": expected_to_vest,
        "total_expense": total_expense,
        "attribution": requested,
        "tranches": tranche_count,
        "expense_schedule": schedule,
        "remeasurement": remeasurement,
        "true_up": {
            # The paragraph a reviewer will look up, stated as the rule it is.
            "applies": not market_condition,
            "condition_in_fair_value": market_condition,
            "basis": (
                "a market condition is reflected in the grant-date fair value (IFRS 2.21), "
                "so the expense stands even if the condition is never met, provided the "
                "service is rendered — there is no true-up"
                if market_condition
                else "service and non-market performance conditions are not in the fair "
                "value (IFRS 2.19); the expense is trued up to the number of awards that "
                "actually vest"
            ),
        },
        "warnings": _warnings(graded_required, forfeiture_determined, market_condition),
    }


def _warnings(graded_required: bool, forfeiture_determined: bool, market_condition: bool) -> list:
    notes = []
    if graded_required:
        notes.append(
            "IFRS 2.IG11 requires graded (accelerated) attribution for awards vesting "
            "in instalments; the straight-line election available under ASC 718 does "
            "not exist under IFRS 2"
        )
    # Silent for a market condition, where a forfeiture estimate would be the
    # error rather than the omission — IFRS 2.21 puts that condition in the
    # grant-date fair value and the call above refuses to double-count it.
    if not forfeiture_determined and not market_condition:
        notes.append(
            "no expected forfeiture rate was estimated, so the expense below is measured "
            "on every award granted; IFRS 2.19-20 measures it on the number expected to "
            "vest, which requires an estimate of forfeitures and a true-up to the number "
            "that actually vest"
        )
    return notes
