"""Discount for lack of control (features.md — DLOC).

The other half of the discount pair, and until now the half with no method at
all: `dloc` was a number an analyst typed, applied as-is, and reported without
a derivation. The marketability discount has four option models, two study
families and a weighting scheme behind it; the control discount had a text box.
That asymmetry is not a reflection of the appraisal literature — it is what the
engine happened to implement first — and on review it is the discount that
draws the sharper question, because unlike a DLOM it can be *structurally*
wrong: applied to a value that was already at a minority level, it discounts
twice for one thing.

Three methods:

- ``control_premium``: the appraiser states the control premium and the engine
  inverts it. DLOC = 1 − 1/(1+CP), which is the same fact stated from the other
  side — a 25% premium over a minority price is a 20% discount from the control
  price, not a 25% one, and taking 25% off is the arithmetic slip this method
  exists to prevent.
- ``studies``: blend published control-premium observations into a premium and
  invert that. Same shape as the DLOM study blenders, and for the same reason:
  set selection is the objection, so the set travels with the answer.
- ``qualitative``: the analyst's own figure, recorded as judgement rather than
  dressed as a derivation.

Two things this module insists on that a bare number could not say.

**Synergies are not control.** An observed acquisition premium is what one
buyer paid for one target, and it impounds whatever that buyer expected to do
with it — cost synergies, revenue synergies, a strategic position. The value of
*control itself* is the ability to direct cash flows, and it is smaller. Taking
the observed premium whole and calling it the control increment is the standard
criticism of the family (Mercer's, and the Delaware courts' in the appraisal
cases), so ``synergy_share`` removes a stated fraction of the premium before
the inversion, and both the raw and adjusted figures are reported.

**A discount has to be applied to the right level of value.** See
`LEVEL_OF_VALUE_BY_APPROACH`.
"""

from __future__ import annotations

import math
import statistics

from .errors import EngineInputError

#: Every DLOC method the engine dispatches on. Absent, or an unrecognised
#: value, is the pre-existing behaviour: `params.dloc` applied as a flat figure.
DLOC_METHODS: frozenset[str] = frozenset({"control_premium", "studies", "qualitative"})

#: A DLOC above this is not refused, but it is far outside what the control
#: premium literature implies for a minority interest in a going concern, and
#: the pre-flight says so. Mirrors `validate.DLOC_REVIEW_THRESHOLD`, which is
#: where the check lives; repeated here so the inversion helpers can clamp
#: against the same idea of "impossible" rather than a second one.
_MAX_DLOC = 0.95


def _num(value, name: str, *, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"{name} must be a number") from exc
    if isinstance(value, bool):
        raise EngineInputError(f"{name} must be a number")
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be finite")
    if minimum is not None and out < minimum:
        raise EngineInputError(f"{name} must be >= {minimum:g} (got {out:g})")
    if maximum is not None and out > maximum:
        raise EngineInputError(f"{name} must be <= {maximum:g} (got {out:g})")
    return out


def dloc_from_control_premium(control_premium: float, name: str = "control_premium") -> float:
    """DLOC implied by a control premium: 1 − 1/(1+CP).

    The two are the same fact from opposite sides, and the conversion is not
    symmetric: a 25% premium is a 20% discount, and a 40% premium is a 28.6%
    discount. Subtracting the premium instead is the single most common error
    in this corner of a valuation, which is why nothing in the engine takes a
    premium and a discount as interchangeable inputs.
    """
    premium = _num(control_premium, name, minimum=0.0)
    return 1.0 - 1.0 / (1.0 + premium)


def control_premium_from_dloc(dloc: float, name: str = "dloc") -> float:
    """The inverse: CP = d/(1−d). Stated so a report can show both sides."""
    discount = _num(dloc, name, minimum=0.0, maximum=_MAX_DLOC)
    return discount / (1.0 - discount)


