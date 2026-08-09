"""Multi-breakpoint OPM cap-table waterfall (remaining-gaps §2 — "OPM allocation").

Standard AICPA breakpoint method: the exit-value payoff of every share class
is piecewise linear and continuous, so its expected value under the OPM
lognormal is a sum of Black-Scholes call spreads between breakpoints.

Breakpoints, in order:
1. Liquidation preferences by seniority (pari passu ranks split pro-rata by
   preference amount).
2. The residual, shared pro-rata on as-converted shares by common,
   participating preferred, converted non-participating preferred, and
   exercised options. Conversion and option-exercise points are found by an
   event loop: at each state, the next conversion breakpoint for a pending
   non-participating class j is  (P_cur − P_j) + P_j·(S + S_j)/S_j  and the
   next exercise point for an option pool is  P_cur + strike·S  (per-share
   residual reaches the strike). Both keep every payoff continuous, so no
   jump corrections are needed and the class values conserve exactly:
   Σ class values == bs_call(E, 0) == E.

3. Participation caps. A participating class carrying ``participation_cap``
   stops drawing residual once its cumulative proceeds — preference plus
   participation — reach the cap, and converts to common at the exit value
   where the as-converted slice is worth more than the cap. Both events are
   breakpoints and both keep the payoff continuous, so the call-spread
   decomposition below still holds.

Simplifications (documented): options are pools with a single strike each and
their exercise proceeds are captured by the slope algebra rather than modeled
as a cash inflow.
"""

from __future__ import annotations

import math

from .bs import bs_call, bs_call_delta
from .errors import EngineInputError

_KINDS = ("preferred", "common", "option")

# Ceiling on the cap table one request may allocate.
#
# The breakpoint method is quadratic in the number of classes twice over: the
# residual event loop resolves one pending class per iteration and rescans the
# rest, and the segments it produces are then priced against a participant map
# whose own size grows with the class count. Both the CPU and the *response*
# scale as n² — measured, 2,000 preferred classes arrive as a 200 KB request
# and leave as a 36 MB body after a second of engine time, and the 8 MB body
# cap admits fifty times that, which is hours of CPU and a response no caller
# could hold. The backsolve makes it worse still: `class_per_share` is the
# Newton objective, so the whole allocation runs again per iteration.
#
# 200 is far past anything real. A late-stage cap table carries a dozen
# preferred series, a common class and a handful of option pools; the largest
# legitimate table this platform has seen is an order of magnitude under the
# limit, while the limit itself keeps the worst case at a few hundred
# kilobytes.
MAX_SHARE_CLASSES = 200


def normalize_share_classes(classes: list[dict]) -> list[dict]:
    """Public entry point for the shared cap-table normaliser (used by PWERM)."""
    return _normalize(classes)


def _finite(value: float, name: str) -> float:
    """Reject NaN/Inf on a cap-table figure (audit T-1 P3).

    Comparisons are the reason this cannot be left to the range checks below:
    ``NaN <= 0`` is False, so a NaN share count passes ``shares must be
    positive`` and goes on to make every allocated value NaN — which FastAPI
    then serialises as ``null``, so a cap table nobody could allocate comes
    back as a successful 200 with holes in it.
    """
    if not math.isfinite(value):
        raise EngineInputError(f"{name} must be a finite number")
    return value


