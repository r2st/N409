"""Discount for lack of marketability models (features.md — DLOM).

Option-based:

- Chaffee (1993): cost of an at-the-money European protective put as a
  fraction of the marketable price.
- Finnerty (2012): average-strike Asian put approximation; no interest-rate
  input, capped by construction around ~32% for extreme vol·time.
- Ghaidarov (2009): the same average-strike put with the *correct* effective
  variance. Agrees with Finnerty to first order at small σ²T and diverges
  above it — Ghaidarov approaches 100% where Finnerty saturates near 32%.
- Longstaff (1995): the value of perfect market timing over the restriction —
  an upper *bound* on the discount rather than an estimate of it.

Empirical:

- Restricted-stock studies: the published median/mean discounts on restricted
  (Rule 144) stock placements, blended across a selected set of studies.
- Pre-IPO studies (Emory, Willamette): the discount at which shares changed
  hands privately in the months before the company's IPO, against the IPO
  price. A different measurement of a different thing — see
  `PRE_IPO_STUDIES` — and deliberately not folded into the restricted-stock
  default set.

The four option models take (σ, T) and are pure; the two study models take no
market inputs at all and are lookups. `MODEL_DLOM_METHODS` is the set that
needs a volatility — every caller that used to spell `("chaffee", "finnerty")`
inline reads it from here, so adding a fifth model cannot miss a check.
"""

from __future__ import annotations

import math
import statistics

from .bs import bs_put, norm_cdf
from .errors import EngineInputError

#: DLOM methods derived from a volatility and a time to exit. A payload naming
#: one of these without `inputs.volatility` is an input error, not a zero.
MODEL_DLOM_METHODS: frozenset[str] = frozenset({"chaffee", "finnerty", "ghaidarov", "longstaff"})

#: The empirical methods: a lookup over a published study table, no market
#: inputs at all. They measure different things and are kept apart for that
#: reason — see `PRE_IPO_STUDIES`.
STUDY_DLOM_METHODS: frozenset[str] = frozenset({"restricted_stock", "pre_ipo"})

#: Every DLOM method the engine dispatches on, model and non-model alike.
DLOM_METHODS: frozenset[str] = MODEL_DLOM_METHODS | STUDY_DLOM_METHODS | {"qualitative"}

#: Which volatility an option-based DLOM is struck on. The models above take
#: the volatility of *the interest being valued*, and in a 409A that interest is
#: common — which sits behind the whole preference stack and is geared well
#: above the enterprise as a result. "class" (the default) uses the common
#: class's own volatility from the breakpoint waterfall; "enterprise" uses the
#: total-equity figure, which is what the engine used to do unconditionally.
#:
#: Kept here rather than in `compute` so the pre-flight validator and the engine
#: read the same vocabulary — see `compute._dlom_volatility` for the resolution
#: rule, including why a payload without a cap table falls back rather than
#: failing.
DLOM_VOLATILITY_BASES: tuple[str, ...] = ("class", "enterprise")


def selects_model_dlom(params: dict) -> bool:
    """Whether these params ask for a discount that needs a volatility.

    Every caller used to spell ``params.get("dlom_method") in
    MODEL_DLOM_METHODS`` inline, at four sites. Once a run could weight several
    methods (``dlom_methods``), all four stopped seeing an option model reached
    through a blend — and because ``chaffee_dlom`` answers 0.0 for σ ≤ 0 rather
    than raising, a blend with a Finnerty leg and no volatility would have
    concluded on a discount with that leg silently contributing nothing. Asking
    the question in one place is what makes that unrepresentable.
    """
    if params.get("dlom_method") in MODEL_DLOM_METHODS:
        return True
    blend = params.get("dlom_methods")
    if not isinstance(blend, list):
        return False
    # A malformed row is not this predicate's business — `_blended_dlom` rejects
    # it with a message about the row. Here it simply does not select a model.
    return any(
        isinstance(entry, dict) and entry.get("method") in MODEL_DLOM_METHODS for entry in blend
    )

