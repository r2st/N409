"""QSBS eligibility engine (feature: QSBS Attestation Letter, IRC §1202).

Pure rule evaluation, not valuation: the attestation letter documents whether
stock qualifies as Qualified Small Business Stock and what exclusion the holder
can claim. The tests implemented:

  - entity test: domestic C corporation at issuance and through the holding
    period (§1202(c)(1), (e)(4));
  - gross asset test: aggregate gross assets never above the applicable limit
    from Aug 10 1993 to immediately after the issuance (§1202(d)(1));
  - active business test: ≥80% of assets by value used in a qualified trade or
    business (§1202(e)(1)), with the excluded service/finance/hospitality
    industries of §1202(e)(3);
  - original issuance test: acquired at original issue for money, property or
    services (§1202(c)(1)(B));
  - holding period and exclusion percentage (§1202(a));
  - per-issuer cap: greater of the lifetime dollar cap or 10× aggregate basis
    (§1202(b)(1)).

Two regimes, split by acquisition date
--------------------------------------
The One Big Beautiful Bill Act (P.L. 119-21, enacted 4 July 2025) rewrote three
of the numbers above for stock **acquired after 4 July 2025**, and left them
untouched for everything issued before. Both sets are live for decades — an
attestation written today is routinely about 2018 stock — so this engine holds
both and picks by the acquisition date rather than replacing one with the other:

                        acquired ≤ 2025-07-04     acquired > 2025-07-04
  gross asset limit     $50M                      $75M
  per-issuer floor      $10M                      $15M
  holding period        more than 5 years,        at least 3 years → 50%
                        one step, percentage      at least 4 years → 75%
                        fixed by acquisition      at least 5 years → 100%
                        date (50/75/100%)

The tiering is the change with teeth: under the old rule a four-year holder had
nothing, and under the new one the same holder has a 75% exclusion. Reporting
`exclusion_percentage` therefore has to be a function of the assessment date as
well as the acquisition date, which it was not.

Both OBBBA dollar figures are indexed for inflation in tax years beginning after
2026; the indexed amounts are published annually and are not modelled here, so
the figures below are the statutory bases. `regime` names which one was applied
so the letter can say so.

Dates are ISO-8601 strings; arithmetic is date-based so the engine stays
deterministic (no clock reads — the valuation date is an input).
"""

from __future__ import annotations

import math
from datetime import date

from .errors import EngineInputError

GROSS_ASSET_LIMIT = 50_000_000.0
GROSS_ASSET_LIMIT_OBBBA = 75_000_000.0
PER_ISSUER_CAP_FLOOR = 10_000_000.0
PER_ISSUER_CAP_FLOOR_OBBBA = 15_000_000.0
BASIS_CAP_MULTIPLE = 10.0
ACTIVE_BUSINESS_THRESHOLD = 0.80
HOLDING_PERIOD_YEARS = 5

# P.L. 119-21 §70431. The statute reads "acquired after the date of enactment",
# so the enactment day itself is on the *old* side of the line: this constant is
# the last pre-OBBBA day, and the comparison below is a strict `>`.
OBBBA_ENACTMENT = date(2025, 7, 4)

# §1202(a)(4) as amended: (holding years completed, exclusion). Ascending, and
# read from the back so the longest satisfied tier wins.
OBBBA_TIERS: tuple[tuple[int, float], ...] = ((3, 0.50), (4, 0.75), (5, 1.00))

# §1202(e)(3) excluded trades: any business whose principal asset is the skill
# of its employees, plus the named finance/farming/extraction/hospitality
# industries. Keys are the intake categories the onboarding wizard collects.
EXCLUDED_INDUSTRIES = frozenset(
    {
        "health",
        "law",
        "engineering",
        "architecture",
        "accounting",
        "actuarial_science",
        "performing_arts",
        "consulting",
        "athletics",
        "financial_services",
        "brokerage",
        "banking",
        "insurance",
        "leasing",
        "investing",
        "farming",
        "mining",
        "oil_and_gas",
        "hotel",
        "motel",
        "restaurant",
    }
)

# Exclusion percentage by acquisition date (§1202(a)): 50% before the 2009
# stimulus window, 75% inside it, 100% from Sep 28 2010 (PATH Act made
# permanent).
_EXCLUSION_75_START = date(2009, 2, 18)
_EXCLUSION_100_START = date(2010, 9, 28)


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


def _date(value, name: str) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError as exc:
        raise EngineInputError(f"{name} must be an ISO date (YYYY-MM-DD)") from exc


