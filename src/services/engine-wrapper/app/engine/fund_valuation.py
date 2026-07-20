"""Fund / LP portfolio valuation under ASC 820 (feature: ASC 820 Fund Holdings).

This is distinct from the corporate parent/subsidiary consolidation in the
valuation service (``domain/portfolio.ts``). Here the subject is an *investment
fund* (VC / PE / credit) marking a portfolio of equity positions to fair value:

- **Position-level marks** — each holding is fair-valued by its own method and
  classified in the ASC 820 fair-value hierarchy (Level 1 / 2 / 3).
- **Calibration to the last round** — a Level 3 holding's model is calibrated so
  it reproduces the price of the most recent financing (backsolve of the OPM
  implied volatility), the standard ASC 820 / AICPA PE-VC guide technique.
- **Roll-forward** — a prior mark is carried to a new measurement date by a
  calibrated re-mark or a public-market-equivalent index movement.
- **NAV** — Σ position fair values − fund liabilities.
- **LP waterfall** — return of capital, preferred return, GP catch-up, carried
  interest, and an end-of-life clawback test.

Pure and deterministic: no I/O, no clock. The FastAPI surface (main.py) wraps
these functions; the valuation service owns persistence and the REST CRUD.
"""

from __future__ import annotations

import math

from .bs import bs_call
from .errors import EngineInputError
from .newton import implied_volatility

# ASC 820 fair-value hierarchy levels.
LEVEL_1 = 1  # quoted prices in active markets for identical assets
LEVEL_2 = 2  # observable inputs other than quoted prices (recent round, comps)
LEVEL_3 = 3  # unobservable inputs (model / calibration)

_MARK_METHODS = ("market", "last_round", "calibrated_opm", "cost")


def _num(value, name: str, *, minimum: float | None = None) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise EngineInputError(f"{name} must be a number") from exc
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be finite")
    if minimum is not None and out < minimum:
        raise EngineInputError(f"{name} must be >= {minimum}")
    return out


def classify_level(method: str, *, has_quote: bool = False) -> int:
    """Map a marking method to its ASC 820 fair-value hierarchy level."""
    if method == "market" or has_quote:
        return LEVEL_1
    if method == "last_round":
        return LEVEL_2
    # cost and calibrated model marks are unobservable → Level 3.
    return LEVEL_3


def calibrate_implied_volatility(
    *,
    round_price_per_share: float,
    total_equity_value: float,
    strike: float,
    time_to_exit_years: float,
    risk_free_rate: float,
    preferred_shares: float,
    fully_diluted_shares: float,
) -> dict:
    """Backsolve the OPM implied volatility that reproduces the last round.

    A single-breakpoint OPM: the financing security behaves like a call on the
    equity struck at ``strike`` (its liquidation preference / conversion point).
    We solve for the volatility at which the per-share option value equals the
    price paid in the round — the calibration that anchors a Level 3 mark to the
    only observable transaction, per the AICPA PE/VC valuation guide.
    """
    s = _num(total_equity_value, "total_equity_value", minimum=0.0)
    k = _num(strike, "strike", minimum=0.0)
    t = _num(time_to_exit_years, "time_to_exit_years", minimum=0.0)
    r = _num(risk_free_rate, "risk_free_rate")
    fd = _num(fully_diluted_shares, "fully_diluted_shares", minimum=1.0)
    price = _num(round_price_per_share, "round_price_per_share", minimum=0.0)
    if t <= 0:
        raise EngineInputError("time_to_exit_years must be positive")
    # Target total value of the round security = price × preferred shares.
    target_class_value = price * _num(preferred_shares, "preferred_shares", minimum=0.0)
    # Per-share option value the OPM must reproduce, scaled to the whole equity
    # call (single breakpoint) → back out via the class's fully-diluted share.
    # Solve bs_call(S, K, t, r, sigma) * (preferred/fd) == target_class_value.
    frac = _num(preferred_shares, "preferred_shares", minimum=0.0) / fd
    if frac <= 0:
        raise EngineInputError("preferred_shares must be positive for calibration")
    # The class owns fraction ``frac`` of the residual equity above the senior
    # preference K, valued as a call on the equity: class_value = frac·call.
    target_call = target_class_value / frac
    intrinsic = max(s - k * math.exp(-r * t), 0.0)
    if not intrinsic <= target_call < s:
        raise EngineInputError(
            "round price implies a residual-claim value outside the no-arbitrage "
            f"range; per-share price must sit between {intrinsic * frac / max(preferred_shares, 1):.4f} "
            f"and the pro-rata share {s / fd:.4f}"
        )
    sigma = implied_volatility(target_call, s, k, t, r)
    return {
        "implied_volatility": round(sigma, 6),
        "calibrated_equity_call": round(bs_call(s, k, t, r, sigma), 4),
        "target_class_value": round(target_class_value, 4),
    }