def _normalize(classes: list[dict]) -> list[dict]:
    if not isinstance(classes, list) or not classes:
        raise EngineInputError("share_classes must be a non-empty list")
    if len(classes) > MAX_SHARE_CLASSES:
        raise EngineInputError(
            f"share_classes accepts at most {MAX_SHARE_CLASSES} classes "
            f"(got {len(classes)}) — the breakpoint allocation grows with the "
            "square of the class count"
        )
    out: list[dict] = []
    names: set[str] = set()
    for i, raw in enumerate(classes):
        if not isinstance(raw, dict):
            raise EngineInputError(f"share_classes[{i}] must be an object")
        name = str(raw.get("name") or "").strip()
        if not name:
            raise EngineInputError(f"share_classes[{i}].name is required")
        if name in names:
            raise EngineInputError(f"share_classes: duplicate class name '{name}'")
        names.add(name)
        kind = raw.get("kind")
        if kind not in _KINDS:
            raise EngineInputError(f"share_classes[{i}].kind must be one of {_KINDS}")
        try:
            shares = float(raw.get("shares"))
        except (TypeError, ValueError):
            raise EngineInputError(f"share_classes[{i}].shares must be a number") from None
        _finite(shares, f"share_classes[{i}].shares")
        if shares <= 0:
            raise EngineInputError(f"share_classes[{i}].shares must be positive")
        cls = {"name": name, "kind": kind, "shares": shares}
        if kind == "preferred":
            try:
                pref = float(raw.get("preference"))
            except (TypeError, ValueError):
                raise EngineInputError(f"'{name}': preference (total) is required for preferred") from None
            _finite(pref, f"'{name}': preference")
            if pref < 0:
                raise EngineInputError(f"'{name}': preference must be >= 0")
            seniority = raw.get("seniority", 1)
            if not isinstance(seniority, int) or isinstance(seniority, bool) or seniority < 1:
                raise EngineInputError(f"'{name}': seniority must be an integer >= 1")
            # `raw.get(...) or 1.0` would quietly turn a conversion_ratio of 0
            # into 1:1 and value the class as if it converted normally. Only an
            # absent or null ratio defaults; anything present is validated.
            raw_ratio = raw.get("conversion_ratio")
            if raw_ratio is None:
                ratio = 1.0
            else:
                try:
                    ratio = float(raw_ratio)
                except (TypeError, ValueError):
                    raise EngineInputError(f"'{name}': conversion_ratio must be a number") from None
            _finite(ratio, f"'{name}': conversion_ratio")
            if ratio <= 0:
                raise EngineInputError(f"'{name}': conversion_ratio must be positive")
            # Both factors are finite and positive and their *product* still
            # need not be: the as-converted share count is what the residual
            # algebra actually runs on, and it is the figure that leaves the
            # doubles.
            #
            # Underflow first, because it is a 500. `_segments` divides by it —
            # the conversion breakpoint is `(P_cur − P) + P·(S + S_j)/S_j` — so
            # a product that flushes to zero is a ZeroDivisionError, for a cap
            # table every check above had passed.
            #
            # Overflow is quieter and worse. `S_j` of `inf` makes `(S + S_j)/S_j`
            # a NaN, the breakpoint never orders ahead of anything, and the
            # residual segment is simply never emitted — so the allocation pays
            # out the preference stack and stops. It conserves nothing and says
            # nothing: a $1,000,000 PWERM exit came back 200 OK having allocated
            # $69.44, with the common holder shown $0.00 per share. This module
            # documents `Σ class values == exit_value` as an invariant; that is
            # the shape of its violation.
            as_converted = shares * ratio
            if not math.isfinite(as_converted) or as_converted <= 0:
                raise EngineInputError(
                    f"'{name}': shares x conversion_ratio ({shares:g} x {ratio:g}) is not a "
                    "representable as-converted share count — the allocation is computed on the "
                    "converted count, so check both figures"
                )
            participating = bool(raw.get("participating", False))
            # Participation cap: the most the class can take in total — its
            # preference plus everything it draws from the residual — before it
            # stops participating. Expressed as a currency amount rather than a
            # multiple of the preference, because that is what the term sheet's
            # "2x cap" resolves to once the round's actual preference is known,
            # and because a class whose preference is zero has no multiple to
            # take. Absent (or null) means uncapped, which is what every cap
            # table stored before this field existed meant.
            raw_cap = raw.get("participation_cap")
            cap: float | None = None
            if raw_cap is not None:
                try:
                    cap = float(raw_cap)
                except (TypeError, ValueError):
                    raise EngineInputError(f"'{name}': participation_cap must be a number") from None
                _finite(cap, f"'{name}': participation_cap")
                if not participating:
                    raise EngineInputError(
                        f"'{name}': participation_cap applies only to participating preferred — "
                        "a non-participating class already stops at its preference"
                    )
                # At or below the preference the class draws no residual at all,
                # which is not a capped participating class but a
                # non-participating one described in a way the allocation would
                # silently disagree with: `_segments` would emit a cap event at
                # or before the residual opens and the class would look
                # participating in the breakpoint table while receiving nothing
                # for it.
                if cap <= pref:
                    raise EngineInputError(
                        f"'{name}': participation_cap ({cap:g}) must exceed the liquidation "
                        f"preference ({pref:g}) — a cap at or below the preference means the "
                        "class does not participate, which is `participating: false`"
                    )
            cls.update(
                preference=pref,
                seniority=seniority,
                participating=participating,
                conversion_ratio=ratio,
                participation_cap=cap,
            )
        elif kind == "option":
            try:
                strike = float(raw.get("strike"))
            except (TypeError, ValueError):
                raise EngineInputError(f"'{name}': strike is required for options") from None
            _finite(strike, f"'{name}': strike")
            if strike <= 0:
                raise EngineInputError(f"'{name}': strike must be positive")
            cls["strike"] = strike
        out.append(cls)
    if not any(c["kind"] == "common" for c in out):
        raise EngineInputError("share_classes must include at least one 'common' class")
    # The same argument as the per-class check above, one level up: every
    # residual slope in `_segments` is `class shares / pool shares`, and the
    # pool is a *sum*, so it can leave the doubles while every term in it is
    # fine. Three common classes of 1e308 shares each are individually legal and
    # add to `inf`; every slope is then `finite / inf == 0.0`, so the residual
    # tranches are handed to nobody and a $1,000,000 exit allocates $0.00 to
    # every class — silently, as a 200, with the arithmetic never once
    # producing a NaN for the finite-result sweep downstream to catch.
    #
    # Fully converted and fully exercised is the largest the pool can ever be,
    # so bounding that bounds every intermediate state of the event loop.
    total_as_converted = sum(c["shares"] * c.get("conversion_ratio", 1.0) for c in out)
    if not math.isfinite(total_as_converted):
        raise EngineInputError(
            "share_classes: the fully-diluted, as-converted share count is not a representable "
            "number — the allocation divides the residual by it, so check the share counts"
        )
    return out


