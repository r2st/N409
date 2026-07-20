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

import math
from datetime import date

from .approaches import EngineInputError, asset_value, income_dcf, market_multiples, opm_backsolve
from .bs import bs_call
from .dlom import chaffee_dlom, finnerty_dlom
from .pwerm import allocate_pwerm
from .volatility import estimate_volatility
from .wacc import compute_wacc
from .waterfall import allocate_waterfall

ENGINE_VERSION = "py-1.0.0"
DEFAULT_RISK_FREE_RATE = 0.04
DEFAULT_TIME_TO_EXIT_YEARS = 3.0

WEIGHT_KEYS = ("weight_asset", "weight_opm", "weight_income", "weight_market")
APPROACH_KEYS = ("asset", "opm_backsolve", "income", "market")

# Keys accepted inside inputs.wacc when auto_wacc is set (mirrors compute_wacc).
_WACC_KEYS = frozenset(
    {
        "comparable_betas",
        "unlevered_beta_input",
        "target_debt_to_equity",
        "market_cap",
        "tax_rate",
        "equity_risk_premium",
        "forecast_horizon_years",
        "risk_free_rate_override",
        "treasury_curve",
        "company_specific_premium",
        "size_premium_override",
        "cost_of_debt",
        "debt_weight",
    }
)


def _num(value, name: str, *, positive: bool = False) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise EngineInputError(f"{name} must be a number") from None
    # Reject NaN/Inf at the boundary: otherwise they propagate silently through
    # bs_call/allocation and surface as a NaN fair-market value (audit T-1 P3).
    if not math.isfinite(out):
        raise EngineInputError(f"{name} must be a finite number")
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


def _reused_prior(prior_approaches: dict, name: str) -> dict:
    entry = prior_approaches.get(name)
    if not isinstance(entry, dict):
        raise EngineInputError(f"prior_approaches.{name} is required to reuse the {name} approach")
    equity = _num(entry.get("equity_value"), f"prior_approaches.{name}.equity_value")
    if equity is None:
        raise EngineInputError(f"prior_approaches.{name}.equity_value is required")
    # Strip the stale weight; the current params re-weight the merged set.
    reused = {k: v for k, v in entry.items() if k != "weight"}
    reused["reused"] = True
    return reused


