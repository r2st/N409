"""Financial anomaly detection over the extracted figures.

`validate.py` asks whether each input is *legal* — present, finite, inside the
band its own field allows. This module asks whether the figures are *consistent
with each other*, which is a different question with a different failure mode:
every value here can be individually unremarkable and jointly impossible.

The failures worth catching are almost all extraction failures rather than
business ones, and they share a shape — a number that is right except for what
it is a number *of*:

  * a revenue figure read off a table denominated in thousands and used as
    dollars, which is a valuation wrong by 1000x that looks entirely ordinary
    on the page;
  * an EBITDA larger than the revenue it came out of;
  * a projection whose every year is the same number, because a merged cell
    was read down a column;
  * a forward figure smaller than the trailing one it is supposed to grow from,
    on an engagement whose whole thesis is growth.

None of these is illegal, so none can be an error — an analyst who has looked
and decided the figure is right must be able to run. They are warnings with
enough detail to check the source document in one step, which is why each one
quotes the two figures whose *relationship* is the problem rather than the
single value that tripped it.

Thresholds are deliberately loose. A detector that fires on a merely unusual
company is one an analyst learns to dismiss, and a dismissed warning is worse
than no warning because it also buries the ones that matter. Each bound below
is set where an honest figure becomes very hard to construct, not where an
uncommon one begins.
"""

from __future__ import annotations

import math

#: Growth above this multiple over one year is possible but nearly always a
#: units mismatch between the two figures — 20x year-on-year revenue growth is
#: a handful of companies a decade, and a thousand-fold is arithmetic.
IMPLAUSIBLE_GROWTH_MULTIPLE = 20.0

#: EBITDA above this share of revenue. Above 1.0 is impossible from operations
#: alone; the band leaves room for other income and for the genuinely
#: extraordinary before it says so.
IMPLAUSIBLE_MARGIN = 1.0

#: A loss this many times revenue is a company whose costs have nothing to do
#: with its sales — usually an EBITDA read from a cumulative column.
IMPLAUSIBLE_LOSS_MULTIPLE = 10.0

#: Two figures that should be denominated alike differing by this factor.
#: 1000 is the thousands/units mismatch; 500 catches it either side of rounding.
UNIT_MISMATCH_FACTOR = 500.0

#: A forecast series whose values are this close together across every period
#: was not forecast — it was filled down.
FLAT_SERIES_TOLERANCE = 1e-9

#: A cash-flow series that changes sign more than this many times is being read
#: across columns that are not periods.
MAX_SIGN_CHANGES = 3


def _finite(value) -> float | None:
    """Coerce to a finite float, or None if missing/unparsable/NaN/bool."""
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _series(value) -> list[float]:
    """A list of finite numbers, or empty. Non-numeric entries are dropped
    rather than reported — `validate._check_income` already owns that
    complaint, and saying it twice trains people to skim."""
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        num = _finite(item)
        if num is not None:
            out.append(num)
    return out


def _magnitude_ratio(a: float, b: float) -> float:
    """How many times bigger the larger of two magnitudes is. inf if one is 0."""
    lo, hi = sorted((abs(a), abs(b)))
    if lo == 0:
        return math.inf if hi > 0 else 1.0
    return hi / lo


class Anomaly:
    """One inconsistency between figures.

    Carries the same ``code``/``field``/``message``/``hint`` shape
    `validate.Issue` does, so `validate_payload` can emit these through its own
    collector without a translation layer and the API surface does not grow a
    second vocabulary for "something is wrong with this payload".
    """

    __slots__ = ("code", "field", "message", "hint")

    def __init__(self, code: str, field: str, message: str, hint: str) -> None:
        self.code = code
        self.field = field
        self.message = message
        self.hint = hint

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Anomaly({self.code!r}, {self.field!r})"

    def __eq__(self, other) -> bool:
        return isinstance(other, Anomaly) and (
            self.code,
            self.field,
            self.message,
            self.hint,
        ) == (other.code, other.field, other.message, other.hint)


def _fmt(value: float) -> str:
    """A figure as an analyst would read it back off a statement."""
    if abs(value) >= 1000:
        return f"{value:,.0f}"
    return f"{value:,.4g}"


# ── detectors ────────────────────────────────────────────────────────────────