def _segments(classes: list[dict]) -> list[dict]:
    """Breakpoint segments: {'from', 'to' (None = ∞), 'participants': {name: slope}}."""
    preferred = [c for c in classes if c["kind"] == "preferred"]
    commons = [c for c in classes if c["kind"] == "common"]
    options = [c for c in classes if c["kind"] == "option"]

    segments: list[dict] = []

    # 1. Preference stack by seniority (1 = most senior), pari passu pro-rata.
    cursor = 0.0
    for rank in sorted({c["seniority"] for c in preferred}):
        rank_classes = [c for c in preferred if c["seniority"] == rank and c["preference"] > 0]
        rank_total = sum(c["preference"] for c in rank_classes)
        if rank_total <= 0:
            continue
        segments.append(
            {
                "from": cursor,
                "to": cursor + rank_total,
                "participants": {c["name"]: c["preference"] / rank_total for c in rank_classes},
            }
        )
        cursor += rank_total

    # 2. Residual event loop.
    pool: dict[str, float] = {c["name"]: c["shares"] for c in commons}
    for c in preferred:
        if c["participating"]:
            pool[c["name"]] = c["shares"] * c["conversion_ratio"]
    pending_conversions = [c for c in preferred if not c["participating"]]
    pending_options = list(options)
    # Capped participating classes, in the two states they pass through: still
    # drawing residual toward the cap, then flat at the cap waiting for the exit
    # value where converting beats holding it. `drawn` tracks what each has
    # taken so far, which at the top of the residual is its preference — the
    # segment slopes below are integrated incrementally, so the cap breakpoint
    # has to be found the same way.
    capped_drawing = [c for c in preferred if c["participating"] and c["participation_cap"] is not None]
    capped_at_cap: list[dict] = []
    drawn: dict[str, float] = {c["name"]: c["preference"] for c in capped_drawing}
    # `p_cur` is the value absorbed *below* the residual pool — everything the
    # classes outside the pool take before the pool sees a dollar. Every
    # conversion breakpoint below is struck against it, since a converting class
    # is choosing between what it holds and a share of `x - p_cur`.
    #
    # For a class still taking its preference that absorbed amount is the
    # preference, which is where this starts. For a class frozen at its
    # participation cap it is the *cap* — preference plus the participation it
    # banked on the way up — and that is the correction the `cap` action below
    # applies. Counting only the preference there understates what sits beneath
    # the pool by the banked participation, which strikes every conversion
    # breakpoint computed while that class is frozen too early: on the cap table
    # in `test_participation_cap_ordering.py` a class converted at $12.0625M
    # rather than $12.375M and was overpaid $192,307 at a $50M exit, with the
    # shortfall taken from common and the uncapped participating class. Value
    # still conserved, so nothing downstream could notice.
    p_cur = sum(c["preference"] for c in preferred)
    b_cur = cursor  # == total preferences

    while True:
        s_cur = sum(pool.values())
        candidates: list[tuple[float, str, dict]] = []
        for c in pending_conversions:
            s_conv = c["shares"] * c["conversion_ratio"]
            x_star = (p_cur - c["preference"]) + c["preference"] * (s_cur + s_conv) / s_conv
            candidates.append((max(x_star, b_cur), "convert", c))
        for c in capped_drawing:
            # The slope is flat inside a segment, so the cap is reached where
            # the remaining headroom divided by this class's share of the
            # residual runs out.
            x_star = b_cur + (c["participation_cap"] - drawn[c["name"]]) * s_cur / pool[c["name"]]
            candidates.append((max(x_star, b_cur), "cap", c))
        for c in capped_at_cap:
            # The same conversion algebra as a non-participating class, with the
            # cap in place of the preference: what a class gives up by
            # converting is whatever it holds *without* converting, and for a
            # capped class that has stopped participating that is the cap.
            #
            # The cap is therefore also what this class contributes to `p_cur`,
            # so it is the cap that comes back out to leave what everything
            # *else* absorbs. Subtracting the preference instead would leave the
            # class's own banked participation sitting in its own conversion
            # threshold.
            s_conv = c["shares"] * c["conversion_ratio"]
            x_star = (p_cur - c["participation_cap"]) + c["participation_cap"] * (
                s_cur + s_conv
            ) / s_conv
            candidates.append((max(x_star, b_cur), "convert_capped", c))
        for o in pending_options:
            candidates.append((max(p_cur + o["strike"] * s_cur, b_cur), "exercise", o))
        if not candidates:
            break
        x_next, action, cls = min(candidates, key=lambda item: item[0])
        if x_next > b_cur and s_cur > 0:
            segments.append(
                {
                    "from": b_cur,
                    "to": x_next,
                    "participants": {name: sh / s_cur for name, sh in pool.items()},
                }
            )
            for c in capped_drawing:
                drawn[c["name"]] += (x_next - b_cur) * pool[c["name"]] / s_cur
        if action == "convert":
            pool[cls["name"]] = cls["shares"] * cls["conversion_ratio"]
            p_cur -= cls["preference"]
            pending_conversions.remove(cls)
        elif action == "cap":
            # Out of the pool: the payoff is flat at the cap from here, so the
            # residual this class was drawing passes to everyone still in.
            del pool[cls["name"]]
            # What this class absorbs beneath the pool stops being its
            # preference and becomes its cap, because the participation it drew
            # on the way up is now banked and frozen there too.
            p_cur += cls["participation_cap"] - cls["preference"]
            capped_drawing.remove(cls)
            capped_at_cap.append(cls)
        elif action == "convert_capped":
            # Back in at the as-converted count, giving up the whole cap it was
            # holding — preference and banked participation alike — so the
            # residual base widens by exactly that.
            pool[cls["name"]] = cls["shares"] * cls["conversion_ratio"]
            p_cur -= cls["participation_cap"]
            capped_at_cap.remove(cls)
        else:
            pool[cls["name"]] = cls["shares"]
            pending_options.remove(cls)
        b_cur = max(x_next, b_cur)

    s_cur = sum(pool.values())
    if s_cur > 0:
        segments.append(
            {
                "from": b_cur,
                "to": None,
                "participants": {name: sh / s_cur for name, sh in pool.items()},
            }
        )
    return segments