def _apply_autopilot(
    params: dict,
    inputs: dict,
    *,
    auto_volatility: bool,
    auto_wacc: bool,
    auto_comparables: bool,
) -> tuple[dict, dict | None]:
    """Run the estimation engines that pre-fill manual inputs (features.md §5).

    Returns a (possibly) modified copy of ``inputs`` plus an ``auto`` metadata
    block describing what was computed. A manually supplied value always wins —
    the auto engines only fill a gap, never override an analyst entry — so the
    pipeline stays backward compatible. Operates on data already carried in
    ``inputs`` (comp price series, beta set, comparable tickers) so a compute
    stays deterministic and offline; live fetching is a separate endpoint.
    """
    if not (auto_volatility or auto_wacc or auto_comparables):
        return inputs, None

    inputs = dict(inputs)  # shallow copy; nested dicts we mutate are copied below
    meta: dict = {}

    # ── auto_comparables → market.multiples from verified comparable tickers ──
    if auto_comparables:
        market_in = dict(inputs.get("market") or {})
        tickers = market_in.get("comparable_tickers")
        if isinstance(tickers, list) and tickers:
            from . import market_data

            metric_field = market_in.get("multiple_metric", "ev_revenue")
            if metric_field not in ("ev_revenue", "ev_ebitda"):
                raise EngineInputError("market.multiple_metric must be 'ev_revenue' or 'ev_ebitda'")
            looked = market_data.lookup(tickers)
            multiples = [
                c[metric_field] for c in looked["companies"] if c.get(metric_field) is not None
            ]
            existing = market_in.get("multiples")
            manual = isinstance(existing, list) and bool(existing)
            if not manual:
                if not multiples:
                    raise EngineInputError(
                        f"auto_comparables: no {metric_field} multiples for {tickers}"
                    )
                market_in["multiples"] = multiples
            inputs["market"] = market_in
            meta["comparables"] = {
                "tickers": tickers,
                "metric": metric_field,
                "resolved_count": len(looked["companies"]),
                "not_found": looked["not_found"],
                "multiples": multiples,
                "used_manual_override": manual,
            }

    # ── auto_volatility → volatility from comparable price series ─────────────
    if auto_volatility:
        comps = inputs.get("volatility_comparables")
        if isinstance(comps, list) and comps:
            method = inputs.get("volatility_method", "historical")
            manual_vol = inputs.get("volatility")
            est = estimate_volatility(
                comps,
                method=method,
                time_to_exit_years=_num(inputs.get("time_to_exit_years"), "time_to_exit_years"),
                manual_override=manual_vol,
            )
            inputs["volatility"] = est["recommended_volatility"]
            meta["volatility"] = est

    # ── auto_wacc → income.discount_rate from CAPM WACC ──────────────────────
    if auto_wacc:
        wacc_in = inputs.get("wacc")
        if isinstance(wacc_in, dict) and wacc_in:
            unknown = set(wacc_in) - _WACC_KEYS
            if unknown:
                raise EngineInputError(f"auto_wacc: unknown wacc keys {sorted(unknown)}")
            result = compute_wacc(**wacc_in)
            income_in = dict(inputs.get("income") or {})
            manual = income_in.get("discount_rate") is not None
            if not manual:
                income_in["discount_rate"] = result["wacc"]
                inputs["income"] = income_in
            meta["wacc"] = {**result, "used_manual_override": manual}

    return inputs, (meta or None)


def _resolve_discounts(
    params: dict, volatility: float | None, t: float, r: float
) -> tuple[float, float, str | None]:
    """DLOC + DLOM (model or qualitative), validated to fractions in [0, 1)."""
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
    return dloc, round(dlom, 4), method


def _compute_pwerm(params: dict, inputs: dict) -> dict:
    """PWERM allocation path (allocation_method == 'pwerm').

    The scenarios themselves determine equity value and its allocation to
    common, so PWERM bypasses the weighted-approach step the OPM path uses.
    Common per-share value then feeds the same DLOC/DLOM discounts.
    """
    pwerm_in = inputs.get("pwerm")
    if not isinstance(pwerm_in, dict):
        raise EngineInputError("allocation_method 'pwerm' requires inputs.pwerm.scenarios")
    scenarios = pwerm_in.get("scenarios")
    share_classes = inputs.get("share_classes")
    if not isinstance(share_classes, list) or not share_classes:
        raise EngineInputError("PWERM requires inputs.share_classes (the cap table)")

    cash = _num(inputs.get("cash"), "cash") or 0.0
    debt = _num(inputs.get("debt"), "debt") or 0.0
    default_rate = _num(pwerm_in.get("discount_rate"), "pwerm.discount_rate")
    if default_rate is None:
        default_rate = _num(inputs.get("risk_free_rate"), "risk_free_rate") or DEFAULT_RISK_FREE_RATE

    allocation = allocate_pwerm(
        scenarios if isinstance(scenarios, list) else [],
        share_classes,
        default_discount_rate=default_rate,
        cash=cash,
        debt=debt,
    )
    equity_value = allocation["equity_value"]
    if equity_value <= 0:
        raise EngineInputError(f"PWERM weighted equity value is not positive ({equity_value:.2f})")

    common_shares = _req(
        inputs.get("shares_outstanding_common"), "shares_outstanding_common", positive=True
    )
    options = _num(inputs.get("options_outstanding"), "options_outstanding") or 0.0
    fully_diluted_common = common_shares + options

    # Expected (probability-weighted) time to exit drives any model DLOM.
    t = allocation["expected_time_to_exit_years"]
    r = _num(inputs.get("risk_free_rate"), "risk_free_rate") or DEFAULT_RISK_FREE_RATE
    method = params.get("dlom_method")
    volatility = _num(inputs.get("volatility"), "volatility", positive=True)
    if method in ("chaffee", "finnerty") and volatility is None:
        raise EngineInputError("volatility is required for the selected model DLOM")

    dloc, dlom, dlom_method = _resolve_discounts(params, volatility, t, r)

    # The waterfall already spread value across the cap table's common shares.
    common_per_share = allocation["common_per_share"]
    fmv_per_share = common_per_share * (1.0 - dloc) * (1.0 - dlom)

    results: dict = {
        "equity_value": round(equity_value, 2),
        "allocation": allocation,
        "allocation_method": "pwerm",
        "common_equity_value": round(allocation["common_value"], 2),
        "assumptions": {
            "expected_time_to_exit_years": t,
            "risk_free_rate": r,
            "volatility": volatility,
        },
        "discounts": {"dloc": dloc, "dlom": dlom, "dlom_method": dlom_method},
        "fully_diluted_common": fully_diluted_common,
        "fmv_per_share": round(fmv_per_share, 4),
    }
    return {"engine_version": ENGINE_VERSION, "results": results}