#: The discount a DLOM model is allowed to return. A model that wants 100% is
#: saying the interest is worthless, which is a conclusion about the security
#: rather than about its marketability.
_MAX_DLOM = 0.99

#: Below this σ²T the closed forms below lose the answer to cancellation and
#: the series expansion is used instead. See `finnerty_dlom`.
_SMALL_VAR_T = 1e-4


def chaffee_dlom(sigma: float, t: float, r: float) -> float:
    if sigma <= 0 or t <= 0:
        return 0.0
    return min(max(bs_put(1.0, 1.0, t, r, sigma), 0.0), _MAX_DLOM)


def finnerty_dlom(sigma: float, t: float) -> float:
    if sigma <= 0 or t <= 0:
        return 0.0
    var_t = sigma * sigma * t

    # v²T = σ²T + ln(2(e^{σ²T} − σ²T − 1)) − 2 ln(e^{σ²T} − 1)
    #
    # Evaluated literally, e^{σ²T} overflows a float once σ²T passes ~709 and
    # the engine raises OverflowError instead of returning a discount. That is
    # reachable: the volatility band is a warning rather than a hard limit, so
    # a mistyped 3000% vol over a ten-year horizon takes the whole calculation
    # down with a 500. Factoring e^{σ²T} out of both logarithms removes it:
    #
    #   ln(2(e^v − v − 1)) − 2 ln(e^v − 1)
    #     = ln2 + v + ln(1 − (v+1)e^{−v}) − 2(v + ln(1 − e^{−v}))
    #
    # so  v²T = ln2 + ln(1 − (v+1)e^{−v}) − 2 ln(1 − e^{−v}),
    # which is bounded for every σ²T and tends to ln2 — the ~32.3% ceiling the
    # model is known for — instead of exploding. expm1 keeps the small-σ²T end
    # accurate, where both logarithm arguments approach zero.
    # The other end needs care too. Both logarithm arguments collapse toward
    # zero as σ²T does, and their difference is the whole answer, so floating
    # point loses it to cancellation long before the maths does — the literal
    # form reported a 0.9% discount for a σ²T of 1e-6 whose true value is
    # 0.03%. Below the threshold the expansion v²T = σ²T/3 + O((σ²T)²) is both
    # exact in the limit and free of subtraction.
    if var_t < _SMALL_VAR_T:
        v_sq_t = var_t / 3.0
    else:
        decay = math.exp(-var_t)
        one_minus_exp = -math.expm1(-var_t)  # 1 − e^{−σ²T}
        inner = one_minus_exp - var_t * decay  # 1 − (σ²T + 1)·e^{−σ²T}
        if inner <= 0 or one_minus_exp <= 0:
            return 0.0
        v_sq_t = math.log(2.0) + math.log(inner) - 2.0 * math.log(one_minus_exp)
    return _average_strike_put(v_sq_t)


def _average_strike_put(v_sq_t: float) -> float:
    """``2Φ(v/2) − 1`` — the average-strike put value shared by Finnerty and
    Ghaidarov, which differ only in the effective variance ``v²T`` they feed it.
    """
    if v_sq_t <= 0:
        return 0.0
    half_v = math.sqrt(v_sq_t) / 2.0
    return min(max(norm_cdf(half_v) - norm_cdf(-half_v), 0.0), _MAX_DLOM)


