"""Guideline-public-company screening, scoring and multiple statistics.

The comp set used to be chosen entirely by the model: it proposed tickers,
`market_data.lookup` confirmed the tickers were real, and whatever the model
picked from that list became the market approach. Nothing in the pipeline could
answer "why this company and not that one" with anything except a sentence the
model wrote, and the fallback when the model returned nothing usable was the
first N candidates in proposal order — which is to say, no selection at all.

This module is the deterministic half. It screens the reference universe
directly (a second, independent source of candidates, so the set does not
depend on what the model happened to recall), scores every candidate on the
dimensions a market-approach reviewer actually challenges, and computes the
multiple statistics with the outlier handling those figures require.

Four scoring dimensions, because these are the four things a reviewer asks
about:

  * **industry** — SIC proximity, by shared prefix. 7372 against 7372 is an
    exact match; 7372 against 7379 shares the 3-digit group; 7372 against 7011
    shares nothing. A 2-digit "major group" match is real but weak, and is
    scored as such rather than treated as equivalent to an exact one.
  * **size** — on a log scale, because the distance from $10m to $100m of
    revenue is the same *kind* of gap as $1bn to $10bn, and a linear measure
    would rank every large-cap as equally wrong for a small target.
  * **growth** — two companies at the same multiple and scale are not equally
    comparable to a target growing at 80% if one is growing at 3%.
  * **profitability** — margin proximity, which is what makes an EV/EBITDA
    multiple transferable at all.

Weights are caller-supplied with a documented default, and every score comes
back with its per-dimension breakdown, because a score a reviewer cannot take
apart is a score they cannot defend.
"""

from __future__ import annotations

import math
import statistics

from .errors import EngineInputError
from .market_data import Company, normalize_ticker
from .market_universe import resolve_universe

# Default dimension weights. Industry dominates because a market approach that
# reaches outside the industry is challenged on that first, and everything else
# is a refinement within it.
DEFAULT_WEIGHTS: dict[str, float] = {
    "industry": 0.40,
    "size": 0.25,
    "growth": 0.20,
    "profitability": 0.15,
}

# Below this, a candidate is reported as screened out rather than ranked. Set
# so a same-major-group company of roughly the right size still surfaces —
# the screen's job is to widen the net, not to pre-empt the analyst.
DEFAULT_MIN_SCORE = 0.30

MAX_SELECTED = 12

# How far apart two companies can be on a dimension before proximity is zero.
# A decade of revenue (10×) is the size horizon; 40 points of growth and 30 of
# margin are the analogous spans on their axes.
_SIZE_DECADES = 1.0
_GROWTH_SPAN = 0.40
_MARGIN_SPAN = 0.30


def _num(value, name: str, *, minimum: float | None = None, maximum: float | None = None) -> float:
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


def _opt_num(value, name: str, **kw) -> float | None:
    return None if value is None else _num(value, name, **kw)


# ── dimension scores ─────────────────────────────────────────────────────────


def sic_similarity(target_sic: str | None, comp_sic: str | None) -> float:
    """Industry proximity from the shared SIC prefix, in [0, 1].

    4 shared digits is the same industry; 3 is the same group; 2 is the same
    major group, which is a real but much weaker claim — a payments processor
    and a crypto exchange share "60", and a report that treats that as an exact
    match is one a reviewer will take apart.
    """
    a = str(target_sic or "").strip()
    b = str(comp_sic or "").strip()
    if not a or not b:
        return 0.0
    shared = 0
    for x, y in zip(a, b):
        if x != y:
            break
        shared += 1
    # Deliberately convex, not linear: the gap between "same group" and "same
    # industry" is smaller than the gap between "same division" and "same group".
    return {0: 0.0, 1: 0.15, 2: 0.45, 3: 0.80}.get(shared, 1.0)


def _log_proximity(target: float, comp: float, span_decades: float) -> float:
    """1 at parity, falling to 0 once the two are `span_decades` apart in log10."""
    if target <= 0 or comp <= 0:
        return 0.0
    decades = abs(math.log10(comp / target))
    return max(0.0, 1.0 - decades / span_decades)


def _linear_proximity(target: float, comp: float, span: float) -> float:
    return max(0.0, 1.0 - abs(comp - target) / span)