def _check_growth(inputs: dict) -> list[Anomaly]:
    out: list[Anomaly] = []
    for basis in ("revenue", "ebitda"):
        ltm = _finite(inputs.get(f"{basis}_ltm"))
        ntm = _finite(inputs.get(f"{basis}_ntm"))
        if ltm is None or ntm is None or ltm <= 0 or ntm <= 0:
            continue
        ratio = ntm / ltm
        if ratio >= UNIT_MISMATCH_FACTOR or ratio <= 1.0 / UNIT_MISMATCH_FACTOR:
            # Separated from the growth case below because the remedy differs:
            # this is not "check the forecast", it is "check the units".
            factor = ratio if ratio > 1 else 1 / ratio
            direction = "upward" if ratio > 1 else "downward"
            out.append(
                Anomaly(
                    "unit_mismatch",
                    f"inputs.{basis}_ntm",
                    f"{basis} moves from {_fmt(ltm)} (LTM) to {_fmt(ntm)} (NTM) — a factor of "
                    f"{factor:,.0f}x {direction}",
                    "A factor of roughly 1,000 between two figures of the same thing is usually "
                    "one of them read off a statement denominated in thousands. Check both "
                    "against the source document.",
                )
            )
        elif ratio >= IMPLAUSIBLE_GROWTH_MULTIPLE:
            out.append(
                Anomaly(
                    "implausible_growth",
                    f"inputs.{basis}_ntm",
                    f"forward {basis} of {_fmt(ntm)} is {ratio:,.1f}x the trailing {_fmt(ltm)}",
                    "Growth at this rate is rare enough that a reviewer will ask for the "
                    "management forecast it came from. Confirm the two figures cover twelve "
                    "months each and are the same entity.",
                )
            )
    return out


def _check_margin(inputs: dict) -> list[Anomaly]:
    out: list[Anomaly] = []
    for horizon in ("ltm", "ntm"):
        revenue = _finite(inputs.get(f"revenue_{horizon}"))
        ebitda = _finite(inputs.get(f"ebitda_{horizon}"))
        if revenue is None or ebitda is None or revenue <= 0:
            continue
        margin = ebitda / revenue
        if margin > IMPLAUSIBLE_MARGIN:
            out.append(
                Anomaly(
                    "impossible_margin",
                    f"inputs.ebitda_{horizon}",
                    f"{horizon.upper()} EBITDA of {_fmt(ebitda)} exceeds {horizon.upper()} "
                    f"revenue of {_fmt(revenue)} ({margin:.0%} margin)",
                    "EBITDA above revenue cannot come from operations. Usually the EBITDA line "
                    "is a cumulative or multi-year total, or the revenue line is a single "
                    "period of it.",
                )
            )
        elif margin < -IMPLAUSIBLE_LOSS_MULTIPLE:
            out.append(
                Anomaly(
                    "implausible_loss",
                    f"inputs.ebitda_{horizon}",
                    f"{horizon.upper()} EBITDA of {_fmt(ebitda)} is a loss "
                    f"{abs(margin):,.0f}x {horizon.upper()} revenue of {_fmt(revenue)}",
                    "A loss this far above revenue usually means the EBITDA figure covers a "
                    "different period than the revenue it is being read against.",
                )
            )
    return out


def _check_scale(inputs: dict) -> list[Anomaly]:
    """Figures that should share a denomination and do not.

    Revenue against the last round's post-money is the pair that catches the
    thousands/units error when only one revenue horizon was extracted, so the
    growth check above has nothing to compare against.
    """
    out: list[Anomaly] = []
    post_money = _finite(inputs.get("last_round_post_money"))
    revenue = _finite(inputs.get("revenue_ltm"))
    if post_money is not None and revenue is not None and post_money > 0 and revenue > 0:
        ratio = _magnitude_ratio(post_money, revenue)
        if ratio >= UNIT_MISMATCH_FACTOR:
            larger = "post-money" if post_money > revenue else "revenue"
            out.append(
                Anomaly(
                    "scale_mismatch",
                    "inputs.revenue_ltm",
                    f"LTM revenue of {_fmt(revenue)} and last-round post-money of "
                    f"{_fmt(post_money)} differ by {ratio:,.0f}x ({larger} is the larger)",
                    "Two figures for the same company this far apart are usually denominated "
                    "differently — one in thousands, one in units. Both feed the valuation "
                    "directly, so the error scales straight through to the share price.",
                )
            )

    cash = _finite(inputs.get("cash"))
    if post_money is not None and cash is not None and post_money > 0 and cash > 0:
        if cash > post_money:
            out.append(
                Anomaly(
                    "cash_exceeds_post_money",
                    "inputs.cash",
                    f"cash of {_fmt(cash)} exceeds the last round's post-money valuation of "
                    f"{_fmt(post_money)}",
                    "A company holding more cash than its own last valuation is possible but "
                    "unusual. Confirm the cash balance is as of the valuation date and not a "
                    "cumulative figure.",
                )
            )
    return out