def ghaidarov_dlom(sigma: float, t: float) -> float:
    """Ghaidarov (2009) average-strike put.

    Same option as Finnerty, corrected effective variance:

        v²T = ln( 2(e^{σ²T} − σ²T − 1) / (σ²T)² )

    The two agree to first order — both expand to σ²T/3 as σ²T → 0 — and part
    company above it. Finnerty's extra ``σ²T − 2ln(e^{σ²T} − 1)`` drives v²T to
    ln2, which is where its ~32.3% ceiling comes from; Ghaidarov's grows like
    σ²T, so the discount runs to 100% for a long enough restriction on a
    volatile enough security. That is the whole reason to offer both: the
    ceiling is a property of Finnerty's algebra, not of marketability, and on a
    ten-year restriction it is the difference between a 32% discount and a 70%
    one.

    Computed in the same factored form for the same reason — ``e^{σ²T}``
    overflows a double past σ²T ≈ 709:

        ln(2(e^v − v − 1)) − 2 ln v  =  ln2 + v + ln(1 − (v+1)e^{−v}) − 2 ln v

    and below `_SMALL_VAR_T` the two ``ln v`` terms cancel to the whole answer,
    so the σ²T/3 expansion is used there instead.
    """
    if sigma <= 0 or t <= 0:
        return 0.0
    var_t = sigma * sigma * t
    if var_t < _SMALL_VAR_T:
        v_sq_t = var_t / 3.0
    else:
        inner = -math.expm1(-var_t) - var_t * math.exp(-var_t)  # 1 − (σ²T + 1)·e^{−σ²T}
        if inner <= 0:
            return 0.0
        v_sq_t = math.log(2.0) + var_t + math.log(inner) - 2.0 * math.log(var_t)
    return _average_strike_put(v_sq_t)


def longstaff_bound(sigma: float, t: float) -> float:
    """Longstaff (1995): the value of perfect market timing over ``t`` years,
    as a multiple of the security's value.

    An investor who could sell at the running maximum earns ``E[max_s≤t S_s]``;
    one locked up earns ``S_0``. The difference is what the restriction costs,
    and under the risk-neutral GBM it has a closed form:

        E[max S] / S_0 = (2 + σ²T/2)·Φ(√(σ²T)/2) + √(σ²T/2π)·e^{−σ²T/8}

    so this returns that minus one. It is the figure Longstaff's tables report,
    and it is deliberately *not* a discount: it exceeds 1.0 for even moderate
    σ²T (a 60% vol over two years already prices the timing option above the
    security), because a lookback is worth more than the thing it looks back
    on. Longstaff offers it as an upper bound on what illiquidity can cost, and
    that is how it is exposed here — `longstaff_dlom` does the conversion.
    """
    if sigma <= 0 or t <= 0:
        return 0.0
    var_t = sigma * sigma * t
    a = math.sqrt(var_t)
    expected_max = (2.0 + var_t / 2.0) * norm_cdf(a / 2.0) + a * math.exp(-var_t / 8.0) / math.sqrt(
        2.0 * math.pi
    )
    return max(expected_max - 1.0, 0.0)


def longstaff_dlom(sigma: float, t: float) -> float:
    """Longstaff's bound expressed as a discount off the perfectly-timed value.

    `longstaff_bound` returns ``L``, the timing option as a multiple of the
    marketable price, and runs past 1.0. A DLOM has to be a fraction below 1,
    so the bound is read the way the discount is defined: the restricted
    interest is worth ``S_0`` where a timeable one is worth ``S_0(1 + L)``, so
    the discount is ``L / (1 + L)``.

    That is monotone in L, agrees with the raw bound to first order where it is
    small, and stays inside [0, 1) where it is not. It remains an upper bound —
    the number this returns is the most illiquidity can be worth under the
    model, not an estimate of what it is worth, and a report that concludes on
    it should say so. `restricted_stock_dlom` is the empirical counterweight.
    """
    bound = longstaff_bound(sigma, t)
    if bound <= 0:
        return 0.0
    return min(bound / (1.0 + bound), _MAX_DLOM)