def score_company(
    company: Company,
    *,
    sic_code: str | None = None,
    revenue: float | None = None,
    revenue_growth: float | None = None,
    ebitda_margin: float | None = None,
    weights: dict[str, float] | None = None,
) -> dict:
    """Score one candidate against the target, with the breakdown that made it.

    A dimension the target says nothing about is *dropped and the weights
    renormalised* — not scored zero. Scoring it zero would penalise every
    candidate equally on an axis nobody measured, which changes the total
    without changing the ranking and makes the number unreadable. A dimension
    the target has and the candidate does not (an unprofitable comp against a
    profitable target) IS scored zero, because that is a real difference.
    """
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    for key, value in w.items():
        if key not in DEFAULT_WEIGHTS:
            raise EngineInputError(f"comparables: unknown weight '{key}'")
        _num(value, f"comparables.weights.{key}", minimum=0.0, maximum=1.0)

    breakdown: dict[str, float] = {}
    applicable: dict[str, float] = {}

    if sic_code:
        breakdown["industry"] = sic_similarity(sic_code, company.sic_code)
        applicable["industry"] = w["industry"]
    if revenue is not None:
        breakdown["size"] = _log_proximity(revenue, company.revenue, _SIZE_DECADES)
        applicable["size"] = w["size"]
    if revenue_growth is not None:
        breakdown["growth"] = (
            _linear_proximity(revenue_growth, company.revenue_growth, _GROWTH_SPAN)
            if company.revenue_growth is not None
            else 0.0
        )
        applicable["growth"] = w["growth"]
    if ebitda_margin is not None:
        breakdown["profitability"] = (
            _linear_proximity(ebitda_margin, company.ebitda_margin, _MARGIN_SPAN)
            if company.ebitda_margin is not None
            else 0.0
        )
        applicable["profitability"] = w["profitability"]

    total_weight = sum(applicable.values())
    if total_weight <= 0:
        # Nothing to match on. An honest 0 with an empty breakdown, so the
        # caller can see the screen had no basis rather than reading a
        # confident-looking number.
        return {"score": 0.0, "breakdown": {}, "weights": {}}

    score = sum(breakdown[k] * applicable[k] for k in breakdown) / total_weight
    return {
        "score": round(score, 4),
        "breakdown": {k: round(v, 4) for k, v in breakdown.items()},
        "weights": {k: round(v / total_weight, 4) for k, v in applicable.items()},
    }


# ── screening ────────────────────────────────────────────────────────────────


def screen_comparables(
    *,
    sic_code: str | None = None,
    revenue: float | None = None,
    revenue_growth: float | None = None,
    ebitda_margin: float | None = None,
    weights: dict | None = None,
    min_score: float = DEFAULT_MIN_SCORE,
    limit: int = MAX_SELECTED,
    include_tickers: list | None = None,
    exclude_tickers: list | None = None,
    live: bool | None = None,
) -> dict:
    """Rank the reference universe against the target.

    ``include_tickers`` forces a candidate into the result whatever it scores —
    the analyst has a comp they intend to use and wants it scored alongside the
    rest rather than argued with. ``exclude_tickers`` removes one outright.

    The universe is resolved against observed market data where the feed is
    available (see ``market_universe``) and falls back to the curated snapshot
    where it is not; ``live=False`` pins the snapshot for a reproducible rerun.
    Either way the result reports which it screened, per row and in aggregate —
    a multiple is not the same claim struck on a live figure as on a reference
    one, and the difference has to survive as far as the reviewer.
    """
    if sic_code is None and revenue is None and revenue_growth is None and ebitda_margin is None:
        raise EngineInputError(
            "comparables: the screen needs at least one target attribute "
            "(sic_code, revenue, revenue_growth or ebitda_margin)"
        )
    floor = _num(min_score, "comparables.min_score", minimum=0.0, maximum=1.0)
    top_n = int(_num(limit, "comparables.limit", minimum=1, maximum=MAX_SELECTED))

    forced = {normalize_ticker(t) for t in (include_tickers or [])}
    banned = {normalize_ticker(t) for t in (exclude_tickers or [])}
    resolution = resolve_universe(live=live)

    ranked: list[dict] = []
    screened_out: list[dict] = []
    for company in resolution.companies:
        if company.ticker in banned:
            continue
        scored = score_company(
            company,
            sic_code=sic_code,
            revenue=revenue,
            revenue_growth=revenue_growth,
            ebitda_margin=ebitda_margin,
            weights=weights,
        )
        row = {**company.to_dict(), **scored, "forced": company.ticker in forced}
        if scored["score"] >= floor or company.ticker in forced:
            ranked.append(row)
        else:
            screened_out.append(
                {
                    "ticker": company.ticker,
                    "name": company.name,
                    "score": scored["score"],
                    "reason": _screen_out_reason(scored["breakdown"]),
                }
            )

    # Forced tickers first, then by score; the tie-break is the ticker so the
    # order is stable across runs and a report reruns identically.
    ranked.sort(key=lambda r: (not r["forced"], -r["score"], r["ticker"]))
    return {
        "selected": ranked[:top_n],
        "screened_out": sorted(screened_out, key=lambda r: -r["score"])[:20],
        "universe_size": len(resolution.companies),
        "universe": resolution.provenance(),
        "min_score": floor,
        "target": {
            "sic_code": sic_code,
            "revenue": revenue,
            "revenue_growth": revenue_growth,
            "ebitda_margin": ebitda_margin,
        },
    }