def compute(
    params: dict,
    inputs: dict,
    recompute: list[str] | None = None,
    prior_approaches: dict | None = None,
    *,
    auto_volatility: bool = False,
    auto_wacc: bool = False,
    auto_comparables: bool = False,
) -> dict:
    """Full 409A computation, or — with `recompute` — a per-subsystem rerun.

    When `recompute` names a subset of APPROACH_KEYS, only those approaches are
    computed fresh; the rest reuse `prior_approaches` (a previous run's
    results.approaches). Weighting, allocation and discounts always re-run.

    The `auto_*` flags run the estimation engines (volatility / WACC /
    comparables) to pre-fill their manual inputs before the calculation; a
    manual value always takes precedence, so the flags are backward compatible.
    """
    inputs, auto_meta = _apply_autopilot(
        params,
        inputs,
        auto_volatility=auto_volatility,
        auto_wacc=auto_wacc,
        auto_comparables=auto_comparables,
    )

    if recompute is not None:
        unknown = set(recompute) - set(APPROACH_KEYS)
        if unknown:
            raise EngineInputError(f"unknown recompute approaches: {sorted(unknown)}")
        if not recompute:
            raise EngineInputError("recompute must name at least one approach")
    prior = prior_approaches or {}

    # PWERM is a self-contained allocation method: its discrete exit scenarios
    # set both the equity value and the allocation to common, so it bypasses
    # the weighted-approach + OPM chain the default path runs.
    allocation_method = params.get("allocation_method") or "opm"
    if allocation_method not in ("opm", "pwerm"):
        raise EngineInputError("allocation_method must be 'opm' or 'pwerm'")
    if allocation_method == "pwerm":
        out = _compute_pwerm(params, inputs)
        if auto_meta is not None:
            out["results"]["auto"] = auto_meta
        return out

    def _fresh(name: str) -> bool:
        """Full runs compute everything; partial runs compute the selected
        approaches and anything the prior run can't supply."""
        return recompute is None or name in recompute or name not in prior

    weights = _weights(params)
    t = _time_to_exit(params, inputs)
    r = _num(inputs.get("risk_free_rate"), "risk_free_rate") or DEFAULT_RISK_FREE_RATE
    cash = _num(inputs.get("cash"), "cash") or 0.0
    debt = _num(inputs.get("debt"), "debt") or 0.0

    approaches: dict[str, dict] = {}

    if weights["weight_asset"] > 0:
        if _fresh("asset"):
            asset_in = inputs.get("asset") or {}
            approaches["asset"] = asset_value(
                total_assets=_num(asset_in.get("total_assets"), "asset.total_assets"),
                total_liabilities=_num(asset_in.get("total_liabilities"), "asset.total_liabilities"),
                cost_to_replicate=_num(asset_in.get("cost_to_replicate"), "asset.cost_to_replicate"),
                method=params.get("asset_method"),
            )
        else:
            approaches["asset"] = _reused_prior(prior, "asset")

    if weights["weight_opm"] > 0:
        if _fresh("opm_backsolve"):
            pps = _num(inputs.get("last_round_price_per_share"), "last_round_price_per_share")
            vol_early = _num(inputs.get("volatility"), "volatility")
            raw_classes = inputs.get("share_classes")
            if pps is not None and pps > 0 and vol_early is not None and vol_early > 0:
                # True backsolve (remaining-gaps §2): root-find the equity
                # value that reprices the last round's preferred to its PPS.
                approaches["opm_backsolve"] = opm_backsolve(
                    _num(inputs.get("last_round_post_money"), "last_round_post_money"),
                    last_round_pps=pps,
                    share_classes=raw_classes if isinstance(raw_classes, list) and raw_classes else None,
                    last_round_class=inputs.get("last_round_class"),
                    preferred_shares=_num(
                        inputs.get("shares_outstanding_preferred"), "shares_outstanding_preferred"
                    ),
                    liquidation_preference=_num(
                        inputs.get("liquidation_preference"), "liquidation_preference"
                    ),
                    common_shares=_num(inputs.get("shares_outstanding_common"), "shares_outstanding_common"),
                    t=t,
                    r=r,
                    sigma=vol_early,
                )
            else:
                post_money = _req(inputs.get("last_round_post_money"), "last_round_post_money", positive=True)
                approaches["opm_backsolve"] = opm_backsolve(post_money)
        else:
            approaches["opm_backsolve"] = _reused_prior(prior, "opm_backsolve")

    if weights["weight_income"] > 0:
        if _fresh("income"):
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
        else:
            approaches["income"] = _reused_prior(prior, "income")

    if weights["weight_market"] > 0:
        if _fresh("market"):
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
        else:
            approaches["market"] = _reused_prior(prior, "market")

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

    share_classes = inputs.get("share_classes")
    has_waterfall = isinstance(share_classes, list) and len(share_classes) > 0

    # Volatility must be strictly positive: a negative value would otherwise be
    # passed straight to bs_call (σ ≤ 0 → intrinsic) and silently produce a
    # wrong allocation instead of an error (audit T-1 P3).
    volatility = _num(inputs.get("volatility"), "volatility", positive=True)
    needs_vol = (
        liquidation_preference > 0
        or has_waterfall
        or (params.get("dlom_method") in ("chaffee", "finnerty"))
    )
    if needs_vol and volatility is None:
        raise EngineInputError("volatility is required (OPM allocation / model DLOM)")

    waterfall_per_share: float | None = None
    if has_waterfall:
        # Full cap-table waterfall (remaining-gaps §2 — multi-breakpoint).
        allocation = allocate_waterfall(equity_value, share_classes, t, r, volatility or 0.0)
        common_equity = allocation["common_value"]
        waterfall_per_share = allocation["common_per_share"]
    elif preferred_shares > 0 and liquidation_preference > 0:
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
    dloc, dlom, method = _resolve_discounts(params, volatility, t, r)

    if waterfall_per_share is not None:
        # Waterfall already spread value over the cap table's common shares.
        fmv_per_share = waterfall_per_share * (1.0 - dloc) * (1.0 - dlom)
    else:
        fmv_per_share = common_equity * (1.0 - dloc) * (1.0 - dlom) / fully_diluted_common

    results: dict = {
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
    }
    if recompute is not None:
        results["recomputed"] = sorted(recompute)
    if auto_meta is not None:
        results["auto"] = auto_meta
    return {"engine_version": ENGINE_VERSION, "results": results}
