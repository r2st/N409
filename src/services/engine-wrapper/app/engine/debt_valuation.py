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
from .kwargs_refusal import describe_unbindable
from .display_text import quote_for_message
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


# The period count every schedule below is built from is `maturity_years ×
# frequency`, and neither factor was bounded. `frequency=100000,
# maturity_years=50` is about 150 bytes of JSON and asks for five million
# cash-flow rows — measured at six seconds and some gigabytes of dicts, and it
# scales linearly from there until the process dies. The work is synchronous in
# a threadpool slot, so nothing interrupts it.
#
# Both ceilings are set past anything that trades. A coupon is paid at most
# daily, and the longest instruments ever issued are century bonds; a
# hundred-year daily-pay note is 36,600 periods, which builds in milliseconds.
MAX_FREQUENCY = 366
MAX_MATURITY_YEARS = 100.0

# Binomial-tree resolution for `convertible_note`. The rollback is O(steps²) in
# pure Python, so the ceiling bounds one request's synchronous work; the floor
# keeps a coarse tree from pricing the note as a two-state coin flip.
MIN_TREE_STEPS = 10
MAX_TREE_STEPS = 2000

# `math.log(sys.float_info.max)` is 709.78: the largest exponent a double can
# carry. `convertible_note` checks its lattice against this before building it,
# rather than discovering the ceiling as an OverflowError partway through.
MAX_LATTICE_LOG = 709.0


def _int(value, name: str) -> int:
    """`int(value)`, with every way it can fail turned into an EngineInputError.

    `params` on `/engine/v1/debt-valuation` is a free-form dict splatted into
    these functions, so anything JSON can carry reaches a bare `int()`. Three of
    its failure modes are not the `(KeyError, TypeError)` the route maps to 422:

      * `int("abc")` raises ValueError;
      * `int(float("nan"))` raises ValueError;
      * `int(float("inf"))` raises OverflowError — and `json.loads("1e400")` is
        `inf`, so a five-character number in the body reaches it.

    None of them is an EngineInputError either, so each one answered a bad input
    with an opaque 500 and a logged traceback instead of the 422 that names the
    field the caller has to fix.
    """
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise EngineInputError(f"{name} must be an integer") from exc


def _frequency(value, name: str = "frequency") -> int:
    """Coupon periods per year — a positive integer, no finer than daily."""
    m = _int(value, name)
    if m <= 0:
        raise EngineInputError(f"{name} must be a positive integer")
    if m > MAX_FREQUENCY:
        raise EngineInputError(f"{name} must be <= {MAX_FREQUENCY} (daily is the finest coupon period)")
    return m


def rating_implied_spread(rating: str) -> float:
    """Implied credit spread (decimal, e.g. 0.015) for a letter rating."""
    key = str(rating or "").strip().upper()
    if key not in RATING_SPREADS_BPS:
        raise EngineInputError(
            f"unknown rating '{quote_for_message(str(rating))}'; "
            f"known: {sorted(RATING_SPREADS_BPS)}"
        )
    return RATING_SPREADS_BPS[key] / 10_000.0


# ── Cash-flow schedules ──────────────────────────────────────────────────────


#: Slack on the period count so a maturity that *is* grid-aligned is not pushed
#: onto an extra period by the last bit of `yrs * m`. Well below any real
#: coupon interval and well above float noise at these magnitudes.
_PERIOD_EPS = 1e-9