def _allocate(
    equity_value: float,
    classes: list[dict],
    # `float | None`, not `float`: the backsolve in `approaches` carries these
    # three as optionals all the way down, and the original `sigma is None`
    # guard was already defending against it. Saying so makes the None checks
    # below type-visible instead of dead code a checker prunes.
    t: float | None,
    r: float | None,
    sigma: float | None,
) -> tuple[list[dict], list[dict], list[float], dict[str, float]]:
    """The allocation itself: validated classes, segments, per-segment tranche
    values, and each class's value — all unrounded.

    Split out from ``allocate_waterfall`` because rounding is a property of the
    response, not of the arithmetic, and one caller needs the arithmetic:
    ``class_per_share`` is the backsolve's Newton objective. See its docstring.
    """
    _finite(equity_value, "equity_value")
    if equity_value <= 0:
        raise EngineInputError("equity_value must be positive for the waterfall allocation")
    # The OPM scalars get the same treatment as every cap-table figure above,
    # and for the same reason `_finite` documents: they are multiplied into
    # every tranche, so one NaN here makes the whole allocation NaN and the
    # run still returns 200 — with `null` where each class's value belongs.
    # Note the ordering: the finiteness check has to come *first*, because the
    # positivity check below cannot do it. `NaN <= 0` is False, so a NaN
    # volatility satisfies "volatility is required" and sails through.
    if t is None:
        raise EngineInputError("time_to_exit is required for the waterfall allocation")
    _finite(t, "time_to_exit")
    if t < 0:
        raise EngineInputError("time_to_exit must be >= 0 for the waterfall allocation")
    if r is None:
        raise EngineInputError("risk_free_rate is required for the waterfall allocation")
    _finite(r, "risk_free_rate")
    if sigma is None:
        raise EngineInputError("volatility is required for the waterfall allocation")
    _finite(sigma, "volatility")
    if sigma <= 0:
        raise EngineInputError("volatility is required for the waterfall allocation")
    normalized = _normalize(classes)
    segments = _segments(normalized)

    values: dict[str, float] = {c["name"]: 0.0 for c in normalized}
    tranches: list[float] = []
    for seg in segments:
        c_from = bs_call(equity_value, seg["from"], t, r, sigma)
        c_to = bs_call(equity_value, seg["to"], t, r, sigma) if seg["to"] is not None else 0.0
        tranche = c_from - c_to
        for name, fraction in seg["participants"].items():
            values[name] += tranche * fraction
        tranches.append(tranche)
    return normalized, segments, tranches, values