def _screen_out_reason(breakdown: dict) -> str:
    """The dimension that sank it — the sentence the exhibit prints."""
    if not breakdown:
        return "no comparable attributes supplied"
    worst = min(breakdown, key=lambda k: breakdown[k])
    return {
        "industry": "different industry",
        "size": "scale too far from the target",
        "growth": "growth profile too different",
        "profitability": "margin profile too different",
    }[worst]


# ── multiple statistics ──────────────────────────────────────────────────────


def multiple_statistics(values: list) -> dict:
    """Central tendency and dispersion for one multiple, outliers named.

    Both the median and the harmonic mean are reported. The harmonic mean is
    the one that is right for a ratio being applied to a denominator — it is
    the multiple implied by aggregating the comps' enterprise values and
    revenues — and the arithmetic mean of multiples is the figure that quietly
    overweights the most expensive comp in the set. Reporting all three lets
    the report state which was used and why.

    Outliers are flagged by the 1.5·IQR rule and excluded from the *trimmed*
    figures, never dropped silently: a comp excluded without appearing anywhere
    is the finding that a reviewer raises.
    """
    clean = [
        float(v) for v in values if isinstance(v, (int, float)) and math.isfinite(v) and v > 0
    ]
    if not clean:
        return {"count": 0}

    ordered = sorted(clean)
    q1, median, q3 = _quartiles(ordered)
    iqr = q3 - q1
    low_fence, high_fence = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    trimmed = [v for v in ordered if low_fence <= v <= high_fence]
    outliers = [v for v in ordered if v < low_fence or v > high_fence]

    return {
        "count": len(clean),
        "min": ordered[0],
        "q1": round(q1, 4),
        "median": round(median, 4),
        "q3": round(q3, 4),
        "max": ordered[-1],
        "mean": round(statistics.fmean(clean), 4),
        "harmonic_mean": round(statistics.harmonic_mean(clean), 4),
        "trimmed_median": round(statistics.median(trimmed), 4) if trimmed else None,
        "trimmed_count": len(trimmed),
        "outliers": [round(v, 4) for v in outliers],
        "iqr": round(iqr, 4),
        # A set this dispersed does not support a point multiple, and the
        # report should say so rather than quoting the median with a straight
        # face. Coefficient of variation, the scale-free dispersion measure.
        "dispersion": round(statistics.pstdev(clean) / statistics.fmean(clean), 4)
        if len(clean) > 1
        else 0.0,
    }


def _quartiles(ordered: list[float]) -> tuple[float, float, float]:
    """Q1, median, Q3 by linear interpolation — defined for n < 4 too.

    `statistics.quantiles` raises below four data points, and a comp set of
    three is ordinary. Interpolating is the same answer where both are defined.
    """
    n = len(ordered)
    if n == 1:
        v = ordered[0]
        return v, v, v

    def at(p: float) -> float:
        pos = p * (n - 1)
        low = math.floor(pos)
        high = math.ceil(pos)
        if low == high:
            return ordered[low]
        return ordered[low] + (ordered[high] - ordered[low]) * (pos - low)

    return at(0.25), at(0.50), at(0.75)


