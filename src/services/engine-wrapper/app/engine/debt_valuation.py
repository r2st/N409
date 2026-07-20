"""Debt / credit instrument fair value (feature: Debt Valuation Engine).

A new quantitative domain, separate from the equity approaches (OPM / income /
market / asset). None of the existing engine math transfers: debt is priced by
discounting contractual cash flows at a market yield (benchmark + credit
spread), with embedded-option instruments (convertibles, SAFEs) bridging back
to equity.

Contents:
  - cash-flow schedules (amortizing vs bullet term loans, coupon bonds);
  - yield-based DCF present value, clean/dirty price and accrued interest;
  - yield-to-maturity solve, Macaulay/modified duration and convexity;
  - credit-spread pricing and a rating → implied-spread map;
  - convertible notes via the Tsiveriotis-Fernandes coupled binomial tree
    (equity component discounted at the risk-free rate, cash/debt component at
    the risky rate);
  - SAFE / convertible-instrument conversion (valuation cap, discount, MFN).

Pure and deterministic. The FastAPI surface (main.py) wraps these; the
valuation service owns persistence and REST CRUD.
"""

from __future__ import annotations

import math

from .errors import EngineInputError
from .newton import newton_raphson

# Illustrative credit-rating → implied spread over the benchmark, in basis
# points (long-run investment-grade / high-yield averages). Configurable.
RATING_SPREADS_BPS: dict[str, float] = {
    "AAA": 43,
    "AA": 60,
    "A": 90,
    "BBB": 150,
    "BB": 300,
    "B": 500,
    "CCC": 900,
    "CC": 1200,
    "C": 1500,
    "D": 2500,
}


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


def rating_implied_spread(rating: str) -> float:
    """Implied credit spread (decimal, e.g. 0.015) for a letter rating."""
    key = str(rating or "").strip().upper()
    if key not in RATING_SPREADS_BPS:
        raise EngineInputError(f"unknown rating '{rating}'; known: {sorted(RATING_SPREADS_BPS)}")
    return RATING_SPREADS_BPS[key] / 10_000.0


# ── Cash-flow schedules ──────────────────────────────────────────────────────


def coupon_schedule(
    *,
    face: float,
    coupon_rate: float,
    frequency: int,
    maturity_years: float,
    amortizing: bool = False,
) -> list[dict]:
    """Contractual cash flows for a coupon instrument.

    ``bullet`` (default): coupons each period + full face at maturity.
    ``amortizing``: equal principal amortisation each period, coupon on the
    declining balance (a term-loan style schedule).
    """
    f = _num(face, "face", minimum=0.0)
    rate = _num(coupon_rate, "coupon_rate", minimum=0.0)
    m = int(frequency)
    if m <= 0:
        raise EngineInputError("frequency must be a positive integer")
    yrs = _num(maturity_years, "maturity_years", minimum=0.0)
    n_periods = max(1, round(yrs * m))
    period_rate = rate / m
    rows: list[dict] = []
    balance = f
    principal_per = f / n_periods if amortizing else 0.0
    for i in range(1, n_periods + 1):
        t = i / m
        interest = balance * period_rate
        principal = principal_per if amortizing else (f if i == n_periods else 0.0)
        balance = max(balance - principal, 0.0)
        rows.append(
            {
                "period": i,
                "t_years": round(t, 6),
                "interest": round(interest, 6),
                "principal": round(principal, 6),
                "amount": round(interest + principal, 6),
                "balance": round(balance, 6),
            }
        )
    return rows


# ── Present value / pricing ──────────────────────────────────────────────────


def present_value(cashflows: list[dict], annual_yield: float, *, frequency: int = 2) -> float:
    """PV of dated cash flows discounted at ``annual_yield`` (nominal, compounded
    ``frequency`` times a year)."""
    y = _num(annual_yield, "annual_yield")
    m = int(frequency)
    if m <= 0:
        raise EngineInputError("frequency must be a positive integer")
    per = y / m
    if per <= -1.0:
        raise EngineInputError("yield too negative to discount")
    pv = 0.0
    for cf in cashflows:
        amount = _num(cf.get("amount", 0.0), "cashflow.amount")
        t = _num(cf.get("t_years", 0.0), "cashflow.t_years", minimum=0.0)
        pv += amount / (1.0 + per) ** (m * t)
    return pv