def allocate_waterfall(
    equity_value: float,
    classes: list[dict],
    t: float | None,
    r: float | None,
    sigma: float | None,
) -> dict:
    normalized, segments, tranches, values = _allocate(equity_value, classes, t, r, sigma)

    breakpoints = [
        {
            "from": round(seg["from"], 2),
            "to": round(seg["to"], 2) if seg["to"] is not None else None,
            "participants": {k: round(v, 6) for k, v in seg["participants"].items()},
            "value": round(tranche, 2),
        }
        for seg, tranche in zip(segments, tranches, strict=True)
    ]

    by_class = {
        c["name"]: {
            "kind": c["kind"],
            # `shares` alongside the value, as `exit_allocation` and
            # `allocate_pwerm` already report it. The allocation exhibit on the
            # report tabulates value, shares and value per share side by side,
            # and reading the share count back out of `value / per_share` is a
            # division by a figure this response has already rounded.
            "shares": c["shares"],
            "value": round(values[c["name"]], 2),
            "per_share": round(values[c["name"]] / c["shares"], 6),
        }
        for c in normalized
    }
    common_shares = sum(c["shares"] for c in normalized if c["kind"] == "common")
    common_value = sum(values[c["name"]] for c in normalized if c["kind"] == "common")
    return {
        "method": "opm_waterfall",
        "breakpoints": breakpoints,
        "classes": by_class,
        "common_value": round(common_value, 2),
        "common_shares": common_shares,
        "common_per_share": round(common_value / common_shares, 6),
    }