# ── Restricted-stock studies ────────────────────────────────────────────────
#
# The empirical leg of a DLOM opinion: observed discounts on private
# placements of stock that was restricted from resale under Rule 144, which is
# as close as the market gets to pricing marketability on its own. Unlike the
# option models these are not derived from anything — they are a published
# table, reproduced here so the engine can conclude without a human retyping
# figures into an overwrite.
#
# Two things about this table are load-bearing:
#
#   * It is a *default*, not a fact of the engine. `restricted_stock_dlom`
#     takes a `studies` argument, and a firm that has its own subscription
#     data or disagrees with a figure passes its own rows. The built-ins exist
#     so a valuation can conclude without that, not to settle which studies
#     are authoritative.
#   * The 1997 Rule 144 amendment (holding period 2 years → 1) is a break in
#     the series, not noise. Discounts after it run roughly half those before,
#     which is the point of `period_end` being on every row: blending a 1970s
#     study with a post-1997 one produces a number describing no regime that
#     ever existed. `DEFAULT_STUDY_SET` is therefore the post-amendment set.
#
# Figures are the study medians where the study reports one and the means
# otherwise (`statistic` names which, per row). Anyone concluding on this
# should cite the study itself, not this file.
RESTRICTED_STOCK_STUDIES: tuple[dict, ...] = (
    {"study": "SEC Institutional Investor Study", "period_start": 1966, "period_end": 1969, "discount": 0.258, "statistic": "mean"},
    {"study": "Gelman", "period_start": 1968, "period_end": 1970, "discount": 0.33, "statistic": "median"},
    {"study": "Moroney", "period_start": 1969, "period_end": 1972, "discount": 0.335, "statistic": "median"},
    {"study": "Maher", "period_start": 1969, "period_end": 1973, "discount": 0.333, "statistic": "median"},
    {"study": "Trout", "period_start": 1968, "period_end": 1972, "discount": 0.335, "statistic": "mean"},
    {"study": "Standard Research Consultants", "period_start": 1978, "period_end": 1982, "discount": 0.45, "statistic": "median"},
    {"study": "Willamette Management Associates", "period_start": 1981, "period_end": 1984, "discount": 0.312, "statistic": "median"},
    {"study": "Silber", "period_start": 1981, "period_end": 1988, "discount": 0.338, "statistic": "mean"},
    {"study": "FMV Opinions", "period_start": 1979, "period_end": 1992, "discount": 0.23, "statistic": "mean"},
    {"study": "Management Planning Inc.", "period_start": 1980, "period_end": 1996, "discount": 0.277, "statistic": "mean"},
    {"study": "Johnson", "period_start": 1991, "period_end": 1995, "discount": 0.20, "statistic": "mean"},
    {"study": "Columbia Financial Advisors (pre-amendment)", "period_start": 1996, "period_end": 1997, "discount": 0.21, "statistic": "mean"},
    {"study": "Columbia Financial Advisors (post-amendment)", "period_start": 1997, "period_end": 1998, "discount": 0.13, "statistic": "mean"},
)

#: The year Rule 144's holding period dropped from two years to one (effective
#: April 1997). Studies straddling it describe two different securities.
RULE_144_AMENDMENT_YEAR = 1997


def is_post_amendment(row: dict) -> bool:
    """Whether a study observed *only* post-amendment placements.

    Keyed on ``period_start``, not ``period_end``. A study that began
    collecting in 1996 and closed in 1997 is a pre-amendment study — most of
    what it observed was two-year-restricted stock — and the built-in table
    contains exactly that case: Columbia Financial Advisors ran two studies
    either side of the amendment, and the earlier one closes *in* 1997. Keying
    on ``period_end`` swept it into the "post-amendment" default, blending its
    21% with the post-amendment 13% for a 17% default that describes neither
    regime. It also read as non-straddling to the check below, so nothing said
    so.
    """
    start = row.get("period_start")
    return isinstance(start, int) and start >= RULE_144_AMENDMENT_YEAR


#: Studies observing only post-amendment placements — the defensible default
#: set for a company being valued today.
DEFAULT_STUDY_SET: tuple[str, ...] = tuple(
    s["study"] for s in RESTRICTED_STOCK_STUDIES if is_post_amendment(s)
)

#: Below this a blend is one or two studies wide, which is a thin basis to
#: conclude on. The built-in table is deliberately not padded to clear it: it
#: holds only published figures, and only one published study in it observes
#: the current Rule 144 regime end-to-end. A firm with subscription data
#: (Stout/FMV and successors) supplies it through `dlom_study_table`; until
#: then the result says the set is thin rather than implying more support than
#: it has.
THIN_STUDY_SET = 3


