"""SMB valuation engine (feature: SMB Fair Market Value report).

Small/medium businesses are valued on owner-adjusted earnings, not venture
cap tables — none of the OPM machinery applies. The methods here:

  - SDE normalization: seller's discretionary earnings = pre-tax income +
    owner compensation + interest + depreciation/amortization + one-time and
    discretionary add-backs (the earnings a single owner-operator actually
    takes home);
  - capitalization of earnings: value = benefit stream / cap rate, with the
    cap rate as build-up (risk-free + equity premium + size premium + company
    risk − long-term growth);
  - multiple methods: SDE multiple and rule-of-thumb revenue multiple, the
    two brokers actually quote;
  - a weighted conclusion across whichever methods ran, mirroring how
    `compute` weights the 409A approaches.

Values are equity values on a debt-free basis (the convention for main-street
transactions: price is for the operation, the seller keeps cash and clears
debt at close).
"""

from __future__ import annotations

import math

from .errors import EngineInputError


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


def _finite(value: float, name: str) -> float:
    if not math.isfinite(value):
        raise EngineInputError(f"{name} overflowed to a non-finite value — check the input magnitudes")
    return value


def sde_normalization(
    *,
    pretax_income: float,
    owner_compensation: float = 0.0,
    interest_expense: float = 0.0,
    depreciation_amortization: float = 0.0,
    one_time_expenses: float = 0.0,
    discretionary_expenses: float = 0.0,
    one_time_income: float = 0.0,
    fair_market_replacement_wage: float = 0.0,
) -> dict:
    """Seller's discretionary earnings from the tax-return P&L.

    ``fair_market_replacement_wage`` handles the multi-owner case: SDE is
    defined for ONE working owner, so a second owner's labor has to be charged
    back at a market wage. Passing the first owner's wage there too converts
    the result to EBITDA-like earnings for an absentee buyer.
    """
    income = _num(pretax_income, "sde.pretax_income")
    addbacks = {
        "owner_compensation": _num(owner_compensation, "sde.owner_compensation", minimum=0.0),
        "interest_expense": _num(interest_expense, "sde.interest_expense", minimum=0.0),
        "depreciation_amortization": _num(
            depreciation_amortization, "sde.depreciation_amortization", minimum=0.0
        ),
        "one_time_expenses": _num(one_time_expenses, "sde.one_time_expenses", minimum=0.0),
        "discretionary_expenses": _num(
            discretionary_expenses, "sde.discretionary_expenses", minimum=0.0
        ),
    }
    deductions = {
        "one_time_income": _num(one_time_income, "sde.one_time_income", minimum=0.0),
        "fair_market_replacement_wage": _num(
            fair_market_replacement_wage, "sde.fair_market_replacement_wage", minimum=0.0
        ),
    }
    sde = income + sum(addbacks.values()) - sum(deductions.values())
    return {
        "pretax_income": income,
        "addbacks": addbacks,
        "deductions": deductions,
        "sde": _finite(sde, "sde.sde"),
    }


def buildup_cap_rate(
    *,
    risk_free_rate: float,
    equity_risk_premium: float,
    size_premium: float = 0.0,
    company_specific_premium: float = 0.0,
    long_term_growth: float = 0.0,
) -> dict:
    """Build-up discount rate, less growth, is the capitalization rate."""
    discount = (
        _num(risk_free_rate, "cap.risk_free_rate", minimum=0.0, maximum=1.0)
        + _num(equity_risk_premium, "cap.equity_risk_premium", minimum=0.0, maximum=1.0)
        + _num(size_premium, "cap.size_premium", minimum=0.0, maximum=1.0)
        + _num(company_specific_premium, "cap.company_specific_premium", minimum=0.0, maximum=1.0)
    )
    growth = _num(long_term_growth, "cap.long_term_growth", minimum=-1.0, maximum=1.0)
    cap_rate = discount - growth
    if cap_rate <= 0:
        raise EngineInputError(
            "capitalization rate must be positive — long_term_growth meets or exceeds the "
            "built-up discount rate"
        )
    return {"discount_rate": discount, "long_term_growth": growth, "cap_rate": cap_rate}


