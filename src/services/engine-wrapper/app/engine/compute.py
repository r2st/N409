"""Full 409A computation: params + inputs → fair market value per common share.

Pipeline (features.md §engine, requirements FR-14/15):
1. Equity value per weighted approach (asset / OPM-backsolve / income / market).
2. Weighted marketable equity value (weights validated to sum to 1).
3. OPM allocation to common: Black-Scholes call over the preferred
   liquidation preference; common participates pro-rata in the upside.
4. DLOC, then DLOM (Chaffee / Finnerty / qualitative).
5. FMV per share over fully diluted common (common + options).
"""

from __future__ import annotations

from datetime import date

from .approaches import EngineInputError, asset_value, income_dcf, market_multiples, opm_backsolve
from .bs import bs_call
from .dlom import chaffee_dlom, finnerty_dlom

ENGINE_VERSION = "py-1.0.0"
DEFAULT_RISK_FREE_RATE = 0.04
DEFAULT_TIME_TO_EXIT_YEARS = 3.0

WEIGHT_KEYS = ("weight_asset", "weight_opm", "weight_income", "weight_market")


def _num(value, name: str, *, positive: bool = False) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be a number") from None
    if positive and out <= 0:
        raise EngineInputError(f"{name} must be positive")
    return out


def _req(value, name: str, *, positive: bool = False) -> float:
    out = _num(value, name, positive=positive)
    if out is None:
        raise EngineInputError(f"{name} is required")
    return out


def _time_to_exit(params: dict, inputs: dict) -> float:
    override = _num(inputs.get("time_to_exit_years"), "time_to_exit_years")
    if override is not None:
        return max(override, 0.0)
    exit_timeline = params.get("exit_timeline")
    if exit_timeline:
        try:
            exit_date = date.fromisoformat(str(exit_timeline)[:10])
            valuation_date = date.fromisoformat(str(inputs.get("valuation_date") or date.today()))
            return max((exit_date - valuation_date).days / 365.25, 0.0)
        except ValueError:
            raise EngineInputError("exit_timeline / valuation_date must be YYYY-MM-DD") from None
    return DEFAULT_TIME_TO_EXIT_YEARS


def _weights(params: dict) -> dict[str, float]:
    raw = {k: params.get(k) for k in WEIGHT_KEYS}
    if all(v is None for v in raw.values()):
        raise EngineInputError("approach weights are not set — save valuation params first")
    weights = {k: _req(v, k) for k, v in raw.items()}
    total = sum(weights.values())
    if abs(total - 1.0) > 1e-6:
        raise EngineInputError(f"approach weights must sum to 1.0 (got {total:.4f})")
    return weights


