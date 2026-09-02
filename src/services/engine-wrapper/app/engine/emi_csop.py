"""EMI / CSOP valuation engine (features: EMI Valuation, CSOP Valuation — UK).

HMRC option-scheme valuations conclude two figures per share, not one:

  - UMV (unrestricted market value): what the share would be worth ignoring
    the restrictions attached to it;
  - AMV (actual market value): the same share with its restrictions priced in
    — leaver provisions, transfer restrictions, drag/tag — expressed here as a
    restriction discount off UMV.

The scheme limits are tested in UMV terms at grant (ITEPA 2003 Schedule 5 for
EMI, Schedule 4 for CSOP; VAL231/VAL230 are the agreement forms these numbers
go on). Statutory limits, in GBP:

  - EMI: company gross assets ≤ £30M and fewer than 250 FTE employees;
    £250,000 per employee (UMV at grant, 3-year rolling window, CSOP options
    count toward it); £3M company-wide unexercised UMV;
  - CSOP: £60,000 per employee (UMV at grant, from 6 April 2023), and the
    exercise price must not be less than UMV at grant.

Like the QSBS engine, failed limits are collected rather than raised — the
deliverable documents every failed condition; EngineInputError is for inputs
the rules cannot be evaluated against.
"""

from __future__ import annotations

import math

from .errors import EngineInputError
from .kwargs_refusal import describe_unbindable

EMI_GROSS_ASSET_LIMIT = 30_000_000.0
EMI_EMPLOYEE_LIMIT = 250
EMI_INDIVIDUAL_LIMIT = 250_000.0
EMI_COMPANY_LIMIT = 3_000_000.0
CSOP_INDIVIDUAL_LIMIT = 60_000.0


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


def share_values(
    *,
    equity_value: float,
    total_shares: float,
    restriction_discount: float = 0.0,
    minority_discount: float = 0.0,
) -> dict:
    """UMV and AMV per share from the concluded equity value.

    ``minority_discount`` applies to BOTH figures (a small holding is worth
    less than pro-rata whether or not the shares are restricted); the
    ``restriction_discount`` is what separates AMV from UMV.
    """
    equity = _num(equity_value, "emi.equity_value", minimum=0.0)
    shares = _num(total_shares, "emi.total_shares")
    if shares <= 0:
        raise EngineInputError("emi.total_shares must be positive")
    minority = _num(minority_discount, "emi.minority_discount", minimum=0.0, maximum=0.99)
    restriction = _num(restriction_discount, "emi.restriction_discount", minimum=0.0, maximum=0.99)
    pro_rata = equity / shares
    umv = pro_rata * (1.0 - minority)
    amv = umv * (1.0 - restriction)
    return {
        "pro_rata_per_share": pro_rata,
        "minority_discount": minority,
        "restriction_discount": restriction,
        "umv_per_share": umv,
        "amv_per_share": amv,
    }


def emi_qualification(
    *,
    gross_assets: float,
    employee_count: float,
    umv_per_share: float,
    options_granted: float,
    individual_prior_grants_umv: float = 0.0,
    company_unexercised_umv: float = 0.0,
    is_independent: bool = True,
    has_qualifying_trade: bool = True,
    works_25_hours_or_75_pct: bool = True,
) -> dict:
    """Schedule 5 limits for one proposed EMI grant."""
    assets = _num(gross_assets, "emi.gross_assets", minimum=0.0)
    employees = _num(employee_count, "emi.employee_count", minimum=0.0)
    umv = _num(umv_per_share, "emi.umv_per_share", minimum=0.0)
    granted = _num(options_granted, "emi.options_granted", minimum=0.0)
    prior = _num(individual_prior_grants_umv, "emi.individual_prior_grants_umv", minimum=0.0)
    outstanding = _num(company_unexercised_umv, "emi.company_unexercised_umv", minimum=0.0)

    grant_umv = umv * granted
    individual_total = prior + grant_umv
    company_total = outstanding + grant_umv

    checks = {
        "gross_assets": {
            "passed": assets <= EMI_GROSS_ASSET_LIMIT,
            "detail": f"£{assets:,.0f} against the £{EMI_GROSS_ASSET_LIMIT:,.0f} limit",
        },
        "employee_count": {
            "passed": employees < EMI_EMPLOYEE_LIMIT,
            "detail": f"{employees:g} FTEs against the fewer-than-{EMI_EMPLOYEE_LIMIT} limit",
        },
        "company_independence": {
            "passed": bool(is_independent),
            "detail": "independent" if is_independent else "under another company's control",
        },
        "qualifying_trade": {
            "passed": bool(has_qualifying_trade),
            "detail": "qualifying trade" if has_qualifying_trade else "excluded activity",
        },
        "working_time": {
            "passed": bool(works_25_hours_or_75_pct),
            "detail": (
                "meets the 25-hours/75% working-time requirement"
                if works_25_hours_or_75_pct
                else "fails the 25-hours/75% working-time requirement"
            ),
        },
        "individual_limit": {
            "passed": individual_total <= EMI_INDIVIDUAL_LIMIT,
            "detail": (
                f"£{individual_total:,.0f} UMV in the 3-year window against the "
                f"£{EMI_INDIVIDUAL_LIMIT:,.0f} limit"
            ),
        },
        "company_limit": {
            "passed": company_total <= EMI_COMPANY_LIMIT,
            "detail": (
                f"£{company_total:,.0f} unexercised UMV against the £{EMI_COMPANY_LIMIT:,.0f} limit"
            ),
        },
    }
    failed = [name for name, c in checks.items() if not c["passed"]]
    return {
        "scheme": "emi",
        "grant_umv": grant_umv,
        "individual_total_umv": individual_total,
        "company_total_umv": company_total,
        "checks": checks,
        "qualifies": not failed,
        "failed_checks": failed,
    }