def smb_valuation(
    *,
    sde_inputs: dict | None = None,
    sde: float | None = None,
    annual_revenue: float | None = None,
    cap_rate_inputs: dict | None = None,
    sde_multiple: float | None = None,
    revenue_multiple: float | None = None,
    weights: dict | None = None,
) -> dict:
    """Run whichever SMB methods the inputs support and weight a conclusion.

    Methods: capitalization of earnings (needs SDE + cap-rate inputs), SDE
    multiple, rule-of-thumb revenue multiple. Weights default to equal across
    the methods that ran; supplying a weight for a method that could not run
    is refused rather than renormalized away, because the analyst asked for an
    opinion the inputs cannot support.
    """
    if (sde is None) == (sde_inputs is None):
        if sde is None:
            raise EngineInputError("smb needs sde or sde_inputs")
        raise EngineInputError("smb accepts sde or sde_inputs, not both")
    normalization = None
    if sde_inputs is not None:
        if not isinstance(sde_inputs, dict):
            raise EngineInputError("smb.sde_inputs must be an object")
        try:
            normalization = sde_normalization(**sde_inputs)
        except TypeError as exc:
            raise EngineInputError(f"invalid sde_inputs: {exc}") from exc
        benefit = normalization["sde"]
    else:
        benefit = _num(sde, "smb.sde")

    methods: dict[str, dict] = {}

    if cap_rate_inputs is not None:
        if not isinstance(cap_rate_inputs, dict):
            raise EngineInputError("smb.cap_rate_inputs must be an object")
        if benefit <= 0:
            raise EngineInputError(
                "capitalization of earnings needs a positive benefit stream; SDE is not positive"
            )
        try:
            cap = buildup_cap_rate(**cap_rate_inputs)
        except TypeError as exc:
            raise EngineInputError(f"invalid cap_rate_inputs: {exc}") from exc
        methods["capitalization_of_earnings"] = {
            **cap,
            "benefit_stream": benefit,
            "equity_value": _finite(benefit / cap["cap_rate"], "smb.capitalized_value"),
        }

    if sde_multiple is not None:
        multiple = _num(sde_multiple, "smb.sde_multiple", minimum=0.0, maximum=100.0)
        if benefit <= 0:
            raise EngineInputError("the SDE multiple method needs a positive SDE")
        methods["sde_multiple"] = {
            "sde": benefit,
            "multiple": multiple,
            "equity_value": _finite(benefit * multiple, "smb.sde_multiple_value"),
        }

    if revenue_multiple is not None:
        if annual_revenue is None:
            raise EngineInputError("smb.revenue_multiple needs smb.annual_revenue")
        revenue = _num(annual_revenue, "smb.annual_revenue", minimum=0.0)
        # `revenue > 0`, not "a revenue was supplied" (R339, methodology M19).
        # The two methods above this one both refuse a non-positive benefit
        # stream out loud, because a multiple struck on nothing is not a small
        # indication — it is not an indication. This one took `annual_revenue:
        # 0`, which is what the questionnaire holds for a pre-revenue business
        # (`rules: { min: 0 }`) and what an overwrite forwards, multiplied it,
        # and put a $0 method into the weighting beside the ones that ran: an
        # SDE of $200k at 3x concludes $600,000 on its own and $300,000 the
        # moment a revenue multiple is left in the form with no revenue to
        # strike it on. Nothing on the schedule says the second figure is half
        # of one method rather than the average of two.
        #
        # Refused rather than dropped, for the reason the sibling branches are:
        # a weight naming a method that could not run is already an error here,
        # so silently not running one the analyst asked for would contradict
        # that. `comparables.comparable_analysis` answers `None` to the same
        # question instead, and says why — its peer screen is still worth
        # having without an indication. There is no such half here: the SMB
        # request exists to conclude a value.
        if revenue <= 0:
            raise EngineInputError(
                "the revenue multiple method needs a positive annual revenue"
            )
        multiple = _num(revenue_multiple, "smb.revenue_multiple", minimum=0.0, maximum=100.0)
        methods["revenue_multiple"] = {
            "revenue": revenue,
            "multiple": multiple,
            "equity_value": _finite(revenue * multiple, "smb.revenue_multiple_value"),
        }

    if not methods:
        raise EngineInputError(
            "no SMB method could run — supply cap_rate_inputs, sde_multiple or revenue_multiple"
        )

    if weights is not None:
        if not isinstance(weights, dict):
            raise EngineInputError("smb.weights must be an object")
        unknown = set(weights) - set(methods)
        if unknown:
            raise EngineInputError(
                f"smb.weights names methods that did not run: {sorted(unknown)}"
            )
        cleaned = {k: _num(v, f"smb.weights.{k}", minimum=0.0) for k, v in weights.items()}
        total = sum(cleaned.values())
        if total <= 0:
            raise EngineInputError("smb.weights must sum to a positive number")
        applied = {k: cleaned.get(k, 0.0) / total for k in methods}
    else:
        applied = {k: 1.0 / len(methods) for k in methods}

    concluded = sum(methods[k]["equity_value"] * applied[k] for k in methods)
    return {
        "sde_normalization": normalization,
        "methods": methods,
        "weights": applied,
        "equity_value": _finite(concluded, "smb.equity_value"),
    }