def _years_between(start: date, end: date) -> float:
    """Approximate year fraction between two dates, for disclosure only.

    The statutory holding-period test is NOT decided on this figure — a day
    count over 365.25 calls exactly-five-calendar-years "5.002 years" whenever
    the span contains two leap days, and the statute's test is *more than* five
    years. The decision compares against the calendar anniversary instead
    (`_anniversary` below); this number is reported so the letter can say how
    long the stock has been held.
    """
    return (end - start).days / 365.25


def _anniversary(acquired: date, years: int) -> date:
    """The calendar anniversary `years` on. Feb 29 rolls to Mar 1 (the day the
    full year completes in a non-leap year), matching how the holding period is
    conventionally counted."""
    if acquired.month == 2 and acquired.day == 29:
        return date(acquired.year + years, 3, 1)
    return date(acquired.year + years, acquired.month, acquired.day)


def is_obbba_stock(acquisition_date: date) -> bool:
    """True for stock the post-OBBBA §1202 applies to.

    One predicate, used for all three of the changed numbers, because they all
    key off the same date. The gross-asset limit is worded against the date the
    stock was *issued* rather than acquired; §1202(c)(1)(B) only recognises
    stock acquired at original issue, so for anything that can pass the tests at
    all the two dates are the same day, and `acquired_at_original_issue` already
    fails the rest.
    """
    return acquisition_date > OBBBA_ENACTMENT


def gross_asset_limit(acquisition_date: date) -> float:
    return GROSS_ASSET_LIMIT_OBBBA if is_obbba_stock(acquisition_date) else GROSS_ASSET_LIMIT


def per_issuer_cap_floor(acquisition_date: date) -> float:
    return PER_ISSUER_CAP_FLOOR_OBBBA if is_obbba_stock(acquisition_date) else PER_ISSUER_CAP_FLOOR


def exclusion_percentage(acquisition_date: date) -> float:
    """The pre-OBBBA percentage, which is fixed by the acquisition date alone.

    Still exported and still correct for the regime it describes, but it is no
    longer the whole answer — post-OBBBA stock earns its percentage in three
    steps over the holding period. Use `holding_period_status` for a figure to
    put in a letter.
    """
    if acquisition_date >= _EXCLUSION_100_START:
        return 1.0
    if acquisition_date >= _EXCLUSION_75_START:
        return 0.75
    return 0.50


def holding_period_status(acquired: date, assessed: date) -> dict:
    """How much of the holding period is behind us, and what it is worth.

    Returns the percentage available *as of the assessment date* alongside the
    ceiling the stock reaches when fully held. Those were one field before, and
    a single field could only be one of the two: the letter printed "exclusion
    available now: no" beside "exclusion percentage 100%", which is the number
    for a date that has not arrived. Under the tiered regime they diverge for
    two whole years rather than only reading oddly, so they are now separate.
    """
    five_year_date = _anniversary(acquired, HOLDING_PERIOD_YEARS)
    if not is_obbba_stock(acquired):
        # One step, and the statute says *more than* five years — the
        # anniversary itself is a day short.
        met = assessed > five_year_date
        maximum = exclusion_percentage(acquired)
        return {
            "years_held": round(_years_between(acquired, assessed), 4),
            "required_years": HOLDING_PERIOD_YEARS,
            "met": met,
            "five_year_date": five_year_date.isoformat(),
            "threshold_date": five_year_date.isoformat(),
            "exclusion_percentage": maximum if met else 0.0,
            "maximum_exclusion_percentage": maximum,
            "tiers": [
                {
                    "years": HOLDING_PERIOD_YEARS,
                    "exclusion_percentage": maximum,
                    "date": five_year_date.isoformat(),
                    "met": met,
                }
            ],
        }

    # Tiered, and worded "at least", so the anniversary day itself counts.
    tiers = [
        {
            "years": years,
            "exclusion_percentage": pct,
            "date": _anniversary(acquired, years).isoformat(),
            "met": assessed >= _anniversary(acquired, years),
        }
        for years, pct in OBBBA_TIERS
    ]
    reached = [t for t in tiers if t["met"]]
    first_years, _ = OBBBA_TIERS[0]
    return {
        "years_held": round(_years_between(acquired, assessed), 4),
        "required_years": first_years,
        "met": bool(reached),
        "five_year_date": five_year_date.isoformat(),
        "threshold_date": _anniversary(acquired, first_years).isoformat(),
        "exclusion_percentage": reached[-1]["exclusion_percentage"] if reached else 0.0,
        "maximum_exclusion_percentage": OBBBA_TIERS[-1][1],
        "tiers": tiers,
    }