def csop_grant_check(
    *,
    umv_per_share: float,
    options_granted: float,
    exercise_price: float,
    individual_prior_grants_umv: float = 0.0,
) -> dict:
    """Schedule 4 limits for one proposed CSOP grant."""
    umv = _num(umv_per_share, "csop.umv_per_share", minimum=0.0)
    granted = _num(options_granted, "csop.options_granted", minimum=0.0)
    price = _num(exercise_price, "csop.exercise_price", minimum=0.0)
    prior = _num(individual_prior_grants_umv, "csop.individual_prior_grants_umv", minimum=0.0)

    grant_umv = umv * granted
    individual_total = prior + grant_umv
    checks = {
        "individual_limit": {
            "passed": individual_total <= CSOP_INDIVIDUAL_LIMIT,
            "detail": (
                f"£{individual_total:,.0f} UMV against the £{CSOP_INDIVIDUAL_LIMIT:,.0f} limit"
            ),
        },
        "exercise_price_not_below_umv": {
            "passed": price >= umv,
            "detail": f"exercise price £{price:,.4f} vs UMV £{umv:,.4f} at grant",
        },
    }
    failed = [name for name, c in checks.items() if not c["passed"]]
    return {
        "scheme": "csop",
        "grant_umv": grant_umv,
        "individual_total_umv": individual_total,
        "checks": checks,
        "qualifies": not failed,
        "failed_checks": failed,
    }


def emi_csop_valuation(scheme, params) -> dict:
    """Endpoint entry point: conclude UMV/AMV, then run the scheme's checks.

    ``params`` carries the ``share_values`` inputs plus the scheme's
    qualification inputs; the concluded UMV feeds the checks so the limits are
    tested at the value this engagement concluded, not a caller-supplied one.
    """
    name = str(scheme or "").strip().lower()
    if name not in {"emi", "csop"}:
        raise EngineInputError("scheme must be 'emi' or 'csop'")
    if not isinstance(params, dict):
        raise EngineInputError("params must be an object")

    value_keys = {"equity_value", "total_shares", "restriction_discount", "minority_discount"}
    # Both halves of the dispatch are guarded, because both unpack a
    # caller-supplied dict into keyword-only parameters. Only the qualification
    # call used to be, and `equity_value` and `total_shares` are required with
    # no default — so the one omission a caller is most likely to make left
    # `share_values` raising a bare TypeError, which is not an EngineInputError
    # and so never reached the route's 422 handler. `{"scheme": "emi",
    # "params": {}}` was answered with a 500 and a stack trace in the log,
    # while the same omission on `/debt-valuation` and `/projection` — the two
    # other routes with a free-form `params` dict — is a 422 naming the fields.
    rest = {k: v for k, v in params.items() if k not in value_keys}
    check = emi_qualification if name == "emi" else csop_grant_check
    # One object, two signatures, so the names it may carry are the union of
    # them less `umv_per_share`, which this function concludes rather than
    # accepts. Refused here so the caller reads the scheme's own input names
    # instead of a TypeError about `share_values()` — see kwargs_refusal.
    unbindable = describe_unbindable((share_values, check), params, provided={"umv_per_share"})
    if unbindable is not None:
        raise EngineInputError(f"invalid params for {name}: {unbindable}")
    try:
        values = share_values(**{k: v for k, v in params.items() if k in value_keys})
        qualification = check(umv_per_share=values["umv_per_share"], **rest)
    except TypeError as exc:
        raise EngineInputError(
            f"invalid params for {name}: the names are all ones this scheme takes, but one of "
            "the values is not of a type it can use"
        ) from exc
    return {**values, "qualification": qualification}