# ── Control-premium studies ─────────────────────────────────────────────────
#
# What the built-in table is, and what it is not.
#
# The control-premium literature rests on one observable: what acquirers pay
# for whole public companies over the pre-announcement trading price of the
# same stock. The trading price is a marketable *minority* price, so the spread
# is the market's own measurement of the two levels of value against each
# other — which is why it is the standard basis for a DLOC despite the synergy
# problem below.
#
# The figures below are the long-run decade medians of that spread for US
# public targets, as summarised across the published series (FactSet Mergerstat
# Review and its successors, the same data BVR's Control Premium Study
# republishes by industry). They are **indicative**, and the engine says so on
# every conclusion that rests on them:
#
#   * they are decade summaries, not the year-and-industry extraction an
#     appraiser would actually cite;
#   * the underlying series is a paid subscription, and reproducing it here
#     would be both wrong and useless — the value of that data is the ability
#     to filter to the subject's own SIC code and period, which no built-in
#     table can do;
#   * the premium an appraiser needs is the one for companies like the subject,
#     and the dispersion across industries is wider than the dispersion across
#     decades.
#
# So they exist to let a valuation conclude, and to make the *shape* of the
# derivation reviewable, not to settle what the premium is. A firm with the
# subscription supplies its own rows through `studies`, which is the path this
# method is built around; `indicative_table` on the result is how a run that
# did not do that is flagged, and the pre-flight raises it as a warning.
CONTROL_PREMIUM_STUDIES: tuple[dict, ...] = (
    {"study": "US public targets, 1990s", "period_start": 1990, "period_end": 1999, "premium": 0.36, "indicative": True},
    {"study": "US public targets, 2000s", "period_start": 2000, "period_end": 2009, "premium": 0.33, "indicative": True},
    {"study": "US public targets, 2010s", "period_start": 2010, "period_end": 2019, "premium": 0.30, "indicative": True},
    {"study": "US public targets, 2020s", "period_start": 2020, "period_end": 2024, "premium": 0.31, "indicative": True},
)

#: The default set: the two most recent decades.
#:
#: Recency is the axis that matters, as it is for the pre-IPO DLOM studies. A
#: premium paid in 1994 was paid into a different market for corporate control
#: — different financing, different disclosure, a different bidder population —
#: and the whole series is not evidence about a transaction today merely
#: because it is longer.
DEFAULT_CONTROL_PREMIUM_SET: tuple[str, ...] = (
    "US public targets, 2010s",
    "US public targets, 2020s",
)

#: Below this a blend is one or two rows wide. Same threshold and same reason
#: as the DLOM study sets: it is a thin thing to conclude on, and saying so is
#: cheaper than padding the table.
THIN_STUDY_SET = 3


def _premium_rows(studies: list[dict] | None) -> tuple[dict, ...]:
    """Caller-supplied premium rows, validated, or the built-in table."""
    if studies is None:
        return CONTROL_PREMIUM_STUDIES
    if not isinstance(studies, list) or not studies:
        raise EngineInputError("dloc.studies must be a non-empty list of study rows")
    rows: list[dict] = []
    for i, row in enumerate(studies):
        if not isinstance(row, dict):
            raise EngineInputError(f"dloc.studies[{i}] must be an object")
        name = row.get("study")
        premium = row.get("premium")
        if not isinstance(name, str) or not name.strip():
            raise EngineInputError(f"dloc.studies[{i}].study is required")
        if not isinstance(premium, (int, float)) or isinstance(premium, bool):
            raise EngineInputError(f"dloc.studies[{i}].premium must be a number")
        premium = float(premium)
        if not math.isfinite(premium) or premium < 0.0:
            # A premium is unbounded above — 100%+ premiums are observed — so
            # only the sign is checked. A negative one is a discount paid for
            # control, which is a finding about that transaction rather than
            # evidence for a DLOC, and the inversion below would misread it.
            raise EngineInputError(
                f"dloc.studies[{i}].premium must be a non-negative fraction (got {premium:g})"
            )
        rows.append({**row, "study": name.strip(), "premium": premium})
    return tuple(rows)


def studies_dloc(
    selected: list[str] | None = None,
    studies: list[dict] | None = None,
    statistic: str = "median",
    synergy_share: float | None = None,
) -> dict:
    """Blend the selected control-premium studies, then invert to a discount.

    The blend happens on the *premium* scale and the inversion happens once, at
    the end. Inverting each row first and averaging the discounts gives a
    different — and wrong — answer, because the inversion is not linear: the
    mean of 1−1/(1+p) is not 1−1/(1+mean p). On a set spanning 30% to 36% the
    gap is small; on one spanning 15% to 90% it is not, and there is no reason
    to accept an error that varies with the spread of the set.
    """
    available = _premium_rows(studies)
    by_name = {row["study"]: row for row in available}

    names = list(selected) if selected else [n for n in DEFAULT_CONTROL_PREMIUM_SET if n in by_name]
    if selected is None and not names:
        # A caller-supplied table sharing no names with the default set: blend
        # what there is, as the DLOM study blender does.
        names = [row["study"] for row in available]
    unknown = [n for n in names if n not in by_name]
    if unknown:
        raise EngineInputError(
            f"unknown control-premium studies {sorted(unknown)} — available: {sorted(by_name)}"
        )
    if not names:
        raise EngineInputError("the studies DLOC method needs at least one selected study")

    rows = [by_name[n] for n in dict.fromkeys(names)]
    premiums = sorted(row["premium"] for row in rows)
    if statistic == "median":
        blended = statistics.median(premiums)
    elif statistic == "mean":
        blended = statistics.fmean(premiums)
    else:
        raise EngineInputError(f"dloc.statistic must be 'median' or 'mean' (got {statistic!r})")

    out = _invert_premium(blended, synergy_share, method="studies")
    return {
        **out,
        "statistic": statistic,
        "studies": rows,
        "study_count": len(rows),
        "low": premiums[0],
        "high": premiums[-1],
        "thin_study_set": len(rows) < THIN_STUDY_SET,
        # True when any concluded row came from the built-ins. The distinction
        # that matters is not "did the caller pass a table" but "is this figure
        # the subscription extraction an appraiser would cite", and a row the
        # engine shipped never is.
        "indicative_table": any(row.get("indicative") is True for row in rows),
    }