def _study_rows(
    studies: list[dict] | None, default_table: tuple[dict, ...] = RESTRICTED_STOCK_STUDIES
) -> tuple[dict, ...]:
    """Caller-supplied study rows, validated, or the built-in table."""
    if studies is None:
        return default_table
    if not isinstance(studies, list) or not studies:
        raise EngineInputError("dlom.studies must be a non-empty list of study rows")
    rows: list[dict] = []
    for i, row in enumerate(studies):
        if not isinstance(row, dict):
            raise EngineInputError(f"dlom.studies[{i}] must be an object")
        name = row.get("study")
        discount = row.get("discount")
        if not isinstance(name, str) or not name.strip():
            raise EngineInputError(f"dlom.studies[{i}].study is required")
        if not isinstance(discount, (int, float)) or isinstance(discount, bool):
            raise EngineInputError(f"dlom.studies[{i}].discount must be a number")
        discount = float(discount)
        if not math.isfinite(discount) or not 0.0 <= discount < 1.0:
            raise EngineInputError(
                f"dlom.studies[{i}].discount must be a fraction in [0, 1) (got {discount:g})"
            )
        rows.append({**row, "study": name.strip(), "discount": discount})
    return tuple(rows)


def _blend_studies(
    selected: list[str] | None,
    studies: list[dict] | None,
    statistic: str,
    *,
    default_table: tuple[dict, ...],
    default_set: tuple[str, ...],
    method: str,
    label: str,
) -> dict:
    """The half the two empirical methods share: resolve the set, combine it.

    Written once rather than twice because the two tables are read the same way
    and reported the same way, and the failure this prevents is the specific one
    the codebase has hit before: a second copy of these branches drifts, and a
    blend's ``pre_ipo`` leg then reports a field its single-method run does not.
    What differs between the families is the *caveats*, and those stay with the
    function that knows them.
    """
    available = _study_rows(studies, default_table)
    by_name = {row["study"]: row for row in available}

    names = list(selected) if selected else [n for n in default_set if n in by_name]
    if selected is None and not names:
        # A caller-supplied table sharing no names with the default set: blend
        # what there is rather than refuse, and let the caveats carry the rest.
        names = [row["study"] for row in available]
    unknown = [n for n in names if n not in by_name]
    if unknown:
        raise EngineInputError(
            f"unknown {label} studies {sorted(unknown)} — available: {sorted(by_name)}"
        )
    if not names:
        raise EngineInputError(f"{method} DLOM needs at least one selected study")

    rows = [by_name[n] for n in dict.fromkeys(names)]
    discounts = sorted(row["discount"] for row in rows)
    if statistic == "median":
        concluded = statistics.median(discounts)
    elif statistic == "mean":
        concluded = statistics.fmean(discounts)
    else:
        raise EngineInputError(f"dlom.statistic must be 'median' or 'mean' (got {statistic!r})")

    return {
        "method": method,
        "dlom": min(max(round(concluded, 4), 0.0), _MAX_DLOM),
        "statistic": statistic,
        "studies": rows,
        "study_count": len(rows),
        "low": discounts[0],
        "high": discounts[-1],
        # A set this narrow is a thin thing to conclude on, whichever family it
        # is drawn from.
        "thin_study_set": len(rows) < THIN_STUDY_SET,
    }


def restricted_stock_dlom(
    selected: list[str] | None = None,
    studies: list[dict] | None = None,
    statistic: str = "median",
) -> dict:
    """Blend the selected restricted-stock studies into one discount.

    ``selected`` names the studies to include (default: `DEFAULT_STUDY_SET`,
    i.e. post-1997-amendment only). ``statistic`` is how the selected rows are
    combined — ``median`` or ``mean`` — which is a separate question from the
    ``statistic`` recorded *on* each row, that being whether the study itself
    published a median or a mean.

    Returns the concluded discount alongside the rows it came from, because a
    number without its set is not reviewable: the whole objection to study-
    based DLOM is set selection, so the set travels with the answer into the
    calculation record and the report exhibit.
    """
    blend = _blend_studies(
        selected,
        studies,
        statistic,
        default_table=RESTRICTED_STOCK_STUDIES,
        default_set=DEFAULT_STUDY_SET,
        method="restricted_stock",
        label="restricted-stock",
    )

    # Classified by when each study *started* observing, for the reason given
    # on `is_post_amendment`: a window closing in 1997 still mostly watched
    # two-year-restricted stock. Comparing period_end here called the built-in
    # default set non-straddling when it spanned both regimes.
    dated = [row for row in blend["studies"] if isinstance(row.get("period_start"), int)]
    straddles = any(is_post_amendment(r) for r in dated) and any(
        not is_post_amendment(r) for r in dated
    )

    # The caveat only this family has: a set spanning the 1997 holding-period
    # change is averaging two regimes. (`thin_study_set` is shared and comes
    # from `_blend_studies`.)
    return {**blend, "straddles_rule_144_amendment": straddles}