def yield_dcf(
    *,
    face: float,
    coupon_rate: float,
    frequency: int,
    maturity_years: float,
    market_yield: float,
    amortizing: bool = False,
    settlement_fraction: float = 0.0,
) -> dict:
    """Yield-based DCF valuation of a bond / term loan.

    Returns the dirty price (PV of all future flows), the accrued interest, and
    the clean price (dirty − accrued). ``settlement_fraction`` is how far (0–1)
    settlement sits into the current coupon period; it shifts every cash-flow
    time earlier by that fraction of a period and accrues the running coupon.
    """
    m = int(frequency)
    schedule = coupon_schedule(
        face=face, coupon_rate=coupon_rate, frequency=frequency, maturity_years=maturity_years, amortizing=amortizing
    )
    frac = _num(settlement_fraction, "settlement_fraction", minimum=0.0)
    if frac >= 1.0:
        raise EngineInputError("settlement_fraction must be < 1")
    # Shift each flow earlier by frac/m years (settlement inside the period).
    shifted = [{"amount": r["amount"], "t_years": max(r["t_years"] - frac / m, 0.0)} for r in schedule]
    dirty = present_value(shifted, market_yield, frequency=m)
    first_interest = schedule[0]["interest"] if schedule else 0.0
    accrued = first_interest * frac
    return {
        "dirty_price": round(dirty, 6),
        "accrued_interest": round(accrued, 6),
        "clean_price": round(dirty - accrued, 6),
        "market_yield": round(_num(market_yield, "market_yield"), 6),
        "schedule": schedule,
    }


def yield_to_maturity(
    *,
    price: float,
    face: float,
    coupon_rate: float,
    frequency: int,
    maturity_years: float,
    amortizing: bool = False,
) -> float:
    """Solve the yield that reprices the instrument to ``price`` (dirty)."""
    target = _num(price, "price", minimum=0.0)
    m = int(frequency)
    schedule = coupon_schedule(
        face=face, coupon_rate=coupon_rate, frequency=frequency, maturity_years=maturity_years, amortizing=amortizing
    )
    flows = [{"amount": r["amount"], "t_years": r["t_years"]} for r in schedule]

    def f(y: float) -> float:
        return present_value(flows, y, frequency=m) - target

    ytm, _ = newton_raphson(f, max(coupon_rate, 0.01), min_x=-0.99, max_x=5.0)
    return ytm


def duration_convexity(
    *,
    face: float,
    coupon_rate: float,
    frequency: int,
    maturity_years: float,
    market_yield: float,
    amortizing: bool = False,
) -> dict:
    """Macaulay / modified duration and convexity.

    Macaulay is analytic (PV-time-weighted); modified duration and convexity are
    computed by a central-difference reprice, which is exact for these smooth
    price/yield functions and avoids per-schedule formula errors.
    """
    m = int(frequency)
    schedule = coupon_schedule(
        face=face, coupon_rate=coupon_rate, frequency=frequency, maturity_years=maturity_years, amortizing=amortizing
    )
    flows = [{"amount": r["amount"], "t_years": r["t_years"]} for r in schedule]
    price = present_value(flows, market_yield, frequency=m)
    if price <= 0:
        raise EngineInputError("non-positive price; cannot compute duration")
    y = _num(market_yield, "market_yield")
    per = y / m
    weighted = 0.0
    for cf in flows:
        pv = cf["amount"] / (1.0 + per) ** (m * cf["t_years"])
        weighted += cf["t_years"] * pv
    macaulay = weighted / price

    dy = 1e-4
    p_up = present_value(flows, y + dy, frequency=m)
    p_dn = present_value(flows, y - dy, frequency=m)
    modified = -(p_up - p_dn) / (2.0 * price * dy)
    convexity = (p_up + p_dn - 2.0 * price) / (price * dy * dy)
    return {
        "price": round(price, 6),
        "macaulay_duration": round(macaulay, 6),
        "modified_duration": round(modified, 6),
        "convexity": round(convexity, 6),
    }


def credit_spread_valuation(
    *,
    face: float,
    coupon_rate: float,
    frequency: int,
    maturity_years: float,
    benchmark_yield: float,
    spread: float | None = None,
    rating: str | None = None,
    amortizing: bool = False,
) -> dict:
    """Price by discounting contractual flows at ``benchmark_yield + spread``.

    The spread is taken directly, or mapped from a letter ``rating``.
    """
    if spread is None:
        if rating is None:
            raise EngineInputError("provide either spread or rating")
        spread = rating_implied_spread(rating)
    bench = _num(benchmark_yield, "benchmark_yield")
    s = _num(spread, "spread")
    all_in = bench + s
    valued = yield_dcf(
        face=face,
        coupon_rate=coupon_rate,
        frequency=frequency,
        maturity_years=maturity_years,
        market_yield=all_in,
        amortizing=amortizing,
    )
    return {
        "benchmark_yield": round(bench, 6),
        "credit_spread": round(s, 6),
        "all_in_yield": round(all_in, 6),
        "fair_value": valued["dirty_price"],
        "clean_price": valued["clean_price"],
        "accrued_interest": valued["accrued_interest"],
    }


