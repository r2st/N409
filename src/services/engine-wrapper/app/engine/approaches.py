"""The four valuation approaches (features.md §engine; requirements FR-14).

Each returns an EQUITY value in currency units. Enterprise-value approaches
bridge with + cash − debt.
"""

from __future__ import annotations

import math
import statistics

from .compounding import compound_factor
from .errors import EngineInputError
from .projection import (
    MAX_FORECAST_YEARS,
    terminal_value_exit_multiple,
    terminal_value_gordon,
)

__all__ = [
    "DCF_TERMINAL_METHODS",
    "EngineInputError",
    "asset_value",
    "income_dcf",
    "market_multiples",
    "opm_backsolve",
]

#: How the DCF values everything past the explicit forecast period.
#:
#: ``gordon`` capitalises the final year's flow into a perpetuity; it is the
#: default and the only thing this engine could do until now. ``exit_multiple``
#: applies a market multiple to a terminal-year metric instead — which is what a
#: DCF cross-checked against the market approach actually does, and what
#: `projection.project_financials` has been able to *build* since it was
#: written while the DCF that consumes it could not read it.
#:
#: The two answer different questions and a report normally shows both: Gordon
#: says what the business is worth held forever, the exit multiple says what a
#: buyer would pay at the horizon. Neither is a refinement of the other.
DCF_TERMINAL_METHODS = ("gordon", "exit_multiple")


def _finite_result(value: float, name: str, hint: str) -> float:
    """A computed approach figure, or an EngineInputError explaining the overflow.

    Every scalar reaching these functions is finite — `compute._num` refuses
    NaN/Inf at the boundary — but the arithmetic between them is not closed over
    the finite floats. Multiplication and division saturate to ``inf`` in Python
    rather than raising, so a cash flow near the top of the double range, a
    multiple applied to a huge metric, or a bridge that adds two of them produce
    an ``inf`` equity value out of inputs that each passed every check.

    Nothing downstream notices: ``inf <= 0`` is False, so the weighted-value
    guard lets it through, ``round(inf, 2)`` is ``inf``, and the figure travels
    the whole way to Starlette's JSON encoder — which is the first thing to
    object, with ``allow_nan=False``, as a 500 naming nothing. Worse, the
    pre-flight validator clears the same payload: it checks that each figure is
    finite, which they all are, so the caller is told the inputs are good and
    then handed an unhandled error for using them.

    So the overflow is caught where it happens and named there. The sibling
    engines already answer this way — `fund_valuation`, `rollforward` and `wacc`
    each refuse a non-finite result rather than returning one — and this is the
    approach layer catching up with them.
    """
    if not math.isfinite(value):
        raise EngineInputError(f"{name} overflowed to a non-finite value — {hint}")
    return value