def roll_forward_mark(
    *,
    prior_fair_value: float,
    method: str = "index",
    index_return: float | None = None,
    accretion_rate: float | None = None,
    periods: float = 1.0,
    new_calibrated_value: float | None = None,
) -> dict:
    """Roll a prior mark to a new measurement date.

    - ``index``: apply a public-market-equivalent total return.
    - ``accretion``: compound a flat accretion rate over ``periods``.
    - ``calibration``: adopt a fresh calibrated value (e.g. a new round).
    """
    pv = _num(prior_fair_value, "prior_fair_value", minimum=0.0)
    if method == "calibration":
        if new_calibrated_value is None:
            raise EngineInputError("calibration roll-forward needs new_calibrated_value")
        new_value = _num(new_calibrated_value, "new_calibrated_value", minimum=0.0)
    elif method == "accretion":
        rate = _num(accretion_rate if accretion_rate is not None else 0.0, "accretion_rate")
        new_value = pv * (1.0 + rate) ** _num(periods, "periods", minimum=0.0)
    else:  # index
        ret = _num(index_return if index_return is not None else 0.0, "index_return")
        new_value = pv * (1.0 + ret)
    return {
        "prior_fair_value": round(pv, 4),
        "new_fair_value": round(max(new_value, 0.0), 4),
        "change": round(new_value - pv, 4),
        "method": method,
    }


def mark_position(position: dict) -> dict:
    """Fair-value one portfolio position and assign its ASC 820 level.

    Recognised ``method`` values:
      - ``market``     : quantity × quoted_price          (Level 1)
      - ``last_round`` : quantity × round_price_per_share  (Level 2)
      - ``calibrated_opm`` : provided ``model_value`` from a calibrated OPM (Level 3)
      - ``cost``       : original cost                     (Level 3)
    """
    if not isinstance(position, dict):
        raise EngineInputError("each position must be an object")
    name = str(position.get("name") or "").strip()
    if not name:
        raise EngineInputError("position.name is required")
    method = str(position.get("method") or "cost")
    if method not in _MARK_METHODS:
        raise EngineInputError(f"position '{name}': method must be one of {_MARK_METHODS}")
    quantity = _num(position.get("quantity", 0.0), f"{name}.quantity", minimum=0.0)
    cost_basis = _num(position.get("cost_basis", 0.0), f"{name}.cost_basis", minimum=0.0)

    if method == "market":
        price = _num(position.get("quoted_price", 0.0), f"{name}.quoted_price", minimum=0.0)
        fair_value = quantity * price
    elif method == "last_round":
        price = _num(position.get("round_price_per_share", 0.0), f"{name}.round_price_per_share", minimum=0.0)
        fair_value = quantity * price
    elif method == "calibrated_opm":
        fair_value = _num(position.get("model_value", 0.0), f"{name}.model_value", minimum=0.0)
    else:  # cost
        fair_value = cost_basis

    level = classify_level(method, has_quote=bool(position.get("quoted_price")))
    return {
        "name": name,
        "method": method,
        "level": level,
        "quantity": round(quantity, 6),
        "cost_basis": round(cost_basis, 4),
        "fair_value": round(fair_value, 4),
        "unrealized_gain": round(fair_value - cost_basis, 4),
    }


def compute_nav(positions: list[dict], liabilities: float = 0.0) -> dict:
    """Mark every position and roll them up into fund NAV.

    NAV = Σ position fair values − fund liabilities. Also returns the ASC 820
    level breakdown (the fair-value hierarchy disclosure table).
    """
    if not isinstance(positions, list) or not positions:
        raise EngineInputError("positions must be a non-empty list")
    marks = [mark_position(p) for p in positions]
    gross = sum(m["fair_value"] for m in marks)
    cost = sum(m["cost_basis"] for m in marks)
    liab = _num(liabilities, "liabilities", minimum=0.0)
    by_level = {LEVEL_1: 0.0, LEVEL_2: 0.0, LEVEL_3: 0.0}
    for m in marks:
        by_level[m["level"]] += m["fair_value"]
    return {
        "positions": marks,
        "gross_asset_value": round(gross, 4),
        "total_cost_basis": round(cost, 4),
        "total_unrealized_gain": round(gross - cost, 4),
        "liabilities": round(liab, 4),
        "net_asset_value": round(gross - liab, 4),
        "level_breakdown": {
            "level_1": round(by_level[LEVEL_1], 4),
            "level_2": round(by_level[LEVEL_2], 4),
            "level_3": round(by_level[LEVEL_3], 4),
        },
    }