def term_loan_fair_value(
    *,
    principal: float,
    coupon_rate: float,
    frequency: int,
    maturity_years: float,
    market_yield: float,
    amortizing: bool = True,
) -> dict:
    """Fair value of a term loan (amortizing by default, or bullet)."""
    valued = yield_dcf(
        face=principal,
        coupon_rate=coupon_rate,
        frequency=frequency,
        maturity_years=maturity_years,
        market_yield=market_yield,
        amortizing=amortizing,
    )
    return {
        "fair_value": valued["dirty_price"],
        "structure": "amortizing" if amortizing else "bullet",
        "market_yield": valued["market_yield"],
        "schedule": valued["schedule"],
        "premium_discount_to_par": round(valued["dirty_price"] - _num(principal, "principal"), 6),
    }


# ── Convertible note (Tsiveriotis-Fernandes) ─────────────────────────────────


def convertible_note(
    *,
    face: float,
    coupon_rate: float,
    frequency: int,
    maturity_years: float,
    conversion_ratio: float,
    stock_price: float,
    volatility: float,
    risk_free_rate: float,
    credit_spread: float,
    dividend_yield: float = 0.0,
    steps: int = 200,
) -> dict:
    """Convertible-note fair value via the Tsiveriotis-Fernandes coupled tree.

    Two values roll back on a CRR stock tree: the total convertible ``U`` and
    the cash-only (debt) component ``B``. The equity part (U − B) discounts at
    the risk-free rate, the debt part at the risky rate r + credit_spread — so
    the model prices default risk on the bond floor while treating conversion
    upside as equity. Returns the total value and its straight-debt / option
    decomposition.
    """
    f = _num(face, "face", minimum=0.0)
    kappa = _num(conversion_ratio, "conversion_ratio", minimum=0.0)
    s0 = _num(stock_price, "stock_price", minimum=0.0)
    sigma = _num(volatility, "volatility", minimum=0.0)
    r = _num(risk_free_rate, "risk_free_rate")
    cs = _num(credit_spread, "credit_spread", minimum=0.0)
    q = _num(dividend_yield, "dividend_yield", minimum=0.0)
    t = _num(maturity_years, "maturity_years", minimum=0.0)
    m = int(frequency)
    n = max(10, min(int(steps), 2000))
    if t <= 0 or sigma <= 0 or s0 <= 0:
        # Degenerate: worth the greater of conversion or redemption today.
        conv = kappa * s0
        return {
            "fair_value": round(max(conv, f), 6),
            "straight_debt_value": round(f, 6),
            "option_value": round(max(conv - f, 0.0), 6),
            "parity": round(conv, 6),
        }

    dt = t / n
    u = math.exp(sigma * math.sqrt(dt))
    d = 1.0 / u
    disc_rf = math.exp(-r * dt)
    disc_risky = math.exp(-(r + cs) * dt)
    p = (math.exp((r - q) * dt) - d) / (u - d)
    p = min(max(p, 0.0), 1.0)
    coupon_per_period = f * _num(coupon_rate, "coupon_rate", minimum=0.0) / m
    # A coupon lands on steps whose time crosses a payment boundary.
    steps_per_coupon = n / (t * m) if t * m > 0 else n

    prices = [s0 * u**j * d ** (n - j) for j in range(n + 1)]
    redeem = f + coupon_per_period
    U = [max(kappa * s, redeem) for s in prices]
    B = [0.0 if kappa * s >= redeem else redeem for s in prices]

    def is_coupon_step(i: int) -> bool:
        # True if a coupon boundary falls in (i, i+1].
        return math.floor((i + 1) / steps_per_coupon) > math.floor(i / steps_per_coupon)

    for i in range(n - 1, -1, -1):
        newU = [0.0] * (i + 1)
        newB = [0.0] * (i + 1)
        add_coupon = coupon_per_period if is_coupon_step(i) else 0.0
        for j in range(i + 1):
            s = s0 * u**j * d ** (i - j)
            eB = p * B[j + 1] + (1 - p) * B[j]
            # Debt part discounts at the risky rate; equity part (U−B) at rf.
            b_cont = disc_risky * eB + add_coupon
            equity_part = disc_rf * (p * (U[j + 1] - B[j + 1]) + (1 - p) * (U[j] - B[j]))
            u_cont = equity_part + b_cont
            conv = kappa * s
            if conv >= u_cont:  # holder converts → pure equity, no residual debt
                newU[j] = conv
                newB[j] = 0.0
            else:
                newU[j] = u_cont
                newB[j] = b_cont
        U, B = newU, newB

    value = U[0]
    straight_debt = B[0]
    return {
        "fair_value": round(value, 6),
        "straight_debt_value": round(straight_debt, 6),
        "option_value": round(value - straight_debt, 6),
        "parity": round(kappa * s0, 6),
    }