def _check_forecast(inputs: dict) -> list[Anomaly]:
    income = inputs.get("income")
    if not isinstance(income, dict):
        return []
    flows = _series(income.get("free_cash_flows"))
    if len(flows) < 2:
        return []

    out: list[Anomaly] = []

    if max(flows) - min(flows) <= FLAT_SERIES_TOLERANCE:
        out.append(
            Anomaly(
                "flat_forecast",
                "inputs.income.free_cash_flows",
                f"every one of the {len(flows)} forecast periods is {_fmt(flows[0])}",
                "An identical figure in every period is usually a merged cell read down a "
                "column rather than a forecast. A DCF over a flat series is an annuity, and "
                "the terminal value will carry nearly all of the conclusion.",
            )
        )

    sign_changes = 0
    previous = 0
    for value in flows:
        if value == 0:
            continue
        current = 1 if value > 0 else -1
        if previous and current != previous:
            sign_changes += 1
        previous = current
    if sign_changes > MAX_SIGN_CHANGES:
        out.append(
            Anomaly(
                "alternating_forecast",
                "inputs.income.free_cash_flows",
                f"the forecast changes sign {sign_changes} times across {len(flows)} periods",
                "A series alternating this often is usually being read across columns that "
                "are not consecutive periods — a variance or a quarter-over-quarter column, "
                "say. Confirm the series is annual free cash flow in period order.",
            )
        )

    # A single period dwarfing the rest, other than the last. A big terminal
    # year is the shape of a forecast; a big year *three* is a typo or a total
    # row that got swept into the series.
    if len(flows) >= 3:
        interior = flows[:-1]
        # Excluded by position, not by value: two periods can legitimately hold
        # the same figure, and dropping every occurrence of the largest would
        # compare it against a scale it had already been removed from.
        peak = max(range(len(interior)), key=lambda i: abs(interior[i]))
        largest = interior[peak]
        scale = max(
            (abs(f) for i, f in enumerate(interior) if i != peak),
            default=0.0,
        )
        if scale > 0 and abs(largest) / scale >= UNIT_MISMATCH_FACTOR:
            out.append(
                Anomaly(
                    "outlier_forecast_period",
                    "inputs.income.free_cash_flows",
                    f"one forecast period of {_fmt(largest)} is "
                    f"{abs(largest) / scale:,.0f}x every other period before the terminal year",
                    "An interior period this far above its neighbours is usually a total row "
                    "read into the series, or a figure in different units from the rest.",
                )
            )

    return out


def _check_capital_structure(inputs: dict) -> list[Anomaly]:
    out: list[Anomaly] = []
    common = _finite(inputs.get("shares_outstanding_common"))
    preferred = _finite(inputs.get("shares_outstanding_preferred"))
    options = _finite(inputs.get("options_outstanding"))
    preference = _finite(inputs.get("liquidation_preference"))
    post_money = _finite(inputs.get("last_round_post_money"))

    if preference is not None and post_money is not None and post_money > 0:
        if preference > post_money:
            out.append(
                Anomaly(
                    "preference_exceeds_post_money",
                    "inputs.liquidation_preference",
                    f"liquidation preference of {_fmt(preference)} exceeds the last round's "
                    f"post-money valuation of {_fmt(post_money)}",
                    "Preferences above the post-money mean the preferred stack is worth more "
                    "than the whole company was priced at, which leaves common with nothing. "
                    "It happens after a down round — confirm this is one before concluding.",
                )
            )

    # An option pool larger than the common it sits alongside is either an
    # extraction error or a genuinely unusual structure worth a sentence in the
    # report; either way nobody should meet it for the first time in review.
    if common is not None and options is not None and common > 0 and options > common:
        out.append(
            Anomaly(
                "options_exceed_common",
                "inputs.options_outstanding",
                f"{_fmt(options)} options outstanding against {_fmt(common)} common shares",
                "More options than common shares usually means the option column included "
                "the authorised pool rather than the grants outstanding.",
            )
        )

    if preferred is not None and common is not None and common > 0:
        ratio = preferred / common
        if ratio >= UNIT_MISMATCH_FACTOR:
            out.append(
                Anomaly(
                    "share_count_mismatch",
                    "inputs.shares_outstanding_preferred",
                    f"{_fmt(preferred)} preferred shares against {_fmt(common)} common — "
                    f"a factor of {ratio:,.0f}x",
                    "Share counts this far apart are usually one column in thousands. The "
                    "ratio sets how much of the equity common holds, so the error goes "
                    "straight to the per-share figure.",
                )
            )

    return out


def detect_anomalies(inputs: object) -> list[Anomaly]:
    """Every inconsistency detectable between the extracted figures.

    Never raises and never blocks: each finding is a warning about a
    *relationship* between values that are individually legal, so an analyst
    who has checked the source and knows the figure is right must be able to
    run anyway.

    Typed against `object` rather than `dict` because the payload arrives off
    the wire — the same reason `validate_payload` coerces before it walks it.
    """
    if not isinstance(inputs, dict):
        return []
    return [
        *_check_growth(inputs),
        *_check_margin(inputs),
        *_check_scale(inputs),
        *_check_forecast(inputs),
        *_check_capital_structure(inputs),
    ]