# ── Pre-IPO studies ─────────────────────────────────────────────────────────
#
# The other empirical leg, and the one that has to be read with its caveats
# attached. A pre-IPO study takes companies that went public, finds the private
# transactions in their own stock in the months before the offering, and reports
# the discount of those prices to the IPO price.
#
# That is a different measurement from the restricted-stock studies above, not a
# second sample of the same one, and it is why these are a separate method
# rather than more rows in `RESTRICTED_STOCK_STUDIES`:
#
#   * **The discounts are roughly twice as large.** Post-amendment restricted
#     stock runs 13-21%; these run 40-60%. Blending the two families without
#     saying so produces a number describing neither — the same objection the
#     Rule 144 amendment split already makes within the restricted-stock table.
#     An appraiser who wants both weights them explicitly, through
#     `dlom_methods`, and the report shows the two legs.
#   * **Selection bias runs one way.** The sample is companies that *succeeded*
#     in going public. A private transaction six months before a successful IPO
#     is priced against a company whose prospects then improved, so part of what
#     is measured is the value change over the period rather than marketability
#     alone. This is the standard criticism of the family (and the IRS has made
#     it), and it is the reason the figures are high.
#   * **The holding period is not comparable.** Rule 144 restriction is a known
#     term; "some months before an IPO that had not been announced yet" is not.
#
# So they are offered, because a DLOM opinion that ignores them is incomplete
# and the legacy deliverable cites them — and they are labelled, because one
# concluded on without its caveats is the finding a reviewer raises first.
#
# Figures are the studies' published summary discounts by observation window.
# Emory ran ten windows between 1980 and 2000 plus a combined study; the
# combined figure is included rather than all ten, because selecting a
# favourable window out of a series is exactly the manipulation the combined
# figure exists to prevent. Willamette's series is summarised by its own
# reported medians over the periods below. Anyone concluding on these should
# cite the study itself, not this file.
PRE_IPO_STUDIES: tuple[dict, ...] = (
    {"study": "Emory 1980-1981", "period_start": 1980, "period_end": 1981, "discount": 0.60, "statistic": "mean"},
    {"study": "Emory 1985-1986", "period_start": 1985, "period_end": 1986, "discount": 0.43, "statistic": "mean"},
    {"study": "Emory 1987-1989", "period_start": 1987, "period_end": 1989, "discount": 0.45, "statistic": "mean"},
    {"study": "Emory 1990-1992", "period_start": 1990, "period_end": 1992, "discount": 0.42, "statistic": "mean"},
    {"study": "Emory 1992-1993", "period_start": 1992, "period_end": 1993, "discount": 0.45, "statistic": "mean"},
    {"study": "Emory 1994-1995", "period_start": 1994, "period_end": 1995, "discount": 0.45, "statistic": "mean"},
    {"study": "Emory 1995-1997", "period_start": 1995, "period_end": 1997, "discount": 0.43, "statistic": "mean"},
    {"study": "Emory 1997-2000", "period_start": 1997, "period_end": 2000, "discount": 0.50, "statistic": "mean"},
    {"study": "Emory 1980-2000 (combined)", "period_start": 1980, "period_end": 2000, "discount": 0.46, "statistic": "mean"},
    {"study": "Willamette 1975-1978", "period_start": 1975, "period_end": 1978, "discount": 0.547, "statistic": "median"},
    {"study": "Willamette 1980-1982", "period_start": 1980, "period_end": 1982, "discount": 0.555, "statistic": "median"},
    {"study": "Willamette 1985-1987", "period_start": 1985, "period_end": 1987, "discount": 0.451, "statistic": "median"},
    {"study": "Willamette 1988-1990", "period_start": 1988, "period_end": 1990, "discount": 0.502, "statistic": "median"},
    {"study": "Willamette 1991-1993", "period_start": 1991, "period_end": 1993, "discount": 0.456, "statistic": "median"},
    {"study": "Willamette 1994-1996", "period_start": 1994, "period_end": 1996, "discount": 0.483, "statistic": "median"},
    {"study": "Willamette 1997", "period_start": 1997, "period_end": 1997, "discount": 0.352, "statistic": "median"},
)