# ── SAFE / convertible instrument ────────────────────────────────────────────


def safe_conversion(
    *,
    investment: float,
    valuation_cap: float | None,
    discount: float,
    next_round_pre_money: float,
    next_round_shares: float,
    mfn_discount: float | None = None,
    mfn_cap: float | None = None,
) -> dict:
    """Value a SAFE / convertible instrument at the next priced round.

    Conversion price = min(cap-implied price, (1 − discount)×round price). The
    MFN provision adopts a more-favourable later discount/cap when supplied.
    Returns the conversion price, shares received, ownership and the mark value
    (shares × round price).
    """
    inv = _num(investment, "investment", minimum=0.0)
    disc = _num(discount, "discount", minimum=0.0)
    if disc >= 1.0:
        raise EngineInputError("discount must be < 1")
    pre = _num(next_round_pre_money, "next_round_pre_money", minimum=0.0)
    shares = _num(next_round_shares, "next_round_shares", minimum=1.0)
    round_price = pre / shares
    if round_price <= 0:
        raise EngineInputError("next round price per share must be positive")

    # MFN: take the most favourable (largest discount, lowest cap).
    eff_discount = max(disc, _num(mfn_discount, "mfn_discount")) if mfn_discount is not None else disc
    cap = valuation_cap
    if mfn_cap is not None:
        cap = mfn_cap if cap is None else min(cap, _num(mfn_cap, "mfn_cap"))

    discount_price = round_price * (1.0 - eff_discount)
    cap_price = None
    if cap is not None:
        cap_price = _num(cap, "valuation_cap", minimum=0.0) / shares
    conversion_price = discount_price if cap_price is None else min(discount_price, cap_price)
    if conversion_price <= 0:
        raise EngineInputError("conversion price resolved to zero")

    safe_shares = inv / conversion_price
    total_shares_post = shares + safe_shares
    return {
        "round_price_per_share": round(round_price, 6),
        "discount_price": round(discount_price, 6),
        "cap_price": round(cap_price, 6) if cap_price is not None else None,
        "conversion_price": round(conversion_price, 6),
        "shares_received": round(safe_shares, 6),
        "ownership_pct": round(safe_shares / total_shares_post, 6),
        "converted_via": "cap" if cap_price is not None and cap_price < discount_price else "discount",
        "fair_value": round(safe_shares * round_price, 6),
        "moic": round((safe_shares * round_price) / inv, 4) if inv > 0 else None,
    }


# ── Dispatcher ───────────────────────────────────────────────────────────────


def value_instrument(instrument_type: str, params: dict) -> dict:
    """Route a debt instrument to its valuation function."""
    if not isinstance(params, dict):
        raise EngineInputError("params must be an object")
    it = str(instrument_type or "").strip()
    if it == "bond":
        base = yield_dcf(**params)
        dur = duration_convexity(
            face=params["face"],
            coupon_rate=params["coupon_rate"],
            frequency=params["frequency"],
            maturity_years=params["maturity_years"],
            market_yield=params["market_yield"],
            amortizing=params.get("amortizing", False),
        )
        return {**base, **{k: dur[k] for k in ("macaulay_duration", "modified_duration", "convexity")}}
    if it == "term_loan":
        return term_loan_fair_value(**params)
    if it == "credit_spread":
        return credit_spread_valuation(**params)
    if it == "convertible":
        return convertible_note(**params)
    if it == "safe":
        return safe_conversion(**params)
    raise EngineInputError(
        f"unknown instrument_type '{instrument_type}'; expected bond, term_loan, credit_spread, convertible or safe"
    )
