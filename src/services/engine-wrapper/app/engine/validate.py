"""Pre-flight validation of an engine payload — every problem at once.

``compute`` is fail-fast by design: the first bad input raises
:class:`EngineInputError` and the analyst gets one message per attempt. For a
409A engagement that turns into a compute → fix → compute loop, and the
messages carry no machine-readable field path, so nothing upstream can point at
the offending form control.

This module walks the same payload ``compute`` would consume and collects
*every* problem as a structured :class:`Issue` — a stable ``code``, the dotted
``field`` path into ``params``/``inputs``, a human message, and a ``hint``
saying what to do about it. Two severities:

* ``error``   — ``compute`` would raise on this. The run cannot succeed.
* ``warning`` — the run will succeed, but the result is questionable and a
  reviewer should look: a DLOM above what is normally supportable, a single
  comparable multiple, volatility outside the usual band, a weighted approach
  whose inputs are missing while its weight is zero, and so on.

Validation is *advisory and total*: it never raises, and an unrecognised shape
is reported rather than crashing the validator. ``compute`` remains the
authority on what actually runs — the checks here mirror it deliberately, and
the negative-path tests pin the two together.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field as dc_field
from datetime import date

from .anomalies import detect_anomalies
from .approaches import DCF_TERMINAL_METHODS
from .dlom import (
    DLOM_METHODS,
    DLOM_VOLATILITY_BASES,
    MODEL_DLOM_METHODS,
    PRE_IPO_RECENCY_YEAR,
    PRE_IPO_STUDIES,
    RESTRICTED_STOCK_STUDIES,
    is_post_amendment,
    selects_model_dlom,
)
from .projection import MAX_FORECAST_YEARS
# The modules that own a shape this validator mirrors. Imported rather than
# restated so a bound or a vocabulary changing in one place cannot leave the
# pre-flight quietly disagreeing with the engine about what is legal.
from .pwerm import SCENARIO_TYPES
from .waterfall import MAX_SHARE_CLASSES

ERROR = "error"
WARNING = "warning"

# Bands outside which a value is legal but worth a second look. Sourced from
# the ranges the AICPA practice aid and our own review checklist treat as
# ordinary for a venture-backed private company.
VOLATILITY_BAND = (0.20, 1.50)
DISCOUNT_RATE_BAND = (0.05, 0.60)
RISK_FREE_BAND = (0.0, 0.15)
DLOM_REVIEW_THRESHOLD = 0.45
DLOC_REVIEW_THRESHOLD = 0.35
TIME_TO_EXIT_BAND = (0.25, 10.0)

WEIGHT_KEYS = ("weight_asset", "weight_opm", "weight_income", "weight_market")
# params weight key → engine approach key (as recorded in results.approaches).
WEIGHT_TO_APPROACH = {
    "weight_asset": "asset",
    "weight_opm": "opm_backsolve",
    "weight_income": "income",
    "weight_market": "market",
}
ALLOCATION_METHODS = ("opm", "pwerm", "hybrid", "cvm", "monte_carlo")


@dataclass(frozen=True)
class Issue:
    """One validation finding, addressable by ``field`` and stable by ``code``."""

    code: str
    field: str
    message: str
    severity: str = ERROR
    hint: str | None = None

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "field": self.field,
            "message": self.message,
            "severity": self.severity,
            "hint": self.hint,
        }


@dataclass
class _Collector:
    issues: list[Issue] = dc_field(default_factory=list)

    def error(self, code: str, field: str, message: str, hint: str | None = None) -> None:
        self.issues.append(Issue(code, field, message, ERROR, hint))

    def warn(self, code: str, field: str, message: str, hint: str | None = None) -> None:
        self.issues.append(Issue(code, field, message, WARNING, hint))


def _finite(value) -> float | None:
    """Coerce to a finite float, or None if it is missing/unparsable/NaN."""
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _require_number(
    c: _Collector,
    value,
    field: str,
    *,
    positive: bool = False,
    hint: str | None = None,
) -> float | None:
    """Reports a missing / non-numeric / non-positive value and returns it."""
    if value is None:
        c.error("required", field, f"{field} is required", hint)
        return None
    num = _finite(value)
    if num is None:
        c.error("not_a_number", field, f"{field} must be a finite number", hint)
        return None
    if positive and num <= 0:
        c.error("not_positive", field, f"{field} must be positive (got {num:g})", hint)
        return None
    return num


# ── individual check groups ───────────────────────────────────────────────────


def _check_weights(c: _Collector, params: dict) -> dict[str, float]:
    """Approach weights: present, numeric, in [0, 1] and summing to 1."""
    raw = {k: params.get(k) for k in WEIGHT_KEYS}
    if all(v is None for v in raw.values()):
        c.error(
            "weights_unset",
            "params.weight_asset",
            "approach weights are not set",
            "Save the valuation params — the four approach weights must sum to 1.",
        )
        return {k: 0.0 for k in WEIGHT_KEYS}

    weights: dict[str, float] = {}
    ok = True
    for key, value in raw.items():
        num = _finite(value)
        if value is None or num is None:
            c.error("not_a_number", f"params.{key}", f"{key} must be a finite number")
            ok = False
            weights[key] = 0.0
            continue
        if not 0.0 <= num <= 1.0:
            c.error(
                "out_of_range",
                f"params.{key}",
                f"{key} must be between 0 and 1 (got {num:g})",
            )
            ok = False
        weights[key] = num

    if ok:
        total = sum(weights.values())
        if abs(total - 1.0) > 1e-6:
            c.error(
                "weights_sum",
                "params.weight_asset",
                f"approach weights must sum to 1.0 (got {total:.4f})",
                "Adjust the four weights in Valuation Params so they total 100%.",
            )
    return weights


def _check_asset(c: _Collector, params: dict, inputs: dict) -> None:
    asset = _dict(inputs.get("asset"))
    method = params.get("asset_method")
    # The same dispatch `approaches.asset_value` makes, and it makes two tests,
    # not one: an explicit `cost_to_replicate`, *or* no method at all with a
    # cost supplied — in which case it values on the cost and never looks at the
    # balance sheet. Only the first was mirrored here, so the validator demanded
    # `total_assets` and `total_liabilities` for a payload the engine values
    # perfectly well without them.
    #
    # `/compute` pre-flights and refuses on any error, so this was not a stale
    # message on an otherwise-fine run: it was a 422 blocking a valuation the
    # engine would have completed. And it is the ordinary shape, not an exotic
    # one — `params.asset_method` is nullable and the params form's own default
    # is blank, so an analyst who fills in the rebuild cost and leaves the
    # method dropdown alone gets told two balance-sheet fields are required for
    # a method that does not use a balance sheet.
    if method == "cost_to_replicate" or (method is None and asset.get("cost_to_replicate") is not None):
        # Non-negative, not positive: `asset_value` refuses only `< 0`, and a
        # zero rebuild cost is a real (if unusual) answer for a company whose
        # asset base is worth nothing. Refusing it here would be the same
        # too-strict pre-flight one line up, one bound narrower.
        cost = _require_number(
            c,
            asset.get("cost_to_replicate"),
            "inputs.asset.cost_to_replicate",
            hint="The cost-to-replicate method needs the rebuild cost of the asset base.",
        )
        if cost is not None and cost < 0:
            c.error(
                "out_of_range",
                "inputs.asset.cost_to_replicate",
                f"cost_to_replicate cannot be negative (got {cost:g})",
            )
        return
    total_assets = _require_number(c, asset.get("total_assets"), "inputs.asset.total_assets")
    total_liabilities = _require_number(
        c, asset.get("total_liabilities"), "inputs.asset.total_liabilities"
    )
    if total_assets is not None and total_liabilities is not None:
        if total_liabilities > total_assets:
            c.warn(
                "negative_nav",
                "inputs.asset.total_liabilities",
                "liabilities exceed assets — the NAV approach contributes a negative equity value",
                "Confirm the balance sheet, or drop the asset weight to zero.",
            )


def _check_opm_inputs(c: _Collector, inputs: dict) -> None:
    """The OPM-backsolve approach: a market anchor from the last round."""
    post_money = _finite(inputs.get("last_round_post_money"))
    pps = _finite(inputs.get("last_round_price_per_share"))
    volatility = _finite(inputs.get("volatility"))
    has_backsolve = pps is not None and pps > 0 and volatility is not None and volatility > 0
    if has_backsolve:
        return
    if post_money is None or post_money <= 0:
        c.error(
            "required",
            "inputs.last_round_post_money",
            "last_round_post_money must be positive for the OPM approach",
            "Enter the last round's post-money valuation, or the round price per "
            "share plus volatility to run a true backsolve.",
        )


def _check_income(c: _Collector, inputs: dict, *, auto_wacc: bool = False) -> None:
    income = _dict(inputs.get("income"))
    fcf = income.get("free_cash_flows")
    if not isinstance(fcf, list) or not fcf:
        c.error(
            "required",
            "inputs.income.free_cash_flows",
            "income.free_cash_flows must be a non-empty list of yearly cash flows",
            "Add the projection years to the financial model.",
        )
    elif len(fcf) > MAX_FORECAST_YEARS:
        # The horizon is the exponent on every discount factor, and a float `**`
        # overflows rather than saturating — so an over-long explicit forecast
        # reached `income_dcf` and came back a 500. Refused here so it lands as a
        # field-addressable 422 alongside whatever else is wrong with the payload.
        c.error(
            "out_of_range",
            "inputs.income.free_cash_flows",
            f"free_cash_flows accepts at most {MAX_FORECAST_YEARS} years; got {len(fcf)}",
            "An explicit DCF forecast period is 5-10 years; use the terminal value "
            "for everything past the horizon.",
        )
    else:
        flows = [_finite(v) for v in fcf]
        for i, value in enumerate(flows):
            if value is None:
                c.error(
                    "not_a_number",
                    f"inputs.income.free_cash_flows[{i}]",
                    f"free_cash_flows[{i}] must be a finite number",
                )
        clean = [v for v in flows if v is not None]
        if clean and all(v <= 0 for v in clean):
            c.warn(
                "all_negative_fcf",
                "inputs.income.free_cash_flows",
                "every projected cash flow is zero or negative",
                "A DCF built entirely on negative flows produces a negative equity "
                "value; check the projection or reweight away from the income approach.",
            )

    # With auto_wacc the discount rate is derived from the WACC build-up during
    # compute, so its absence here is expected.
    rate = (
        _finite(income.get("discount_rate"))
        if auto_wacc
        else _require_number(c, income.get("discount_rate"), "inputs.income.discount_rate", positive=True)
    )
    # `_finite(...) or 0.0` was the idiom, and it conflated three different
    # things: absent (default to zero, correct), zero (default to zero, same
    # answer), and *unusable* — a string, a list, a NaN, a bool — which it also
    # read as zero and reported nothing about.
    #
    # That last case is the one that mattered. `compute._num` does not agree
    # that an unusable terminal growth is zero: it raises on a string or a NaN,
    # so the validator cleared a payload (`ok: true`, no issues) that `/compute`
    # then refused — the precise mismatch this module's contract rules out. And
    # a bool was worse than a mismatch: `float(True)` is `1.0`, so `compute`
    # read `terminal_growth: true` as 100% perpetual growth and returned a fair
    # market value three times the correct one, warning-free, on a payload the
    # validator had called clean. (`compute._num` now refuses bools too; this is
    # the half that names the field for the analyst instead of failing the run.)
    #
    # Absent still means zero. Anything present has to be a number.
    terminal_method = _check_dcf_terminal(c, income)

    raw_growth = income.get("terminal_growth")
    growth = 0.0
    if raw_growth is not None:
        parsed_growth = _finite(raw_growth)
        if parsed_growth is None:
            c.error(
                "not_a_number",
                "inputs.income.terminal_growth",
                "terminal_growth must be a finite number",
                "Leave it unset for a zero-growth perpetuity, or enter the "
                "long-run growth rate as a fraction (2% is 0.02).",
            )
        else:
            growth = parsed_growth
    if rate is not None:
        # Only the Gordon perpetuity diverges at r <= g; an exit multiple
        # capitalises nothing, so the engine does not demand the inequality
        # there and neither can the pre-flight — see `approaches.income_dcf`.
        if terminal_method == "gordon" and rate <= growth:
            c.error(
                "rate_below_growth",
                "inputs.income.discount_rate",
                f"discount_rate ({rate:g}) must exceed terminal_growth ({growth:g})",
                "The Gordon terminal value diverges unless the discount rate is "
                "greater than the perpetual growth rate.",
            )
        elif not DISCOUNT_RATE_BAND[0] <= rate <= DISCOUNT_RATE_BAND[1]:
            c.warn(
                "outside_band",
                "inputs.income.discount_rate",
                f"discount rate {rate:.1%} is outside the usual "
                f"{DISCOUNT_RATE_BAND[0]:.0%}–{DISCOUNT_RATE_BAND[1]:.0%} band",
                "Document the WACC build-up supporting this rate.",
            )
    if growth >= 0.05:
        c.warn(
            "outside_band",
            "inputs.income.terminal_growth",
            f"terminal growth {growth:.1%} exceeds long-run GDP growth",
            "Perpetual growth above ~5% is hard to support in a valuation report.",
        )


def _check_dcf_terminal(c: _Collector, income: dict) -> str:
    """The DCF's terminal method and mid-year switch. Returns the method.

    Returned rather than only reported because the ``r > g`` check above depends
    on it: the inequality is a property of the Gordon perpetuity, and applying it
    to an exit-multiple run would refuse a payload the engine accepts — the
    precise pre-flight/engine disagreement this module exists to rule out.
    """
    method = income.get("terminal_method")
    resolved = "gordon"
    if method is not None:
        if not isinstance(method, str) or method not in DCF_TERMINAL_METHODS:
            c.error(
                "invalid_choice",
                "inputs.income.terminal_method",
                f"terminal_method must be one of {list(DCF_TERMINAL_METHODS)} (got {method!r})",
                "Leave it unset to capitalise the final year's cash flow into a "
                "perpetuity (Gordon growth).",
            )
        else:
            resolved = method

    if resolved == "exit_multiple":
        multiple = income.get("exit_multiple")
        parsed = _finite(multiple)
        if multiple is None:
            c.error(
                "required",
                "inputs.income.exit_multiple",
                "an exit-multiple terminal value needs inputs.income.exit_multiple",
                "Use the market approach's concluded multiple, or switch the terminal "
                "method back to Gordon growth.",
            )
        elif parsed is None or parsed <= 0:
            c.error(
                "out_of_range",
                "inputs.income.exit_multiple",
                "exit_multiple must be a positive number",
            )
        metric = income.get("terminal_metric")
        if metric is None:
            # Legal — the engine falls back to the final free cash flow — but an
            # EV/FCF exit multiple is not what an analyst who typed "8x" meant,
            # and the difference is invisible in the result unless it is said here.
            c.warn(
                "implied_terminal_metric",
                "inputs.income.terminal_metric",
                "no terminal metric supplied, so the exit multiple will be struck on "
                "the final year's free cash flow",
                "Supply the terminal-year EBITDA or revenue the multiple belongs to, "
                "so the report can name the denominator.",
            )
        elif _finite(metric) is None or _finite(metric) <= 0:  # type: ignore[operator]
            c.error(
                "out_of_range",
                "inputs.income.terminal_metric",
                "terminal_metric must be a positive number to strike a multiple against it",
            )

    # The mid-year switch is checked for *shape* only, and deliberately draws no
    # warning either way. End-of-year discounting is the weaker assumption — it
    # puts every dollar on 31 December and understates present value by
    # (1+r)^0.5 - 1, about 8% at a 17% discount rate — but it is also the
    # engine's default and the basis every stored valuation was concluded on. A
    # warning fired on the default is one that fires on every valuation, which
    # is a banner rather than a finding and trains reviewers to skip the panel.
    # Which convention ran is recorded on the result instead
    # (`approaches.income.mid_year_convention`), where the report can state it.
    mid_year = income.get("mid_year_convention")
    if mid_year is not None and not isinstance(mid_year, bool):
        c.error(
            "not_a_boolean",
            "inputs.income.mid_year_convention",
            "mid_year_convention must be true or false",
            "It selects the discounting convention, so it has to be an explicit "
            "true or false rather than a number or a string.",
        )

    return resolved


def _check_market(c: _Collector, inputs: dict, *, auto_comparables: bool = False) -> None:
    market = _dict(inputs.get("market"))
    multiples = market.get("multiples")
    if multiples is None and market.get("multiple") is not None:
        multiples = [market["multiple"]]
    if not isinstance(multiples, list) or not multiples:
        # With auto_comparables the multiples come from the comparable-company
        # engine during compute.
        if not auto_comparables:
            c.error(
                "required",
                "inputs.market.multiples",
                "market.multiples (from the comparable companies) is required",
                "Run the comparables pipeline, or enter the trading multiples manually.",
            )
    else:
        # Every entry, by index — not "does at least one survive".
        #
        # `compute._weighted_equity` coerces the whole list with `_req`, so one
        # unusable entry fails the run. The filter below only ever asked whether
        # *something* was left after dropping the bad ones, so `[8.0, null]`,
        # `[8.0, "12.5x"]` and `[8.0, true]` all cleared the pre-flight with
        # `ok: true` and were then refused by the calculation they had just
        # cleared — the mismatch this module's contract exists to rule out, and
        # the one `compute` names in its own comment on that coercion.
        #
        # It is the normal way a comparables list goes wrong, too: the market
        # feed returns `None` for a ticker with no multiple for the chosen
        # metric, and a hand-typed set carries the "x" suffix an analyst reads
        # the figure with. Reported per element, like `free_cash_flows`, so the
        # form can point at the offending row rather than the whole list.
        parsed = [_finite(x) for x in multiples]
        for i, value in enumerate(parsed):
            if value is None:
                c.error(
                    "not_a_number",
                    f"inputs.market.multiples[{i}]",
                    f"market.multiples[{i}] must be a finite number",
                    "Remove the comparable, or enter its multiple as a bare number (12.5, not '12.5x').",
                )
        clean = [m for m in parsed if m is not None and m > 0]
        if not clean:
            c.error(
                "not_positive",
                "inputs.market.multiples",
                "market.multiples must contain at least one positive multiple",
            )
        else:
            if len(clean) == 1:
                c.warn(
                    "thin_comparables",
                    "inputs.market.multiples",
                    "only one comparable multiple — the median is that single company",
                    "A guideline-company analysis normally rests on at least three comparables.",
                )
            biggest = max(clean)
            if biggest > 50:
                c.warn(
                    "outlier_multiple",
                    "inputs.market.multiples",
                    f"a comparable multiple of {biggest:g}× looks like an outlier",
                    "Check the comparable set for a company with a near-zero metric.",
                )
    _require_number(
        c,
        market.get("metric"),
        "inputs.market.metric",
        positive=True,
        hint="The metric is the revenue or EBITDA the multiple is applied to.",
    )


def _check_share_classes(c: _Collector, classes: list) -> None:
    """The cap table, class by class — mirrors ``waterfall._normalize``.

    Nothing looked inside ``share_classes`` before. The list's *shape* was
    checked and its contents were left to the normaliser, which runs inside
    ``compute`` and is fail-fast: it raises on the first bad class, so a cap
    table with four problems took four round trips, and every message arrived
    as a bare string with no field path for the form to point at. That is
    precisely the loop this module exists to collapse — and the cap table is
    the input most likely to need it, because it is imported from a
    spreadsheet rather than typed into four boxes.

    The class-level checks are the ones an import gets wrong: a missing name, a
    kind spelled `preference` instead of `preferred`, a share count that came
    through as a string with a thousands separator, a preferred class whose
    preference column was blank, an option pool with no strike. Two duplicated
    class names is the other common one — spreadsheets carry a "Series A" and a
    "Series A-1" that both trim to the same label.

    Not mirrored: the representability guards (`shares × conversion_ratio`
    leaving the doubles, the fully-diluted total overflowing). Those are
    properties of the arithmetic on figures that individually pass everything
    here, they carry their own explanatory messages, and no analyst reaches
    them by accident — ``compute`` stays the authority on those, as this
    module's contract says it does on anything a pre-flight cannot see.
    """
    if len(classes) > MAX_SHARE_CLASSES:
        c.error(
            "too_many",
            "inputs.share_classes",
            f"share_classes accepts at most {MAX_SHARE_CLASSES} classes (got {len(classes)})",
            "The breakpoint allocation grows with the square of the class count; "
            "consolidate classes that share economics.",
        )
        return

    seen: set[str] = set()
    has_common = False
    for i, raw in enumerate(classes):
        path = f"inputs.share_classes[{i}]"
        if not isinstance(raw, dict):
            c.error("invalid_shape", path, f"share_classes[{i}] must be an object")
            continue

        name = str(raw.get("name") or "").strip()
        if not name:
            c.error("required", f"{path}.name", f"share_classes[{i}].name is required")
        elif name in seen:
            c.error(
                "duplicate",
                f"{path}.name",
                f"share_classes: duplicate class name '{name}'",
                "Each class needs a distinct label — the allocation is keyed by name.",
            )
        else:
            seen.add(name)
        label = name or f"share_classes[{i}]"

        kind = raw.get("kind")
        if kind not in ("preferred", "common", "option"):
            c.error(
                "out_of_range",
                f"{path}.kind",
                f"share_classes[{i}].kind must be one of ('preferred', 'common', 'option')",
            )
        elif kind == "common":
            has_common = True

        shares = _finite(raw.get("shares"))
        if shares is None:
            c.error("not_a_number", f"{path}.shares", f"'{label}': shares must be a number")
        elif shares <= 0:
            c.error(
                "not_positive",
                f"{path}.shares",
                f"'{label}': shares must be positive (got {shares:g})",
            )

        if kind == "preferred":
            preference = _finite(raw.get("preference"))
            if preference is None:
                c.error(
                    "required",
                    f"{path}.preference",
                    f"'{label}': preference (total) is required for preferred",
                    "The total liquidation preference of the class, not the per-share amount.",
                )
            elif preference < 0:
                c.error(
                    "out_of_range",
                    f"{path}.preference",
                    f"'{label}': preference must be >= 0 (got {preference:g})",
                )
            seniority = raw.get("seniority", 1)
            if not isinstance(seniority, int) or isinstance(seniority, bool) or seniority < 1:
                c.error(
                    "out_of_range",
                    f"{path}.seniority",
                    f"'{label}': seniority must be an integer >= 1",
                    "1 is the most senior rank; classes sharing a rank split pari passu.",
                )
            # `None` defaults to 1:1; anything else present has to be a positive
            # number, because a zero ratio would value a class as if it converted
            # normally while converting into nothing.
            if raw.get("conversion_ratio") is not None:
                ratio = _finite(raw["conversion_ratio"])
                if ratio is None:
                    c.error(
                        "not_a_number",
                        f"{path}.conversion_ratio",
                        f"'{label}': conversion_ratio must be a number",
                    )
                elif ratio <= 0:
                    c.error(
                        "not_positive",
                        f"{path}.conversion_ratio",
                        f"'{label}': conversion_ratio must be positive (got {ratio:g})",
                    )
            # Mirrors `waterfall._normalize`: a cap only means something on a
            # participating class, and only above the preference. Both are
            # refusals in the allocation, so both belong here rather than
            # reaching the analyst as a bare `detail` from `/compute`.
            if raw.get("participation_cap") is not None:
                cap = _finite(raw["participation_cap"])
                if cap is None:
                    c.error(
                        "not_a_number",
                        f"{path}.participation_cap",
                        f"'{label}': participation_cap must be a number",
                    )
                elif not bool(raw.get("participating", False)):
                    c.error(
                        "invalid_shape",
                        f"{path}.participation_cap",
                        f"'{label}': participation_cap applies only to participating preferred",
                        "Set participating: true, or drop the cap — a non-participating class "
                        "already stops at its preference.",
                    )
                elif preference is not None and cap <= preference:
                    c.error(
                        "out_of_range",
                        f"{path}.participation_cap",
                        f"'{label}': participation_cap ({cap:g}) must exceed the liquidation "
                        f"preference ({preference:g})",
                        "The cap is the total the class may take, preference included, so a cap "
                        "at or below the preference is `participating: false`.",
                    )
        elif kind == "option":
            strike = _finite(raw.get("strike"))
            if strike is None:
                c.error(
                    "required",
                    f"{path}.strike",
                    f"'{label}': strike is required for options",
                )
            elif strike <= 0:
                c.error(
                    "not_positive",
                    f"{path}.strike",
                    f"'{label}': strike must be positive (got {strike:g})",
                )

    if not has_common:
        c.error(
            "required",
            "inputs.share_classes",
            "share_classes must include at least one 'common' class",
            "The residual after the preference stack is shared on the common classes; "
            "without one there is nothing to conclude a per-share value on.",
        )


def _check_cap_table(
    c: _Collector,
    params: dict,
    inputs: dict,
    *,
    allocation_method: str = "opm",
    auto_volatility: bool = False,
) -> None:
    """Share counts, preference stack and the volatility the allocation needs."""
    _require_number(
        c,
        inputs.get("shares_outstanding_common"),
        "inputs.shares_outstanding_common",
        positive=True,
        hint="Fully diluted common is the denominator of the per-share value.",
    )

    # Share counts and the preference stack are all "cannot be negative", and
    # each of them silently changes the answer rather than failing when it is.
    #
    # `options_outstanding` was checked from the start; the other two were not,
    # and they are the ones that matter most. Every allocation path guards the
    # preference with `preferred_shares > 0 and liquidation_preference > 0`, so a
    # single mistyped minus sign does not produce a wrong-looking number — it
    # takes the entire preference stack out of the model and falls through to
    # as-converted, where common receives everything. Measured on the reference
    # payload, `shares_outstanding_preferred: -2000000` moved the concluded FMV
    # from $0.9761 to $1.5789, a 62% overstatement reported as a clean 200 with
    # no error and no warning. That is the direction that understates option
    # strike prices, and it is invisible in the result.
    for field_name, label in (
        ("options_outstanding", "options_outstanding"),
        ("shares_outstanding_preferred", "shares_outstanding_preferred"),
        ("liquidation_preference", "liquidation_preference"),
    ):
        raw = inputs.get(field_name)
        if raw is None:
            continue
        num = _finite(raw)
        if num is None:
            c.error("not_a_number", f"inputs.{field_name}", f"{label} must be a number")
        elif num < 0:
            c.error(
                "out_of_range",
                f"inputs.{field_name}",
                f"{label} cannot be negative (got {num:g})",
            )

    share_classes = inputs.get("share_classes")
    has_waterfall = False
    if isinstance(share_classes, list) and share_classes:
        has_waterfall = True
        _check_share_classes(c, share_classes)
    if share_classes is not None and not isinstance(share_classes, list):
        c.error(
            "invalid_shape",
            "inputs.share_classes",
            "share_classes must be a list of cap-table classes",
        )

    preferred = _finite(inputs.get("shares_outstanding_preferred")) or 0.0
    preference = _finite(inputs.get("liquidation_preference")) or 0.0
    if preferred > 0 and preference <= 0 and not has_waterfall:
        c.warn(
            "no_preference",
            "inputs.liquidation_preference",
            "preferred shares are outstanding but no liquidation preference is set",
            "Without a preference the allocation falls back to as-converted, which "
            "overstates common value.",
        )
    # The converse, and the more damaging of the two — which is why it is an
    # error rather than the warning above. A preference with no preferred share
    # count behind it cannot be allocated at all: the aggregate branches in
    # `compute._opm_allocate` and `current_value.allocate_cvm` need the count to
    # size the upside slice, so both now refuse it. This is the pre-flight saying
    # so first, with the field path, instead of the analyst learning it from a
    # bare `detail` on a run they had been told was fine.
    #
    # A missing preferred count also used to be *silent* rather than refused,
    # which is what makes stating it here worth doing twice: the run succeeded,
    # common took the whole equity value, and the preference stack simply was not
    # in the model. Nothing on the response said which figure had been ignored.
    if preference > 0 and preferred <= 0 and not has_waterfall and allocation_method != "pwerm":
        c.error(
            "required",
            "inputs.shares_outstanding_preferred",
            "a liquidation preference is set but no preferred shares are outstanding — "
            "the allocation needs both to place the preference",
            "Enter the preferred shares outstanding, or clear the liquidation preference "
            "if the company has no preferred stock. Importing the cap table instead sets "
            "share_classes, which carries a preference per class and does not use these.",
        )

    # Simulating a payoff needs the payoff structure it is simulating. Unlike
    # every other allocation there is no aggregate fallback here — a blended
    # preferred class behind one preference is precisely the case the closed
    # form already prices exactly, so accepting it would mean offering a slower,
    # noisier route to an answer the OPM gives outright.
    if allocation_method == "monte_carlo" and not has_waterfall:
        c.error(
            "required",
            "inputs.share_classes",
            "the Monte Carlo allocation requires the cap table (inputs.share_classes)",
            "Import or enter the share classes. For an aggregate preference stack use the "
            "OPM allocation, which prices that structure exactly and without simulation.",
        )

    volatility = _finite(inputs.get("volatility"))
    model_dlom = selects_model_dlom(params)
    # Only the OPM-style allocations price a Black-Scholes call; PWERM and CVM
    # walk the deterministic waterfall and need volatility solely for a model
    # DLOM. With auto_volatility the estimator supplies it during compute.
    #
    # Monte Carlo belongs with the first group: volatility is the entire
    # parameter it simulates, and a run without one is a very expensive way to
    # evaluate the deterministic waterfall.
    opm_allocation = allocation_method in ("opm", "hybrid", "monte_carlo")
    needs_volatility = not auto_volatility and (
        model_dlom or (opm_allocation and (preference > 0 or has_waterfall))
    )
    if volatility is None or volatility <= 0:
        if needs_volatility:
            c.error(
                "required",
                "inputs.volatility",
                "volatility is required for the OPM allocation / model DLOM",
                "Run the volatility estimator over the comparable set, or enter it manually.",
            )
    elif not VOLATILITY_BAND[0] <= volatility <= VOLATILITY_BAND[1]:
        c.warn(
            "outside_band",
            "inputs.volatility",
            f"volatility {volatility:.1%} is outside the usual "
            f"{VOLATILITY_BAND[0]:.0%}–{VOLATILITY_BAND[1]:.0%} band",
            "Check the comparable set and the lookback window.",
        )

    rate = _finite(inputs.get("risk_free_rate"))
    if rate is not None and not RISK_FREE_BAND[0] <= rate <= RISK_FREE_BAND[1]:
        c.warn(
            "outside_band",
            "inputs.risk_free_rate",
            f"risk-free rate {rate:.1%} is outside the plausible "
            f"{RISK_FREE_BAND[0]:.0%}–{RISK_FREE_BAND[1]:.0%} band",
            "Use the Treasury yield matching the time to exit.",
        )


def _check_discounts(c: _Collector, params: dict) -> None:
    dloc = _finite(params.get("dloc"))
    if params.get("dloc") is not None and dloc is None:
        c.error("not_a_number", "params.dloc", "dloc must be a finite number")
    elif dloc is not None:
        if not 0.0 <= dloc < 1.0:
            c.error("out_of_range", "params.dloc", f"dloc must be a fraction in [0, 1) (got {dloc:g})")
        elif dloc > DLOC_REVIEW_THRESHOLD:
            c.warn(
                "high_discount",
                "params.dloc",
                f"a {dloc:.1%} discount for lack of control is unusually large",
                "Support it with the control-premium study you relied on.",
            )

    basis = params.get("dlom_volatility_basis")
    if basis is not None and (
        not isinstance(basis, str) or basis.lower() not in DLOM_VOLATILITY_BASES
    ):
        c.error(
            "invalid_choice",
            "params.dlom_volatility_basis",
            f"dlom_volatility_basis must be one of {list(DLOM_VOLATILITY_BASES)} (got {basis!r})",
            "Leave it unset to strike the DLOM on the common class's own volatility, "
            "which is the interest being valued.",
        )
    elif isinstance(basis, str) and basis.lower() == "enterprise":
        c.warn(
            "enterprise_dlom_volatility",
            "params.dlom_volatility_basis",
            "the DLOM will be struck on the enterprise volatility rather than on the "
            "common class's own",
            "Common sits behind the preference stack, so its return volatility is "
            "higher than the enterprise's and the option models take the volatility of "
            "the interest being valued. Document why the enterprise figure was used.",
        )

    method = params.get("dlom_method")
    blend = params.get("dlom_methods")
    if blend is not None:
        # A weighted blend is checked as a set of weights here; each leg's own
        # inputs are checked by the branch that leg selects, and the concluded
        # figure only exists after compute. `_check_dlom_blend` returns nothing
        # for `dlom` because there is no single number to range-check yet.
        _check_dlom_blend(c, params)
        return

    if method == "qualitative":
        qualitative = params.get("dlom_qualitative")
        if qualitative is None and params.get("dlom") is None:
            c.error(
                "required",
                "params.dlom_qualitative",
                "the qualitative DLOM method needs dlom_qualitative (or dlom)",
            )
        dlom = _finite(qualitative if qualitative is not None else params.get("dlom"))
    elif method in MODEL_DLOM_METHODS:
        dlom = None  # derived from volatility and time to exit at compute time
    elif method == "restricted_stock":
        # Blended from the study set at compute time. What can be checked here
        # is the *set*: an unknown study name is a 422 from the engine rather
        # than a number, and a set straddling the 1997 Rule 144 amendment is a
        # reviewable choice rather than an error.
        dlom = None
        _check_restricted_stock(c, params)
    elif method == "pre_ipo":
        # Same again over the other empirical table, plus the caveat this family
        # always carries — see `_check_pre_ipo`.
        dlom = None
        _check_pre_ipo(c, params)
    else:
        dlom = _finite(params.get("dlom"))
        if params.get("dlom") is not None and dlom is None:
            c.error("not_a_number", "params.dlom", "dlom must be a finite number")

    if dlom is not None:
        if not 0.0 <= dlom < 1.0:
            c.error("out_of_range", "params.dlom", f"dlom must be a fraction in [0, 1) (got {dlom:g})")
        elif dlom > DLOM_REVIEW_THRESHOLD:
            c.warn(
                "high_discount",
                "params.dlom",
                f"a {dlom:.1%} discount for lack of marketability is above the range "
                "normally supportable",
                "Reviewers will expect a model DLOM (Chaffee / Finnerty / Ghaidarov / "
                "Longstaff) or a cited restricted-stock study.",
            )


def _check_dlom_blend(c: _Collector, params: dict) -> None:
    """Pre-flight for a weighted DLOM (`dlom_methods`): the methods and weights.

    The engine raises on every problem found here, but only once the calculation
    has been dispatched. Checking at save time is what lets the params editor
    refuse a blend whose weights total 90% — which is the mistake this shape
    makes easy, and the one with no safe recovery: the weights are deliberately
    not normalised (see `compute._blended_dlom`), so a blend summing to 0.9
    concludes on a discount a tenth lower than the analyst intended rather than
    on their figures scaled up.
    """
    blend = params.get("dlom_methods")
    if params.get("dlom_method") is not None:
        c.error(
            "conflicting",
            "params.dlom_methods",
            "dlom_method and dlom_methods are both set",
            "Choose one method, or weight several — not both.",
        )
        return
    if not isinstance(blend, list) or not blend:
        c.error(
            "invalid_shape",
            "params.dlom_methods",
            "dlom_methods must be a non-empty list of {method, weight} objects",
            "Leave it unset and set dlom_method to conclude on a single method.",
        )
        return
    if len(blend) < 2:
        c.error(
            "invalid_shape",
            "params.dlom_methods",
            "a weighted DLOM needs at least two methods",
            "Set dlom_method instead to conclude on one.",
        )
        return

    total = 0.0
    seen: set[str] = set()
    ok = True
    for i, entry in enumerate(blend):
        field = f"params.dlom_methods[{i}]"
        if not isinstance(entry, dict):
            c.error("invalid_shape", field, "each entry must be an object with method and weight")
            ok = False
            continue
        name = entry.get("method")
        if not isinstance(name, str) or name not in DLOM_METHODS:
            c.error(
                "out_of_range",
                f"{field}.method",
                f"method must be one of {sorted(DLOM_METHODS)} (got {name!r})",
            )
            ok = False
        elif name in seen:
            c.error(
                "duplicate",
                f"{field}.method",
                f"{name!r} is weighted twice",
                "Give each method a single weight.",
            )
            ok = False
        else:
            seen.add(name)
            if name == "restricted_stock":
                _check_restricted_stock(c, params)
            elif name == "pre_ipo":
                _check_pre_ipo(c, params)
            elif name == "qualitative" and params.get("dlom_qualitative") is None:
                c.error(
                    "required",
                    "params.dlom_qualitative",
                    "a qualitative leg needs dlom_qualitative",
                    "It is the analyst's own figure; nothing derives it.",
                )
                ok = False

        weight = _finite(entry.get("weight"))
        if weight is None:
            c.error("not_a_number", f"{field}.weight", "weight must be a finite number")
            ok = False
        elif not 0.0 <= weight <= 1.0:
            c.error(
                "out_of_range",
                f"{field}.weight",
                f"weight must be a fraction in [0, 1] (got {weight:g})",
            )
            ok = False
        else:
            total += weight

    if ok and abs(total - 1.0) > 1e-6:
        c.error(
            "weights_sum",
            "params.dlom_methods",
            f"DLOM method weights must sum to 1.0 (got {total:.4f})",
            "Adjust the weights so they total 100%.",
        )

    # A zero-weighted method is in the table and out of the answer, which is a
    # reviewable choice rather than a mistake — an appraiser who computed
    # Longstaff to show it as an upper bound and weighted it to nothing is
    # documenting the bound, not concluding on it.
    zero = [
        str(e.get("method"))
        for e in blend
        if isinstance(e, dict) and _finite(e.get("weight")) == 0.0
    ]
    if zero:
        c.warn(
            "zero_weight",
            "params.dlom_methods",
            f"{sorted(zero)} carry no weight in the concluded discount",
            "They will appear in the report's method table with a nil weight.",
        )


def _check_restricted_stock(c: _Collector, params: dict) -> None:
    """Pre-flight for the `restricted_stock` DLOM: the study set.

    The engine raises on an unknown study name, which is a 422 the analyst can
    act on but only *after* the calculation is dispatched. Naming them here
    means the params editor can refuse the set at save time, and it is the one
    place that can say which names are actually available.
    """
    known = {row["study"] for row in RESTRICTED_STOCK_STUDIES}
    table = params.get("dlom_study_table")
    if isinstance(table, list) and table:
        # A caller-supplied table replaces the built-ins entirely, so the
        # selection is checked against theirs, not ours.
        known = {
            str(row["study"]).strip()
            for row in table
            if isinstance(row, dict) and isinstance(row.get("study"), str) and row["study"].strip()
        }

    statistic = params.get("dlom_statistic")
    if statistic is not None and statistic not in ("median", "mean"):
        c.error(
            "out_of_range",
            "params.dlom_statistic",
            f"dlom_statistic must be 'median' or 'mean' (got {statistic!r})",
        )

    selected = params.get("dlom_studies")
    if selected is None:
        return
    if not isinstance(selected, list) or not selected:
        c.error(
            "invalid_shape",
            "params.dlom_studies",
            "dlom_studies must be a non-empty list of study names",
            "Leave it unset to use the post-1997 default set.",
        )
        return

    unknown = sorted({str(n) for n in selected} - known)
    if unknown:
        c.error(
            "unknown_study",
            "params.dlom_studies",
            f"unknown restricted-stock studies: {unknown}",
            f"Available studies: {sorted(known)}.",
        )
        return

    # Classified by `is_post_amendment` rather than by a period comparison
    # restated here: this check had its own copy of the rule keyed on
    # period_end, which called a set holding both Columbia studies — the
    # textbook straddle, one either side of the amendment — single-regime,
    # because the earlier study's window closes *in* 1997.
    by_name = {row["study"]: row for row in RESTRICTED_STOCK_STUDIES}
    dated = [by_name[n] for n in selected if n in by_name]
    if any(is_post_amendment(r) for r in dated) and any(
        not is_post_amendment(r) for r in dated
    ):
        c.warn(
            "mixed_regime",
            "params.dlom_studies",
            "the selected studies straddle the 1997 Rule 144 amendment, which cut the "
            "holding period from two years to one",
            "Discounts before and after the amendment describe different securities. "
            "Blending them produces a figure for a regime that never existed — select "
            "one side or explain the blend in the report.",
        )


def _check_pre_ipo(c: _Collector, params: dict) -> None:
    """Pre-flight for the `pre_ipo` DLOM: the study set and the family's caveat.

    The same job `_check_restricted_stock` does for the other empirical family,
    against the other table — plus the one warning this family always earns.
    """
    known = {row["study"] for row in PRE_IPO_STUDIES}
    table = params.get("dlom_pre_ipo_table")
    if isinstance(table, list) and table:
        known = {
            str(row["study"]).strip()
            for row in table
            if isinstance(row, dict) and isinstance(row.get("study"), str) and row["study"].strip()
        }

    # Always, not only on an unusual set. A pre-IPO discount runs roughly twice
    # a post-amendment restricted-stock one, and the reason is partly
    # measurement rather than marketability — the sample is companies that went
    # on to complete an IPO. A report concluding here without addressing that is
    # the one a reviewer sends back, so the pre-flight says so at save time
    # rather than leaving it to be noticed in review.
    c.warn(
        "pre_ipo_selection_bias",
        "params.dlom_method",
        "pre-IPO studies observe only companies that went on to complete an IPO, so "
        "part of the measured discount is the change in prospects over the period",
        "Address the selection bias in the report, and consider weighting this "
        "against a restricted-stock leg through dlom_methods rather than concluding "
        "on it alone.",
    )

    selected = params.get("dlom_pre_ipo_studies")
    if selected is None:
        return
    if not isinstance(selected, list) or not selected:
        c.error(
            "invalid_shape",
            "params.dlom_pre_ipo_studies",
            "dlom_pre_ipo_studies must be a non-empty list of study names",
            "Leave it unset to use the default set (the most recent window from each "
            "study family, plus Emory's combined figure).",
        )
        return

    unknown = sorted({str(n) for n in selected} - known)
    if unknown:
        c.error(
            "unknown_study",
            "params.dlom_pre_ipo_studies",
            f"unknown pre-IPO studies: {unknown}",
            f"Available studies: {sorted(known)}.",
        )
        return

    # Keyed on when each window *closed*, not on when it opened — see
    # `PRE_IPO_RECENCY_YEAR` for why this is the opposite key from the Rule 144
    # test two functions up, and what goes wrong if the two are conflated.
    by_name = {row["study"]: row for row in PRE_IPO_STUDIES}
    dated = [by_name[n] for n in selected if n in by_name]
    if any(
        isinstance(r.get("period_end"), int) and r["period_end"] < PRE_IPO_RECENCY_YEAR
        for r in dated
    ):
        c.warn(
            "dated_study_window",
            "params.dlom_pre_ipo_studies",
            f"the selection includes a window that closed before {PRE_IPO_RECENCY_YEAR}, "
            "when the IPO market worked differently",
            "A discount observed in the early 1980s is weak evidence about a company "
            "being valued today; prefer the recent windows, or say why the long series "
            "is the better basis.",
        )


def _check_dates(c: _Collector, params: dict, inputs: dict) -> None:
    """Valuation / exit dates and the time to exit they imply."""
    valuation_date = inputs.get("valuation_date")
    parsed_valuation: date | None = None
    if valuation_date is not None:
        try:
            parsed_valuation = date.fromisoformat(str(valuation_date)[:10])
        except ValueError:
            c.error(
                "invalid_date",
                "inputs.valuation_date",
                "valuation_date must be YYYY-MM-DD",
            )

    exit_timeline = params.get("exit_timeline")
    override = _finite(inputs.get("time_to_exit_years"))
    years: float | None = override
    if override is None and exit_timeline:
        try:
            exit_date = date.fromisoformat(str(exit_timeline)[:10])
            years = (exit_date - (parsed_valuation or date.today())).days / 365.25
        except ValueError:
            c.error(
                "invalid_date",
                "params.exit_timeline",
                "exit_timeline must be YYYY-MM-DD",
            )

    if years is None:
        return
    if years <= 0:
        c.warn(
            "exit_in_past",
            "params.exit_timeline",
            "the exit date is on or before the valuation date",
            "The engine floors the time to exit at zero, collapsing the option value.",
        )
    elif not TIME_TO_EXIT_BAND[0] <= years <= TIME_TO_EXIT_BAND[1]:
        c.warn(
            "outside_band",
            "params.exit_timeline",
            f"time to exit of {years:.2f} years is outside the usual "
            f"{TIME_TO_EXIT_BAND[0]:g}–{TIME_TO_EXIT_BAND[1]:g} year band",
            "The time to exit drives both the option value and any model DLOM.",
        )


def _check_pwerm(c: _Collector, inputs: dict) -> None:
    share_classes = inputs.get("share_classes")
    if not isinstance(share_classes, list) or not share_classes:
        c.error(
            "required",
            "inputs.share_classes",
            "PWERM requires inputs.share_classes (the cap table)",
            "Import the cap table so the waterfall can split each exit outcome.",
        )

    pwerm = inputs.get("pwerm")
    if not isinstance(pwerm, dict):
        c.error(
            "required",
            "inputs.pwerm.scenarios",
            "the PWERM allocation needs inputs.pwerm.scenarios",
            "Model the discrete exit outcomes (IPO / acquisition / stay private).",
        )
        return
    scenarios = pwerm.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        c.error(
            "required",
            "inputs.pwerm.scenarios",
            "pwerm.scenarios must be a non-empty list",
        )
        return
    if len(scenarios) > 50:
        c.error(
            "too_many",
            "inputs.pwerm.scenarios",
            f"at most 50 scenarios (got {len(scenarios)})",
        )

    total = 0.0
    countable = True
    for i, scenario in enumerate(scenarios):
        path = f"inputs.pwerm.scenarios[{i}]"
        if not isinstance(scenario, dict):
            c.error("invalid_shape", path, f"scenarios[{i}] must be an object")
            countable = False
            continue
        probability = _finite(scenario.get("probability"))
        if probability is None:
            c.error("required", f"{path}.probability", f"scenarios[{i}].probability is required")
            countable = False
        elif probability < 0:
            c.error(
                "out_of_range",
                f"{path}.probability",
                f"scenarios[{i}].probability must be >= 0",
            )
            countable = False
        else:
            total += probability

        if scenario.get("equity_value") is None and scenario.get("enterprise_value") is None:
            c.error(
                "required",
                f"{path}.equity_value",
                f"scenarios[{i}] needs an equity_value or enterprise_value",
            )
        else:
            # `_scenario_equity` refuses a negative exit. It cannot be bridged
            # here — the cash/debt that turn an enterprise value into an equity
            # value live outside the scenario — so only a directly-stated
            # equity value is checked, which is the one the analyst types.
            stated = scenario.get("equity_value")
            if stated is not None:
                equity = _finite(stated)
                if equity is None:
                    c.error(
                        "not_a_number",
                        f"{path}.equity_value",
                        f"scenarios[{i}].equity_value must be a finite number",
                    )
                elif equity < 0:
                    c.error(
                        "out_of_range",
                        f"{path}.equity_value",
                        f"scenarios[{i}] exit equity value is negative ({equity:.2f})",
                        "A liquidation scenario bottoms out at zero — equity holders are not "
                        "liable beyond their investment.",
                    )
            elif _finite(scenario.get("enterprise_value")) is None:
                c.error(
                    "not_a_number",
                    f"{path}.enterprise_value",
                    f"scenarios[{i}].enterprise_value must be a finite number",
                )

        scenario_type = scenario.get("type")
        if scenario_type is not None and scenario_type not in SCENARIO_TYPES:
            c.error(
                "out_of_range",
                f"{path}.type",
                f"scenarios[{i}].type must be one of {SCENARIO_TYPES}",
            )

        if scenario.get("time_to_exit_years") is not None:
            years = _finite(scenario["time_to_exit_years"])
            if years is None:
                c.error(
                    "not_a_number",
                    f"{path}.time_to_exit_years",
                    f"scenarios[{i}].time_to_exit_years must be a finite number",
                )
            elif years < 0:
                c.error(
                    "out_of_range",
                    f"{path}.time_to_exit_years",
                    f"scenarios[{i}].time_to_exit_years must be >= 0",
                )

        if scenario.get("discount_rate") is not None:
            rate = _finite(scenario["discount_rate"])
            if rate is None:
                c.error(
                    "not_a_number",
                    f"{path}.discount_rate",
                    f"scenarios[{i}].discount_rate must be a finite number",
                )
            elif rate <= -1:
                c.error(
                    "out_of_range",
                    f"{path}.discount_rate",
                    f"scenarios[{i}].discount_rate must exceed -1 (i.e. > -100%)",
                )

    # An error, not a warning — and unconditional, not `if total > 0`.
    #
    # `allocate_pwerm` refuses a set that does not sum to 1; it does not
    # normalise anything, which is what the warning this replaces told the
    # analyst it would do. So a PWERM payload whose probabilities came to 0.9
    # was reported `ok: true` with a reassuring note, and then refused by
    # `/compute` with a bare `detail` string and no field path — the analyst
    # having been told, in writing, that the engine would handle it.
    #
    # The `total > 0` guard was the same bug with the volume off: a set that is
    # all zeros (or whose every probability failed a check above) summed to 0,
    # skipped the warning entirely, and produced no issue of any kind for a
    # payload the engine cannot run. `countable` is what keeps that from
    # double-reporting — a probability already named as missing or negative has
    # its own error, and a sum computed without it means nothing.
    if countable and abs(total - 1.0) > 1e-6:
        c.error(
            "probabilities_sum",
            "inputs.pwerm.scenarios",
            f"pwerm scenario probabilities must sum to 1.0 (got {total:.4f})",
            "Adjust the scenario probabilities so they total 100% — the engine weights "
            "each exit by its own probability and does not rescale them.",
        )


def _check_hybrid(c: _Collector, inputs: dict) -> None:
    raw = inputs.get("hybrid")
    if raw is None:
        return
    if not isinstance(raw, dict):
        c.error(
            "invalid_shape",
            "inputs.hybrid",
            "inputs.hybrid must be an object with opm_weight / pwerm_weight",
        )
        return
    opm = _finite(raw.get("opm_weight", 0.5))
    pwerm = _finite(raw.get("pwerm_weight", 0.5))
    if opm is None or pwerm is None:
        c.error("not_a_number", "inputs.hybrid", "hybrid weights must be finite numbers")
        return
    if opm < 0 or pwerm < 0:
        c.error("out_of_range", "inputs.hybrid", "hybrid weights must be non-negative")
    elif abs(opm + pwerm - 1.0) > 1e-6:
        c.error(
            "weights_sum",
            "inputs.hybrid",
            f"hybrid weights must sum to 1.0 (got {opm + pwerm:.4f})",
        )


# ── entry point ───────────────────────────────────────────────────────────────


def validate_payload(
    params: dict,
    inputs: dict,
    *,
    recompute: list[str] | None = None,
    prior_approaches: dict | None = None,
    auto_volatility: bool = False,
    auto_wacc: bool = False,
    auto_comparables: bool = False,
) -> list[Issue]:
    """Every problem with this payload, errors and warnings together.

    Mirrors what ``compute`` requires: only approaches carrying weight are
    checked, an approach being *reused* from a prior run (per-subsystem
    recalculation) is checked against ``prior_approaches`` instead of its
    inputs, and an input the estimation autopilot will fill in is not reported
    as missing. Never raises.
    """
    c = _Collector()
    params = _dict(params)
    inputs = _dict(inputs)
    prior = _dict(prior_approaches)

    allocation_method = params.get("allocation_method") or "opm"
    if allocation_method not in ALLOCATION_METHODS:
        c.error(
            "unknown_method",
            "params.allocation_method",
            f"allocation_method must be one of {ALLOCATION_METHODS} (got {allocation_method!r})",
        )
        allocation_method = "opm"

    # PWERM derives equity value from its scenarios, so the weighted-approach
    # inputs are irrelevant on that path (compute skips them entirely).
    if allocation_method != "pwerm":
        weights = _check_weights(c, params)
        for weight_key, approach in WEIGHT_TO_APPROACH.items():
            weight = weights.get(weight_key, 0.0)
            fresh = recompute is None or approach in recompute or approach not in prior
            if weight > 0 and not fresh:
                entry = prior.get(approach)
                if not isinstance(entry, dict) or _finite(entry.get("equity_value")) is None:
                    c.error(
                        "required",
                        f"prior_approaches.{approach}.equity_value",
                        f"prior_approaches.{approach}.equity_value is required to reuse "
                        f"the {approach} approach",
                        "Run a full calculation before recalculating a single approach.",
                    )
                continue
            if weight <= 0:
                continue
            if approach == "asset":
                _check_asset(c, params, inputs)
            elif approach == "opm_backsolve":
                _check_opm_inputs(c, inputs)
            elif approach == "income":
                _check_income(c, inputs, auto_wacc=auto_wacc)
            elif approach == "market":
                _check_market(c, inputs, auto_comparables=auto_comparables)

    if allocation_method in ("pwerm", "hybrid"):
        _check_pwerm(c, inputs)
    if allocation_method == "hybrid":
        _check_hybrid(c, inputs)

    _check_cap_table(
        c,
        params,
        inputs,
        allocation_method=allocation_method,
        auto_volatility=auto_volatility,
    )
    _check_discounts(c, params)
    _check_dates(c, params, inputs)

    # Consistency *between* the figures, after every check on their individual
    # legality. Always warnings: an anomaly is a relationship between values
    # each of which is legal on its own, so an analyst who has checked the
    # source and knows the figure is right must still be able to run. Emitted
    # through the same collector so the API surface does not grow a second
    # vocabulary for "something is wrong with this payload".
    for anomaly in detect_anomalies(inputs):
        c.warn(anomaly.code, anomaly.field, anomaly.message, anomaly.hint)

    return c.issues


def split_issues(issues: list[Issue]) -> tuple[list[Issue], list[Issue]]:
    """(errors, warnings) — the two lists the API surfaces separately."""
    return (
        [i for i in issues if i.severity == ERROR],
        [i for i in issues if i.severity == WARNING],
    )