#: The default pre-IPO set: the most recent window from each of the two study
#: families, plus Emory's combined figure.
#:
#: Recency is the axis that matters here, the way the Rule 144 amendment is the
#: axis in the restricted-stock table. The 1980s windows observed a market with
#: a different IPO process and a different retail bid, and a 1980-1981 60%
#: discount is not evidence about a company being valued today. Emory's combined
#: figure is kept alongside them precisely because it is *not* a window an
#: appraiser chose — it is the whole series, which is the answer to the charge
#: that the family is cherry-picked.
DEFAULT_PRE_IPO_SET: tuple[str, ...] = (
    "Emory 1997-2000",
    "Emory 1980-2000 (combined)",
    "Willamette 1994-1996",
    "Willamette 1997",
)

#: A pre-IPO window that *closed* before this year predates the modern IPO
#: market — reported as a caveat rather than refused, since an appraiser may
#: have a reason to reach for the long series.
#:
#: Keyed on ``period_end``, and deliberately not on ``period_start`` the way
#: `is_post_amendment` is. The two ask different questions of the same field.
#: The Rule 144 test asks *which security was observed*, and a window opening in
#: 1996 mostly watched two-year-restricted stock however late it closed — so it
#: keys on the start. This asks *how stale the evidence is*, and a series
#: running to 2000 is recent evidence even though it opened in 1980. Keying this
#: one on the start would flag Emory's combined study — the whole series, and
#: the answer to the charge that this family is cherry-picked — as dated, which
#: would put a caveat on the default set and train readers to ignore it.
PRE_IPO_RECENCY_YEAR = 1990


def pre_ipo_dlom(
    selected: list[str] | None = None,
    studies: list[dict] | None = None,
    statistic: str = "median",
) -> dict:
    """Blend the selected pre-IPO studies into one discount.

    Same shape and same arguments as `restricted_stock_dlom`, over a different
    table — so a blend weighting the two families reads the same working from
    each leg, and neither can grow a reporting field the other lacks.

    The result carries the family's caveats (`selection_bias`, and
    `predates_modern_ipo_market` when the set reaches back before
    `PRE_IPO_RECENCY_YEAR`) because they are not optional context: these
    discounts run roughly twice the restricted-stock ones for reasons that are
    partly measurement, and a report quoting 46% without saying why it is 46%
    is a report that gets sent back.
    """
    blend = _blend_studies(
        selected,
        studies,
        statistic,
        default_table=PRE_IPO_STUDIES,
        default_set=DEFAULT_PRE_IPO_SET,
        method="pre_ipo",
        label="pre-IPO",
    )
    dated = [r for r in blend["studies"] if isinstance(r.get("period_end"), int)]
    return {
        **blend,
        "selection_bias": (
            "The sample is companies that went on to complete an IPO, so part of the "
            "measured discount is the change in the company's prospects over the period "
            "rather than marketability alone. These figures run roughly twice the "
            "post-amendment restricted-stock discounts, and the difference is not "
            "wholly a difference in marketability."
        ),
        "predates_modern_ipo_market": any(
            r["period_end"] < PRE_IPO_RECENCY_YEAR for r in dated
        ),
    }