def class_volatilities(
    equity_value: float,
    classes: list[dict],
    t: float | None,
    r: float | None,
    sigma: float | None,
) -> dict:
    """Per-class volatility implied by the same breakpoint waterfall.

    The enterprise volatility ``sigma`` describes the *total* equity. A share
    class is a levered claim on that equity — a call spread, per the
    decomposition above — so its own return volatility is not sigma, and for
    common it is materially higher: common sits behind the whole preference
    stack, which gears it.

    The standard result follows from Itô on ``V_class = f(S)``:

        sigma_class = sigma · (S / V_class) · ∂V_class/∂S

    where the elasticity ``(S/V)·∂V/∂S`` is the class's option gearing. Each
    class's delta is the participation-weighted sum of its tranches' spread
    deltas, ``N(d1(K_from)) − N(d1(K_to))``, which is the term-by-term
    derivative of the very sum ``_allocate`` uses for the values — so the two
    are guaranteed consistent rather than separately derived.

    This is the figure a 409A report needs in two places: it is the volatility
    that belongs in an option-based DLOM struck on common (Chaffee and Finnerty
    both take the volatility of the *interest being valued*, not of the
    enterprise), and it is the "class volatility" schedule a reviewer looks for
    behind a DLOM concluded on a single class.

    Returns ``{"enterprise_volatility": …, "classes": {name: {...}}}``. A class
    the waterfall values at zero — one so far out of the money that no tranche
    reaches it — has no defined return volatility, and is reported with a null
    rather than an infinity.

    ``common_volatility`` is the same figure for the *aggregate* common claim —
    the one interest a 409A actually concludes on — and is what an option-based
    DLOM struck on common should be given. It is the value-weighted mean of the
    common classes' volatilities, which is exact rather than approximate: each
    class contributes ``sigma·S·delta_i``, so summing the numerators and the
    values is the same operation as taking the elasticity of the summed claim.
    """
    normalized, segments, _tranches, values = _allocate(equity_value, classes, t, r, sigma)
    # `_allocate` has validated all three; narrowing here is for the type checker
    # and costs nothing at runtime.
    assert t is not None and r is not None and sigma is not None

    deltas: dict[str, float] = {c["name"]: 0.0 for c in normalized}
    for seg in segments:
        d_from = bs_call_delta(equity_value, seg["from"], t, r, sigma)
        d_to = bs_call_delta(equity_value, seg["to"], t, r, sigma) if seg["to"] is not None else 0.0
        spread_delta = d_from - d_to
        for name, fraction in seg["participants"].items():
            deltas[name] += spread_delta * fraction

    out: dict[str, dict] = {}
    for c in normalized:
        name = c["name"]
        value = values[name]
        delta = deltas[name]
        # Elasticity is (S/V)·ΔV/ΔS. Undefined at V = 0, and the whole point of
        # reporting it is that a reader can check it, so an undefined one is
        # reported as undefined.
        if value > 0:
            elasticity = equity_value * delta / value
            volatility = sigma * elasticity
        else:
            elasticity = None
            volatility = None
        out[name] = {
            "kind": c["kind"],
            "value": round(value, 2),
            "delta": round(delta, 6),
            "elasticity": round(elasticity, 6) if elasticity is not None else None,
            "volatility": round(volatility, 6) if volatility is not None else None,
        }

    # The aggregate common claim. `allocate_waterfall` strikes its
    # `common_per_share` over exactly this set (kind == "common", options
    # excluded, since the pool is valued as its own class at its own strike),
    # so the volatility of the interest being valued is taken over the same set.
    common_value = sum(values[c["name"]] for c in normalized if c["kind"] == "common")
    common_delta = sum(deltas[c["name"]] for c in normalized if c["kind"] == "common")
    common_volatility = (
        round(sigma * equity_value * common_delta / common_value, 6) if common_value > 0 else None
    )

    return {
        "enterprise_volatility": sigma,
        "common_volatility": common_volatility,
        "time_to_exit_years": t,
        "risk_free_rate": r,
        "equity_value": round(equity_value, 2),
        "classes": out,
        # Σ over classes of ∂V_class/∂S is ∂(Σ V_class)/∂S = ∂S/∂S = 1, since the
        # waterfall conserves value. Reported so a reviewer can check the
        # schedule adds up without redoing the option arithmetic.
        "delta_total": round(sum(deltas.values()), 6),
    }