def qsbs_eligibility(
    *,
    entity_type: str,
    is_domestic: bool = True,
    gross_assets_before_issuance: float,
    gross_assets_after_issuance: float,
    industry: str,
    active_business_asset_pct: float,
    acquired_at_original_issue: bool,
    acquisition_date,
    assessment_date,
    aggregate_basis: float = 0.0,
    prior_1202_exclusions: float = 0.0,
    redemptions_within_window: bool = False,
) -> dict:
    """Evaluate every §1202 test and return a per-test breakdown + conclusion.

    Fails are collected rather than raised: an attestation letter that names
    every failed requirement is the deliverable, so one bad test must not mask
    the others. EngineInputError is reserved for inputs the rules cannot be
    evaluated against at all.
    """
    entity = str(entity_type or "").strip().lower().replace("-", "_").replace(" ", "_")
    gross_before = _num(gross_assets_before_issuance, "qsbs.gross_assets_before_issuance", minimum=0.0)
    gross_after = _num(gross_assets_after_issuance, "qsbs.gross_assets_after_issuance", minimum=0.0)
    active_pct = _num(active_business_asset_pct, "qsbs.active_business_asset_pct", minimum=0.0)
    if active_pct > 1.0:
        raise EngineInputError("qsbs.active_business_asset_pct is a fraction; got a value above 1")
    basis = _num(aggregate_basis, "qsbs.aggregate_basis", minimum=0.0)
    prior_excluded = _num(prior_1202_exclusions, "qsbs.prior_1202_exclusions", minimum=0.0)
    acquired = _date(acquisition_date, "qsbs.acquisition_date")
    assessed = _date(assessment_date, "qsbs.assessment_date")
    if assessed < acquired:
        raise EngineInputError("qsbs.assessment_date precedes qsbs.acquisition_date")

    industry_key = str(industry or "").strip().lower().replace("-", "_").replace(" ", "_")
    obbba = is_obbba_stock(acquired)
    asset_limit = gross_asset_limit(acquired)

    tests = {
        "c_corporation": {
            "passed": entity in {"c_corp", "c_corporation", "ccorp"} and bool(is_domestic),
            "detail": f"entity_type={entity or 'unknown'}, domestic={bool(is_domestic)}",
        },
        "gross_asset_test": {
            "passed": gross_before <= asset_limit and gross_after <= asset_limit,
            "detail": (
                f"before issuance ${gross_before:,.0f}, immediately after "
                f"${gross_after:,.0f}, limit ${asset_limit:,.0f}"
            ),
        },
        "qualified_trade_or_business": {
            "passed": industry_key not in EXCLUDED_INDUSTRIES,
            "detail": f"industry={industry_key or 'unknown'}",
        },
        "active_business_test": {
            "passed": active_pct >= ACTIVE_BUSINESS_THRESHOLD,
            "detail": f"{active_pct:.0%} of assets in active qualified use (threshold {ACTIVE_BUSINESS_THRESHOLD:.0%})",
        },
        "original_issuance": {
            "passed": bool(acquired_at_original_issue),
            "detail": "acquired at original issue" if acquired_at_original_issue else "acquired secondary",
        },
        "no_disqualifying_redemptions": {
            "passed": not redemptions_within_window,
            "detail": (
                "issuer redemptions inside the §1202(c)(3) window"
                if redemptions_within_window
                else "no significant issuer redemptions in the testing window"
            ),
        },
    }

    stock_qualifies = all(t["passed"] for t in tests.values())
    holding = holding_period_status(acquired, assessed)

    # §1202(b)(1): the year's exclusion cannot exceed the greater of the
    # lifetime dollar cap (less prior exclusions, floored at zero) or 10× the
    # basis of stock disposed of in the year. The attestation reports the
    # ceiling as of the assessment date on the full aggregate basis.
    lifetime_cap = per_issuer_cap_floor(acquired)
    lifetime_remaining = max(lifetime_cap - prior_excluded, 0.0)
    cap = max(lifetime_remaining, BASIS_CAP_MULTIPLE * basis)

    return {
        "eligible": stock_qualifies,
        "exclusion_available_now": stock_qualifies and holding["met"],
        "regime": "obbba" if obbba else "pre_obbba",
        "tests": tests,
        "holding_period": holding,
        "exclusion_percentage": holding["exclusion_percentage"] if stock_qualifies else 0.0,
        "maximum_exclusion_percentage": (
            holding["maximum_exclusion_percentage"] if stock_qualifies else 0.0
        ),
        "gain_exclusion_cap": cap if stock_qualifies else 0.0,
        "cap_components": {
            "lifetime_cap": lifetime_cap,
            "prior_exclusions": prior_excluded,
            "lifetime_remaining": lifetime_remaining,
            "ten_times_basis": BASIS_CAP_MULTIPLE * basis,
        },
        "failed_tests": [name for name, t in tests.items() if not t["passed"]],
    }