def _invert_premium(premium: float, synergy_share: float | None, *, method: str) -> dict:
    """Premium → discount, with the synergy deduction shown rather than folded in.

    Both premiums are reported — the observed one and the one left after the
    synergy share is removed — because the deduction is a judgement, and a
    reader who disagrees with it needs to see what it was applied to. A report
    stating only the adjusted figure has quietly relabelled somebody's estimate
    as an observation.
    """
    observed = _num(premium, f"dloc.{method} premium", minimum=0.0)
    share = 0.0 if synergy_share is None else _num(synergy_share, "dloc.synergy_share", minimum=0.0, maximum=0.99)
    control_only = observed * (1.0 - share)
    dloc = dloc_from_control_premium(control_only, f"dloc.{method} premium")
    out = {
        "method": method,
        "dloc": min(max(round(dloc, 6), 0.0), _MAX_DLOC),
        "observed_control_premium": round(observed, 6),
        "control_premium_applied": round(control_only, 6),
        "formula": "DLOC = 1 − 1/(1 + control premium)",
    }
    if synergy_share is not None:
        out["synergy_share"] = share
        out["synergy_note"] = (
            "An observed acquisition premium impounds what the buyer expected to do with the "
            "target — cost and revenue synergies, and a strategic position — as well as the value "
            f"of control itself. {share:.0%} of the observed premium is treated as synergistic and "
            "removed before the inversion; the balance is the control increment a financial buyer "
            "would pay."
        )
    return out


def control_premium_dloc(premium: float, synergy_share: float | None = None) -> dict:
    """One stated control premium, inverted. The whole method."""
    return _invert_premium(premium, synergy_share, method="control_premium")


# ── Level of value ──────────────────────────────────────────────────────────
#
# The structural error a DLOC method can make, and a bare number cannot even
# express.
#
# A discount steps between levels of value, so it is only meaningful against a
# value that sits at the level above it. A DLOC steps control → marketable
# minority. Apply it to a figure that was already a marketable minority value
# and you have discounted twice for one thing, and nothing about the result
# looks wrong: it is a plausible per-share figure that is simply too low.
#
# Which level each approach lands at is not a matter of opinion:
#
#   * **asset** — the net value of the enterprise's assets is what a holder of
#     the whole enterprise has. Control.
#   * **income** — a DCF over 100% of the enterprise's cash flows, discounted at
#     a rate with no minority adjustment, values the ability to direct those
#     cash flows. Control.
#   * **market** — guideline *public company* multiples are struck on trading
#     prices, and a trading price is what a minority holder pays for a share
#     they cannot use to direct anything. Marketable minority. (Guideline
#     *transaction* multiples would be control; this engine's market approach
#     is the public-company one.)
#   * **opm_backsolve** — the backsolve inverts the price a preferred investor
#     paid in the last round. That investor bought a minority stake. Marketable
#     minority, and the most common way a 409A ends up double-discounting,
#     because the backsolve usually carries most of the weight.
#
# The engine does not refuse the combination — an appraiser may have a specific
# reason, and refusing would be the engine overruling the analysis. It reports
# the weighted share of the equity value that came in at a minority level, so
# the pre-flight can warn and the report can disclose.
LEVEL_OF_VALUE_BY_APPROACH: dict[str, str] = {
    "asset": "control",
    "income": "control",
    "market": "minority",
    "opm_backsolve": "minority",
}

#: Above this share of minority-basis weight, a non-zero DLOC is more likely a
#: double count than a judgement. Half, because that is the point at which the
#: majority of the value being discounted was never at a control level.
MINORITY_BASIS_WARN_SHARE = 0.5


def minority_basis_share(weight_by_approach: dict | None) -> float | None:
    """The share of the weighted equity value that arrived at a minority level.

    None when there are no weights to read — the PWERM path derives equity
    value from its own scenarios rather than from the four approaches, and a
    guess about its level of value would be worse than silence.
    """
    if not isinstance(weight_by_approach, dict) or not weight_by_approach:
        return None
    total = 0.0
    minority = 0.0
    for name, weight in weight_by_approach.items():
        try:
            w = float(weight)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(w) or w <= 0:
            continue
        total += w
        if LEVEL_OF_VALUE_BY_APPROACH.get(name) == "minority":
            minority += w
    if total <= 0:
        return None
    return minority / total


