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

from .projection import MAX_FORECAST_YEARS
# The two modules that own a shape this validator mirrors. Imported rather than
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
ALLOCATION_METHODS = ("opm", "pwerm", "hybrid", "cvm")


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
        if rate <= growth:
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

    volatility = _finite(inputs.get("volatility"))
    model_dlom = params.get("dlom_method") in ("chaffee", "finnerty")
    # Only the OPM-style allocations price a Black-Scholes call; PWERM and CVM
    # walk the deterministic waterfall and need volatility solely for a model
    # DLOM. With auto_volatility the estimator supplies it during compute.
    opm_allocation = allocation_method in ("opm", "hybrid")
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

    method = params.get("dlom_method")
    if method == "qualitative":
        qualitative = params.get("dlom_qualitative")
        if qualitative is None and params.get("dlom") is None:
            c.error(
                "required",
                "params.dlom_qualitative",
                "the qualitative DLOM method needs dlom_qualitative (or dlom)",
            )
        dlom = _finite(qualitative if qualitative is not None else params.get("dlom"))
    elif method in ("chaffee", "finnerty"):
        dlom = None  # derived from volatility and time to exit at compute time
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
                "Reviewers will expect a model DLOM (Chaffee / Finnerty) or a cited study.",
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

    return c.issues


def split_issues(issues: list[Issue]) -> tuple[list[Issue], list[Issue]]:
    """(errors, warnings) — the two lists the API surfaces separately."""
    return (
        [i for i in issues if i.severity == ERROR],
        [i for i in issues if i.severity == WARNING],
    )
