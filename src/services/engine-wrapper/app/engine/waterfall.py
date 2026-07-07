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

from .bs import bs_call
from .errors import EngineInputError

_KINDS = ("preferred", "common", "option")


def _normalize(classes: list[dict]) -> list[dict]:
    if not isinstance(classes, list) or not classes:
        raise EngineInputError("share_classes must be a non-empty list")
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
        if shares <= 0:
            raise EngineInputError(f"share_classes[{i}].shares must be positive")
        cls = {"name": name, "kind": kind, "shares": shares}
        if kind == "preferred":
            try:
                pref = float(raw.get("preference"))
            except (TypeError, ValueError):
                raise EngineInputError(f"'{name}': preference (total) is required for preferred") from None
            if pref < 0:
                raise EngineInputError(f"'{name}': preference must be >= 0")
            seniority = raw.get("seniority", 1)
            if not isinstance(seniority, int) or isinstance(seniority, bool) or seniority < 1:
                raise EngineInputError(f"'{name}': seniority must be an integer >= 1")
            ratio = float(raw.get("conversion_ratio", 1.0) or 1.0)
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


def allocate_waterfall(
    equity_value: float,
    classes: list[dict],
    t: float,
    r: float,
    sigma: float,
) -> dict:
    if equity_value <= 0:
        raise EngineInputError("equity_value must be positive for the waterfall allocation")
    if sigma is None or sigma <= 0:
        raise EngineInputError("volatility is required for the waterfall allocation")
    normalized = _normalize(classes)
    segments = _segments(normalized)

    values: dict[str, float] = {c["name"]: 0.0 for c in normalized}
    breakpoints: list[dict] = []
    for seg in segments:
        c_from = bs_call(equity_value, seg["from"], t, r, sigma)
        c_to = bs_call(equity_value, seg["to"], t, r, sigma) if seg["to"] is not None else 0.0
        tranche = c_from - c_to
        for name, fraction in seg["participants"].items():
            values[name] += tranche * fraction
        breakpoints.append(
            {
                "from": round(seg["from"], 2),
                "to": round(seg["to"], 2) if seg["to"] is not None else None,
                "participants": {k: round(v, 6) for k, v in seg["participants"].items()},
                "value": round(tranche, 2),
            }
        )

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


def class_per_share(
    equity_value: float,
    classes: list[dict],
    class_name: str,
    t: float,
    r: float,
    sigma: float,
) -> float:
    """Model value per share of one class — the backsolve objective."""
    result = allocate_waterfall(equity_value, classes, t, r, sigma)
    cls = result["classes"].get(class_name)
    if cls is None:
        raise EngineInputError(f"share class '{class_name}' not found in share_classes")
    return cls["per_share"]