def schedule_periods(maturity_years: float, frequency: int) -> tuple[int, float]:
    """How many coupon periods remain, and how far the grid is shifted.

    A coupon schedule is dated backwards from maturity — the final flow lands on
    the maturity date and the others step back one period at a time, so a note
    with a non-whole number of periods left carries a *short first period* and
    every later date is exact. That is how the instrument is written and it is
    the convention the rest of this module already assumes: ``settlement_fraction``
    and ``accrued_interest`` exist precisely because settlement sits inside a
    period, and the full coupon is still paid on the date.

    It used to be dated forwards from today onto a whole-period grid —
    ``n = max(1, round(yrs * m))`` and ``t = i / m`` — which is only the same
    schedule when the maturity happens to land on that grid. Off it, three
    things went wrong at once and all silently:

      * ``round`` is half-to-even, so ``4.25`` years semiannual took
        ``round(8.5) = 8`` periods and ``4.75`` took ``round(9.5) = 10``. Two
        notes a quarter-year either side of the same midpoint were priced a
        whole year apart — 868.08 against 841.75 on a 5% note at a 9% yield,
        a 3.0% gap standing in for six months of maturity.
      * the redemption moved off the maturity date. A note maturing 2027-06-30
        valued at 2026-08-30 is 1.83 years; its flows were dated 0.5, 1.0, 1.5
        and 2.0, redeeming two months after the note is actually repaid.
      * a maturity inside the first period was floored to a whole one by the
        ``max(1, ...)``. An instrument at or past maturity was priced as a
        half-year note paying a full coupon: 980.86 for a bond that is worth its
        redemption today.

    Returns the period count and the shift to add to each grid date. The shift is
    exactly ``0.0`` — and every date bit-identical to the old ones — whenever the
    maturity is a whole number of periods, which is what a schedule built from a
    tenor rather than from two dates always is.
    """
    m = _frequency(frequency)
    yrs = _num(maturity_years, "maturity_years", minimum=0.0, maximum=MAX_MATURITY_YEARS)
    # Ceil, not round: a note with 8.5 periods left has nine payments due, and
    # the ninth is the redemption. Rounding chose between eight and ten.
    n_periods = max(1, math.ceil(yrs * m - _PERIOD_EPS))
    # `i / m + offset` rather than `yrs - (n - i) / m`: the two are equal in
    # exact arithmetic, and only the first is bit-identical to `i / m` on the
    # aligned case, because `offset` is then exactly zero rather than a
    # difference of two nearby doubles.
    return n_periods, yrs - n_periods / m


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

    Dated backwards from maturity — see `schedule_periods`.
    """
    f = _num(face, "face", minimum=0.0)
    rate = _num(coupon_rate, "coupon_rate", minimum=0.0)
    m = _frequency(frequency)
    n_periods, offset = schedule_periods(maturity_years, m)
    period_rate = rate / m
    rows: list[dict] = []
    balance = f
    principal_per = f / n_periods if amortizing else 0.0
    for i in range(1, n_periods + 1):
        # Never negative: `n_periods` is at most one period past `yrs * m`, so
        # the first date is in (0, 1/m] — and exactly 0 only for a matured
        # instrument, whose single flow is its redemption today.
        t = max(i / m + offset, 0.0)
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
    m = _frequency(frequency)
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
    m = _frequency(frequency)
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
    m = _frequency(frequency)
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
    m = _frequency(frequency)
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
    t = _num(maturity_years, "maturity_years", minimum=0.0, maximum=MAX_MATURITY_YEARS)
    m = _frequency(frequency)
    n = max(MIN_TREE_STEPS, min(_int(steps, "steps"), MAX_TREE_STEPS))
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
    # The tree's top node is `s0·u^n` with u = e^{σ√dt}, so its height in logs
    # is ln s0 + σ√(t·n), and the payoff standing there is `κ` times it. Each
    # factor is separately reasonable — a 3-year note, a 2000-step tree, and a
    # volatility the engine deliberately does not cap (the band is a warning,
    # not a limit, so a startup's 150% is as legitimate as a mistyped 10,000%)
    # — but their combination leaves the doubles. `u**j` *raises* OverflowError
    # rather than saturating to inf, so a volatility of 100 on an otherwise
    # ordinary convertible took /engine/v1/debt-valuation down as a 500 that
    # named nothing. Checked in logs, before anything is exponentiated, because
    # the check itself must not be the thing that overflows.
    lattice_log_height = math.log(s0) + sigma * math.sqrt(t * n)
    if kappa > 0:
        lattice_log_height += math.log(kappa)
    if lattice_log_height > MAX_LATTICE_LOG:
        raise EngineInputError(
            "the binomial tree's price range overflows a double — reduce volatility, "
            "maturity_years, steps, stock_price or conversion_ratio "
            f"(ln of the tree's highest payoff is {lattice_log_height:.0f}, "
            f"and {MAX_LATTICE_LOG:.0f} is the most a double can carry)"
        )
    u = math.exp(sigma * math.sqrt(dt))
    d = 1.0 / u
    disc_rf = math.exp(-r * dt)
    disc_risky = math.exp(-(r + cs) * dt)
    # The CRR no-arbitrage condition, checked rather than clamped.
    #
    # The risk-neutral probability is only a probability while the drift over a
    # step sits strictly inside the lattice's own move range, `d < e^{(r−q)dt} <
    # u`, which is `|r − q|·dt < σ·√dt`. Outside it `p` leaves [0, 1] and the
    # clamp that used to stand here pinned it to an endpoint — a tree that moves
    # one way at every node, which is not a discretised diffusion at all. The
    # conversion option is then priced against a deterministic ramp and comes
    # back at exactly zero.
    #
    # The failure is silent and, worse, it is *flat*: once clamped, the value
    # stops being a function of the input that broke it. On an ordinary
    # 5-year convertible at 30% volatility, `dividend_yield` of 2.0 and of 5.0
    # both returned a fair value of 872.28 — the same number, because both had
    # been rounded to the same endpoint. A yield typed as `2` for 2% is the slip
    # that gets there, and the two other roads are the same arithmetic: a
    # risk-free rate typed as a whole number, or a genuinely low-volatility
    # issuer on a coarse tree.
    #
    # Refused with the step count that would fix it, because the condition
    # rearranges to `n > t·((r−q)/σ)²` and is often satisfiable: the 2.0 case
    # above needs 212 steps against the default 200. Raising `n` here instead
    # would be the engine quietly choosing a discretisation the caller set.
    drift_per_step = abs(r - q) * dt
    if drift_per_step >= sigma * math.sqrt(dt):
        needed = math.floor(t * ((r - q) / sigma) ** 2) + 1
        detail = (
            f"raise steps to at least {needed}"
            if needed <= MAX_TREE_STEPS
            else f"no tree under the {MAX_TREE_STEPS}-step ceiling can carry it, so check that "
            "risk_free_rate and dividend_yield are fractions (2% is 0.02)"
        )
        raise EngineInputError(
            f"the binomial tree's drift over one step ({r:g} − {q:g} over {dt:g} years) is not "
            f"inside its own move range at volatility {sigma:g} — the risk-neutral probability "
            f"leaves [0, 1] and the tree stops being a diffusion; {detail}"
        )
    p = (math.exp((r - q) * dt) - d) / (u - d)
    coupon_per_period = f * _num(coupon_rate, "coupon_rate", minimum=0.0) / m

    # Coupon dates come from the same schedule `yield_dcf` discounts, so the
    # tree and the DCF price the same instrument's cash flows — which means the
    # same count *and* the same dates, and `schedule_periods` is the one place
    # both are decided. It used to keep its own copy of the old forward-dated
    # grid, so on any maturity that is not a whole number of periods the tree
    # priced a different instrument than the DCF beside it: a 1.83-year note
    # paid the tree four coupons at 0.5/1.0/1.5/2.0, the last of them after the
    # note had been redeemed.
    #
    # `coupons_at[k]` is how many coupons the holder receives at step k; two can
    # share a step only when the tree is coarser than the coupon frequency, and
    # dropping one there would silently underprice the note.
    n_coupons, coupon_offset = schedule_periods(t, m)
    coupons_at = [0] * (n + 1)
    for k in range(1, n_coupons + 1):
        coupons_at[min(n, max(1, round((k / m + coupon_offset) / dt)))] += 1

    prices = [s0 * u**j * d ** (n - j) for j in range(n + 1)]
    # Redemption at maturity is face plus the coupon due that day, if one is.
    # That coupon is then struck from the rollback schedule: counting a payment
    # both in the terminal payoff and again on the last step paid the final
    # coupon twice, which on a 3-year 5% semiannual note discounted at 6%
    # overpriced the whole instrument by 2.2% — the coupon itself, present
    # valued — and grew with the coupon rate.
    final_coupon = coupon_per_period if coupons_at[n] > 0 else 0.0
    coupons_at[n] = max(0, coupons_at[n] - 1)
    redeem = f + final_coupon
    U = [max(kappa * s, redeem) for s in prices]
    B = [0.0 if kappa * s >= redeem else redeem for s in prices]

    for i in range(n - 1, -1, -1):
        newU = [0.0] * (i + 1)
        newB = [0.0] * (i + 1)
        add_coupon = coupon_per_period * coupons_at[i + 1]
        for j in range(i + 1):
            s = s0 * u**j * d ** (i - j)
            eB = p * B[j + 1] + (1 - p) * B[j]
            # Debt part discounts at the risky rate; equity part (U−B) at rf.
            # The coupon is inside the discount because it is paid at step i+1,
            # not at i — adding it undiscounted made every coupon arrive one
            # step early, an error that shrinks with dt but always favours the
            # holder.
            b_cont = disc_risky * (eB + add_coupon)
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


#: The grid a conversion price is reported on. Six decimals of a dollar per
#: share, and the *whole* grid — there is no finer price for the response to
#: fall back to, so a positive price below half of it has nowhere to be stated.
CONVERSION_PRICE_QUANTUM = 1e-6


def _positive_cap(value, name: str) -> float:
    """A valuation cap, which is a company valuation and so cannot be zero.

    Split out because `valuation_cap` and `mfn_cap` are the same quantity and
    have to be refused the same way — `min(cap, mfn_cap)` only means anything
    when both have been through the same guard. See `safe_conversion`.
    """
    cap = _num(value, name, minimum=0.0)
    if cap <= 0:
        raise EngineInputError(
            f"{name} must be positive — a cap of zero converts the instrument at a price of "
            "zero; omit the field entirely for an uncapped instrument"
        )
    return cap


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
    #
    # Both MFN terms are put through the same guard as the primary term they can
    # replace, and *before* they are compared against it. Neither used to be:
    #
    #   * `mfn_discount` skipped the `< 1` check `discount` gets, so an MFN
    #     discount of 1.5 drove the conversion price negative and surfaced as
    #     "conversion price resolved to zero" — an error that names neither the
    #     field at fault nor what was actually wrong with it.
    #   * `min(valuation_cap, mfn_cap)` compared the *raw* cap, so a cap that
    #     arrived as a numeric string — which `params` is a free-form dict and
    #     so routinely does — priced fine on its own but raised a bare
    #     `TypeError: '<' not supported between float and str` the moment an MFN
    #     cap was supplied alongside it. That leaves the endpoint as a 422 with
    #     a Python internal for a detail, which is the failure mode `_int` and
    #     `_sequence` exist to prevent everywhere else in this engine.
    if mfn_discount is None:
        eff_discount = disc
    else:
        mfn_disc = _num(mfn_discount, "mfn_discount", minimum=0.0)
        if mfn_disc >= 1.0:
            raise EngineInputError("mfn_discount must be < 1")
        eff_discount = max(disc, mfn_disc)

    # Positive, not merely non-negative. A cap of zero is not a cap — it puts the
    # conversion price at zero and the note converts into an unbounded number of
    # shares — and it is what the debt page sends for a *cleared* cap field,
    # because `Number('')` is 0. So the ordinary act of emptying an optional
    # input produced "conversion price resolved to zero", an error naming
    # neither the field at fault nor what was wrong with it. That is the failure
    # mode the MFN guards below were written to prevent, on the primary term.
    cap = _positive_cap(valuation_cap, "valuation_cap") if valuation_cap is not None else None
    if mfn_cap is not None:
        mfn_c = _positive_cap(mfn_cap, "mfn_cap")
        cap = mfn_c if cap is None else min(cap, mfn_c)

    discount_price = round_price * (1.0 - eff_discount)
    cap_price = cap / shares if cap is not None else None
    conversion_price = discount_price if cap_price is None else min(discount_price, cap_price)
    # Zero, and everything that is published as zero.
    #
    # The guard used to read the unrounded price while the response reported
    # `round(conversion_price, 6)`, so the whole band below half a microdollar
    # cleared it and then came back stated as `0.0` — the exact state
    # `_positive_cap` refuses a zero cap for, reached by a cap that is merely
    # small. A `valuation_cap` of 4 on a ten-million-share round is $4e-07 a
    # share: the response said the instrument converted at a price of zero,
    # handed the holder 2.5e+11 shares against the round's 10,000,000, and put
    # its ownership at 99.996%, as a 200. And 4 for $4,000,000 is the ordinary
    # units slip — the same one `anomalies.UNIT_MISMATCH_FACTOR` exists to catch
    # on the other side of the engine — not an exotic input.
    #
    # Six decimals is the whole grid this figure is stated on; there is no finer
    # price for the document to fall back to, so a price below it is refused
    # rather than printed. The same rule `compute._concluded_fmv_per_share`
    # applies to the conclusion, for the same reason.
    #
    # Struck at the grid and not above it: a cap slipped by six orders of
    # magnitude rather than seven prices at $0.000001 a share and still prices.
    # What is refused here is a figure the response contradicts itself about,
    # not every implausible one.
    if round(conversion_price, 6) <= 0:
        # Both legs, because the conversion price is the lower of them and the
        # message has to say which one put it on the floor.
        raise EngineInputError(
            f"the conversion price resolved to {conversion_price:g}, which is at or below the "
            f"{CONVERSION_PRICE_QUANTUM:g} per share it is reported at — the discount leg is "
            f"{discount_price:g} (round price {round_price:g} less {eff_discount:.4g}) and the "
            f"cap leg is {'none' if cap_price is None else format(cap_price, 'g')}; check that "
            "valuation_cap and next_round_pre_money are whole dollars rather than millions"
        )

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
    """Route a debt instrument to its valuation function.

    Any OverflowError raised under here is re-raised as an EngineInputError, so
    it leaves the endpoint as the 422 a bad magnitude deserves rather than a 500.

    `convertible_note` names its own overflow, precisely, before it happens; this
    is the backstop for the rest. Python's float arithmetic is inconsistent about
    which operations raise: `math.exp`, `**` and `float(int)` raise OverflowError,
    while `*` and `/` saturate to `inf` silently. So the discount factors alone
    give two 500s — `math.exp(-r·dt)` for a very negative rate, `(1 + y/m)^(m·t)`
    for a very large yield — and `params` is a free-form dict, so every rate on
    every instrument here is a caller-supplied double with no ceiling of its own.

    Catching the exception type rather than bounding each rate is the deliberate
    choice: a ceiling on a rate is a modelling opinion this module has no reason
    to hold, and it would have to be repeated on every input of every instrument,
    including ones added later. Overflow is not an opinion — the arithmetic
    genuinely has no answer to return — and it is one type, raised at the exact
    operation that could not be completed.
    """
    try:
        return _dispatch(instrument_type, params)
    except OverflowError as exc:
        raise EngineInputError(
            f"the {str(instrument_type or '').strip() or 'instrument'} calculation overflowed "
            f"a double ({exc}) — check the input magnitudes, particularly the rates"
        ) from exc


#: The entry point each instrument's free-form ``params`` is called with. Also
#: what the caller is told they may name: a params object that cannot be bound
#: is refused here, in the instrument's own input names, rather than reaching
#: the endpoint as a TypeError naming an internal function (kwargs_refusal).
_ENTRY_POINTS = {
    "bond": yield_dcf,
    "term_loan": term_loan_fair_value,
    "credit_spread": credit_spread_valuation,
    "convertible": convertible_note,
    "safe": safe_conversion,
}


def _dispatch(instrument_type: str, params: dict) -> dict:
    if not isinstance(params, dict):
        raise EngineInputError("params must be an object")
    it = str(instrument_type or "").strip()
    entry = _ENTRY_POINTS.get(it)
    if entry is not None:
        unbindable = describe_unbindable(entry, params)
        if unbindable is not None:
            raise EngineInputError(f"invalid params for {it}: {unbindable}")
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
        f"unknown instrument_type '{quote_for_message(str(instrument_type))}'; "
        "expected bond, term_loan, credit_spread, convertible or safe"
    )