def level_of_value_detail(dloc: float, weight_by_approach: dict | None) -> dict | None:
    """The level-of-value working, or None when there is nothing to say.

    Nothing to say means no weights (see `minority_basis_share`). A zero DLOC
    used to mean it too, and that was a confusion of two different questions.

    *Does this discount double-count?* is about the discount, and a zero one
    cannot — a note about it on every 409A that correctly applied none would be
    noise that trains readers to skip the block that matters. So the flag and
    its note stay gated on ``dloc > 0``.

    *What level of value did the allocation land at?* is about the weighted mix
    of approaches and has nothing to do with the discount. Withholding it when
    ``dloc`` is zero withheld it exactly where it matters most: a zero DLOC is
    most often zero *because* the weight sits on a backsolve and guideline
    multiples, which already produce a marketable minority value. The consumers
    read `minority_basis_weight` to decide what to call the allocated figure
    (`allocated_level` in domain/reportFigures.ts, and Exhibit H's opening row),
    and with the field absent they fell back to "marketable, controlling" — so
    the report asserted a controlling level of value, applied no control
    discount to it, and then labelled the unchanged number minority. Three
    statements, on the same page, that cannot all be true.
    """
    share = minority_basis_share(weight_by_approach)
    if share is None or not isinstance(weight_by_approach, dict):
        return None
    detail: dict = {
        "minority_basis_weight": round(share, 6),
        "control_basis_weight": round(1.0 - share, 6),
        "approach_levels": {
            name: LEVEL_OF_VALUE_BY_APPROACH.get(name, "unknown")
            for name, weight in weight_by_approach.items()
            if isinstance(weight, (int, float)) and not isinstance(weight, bool) and weight > 0
        },
        "double_counts_minority": dloc > 0 and share > MINORITY_BASIS_WARN_SHARE,
    }
    if detail["double_counts_minority"]:
        detail["note"] = (
            f"{share:.0%} of the weighted equity value came from approaches that already produce a "
            "marketable minority value — a backsolve inverts the price a minority investor paid, "
            "and guideline public company multiples are struck on minority trading prices. A "
            "discount for lack of control applied to that portion discounts a second time for a "
            "control the value never included."
        )
    return detail


def resolve_dloc(
    params: dict, weight_by_approach: dict | None = None
) -> tuple[float, str | None, dict | None]:
    """The concluded DLOC, the method that produced it, and its working.

    An unrecognised or absent ``dloc_method`` falls back to reading ``dloc`` as
    a flat figure, which is what every valuation stored before this module
    existed did. That fallback is deliberate and permanent: a recalculation of
    an engagement concluded last year must not change its number because the
    engine grew a method vocabulary since.
    """
    method = params.get("dloc_method")
    if method is not None and not isinstance(method, str):
        raise EngineInputError("dloc_method must be a string")
    if method is not None and method not in DLOC_METHODS:
        raise EngineInputError(
            f"dloc_method must be one of {sorted(DLOC_METHODS)} (got {method!r})"
        )

    synergy = params.get("dloc_synergy_share")
    detail: dict | None = None

    if method == "control_premium":
        premium = params.get("control_premium")
        if premium is None:
            raise EngineInputError(
                "the control_premium DLOC method needs params.control_premium — "
                "set dloc_method to 'qualitative' to state the discount directly"
            )
        detail = control_premium_dloc(premium, synergy)
        dloc = float(detail["dloc"])
    elif method == "studies":
        selected = params.get("dloc_studies")
        table = params.get("dloc_study_table")
        detail = studies_dloc(
            selected=selected if isinstance(selected, list) else None,
            studies=table if isinstance(table, list) else None,
            statistic=str(params.get("dloc_statistic") or "median"),
            synergy_share=synergy,
        )
        dloc = float(detail["dloc"])
    elif method == "qualitative":
        stated = params.get("dloc")
        if stated is None:
            raise EngineInputError("the qualitative DLOC method needs params.dloc")
        dloc = _num(stated, "dloc", minimum=0.0, maximum=_MAX_DLOC)
        detail = {
            "method": "qualitative",
            "dloc": round(dloc, 6),
            "implied_control_premium": round(control_premium_from_dloc(dloc), 6),
            "basis": "analyst judgement — no premium study was applied",
        }
    else:
        raw = params.get("dloc")
        dloc = 0.0 if raw is None else _num(raw, "dloc")

    level = level_of_value_detail(dloc, weight_by_approach)
    if level is not None:
        detail = {**(detail or {"method": method or "stated", "dloc": round(dloc, 6)}), **level}
    return dloc, method, detail
