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

Simplifications (documented): participating preferred has no participation
cap; options are pools with a single strike each and their exercise proceeds
are captured by the slope algebra rather than modeled as a cash inflow.
"""

from __future__ import annotations

import math

from .bs import bs_call
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
            cls.update(
                preference=pref,
                seniority=seniority,
                participating=bool(raw.get("participating", False)),
                conversion_ratio=ratio,
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
    p_cur = sum(c["preference"] for c in preferred)  # preferences still being taken
    b_cur = cursor  # == total preferences

    while True:
        s_cur = sum(pool.values())
        candidates: list[tuple[float, str, dict]] = []
        for c in pending_conversions:
            s_conv = c["shares"] * c["conversion_ratio"]
            x_star = (p_cur - c["preference"]) + c["preference"] * (s_cur + s_conv) / s_conv
            candidates.append((max(x_star, b_cur), "convert", c))
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
        if action == "convert":
            pool[cls["name"]] = cls["shares"] * cls["conversion_ratio"]
            p_cur -= cls["preference"]
            pending_conversions.remove(cls)
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