def income_dcf(
    free_cash_flows: list[float],
    discount_rate: float,
    terminal_growth: float = 0.0,
    cash: float = 0.0,
    debt: float = 0.0,
    mid_year_convention: bool = False,
    terminal_method: str = "gordon",
    exit_multiple: float | None = None,
    terminal_metric: float | None = None,
    terminal_metric_basis: str | None = None,
) -> dict:
    """Discounted cash flow: PV of the explicit forecast plus a terminal value.

    **Mid-year convention.** End-of-year discounting assumes every dollar of a
    year's cash flow lands on 31 December. It does not: it arrives roughly
    evenly across the year, so the average dollar is about six months early and
    ought to be discounted for ``n − 0.5`` years rather than ``n``. That is the
    mid-year convention, it is standard in 409A and appraisal practice, and
    leaving it off understates present value by roughly ``(1+r)^0.5 − 1`` — 8.2%
    at a 17% discount rate, 12% at 25%. On a valuation whose income approach
    carries real weight that is the difference between two defensible
    conclusions, so it is offered explicitly rather than approximated.

    It is *off* by default. Not because end-of-year is better — it is not — but
    because turning it on silently would move every stored valuation's income
    approach by 8-12% with nothing in the result document saying why. The
    convention travels on the result (``mid_year_convention``) so a report
    states which one it used.

    Under the convention the Gordon terminal value is discounted at ``N − 0.5``
    too, and that is not an approximation: if the perpetuity's own flows arrive
    mid-year, its value at the horizon is ``(1+r)^0.5`` times the textbook
    Gordon figure, and dividing that by ``(1+r)^N`` is exactly dividing the
    textbook figure by ``(1+r)^(N−0.5)``. An *exit multiple* terminal value is
    discounted at the full ``N`` either way, because it is not a flow spread
    over a year — it is a single sale on the horizon date, and a mid-year stub
    would assert that half the company was sold six months early.

    **Terminal method.** ``gordon`` capitalises the final year's flow;
    ``exit_multiple`` applies ``exit_multiple`` to ``terminal_metric`` (the
    terminal-year EBITDA or revenue off the projection). Absent an explicit
    metric the final free cash flow is used and the basis is recorded as
    ``fcff``, because a multiple whose denominator is not named is a multiple
    nobody can check.
    """
    if not free_cash_flows:
        raise EngineInputError("income.free_cash_flows must be a non-empty list")
    # The explicit forecast period is the exponent every discount factor below
    # is raised to, and it arrived as a list of whatever length the caller sent.
    # Python's float `**` raises OverflowError rather than returning inf, so a
    # plausible 30% discount rate over ~3,200 years — a 20 KB body, well inside
    # the request cap — took the whole request down with an unhandled exception
    # and a 500. `projection.py` already refuses the same horizon when it
    # *builds* the flows; a caller supplying them directly bypassed that, so the
    # bound belongs here too and is deliberately the same number.
    if len(free_cash_flows) > MAX_FORECAST_YEARS:
        raise EngineInputError(
            f"income.free_cash_flows accepts at most {MAX_FORECAST_YEARS} years "
            f"(a DCF forecast period is 5-10 years); got {len(free_cash_flows)}"
        )
    if terminal_method not in DCF_TERMINAL_METHODS:
        raise EngineInputError(
            f"income.terminal_method must be one of {list(DCF_TERMINAL_METHODS)} "
            f"(got {terminal_method!r})"
        )
    # Only the Gordon perpetuity diverges as the rate approaches the growth
    # rate. An exit multiple never capitalises anything, so demanding the same
    # inequality of it would refuse a perfectly ordinary payload — one that
    # values the horizon at 8x EBITDA and says nothing about perpetual growth.
    if terminal_method == "gordon" and discount_rate <= terminal_growth:
        raise EngineInputError("income.discount_rate must exceed terminal_growth")

    # compound_factor rather than a bare `**`: it turns an overflow or a base at
    # or below zero into a 422 naming the rate, instead of an OverflowError or a
    # complex number that dies several frames later.
    horizon = len(free_cash_flows)
    offset = 0.5 if mid_year_convention else 0.0
    factors = [
        compound_factor(discount_rate, year + 1 - offset, "income.discount_rate")
        for year in range(horizon)
    ]
    pv_fcf = sum(fcf / factor for fcf, factor in zip(free_cash_flows, factors))

    if terminal_method == "gordon":
        terminal_value = terminal_value_gordon(free_cash_flows[-1], discount_rate, terminal_growth)
        # The perpetuity's own flows are mid-year too, so it shares the stub —
        # see the docstring. `factors[-1]` is already (1+r)^(N-0.5).
        terminal_factor = factors[-1]
        terminal_detail: dict = {
            "method": "gordon",
            "terminal_growth": terminal_growth,
            "final_free_cash_flow": free_cash_flows[-1],
        }
    else:
        if exit_multiple is None:
            raise EngineInputError(
                "income.exit_multiple is required when terminal_method is 'exit_multiple'"
            )
        metric = terminal_metric if terminal_metric is not None else free_cash_flows[-1]
        basis = terminal_metric_basis or ("fcff" if terminal_metric is None else "unspecified")
        if metric <= 0:
            raise EngineInputError(
                f"income.terminal_metric must be positive to strike an exit multiple "
                f"against it (got {metric:g}) — use the Gordon terminal value instead"
            )
        terminal_value = terminal_value_exit_multiple(metric, exit_multiple)
        # A sale on the horizon date, not a flow spread over the final year, so
        # it takes the full N whether or not the explicit flows took a stub.
        terminal_factor = compound_factor(discount_rate, horizon, "income.discount_rate")
        terminal_detail = {
            "method": "exit_multiple",
            "exit_multiple": exit_multiple,
            "terminal_metric": metric,
            "terminal_metric_basis": basis,
        }

    pv_terminal = terminal_value / terminal_factor
    enterprise = pv_fcf + pv_terminal
    hint = (
        "check the cash-flow magnitudes, and that the discount rate is far "
        "enough above the terminal growth rate"
    )
    return {
        "pv_explicit": _finite_result(pv_fcf, "income.pv_explicit", hint),
        "pv_terminal": _finite_result(pv_terminal, "income.pv_terminal", hint),
        "enterprise_value": _finite_result(enterprise, "income.enterprise_value", hint),
        "equity_value": _finite_result(enterprise + cash - debt, "income.equity_value", hint),
        # The two methodology choices, on the result rather than only on the
        # request: a stored valuation is re-read by the report service and by
        # the next year's roll-forward, and neither can tell an 8% difference in
        # present value from a different forecast unless the convention is here.
        "mid_year_convention": mid_year_convention,
        "terminal_method": terminal_method,
        "terminal_value": _finite_result(terminal_value, "income.terminal_value", hint),
        "terminal_detail": terminal_detail,
    }


