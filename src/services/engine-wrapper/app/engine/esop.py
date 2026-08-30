"""ESOP valuation engine (feature: annual ESOP valuation for ERISA).

An ESOP trustee needs the same equity value the other approaches produce, then
three things the 409A path does not do:

  - the level-of-value chain made explicit: controlling → marketable minority
    → nonmarketable minority. ERISA adequate-consideration work is disclosed
    at each level, because which level the ESOP transacts at (control vs
    minority) is the single most litigated input;
  - a discount for lack of control derived from the control premium when the
    appraiser supplies the premium instead ( DLOC = 1 − 1/(1+CP) — they are
    the same fact stated from opposite sides);
  - the repurchase obligation: the sponsor must buy back distributed shares,
    and the annual valuation reports the projected liability and its PV so the
    board can see the cash calls coming.

Pure and deterministic; equity value arrives as an input (the weighted
approaches, DCF or market engines produce it upstream).
"""

from __future__ import annotations

import math

from .compounding import compound_factor
from .errors import EngineInputError

MAX_PROJECTION_YEARS = 50


def _num(
    value, name: str, *, minimum: float | None = None, maximum: float | None = None
) -> float:
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


def dloc_from_control_premium(control_premium: float) -> float:
    """DLOC implied by a control premium: 1 − 1/(1+CP)."""
    premium = _num(control_premium, "esop.control_premium", minimum=0.0)
    return 1.0 - 1.0 / (1.0 + premium)


def esop_share_value(
    *,
    equity_value: float,
    shares_outstanding: float,
    value_basis: str = "control",
    control_premium: float | None = None,
    dloc: float | None = None,
    dlom: float = 0.0,
    esop_shares: float | None = None,
) -> dict:
    """Level-of-value chain from an equity value to the ESOP per-share value.

    ``value_basis`` names the level the input equity value sits at:
      - "control": the DLOC (given directly or via ``control_premium``) steps
        down to marketable minority, then DLOM to nonmarketable;
      - "minority": the input is already marketable minority — a supplied
        control premium steps UP to the control level for disclosure, and only
        DLOM applies on the way down.

    Passing both ``dloc`` and ``control_premium`` is refused rather than
    silently preferring one: they encode the same fact, and if they disagree
    the report would carry whichever the code happened to pick.
    """
    equity = _num(equity_value, "esop.equity_value", minimum=0.0)
    shares = _num(shares_outstanding, "esop.shares_outstanding")
    if shares <= 0:
        raise EngineInputError("esop.shares_outstanding must be positive")
    basis = str(value_basis or "").strip().lower()
    if basis not in {"control", "minority"}:
        raise EngineInputError("esop.value_basis must be 'control' or 'minority'")
    if dloc is not None and control_premium is not None:
        raise EngineInputError("esop accepts dloc or control_premium, not both")
    discount_lack_control = (
        _num(dloc, "esop.dloc", minimum=0.0, maximum=0.99)
        if dloc is not None
        else dloc_from_control_premium(control_premium) if control_premium is not None else 0.0
    )
    discount_marketability = _num(dlom, "esop.dlom", minimum=0.0, maximum=0.99)

    if basis == "control":
        control_value = equity
        minority_value = control_value * (1.0 - discount_lack_control)
    else:
        minority_value = equity
        # Step up for disclosure only; the conclusion never passes through it.
        control_value = (
            minority_value / (1.0 - discount_lack_control)
            if discount_lack_control < 1.0
            else minority_value
        )
    nonmarketable_value = minority_value * (1.0 - discount_marketability)

    per_share = nonmarketable_value / shares
    esop_stake = None
    if esop_shares is not None:
        stake_shares = _num(esop_shares, "esop.esop_shares", minimum=0.0)
        if stake_shares > shares:
            raise EngineInputError("esop.esop_shares exceeds esop.shares_outstanding")
        esop_stake = per_share * stake_shares

    return {
        "value_basis": basis,
        "levels": {
            "control": control_value,
            "marketable_minority": minority_value,
            "nonmarketable_minority": nonmarketable_value,
        },
        "dloc": discount_lack_control,
        "dlom": discount_marketability,
        "shares_outstanding": shares,
        "fmv_per_share": per_share,
        "esop_stake_value": esop_stake,
    }


def repurchase_obligation(
    *,
    esop_share_balance: float,
    fmv_per_share: float,
    share_value_growth: float = 0.0,
    annual_redemption_rate: float,
    years: int = 10,
    discount_rate: float | None = None,
) -> dict:
    """Projected buy-back liability: each year a slice of the remaining balance
    is redeemed at that year's grown share value.

    The redemption slice is taken from the remaining balance (a survival
    process, like the MEEM attrition), not the opening balance — a plan that
    redeems 10% a year does not exhaust in ten years.
    """
    balance = _num(esop_share_balance, "repurchase.esop_share_balance", minimum=0.0)
    price = _num(fmv_per_share, "repurchase.fmv_per_share", minimum=0.0)
    growth = _num(share_value_growth, "repurchase.share_value_growth", minimum=-0.99)
    redemption = _num(annual_redemption_rate, "repurchase.annual_redemption_rate", minimum=0.0, maximum=1.0)
    if not isinstance(years, int) or isinstance(years, bool):
        raise EngineInputError("repurchase.years must be an integer")
    if years <= 0 or years > MAX_PROJECTION_YEARS:
        raise EngineInputError(f"repurchase.years must be between 1 and {MAX_PROJECTION_YEARS}")
    rate = None
    if discount_rate is not None:
        rate = _num(discount_rate, "repurchase.discount_rate", minimum=0.0)

    rows = []
    remaining = balance
    total = 0.0
    total_pv = 0.0
    for year in range(1, years + 1):
        year_price = price * compound_factor(growth, year, "repurchase.share_value_growth")
        shares_redeemed = remaining * redemption
        cost = shares_redeemed * year_price
        remaining -= shares_redeemed
        # `None` rather than the undiscounted cost when no rate was supplied,
        # for the same reason `pv_of_obligation` below is None: a present value
        # nobody asked for is not a present value of zero years' discounting.
        #
        # The row used to carry `pv = cost`, so one result object both declined
        # to state a present value for the obligation and stated one for every
        # year of it — and a reader summing the column got `total_obligation`
        # back under the name the total refuses to use. Exhibit ESOP's own
        # comment describes the behaviour this now has ("without one the rows
        # carry no present value"); the `schedule.some(r => r.pv !== null)` half
        # of its guard was true whatever the engine did.
        pv = cost / compound_factor(rate, year, "repurchase.discount_rate") if rate is not None else None
        total += cost
        total_pv += pv if pv is not None else 0.0
        rows.append(
            {
                "year": year,
                "share_price": year_price,
                "shares_redeemed": shares_redeemed,
                "repurchase_cost": cost,
                "remaining_shares": remaining,
                "pv": pv,
            }
        )
        if not math.isfinite(cost):
            raise EngineInputError(
                "repurchase cost overflowed — check the growth rate and share balance magnitudes"
            )

    return {
        "schedule": rows,
        "total_obligation": total,
        "pv_of_obligation": total_pv if rate is not None else None,
        "ending_share_balance": remaining,
    }