# ── industry-specific multiple selection ─────────────────────────────────────

# SIC major groups where a revenue multiple is the market convention because
# reported EBITDA is not the value driver: software and computer services
# (73), and biological/pharmaceutical products (28), where a pre-approval or
# recently-launched company's EBITDA says nothing about the asset.
_REVENUE_MULTIPLE_GROUPS = {"73", "28", "36"}


def primary_multiple(
    *, sic_code: str | None, ebitda_margin: float | None, ebitda_count: int
) -> dict:
    """Which multiple the market approach should lead with, and why.

    Three things decide it, in order: whether the target has meaningful EBITDA
    at all, whether enough comps do to make a set, and the industry convention.
    An EV/EBITDA multiple struck on two comps is not a multiple.
    """
    group = str(sic_code or "")[:2]

    if ebitda_margin is None or ebitda_margin <= 0:
        return {
            "multiple": "ev_revenue",
            "basis": "the target has no meaningful positive EBITDA, so an EBITDA multiple "
            "has no denominator to apply to",
        }
    if ebitda_count < 3:
        return {
            "multiple": "ev_revenue",
            "basis": f"only {ebitda_count} comparable(s) report positive EBITDA — too few to "
            "strike a defensible EV/EBITDA multiple",
        }
    if group in _REVENUE_MULTIPLE_GROUPS:
        return {
            "multiple": "ev_revenue",
            "basis": "revenue multiples are the market convention in this industry, where "
            "reported EBITDA reflects the pace of reinvestment more than the earning power "
            "of the business",
        }
    return {
        "multiple": "ev_ebitda",
        "basis": "the target and the comparable set both report meaningful positive EBITDA, "
        "which makes the earnings multiple the more direct measure",
    }


# ── the whole analysis ───────────────────────────────────────────────────────


def comparable_analysis(
    *,
    sic_code: str | None = None,
    revenue: float | None = None,
    revenue_growth: float | None = None,
    ebitda_margin: float | None = None,
    weights: dict | None = None,
    min_score: float = DEFAULT_MIN_SCORE,
    limit: int = MAX_SELECTED,
    include_tickers: list | None = None,
    exclude_tickers: list | None = None,
    live: bool | None = None,
) -> dict:
    """Screen, score, and produce the multiple statistics and implied values."""
    revenue = _opt_num(revenue, "comparables.revenue", minimum=0.0)
    revenue_growth = _opt_num(revenue_growth, "comparables.revenue_growth", minimum=-1.0, maximum=20.0)
    ebitda_margin = _opt_num(ebitda_margin, "comparables.ebitda_margin", minimum=-10.0, maximum=1.0)

    screen = screen_comparables(
        sic_code=sic_code,
        revenue=revenue,
        revenue_growth=revenue_growth,
        ebitda_margin=ebitda_margin,
        weights=weights,
        min_score=min_score,
        limit=limit,
        include_tickers=include_tickers,
        exclude_tickers=exclude_tickers,
        live=live,
    )
    selected = screen["selected"]

    ev_revenue = multiple_statistics([c["ev_revenue"] for c in selected])
    ev_ebitda = multiple_statistics([c["ev_ebitda"] for c in selected])
    choice = primary_multiple(
        sic_code=sic_code, ebitda_margin=ebitda_margin, ebitda_count=ev_ebitda.get("count", 0)
    )

    # The indicated enterprise value, at the trimmed median of the chosen
    # multiple — trimmed because the outliers are already named, and applying
    # an untrimmed median means applying whichever extreme happened to survive.
    stats = ev_revenue if choice["multiple"] == "ev_revenue" else ev_ebitda
    denominator = revenue if choice["multiple"] == "ev_revenue" else (
        revenue * ebitda_margin if revenue is not None and ebitda_margin is not None else None
    )
    multiple = stats.get("trimmed_median")
    indicated = (
        denominator * multiple if denominator is not None and multiple is not None else None
    )

    return {
        **screen,
        "multiples": {"ev_revenue": ev_revenue, "ev_ebitda": ev_ebitda},
        "primary_multiple": choice,
        "indicated_enterprise_value": indicated,
        "indicated_basis": {
            "multiple": choice["multiple"],
            "applied": multiple,
            "denominator": denominator,
        },
    }