#: The horizons a guideline-public-company multiple can be struck over.
#: LTM is the last twelve months actually reported; NTM the next twelve
#: forecast. They are different multiples over different metrics and are not
#: interchangeable — see `market_multiples`.
MARKET_HORIZONS = ("ltm", "ntm")


def market_multiples(
    metric: float,
    multiples: list[float],
    cash: float = 0.0,
    debt: float = 0.0,
    horizon: str = "ltm",
    basis: str | None = None,
) -> dict:
    """Guideline-public-company value: median multiple × the subject's metric.

    ``horizon`` names which twelve months both sides of that product are struck
    over — ``ltm`` (last, reported) or ``ntm`` (next, forecast). It does not
    change the arithmetic, and that is exactly why it has to be recorded:
    nothing in a bare number says whether an 8.0× came off trailing or forward
    revenue, and pairing a forward multiple with a trailing metric understates
    a growing company by its whole growth rate. The caller supplies a matched
    pair; this records which pair it was, so the calculation, the report
    exhibit and the reviewer all read the same basis.

    ``basis`` is the metric's name (``revenue`` / ``ebitda``) for the same
    reason. Together they label the multiple: "EV/NTM Revenue".
    """
    if horizon not in MARKET_HORIZONS:
        raise EngineInputError(
            f"market.horizon must be one of {list(MARKET_HORIZONS)} (got {horizon!r})"
        )
    clean = [m for m in multiples if isinstance(m, (int, float)) and not isinstance(m, bool) and m > 0]
    if not clean:
        raise EngineInputError("market.multiples must contain at least one positive multiple")
    if metric <= 0:
        raise EngineInputError("market.metric must be positive")
    selected = statistics.median(clean)
    enterprise = selected * metric
    hint = "check the metric and multiple magnitudes"
    label = f"EV/{horizon.upper()} {basis.title()}" if basis else f"EV/{horizon.upper()}"
    return {
        "metric": metric,
        "multiples": clean,
        "selected_multiple": selected,
        "horizon": horizon,
        "basis": basis,
        "multiple_label": label,
        "enterprise_value": _finite_result(enterprise, "market.enterprise_value", hint),
        "equity_value": _finite_result(enterprise + cash - debt, "market.equity_value", hint),
    }


def asset_value(
    total_assets: float | None = None,
    total_liabilities: float | None = None,
    cost_to_replicate: float | None = None,
    method: str | None = None,
) -> dict:
    if method == "cost_to_replicate" or (method is None and cost_to_replicate is not None):
        if cost_to_replicate is None or cost_to_replicate < 0:
            raise EngineInputError("asset.cost_to_replicate is required for the cost-to-replicate method")
        return {"method": "cost_to_replicate", "equity_value": cost_to_replicate}
    if total_assets is None or total_liabilities is None:
        raise EngineInputError("asset.total_assets and asset.total_liabilities are required for NAV")
    return {
        "method": "nav",
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "equity_value": _finite_result(
            total_assets - total_liabilities,
            "asset.equity_value",
            "check the balance-sheet magnitudes",
        ),
    }