def compute(params: dict, inputs: dict) -> dict:
    weights = _weights(params)
    t = _time_to_exit(params, inputs)
    r = _num(inputs.get("risk_free_rate"), "risk_free_rate") or DEFAULT_RISK_FREE_RATE
    cash = _num(inputs.get("cash"), "cash") or 0.0
    debt = _num(inputs.get("debt"), "debt") or 0.0

    approaches: dict[str, dict] = {}

    if weights["weight_asset"] > 0:
        asset_in = inputs.get("asset") or {}
        approaches["asset"] = asset_value(
            total_assets=_num(asset_in.get("total_assets"), "asset.total_assets"),
            total_liabilities=_num(asset_in.get("total_liabilities"), "asset.total_liabilities"),
            cost_to_replicate=_num(asset_in.get("cost_to_replicate"), "asset.cost_to_replicate"),
            method=params.get("asset_method"),
        )

    if weights["weight_opm"] > 0:
        post_money = _req(inputs.get("last_round_post_money"), "last_round_post_money", positive=True)
        approaches["opm_backsolve"] = opm_backsolve(post_money)

    if weights["weight_income"] > 0:
        income_in = inputs.get("income") or {}
        fcf = income_in.get("free_cash_flows")
        if not isinstance(fcf, list):
            raise EngineInputError("income.free_cash_flows (list of yearly FCF) is required")
        approaches["income"] = income_dcf(
            [_req(v, "income.free_cash_flows[]") for v in fcf],
            _req(income_in.get("discount_rate"), "income.discount_rate", positive=True),
            _num(income_in.get("terminal_growth"), "income.terminal_growth") or 0.0,
            cash=cash,
            debt=debt,
        )

    if weights["weight_market"] > 0:
        market_in = inputs.get("market") or {}
        multiples = market_in.get("multiples")
        if multiples is None and market_in.get("multiple") is not None:
            multiples = [market_in["multiple"]]
        if not isinstance(multiples, list):
            raise EngineInputError("market.multiples (from comparables) is required")
        metric = _req(market_in.get("metric"), "market.metric", positive=True)
        approaches["market"] = market_multiples(
            metric, [float(m) for m in multiples], cash=cash, debt=debt
        )

    weight_by_approach = {
        "asset": weights["weight_asset"],
        "opm_backsolve": weights["weight_opm"],
        "income": weights["weight_income"],
        "market": weights["weight_market"],
    }
    equity_value = sum(
        approaches[name]["equity_value"] * w for name, w in weight_by_approach.items() if w > 0
    )
    if equity_value <= 0:
        raise EngineInputError(f"weighted equity value is not positive ({equity_value:.2f})")

    # ── OPM allocation to common ────────────────────────────────────────────
    common_shares = _req(inputs.get("shares_outstanding_common"), "shares_outstanding_common", positive=True)
    options = _num(inputs.get("options_outstanding"), "options_outstanding") or 0.0
    preferred_shares = _num(inputs.get("shares_outstanding_preferred"), "shares_outstanding_preferred") or 0.0
    liquidation_preference = _num(inputs.get("liquidation_preference"), "liquidation_preference") or 0.0
    fully_diluted_common = common_shares + options

    volatility = _num(inputs.get("volatility"), "volatility")
    needs_vol = liquidation_preference > 0 or (params.get("dlom_method") in ("chaffee", "finnerty"))
    if needs_vol and volatility is None:
        raise EngineInputError("volatility is required (OPM allocation / model DLOM)")

    if preferred_shares > 0 and liquidation_preference > 0:
        upside = bs_call(equity_value, liquidation_preference, t, r, volatility or 0.0)
        common_fraction = fully_diluted_common / (fully_diluted_common + preferred_shares)
        common_equity = upside * common_fraction
        allocation = {
            "method": "opm_single_breakpoint",
            "breakpoint": liquidation_preference,
            "upside_after_preference": upside,
            "common_fraction": common_fraction,
        }
    else:
        common_fraction = (
            fully_diluted_common / (fully_diluted_common + preferred_shares)
            if preferred_shares > 0
            else 1.0
        )
        common_equity = equity_value * common_fraction
        allocation = {"method": "as_converted", "common_fraction": common_fraction}

    # ── Discounts ───────────────────────────────────────────────────────────
    dloc = _num(params.get("dloc"), "dloc") or 0.0
    method = params.get("dlom_method")
    if method == "chaffee":
        dlom = chaffee_dlom(volatility or 0.0, t, r)
    elif method == "finnerty":
        dlom = finnerty_dlom(volatility or 0.0, t)
    elif method == "qualitative":
        dlom_q = _num(params.get("dlom_qualitative"), "dlom_qualitative")
        dlom = dlom_q if dlom_q is not None else _req(params.get("dlom"), "dlom")
    else:
        dlom = _num(params.get("dlom"), "dlom") or 0.0
    if not 0.0 <= dloc < 1.0 or not 0.0 <= dlom < 1.0:
        raise EngineInputError("dloc/dlom must be fractions in [0, 1)")

    fmv_per_share = common_equity * (1.0 - dloc) * (1.0 - dlom) / fully_diluted_common

    return {
        "engine_version": ENGINE_VERSION,
        "results": {
            "equity_value": round(equity_value, 2),
            "approaches": {
                name: {**data, "weight": weight_by_approach[name]} for name, data in approaches.items()
            },
            "allocation": allocation,
            "common_equity_value": round(common_equity, 2),
            "assumptions": {
                "time_to_exit_years": round(t, 4),
                "risk_free_rate": r,
                "volatility": volatility,
            },
            "discounts": {"dloc": dloc, "dlom": round(dlom, 4), "dlom_method": method},
            "fully_diluted_common": fully_diluted_common,
            "fmv_per_share": round(fmv_per_share, 4),
        },
    }