def exit_allocation(exit_value: float, classes: list[dict]) -> dict:
    """Deterministic liquidation waterfall at a *known* exit equity value.

    This is the intrinsic (σ → 0, t → 0) limit of ``allocate_waterfall``: the
    same breakpoint segments, but each tranche is filled by the exit value
    that actually lands in it rather than by its Black-Scholes expectation.
    PWERM allocates each of its discrete exit scenarios with this, so PWERM
    and the OPM allocation agree on the underlying payoff structure. Value is
    conserved exactly: ``Σ class values == exit_value``.
    """
    _finite(exit_value, "exit_value")
    if exit_value < 0:
        raise EngineInputError("exit_value must be >= 0 for the waterfall allocation")
    normalized = _normalize(classes)
    segments = _segments(normalized)

    values: dict[str, float] = {c["name"]: 0.0 for c in normalized}
    breakpoints: list[dict] = []
    for seg in segments:
        lo = seg["from"]
        upper = exit_value if seg["to"] is None else min(exit_value, seg["to"])
        width = max(0.0, upper - lo)
        if width <= 0:
            continue
        for name, fraction in seg["participants"].items():
            values[name] += width * fraction
        breakpoints.append(
            {
                "from": round(lo, 2),
                "to": round(seg["to"], 2) if seg["to"] is not None else None,
                "participants": {k: round(v, 6) for k, v in seg["participants"].items()},
                "value": round(width, 2),
            }
        )

    by_class = {
        c["name"]: {
            "kind": c["kind"],
            "shares": c["shares"],
            "value": round(values[c["name"]], 2),
            "per_share": round(values[c["name"]] / c["shares"], 6),
        }
        for c in normalized
    }
    common_shares = sum(c["shares"] for c in normalized if c["kind"] == "common")
    common_value = sum(values[c["name"]] for c in normalized if c["kind"] == "common")
    return {
        "method": "deterministic_waterfall",
        "exit_value": round(exit_value, 2),
        "breakpoints": breakpoints,
        "classes": by_class,
        "common_value": round(common_value, 2),
        "common_shares": common_shares,
        "common_per_share": round(common_value / common_shares, 6) if common_shares > 0 else 0.0,
    }


def class_per_share(
    equity_value: float,
    classes: list[dict],
    class_name: str,
    t: float | None,
    r: float | None,
    sigma: float | None,
) -> float:
    """Model value per share of one class — the backsolve objective.

    Reads the allocation rather than ``allocate_waterfall``'s response, because
    the response rounds ``per_share`` to six decimals and this is what Newton
    differentiates. Rounding turns the objective into a step function, and both
    halves of the solver degrade on one:

    - The derivative is a central difference over ``h = |x|·1e-6``. On an equity
      of $2.5e7 that is a step of 25, which moves the per-share figure by
      ``50 / total_shares`` — so once a cap table runs to hundreds of millions
      of shares the whole difference is *smaller than the rounding quantum* and
      the derivative is reading quantization noise, not slope.
    - Convergence is tested on the step size, so the solver keeps stepping until
      the step is under ``1e-7·|x|``. It cannot get there against a function
      that is flat in stretches, so it burns its iteration budget.

    The error that leaves in the solved equity value is the quantum divided by
    the slope — ``1e-6 · total_shares`` — so it grows linearly with the share
    count while the reported ``solved_pps``, rounded the same way, still shows a
    clean hit on the target. Measured against the exact objective on the same
    inputs: 12M shares solved $5 apart in 8 Newton iterations against 2, 1.2B
    shares $353 apart in 24, and 120B shares $26,469 apart (0.12%) in 18.

    A 409A opinion is defensible to the cent, and this is the number the whole
    OPM hangs off — so the objective is exact and the rounding stays in
    ``allocate_waterfall``, where it only ever reaches a response body.
    """
    normalized, _, _, values = _allocate(equity_value, classes, t, r, sigma)
    for c in normalized:
        if c["name"] == class_name:
            return values[c["name"]] / c["shares"]
    raise EngineInputError(f"share class '{class_name}' not found in share_classes")