def opm_backsolve(
    last_round_post_money: float | None = None,
    *,
    last_round_pps: float | None = None,
    share_classes: list[dict] | None = None,
    last_round_class: str | None = None,
    preferred_shares: float | None = None,
    liquidation_preference: float | None = None,
    common_shares: float | None = None,
    options_shares: float | None = None,
    t: float | None = None,
    r: float | None = None,
    sigma: float | None = None,
) -> dict:
    """Market-calibrated equity value from the last priced round.

    Full backsolve (remaining-gaps §2): Newton-Raphson iterates the equity
    value until the last round's preferred reprices to the round PPS —
    against the full cap-table waterfall when share_classes is provided,
    else against the aggregate single-breakpoint model. Falls back to the
    post-money passthrough when the PPS inputs are absent (the M1 behavior).

    ``options_shares`` is the outstanding option pool. It belongs here because
    the single-breakpoint model this function inverts has to be *the same model*
    ``compute._opm_allocate`` then runs forward — see the comment on
    ``_single_breakpoint_base`` below.
    """
    # Lazy imports: newton/waterfall depend on this module's sibling `errors`.
    from .newton import implied_volatility, newton_raphson

    have_model = t is not None and r is not None and sigma is not None and sigma > 0

    # The junior share base the aggregate model splits residual upside on.
    #
    # `compute._opm_allocate` gives common `upside x fd / (fd + preferred)`,
    # where `fd` is common *plus the option pool* — options are folded into
    # fully-diluted common by the single-breakpoint simplification. The
    # backsolve is the inverse of exactly that allocation, so it has to use
    # exactly that denominator, and it did not: it split the upside on bare
    # common. Solve with one cap table, allocate with another, and the round
    # does not reprice to its own PPS under the model that produced the
    # opinion — which is the one property a backsolve exists to have.
    #
    # It is not a rounding difference. The omitted pool makes the preferred's
    # slice of the upside too large, so the equity value that hits the target
    # PPS comes out too low, and the understatement is roughly the size of the
    # pool: on 8M common, a 2M pool, 4M preferred behind a $10M preference at
    # 65% vol over four years, a $2.50 round backsolved to $18.0M where the
    # allocation model says $19.6M, and the concluded FMV per common share came
    # out 11.9% light — in the direction that under-prices employee options.
    #
    # `or 0.0` rather than a required argument: every other cap-table scalar on
    # this path is optional, and a caller that does not model a pool is not
    # wrong, it just has no pool.
    fully_diluted_common = (common_shares or 0.0) + (options_shares or 0.0)

    def _bounds(total_claim: float) -> tuple[float, float]:
        hi = max(total_claim * 1000.0, 1e6)
        if last_round_post_money and last_round_post_money > 0:
            hi = max(hi, last_round_post_money * 1000.0)
        return 1e-3, hi

    if last_round_pps is not None and last_round_pps > 0 and have_model:
        if share_classes and last_round_class:
            from .waterfall import class_per_share, normalize_share_classes

            target = float(last_round_pps)
            # Normalised before anything reads it. `sum(float(c.get("shares")))`
            # over the *raw* list was the first thing to touch a cap table on
            # this path, and it assumed every entry was a dict with a numeric
            # `shares` — an assumption only `_normalize` actually enforces, and
            # it does not run until `class_per_share` a few lines below. So a
            # single malformed entry — `share_classes: [{...}, 1.5]`, a null
            # left by a client-side filter, `"shares": "1,000,000"` — raised a
            # bare AttributeError/TypeError/ValueError out of a generator
            # expression, and a cap table the waterfall was about to refuse
            # with a 422 naming the offending class came back as a 500 naming
            # nothing. Reachable on /compute and, since it skips the pre-flight
            # validator entirely, on every /sensitivity run as well.
            #
            # The normaliser is the one authority on this shape and it runs on
            # this list anyway, once per Newton iteration; running it once up
            # front costs nothing and makes the error the same one the
            # allocation itself would have given.
            normalized = normalize_share_classes(share_classes)
            total_shares = sum(c["shares"] for c in normalized)
            lo, hi = _bounds(target * max(total_shares, 1.0))
            x0 = last_round_post_money if last_round_post_money and last_round_post_money > 0 else target * total_shares

            def objective(equity: float) -> float:
                return class_per_share(equity, share_classes, last_round_class, t, r, sigma) - target

            equity, iterations = newton_raphson(objective, x0, tol=1e-7, min_x=lo, max_x=hi)
            result = {
                "equity_value": equity,
                "method": "backsolve_waterfall",
                "iterations": iterations,
                "target_pps": target,
                "solved_pps": class_per_share(equity, share_classes, last_round_class, t, r, sigma),
            }
        elif (
            preferred_shares is not None
            and preferred_shares > 0
            and liquidation_preference is not None
            and liquidation_preference > 0
            and common_shares is not None
            and common_shares > 0
        ):
            from .bs import bs_call

            target = float(last_round_pps)
            pref_fraction = preferred_shares / (preferred_shares + fully_diluted_common)

            def preferred_per_share(equity: float) -> float:
                upside = bs_call(equity, liquidation_preference, t, r, sigma)
                return ((equity - upside) + pref_fraction * upside) / preferred_shares

            lo, hi = _bounds(target * (preferred_shares + fully_diluted_common))
            x0 = (
                last_round_post_money
                if last_round_post_money and last_round_post_money > 0
                else target * (preferred_shares + fully_diluted_common)
            )
            equity, iterations = newton_raphson(
                lambda e: preferred_per_share(e) - target, x0, tol=1e-7, min_x=lo, max_x=hi
            )
            result = {
                "equity_value": equity,
                "method": "backsolve_single",
                "iterations": iterations,
                "target_pps": target,
                "solved_pps": preferred_per_share(equity),
            }
        else:
            result = None
        if result is not None:
            if last_round_post_money and last_round_post_money > 0:
                result["last_round_post_money"] = last_round_post_money
                if (
                    # Only on the branch this inversion is the inverse *of*.
                    #
                    # The algebra below is the single-breakpoint payoff split and
                    # nothing else: preferred takes the preference, then a
                    # `preferred_shares / (preferred_shares + fd)` slice of one
                    # Black-Scholes call struck at the aggregate preference. The
                    # waterfall branch does not price the round that way — it
                    # walks seniority ranks, participation, conversion points and
                    # option-exercise points, and prices a call spread per
                    # segment. Reporting a vol derived from the simple model on a
                    # `backsolve_waterfall` result attached a figure from a model
                    # the run did not use to a run that says which model it did,
                    # and the two disagree by exactly as much as the cap table is
                    # more complicated than one preference — which is the whole
                    # reason the waterfall path exists.
                    #
                    # It was reachable on ordinary payloads, not exotic ones:
                    # `compute` passes the scalar cap-table fields alongside
                    # `share_classes` on every run, because the analyst form
                    # collects both, so any waterfall backsolve with a post-money
                    # carried one. An analyst comparing the disclosed implied vol
                    # against the `volatility` assumption the opinion rests on
                    # would read a gap that is an artifact of the wrong model.
                    #
                    # Omitted rather than approximated: this is a disclosure
                    # extra — the `except EngineInputError: pass` below already
                    # establishes that an ill-posed one is reported as nothing —
                    # and a silently-wrong number is worse than an absent one.
                    result["method"] == "backsolve_single"
                    and liquidation_preference
                    and liquidation_preference > 0
                    and preferred_shares
                    and common_shares
                ):
                    # Preferred value = (E − C) + f_p·C, so the implied common-
                    # side call value is C = (E − preferred_value) / (1 − f_p);
                    # invert Black-Scholes on that for the round's implied vol.
                    # Same junior base as the solve above, for the same reason:
                    # this inverts the identical payoff split.
                    pref_fraction = preferred_shares / (preferred_shares + fully_diluted_common)
                    # `1 − f_p` is a subtraction of two nearby doubles and it
                    # reaches exactly zero well before the *shares* do. Any cap
                    # table where the common count is more than ~2^53 times
                    # smaller than the preferred — 1e308 preferred against 7e6
                    # common, or a common count that underflowed to 1e-320 —
                    # rounds `f_p` to 1.0, and the division below is then a
                    # ZeroDivisionError escaping as a 500.
                    #
                    # Skipping is the right answer rather than raising: the
                    # inversion is a disclosure extra, and the `except
                    # EngineInputError: pass` immediately below already
                    # establishes that an ill-posed implied vol is reported as
                    # nothing rather than allowed to fail a run whose equity
                    # value solved fine.
                    if 1.0 - pref_fraction <= 0.0:
                        return result
                    call_value = (
                        last_round_post_money - last_round_pps * preferred_shares
                    ) / (1.0 - pref_fraction)
                    try:
                        result["implied_volatility"] = implied_volatility(
                            call_value, last_round_post_money, liquidation_preference, t, r
                        )
                    except EngineInputError:
                        pass  # ill-posed — report nothing rather than fail the run
            return result

    if last_round_post_money is None or last_round_post_money <= 0:
        raise EngineInputError("last_round_post_money must be positive for the OPM approach")
    return {"equity_value": last_round_post_money, "method": "post_money"}