def lp_waterfall(
    *,
    committed_capital: float,
    contributed_capital: float,
    distributable: float,
    preferred_return_rate: float = 0.08,
    years: float = 1.0,
    carry_pct: float = 0.20,
    gp_catch_up: bool = True,
    management_fees_paid: float = 0.0,
    gp_distributions_to_date: float = 0.0,
) -> dict:
    """Distribution waterfall for a whole-fund (European) LP structure.

    Tiers, in order:
      1. **Return of capital** — LPs recover contributed capital (incl. fees).
      2. **Preferred return** — LPs earn a compounded hurdle on contributed
         capital before the GP shares in profit.
      3. **GP catch-up** — the GP receives 100% until it holds ``carry_pct`` of
         the profit distributed above return of capital (if ``gp_catch_up``).
      4. **Carried interest** — the residual splits ``carry_pct`` GP / rest LP.

    Also runs an end-of-life **clawback** test: if the GP's cumulative carry
    exceeds ``carry_pct`` of total profit, the excess is owed back to the LPs.
    """
    committed = _num(committed_capital, "committed_capital", minimum=0.0)
    contributed = _num(contributed_capital, "contributed_capital", minimum=0.0)
    available = _num(distributable, "distributable", minimum=0.0)
    pref_rate = _num(preferred_return_rate, "preferred_return_rate", minimum=0.0)
    yrs = _num(years, "years", minimum=0.0)
    carry = _num(carry_pct, "carry_pct", minimum=0.0)
    if carry >= 1.0:
        raise EngineInputError("carry_pct must be < 1")
    fees = _num(management_fees_paid, "management_fees_paid", minimum=0.0)

    lp = 0.0
    gp = 0.0
    remaining = available

    # Tier 1 — return of capital (contributed capital including fees paid).
    roc_target = contributed + fees
    roc = min(remaining, roc_target)
    lp += roc
    remaining -= roc

    # Tier 2 — preferred return (compounded hurdle on contributed capital).
    pref_target = contributed * ((1.0 + pref_rate) ** yrs - 1.0)
    pref = min(remaining, pref_target)
    lp += pref
    remaining -= pref

    # Tier 3 — GP catch-up to carry_pct of profit above return of capital.
    catch_up = 0.0
    if gp_catch_up and carry > 0 and remaining > 0:
        # GP should end with carry_pct of (pref + catch_up + ...): solve so that
        # after catch-up, gp / (pref + catch_up) == carry.
        target = carry / (1.0 - carry) * pref
        catch_up = min(remaining, target)
        gp += catch_up
        remaining -= catch_up

    # Tier 4 — carried interest split of the residual.
    carry_gp = remaining * carry
    carry_lp = remaining - carry_gp
    gp += carry_gp
    lp += carry_lp
    remaining = 0.0

    total_profit = max(available - roc_target, 0.0)
    gp_total = gp + _num(gp_distributions_to_date, "gp_distributions_to_date", minimum=0.0)
    entitled = carry * total_profit
    # Clawback: the GP owes back any cumulative carry above its entitled share
    # of total profit (the end-of-life true-up LPACs require).
    clawback = round(max(gp_total - entitled, 0.0), 4)

    return {
        "distributable": round(available, 4),
        "lp_distribution": round(lp, 4),
        "gp_distribution": round(gp, 4),
        "tiers": {
            "return_of_capital": round(roc, 4),
            "preferred_return": round(pref, 4),
            "gp_catch_up": round(catch_up, 4),
            "carried_interest_gp": round(carry_gp, 4),
            "carried_interest_lp": round(carry_lp, 4),
        },
        "total_profit": round(total_profit, 4),
        "gp_carry_entitled": round(entitled, 4),
        "clawback_owed": clawback,
        "dpi": round(lp / contributed, 4) if contributed > 0 else None,
        "committed_capital": round(committed, 4),
    }


def fund_valuation(payload: dict) -> dict:
    """Full fund pass: NAV from marked positions, plus an optional LP waterfall.

    ``payload`` keys: ``positions`` (list), ``liabilities`` (float), and an
    optional ``lp_terms`` block with ``distributable`` to run the waterfall.
    """
    if not isinstance(payload, dict):
        raise EngineInputError("payload must be an object")
    nav = compute_nav(payload.get("positions", []), payload.get("liabilities", 0.0))
    result: dict = {"nav": nav}
    lp_terms = payload.get("lp_terms")
    if isinstance(lp_terms, dict) and lp_terms.get("distributable") is not None:
        result["waterfall"] = lp_waterfall(
            committed_capital=lp_terms.get("committed_capital", 0.0),
            contributed_capital=lp_terms.get("contributed_capital", 0.0),
            distributable=lp_terms.get("distributable", 0.0),
            preferred_return_rate=lp_terms.get("preferred_return_rate", 0.08),
            years=lp_terms.get("years", 1.0),
            carry_pct=lp_terms.get("carry_pct", 0.20),
            gp_catch_up=bool(lp_terms.get("gp_catch_up", True)),
            management_fees_paid=lp_terms.get("management_fees_paid", 0.0),
            gp_distributions_to_date=lp_terms.get("gp_distributions_to_date", 0.0),
        )
    return result
