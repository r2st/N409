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

from .approaches import (
    MARKET_HORIZONS,
    EngineInputError,
    asset_value,
    income_dcf,
    market_multiples,
    opm_backsolve,
)
from .bs import bs_call
from .current_value import allocate_cvm
from .dlom import (
    DLOM_METHODS,
    DLOM_VOLATILITY_BASES,
    chaffee_dlom,
    finnerty_dlom,
    ghaidarov_dlom,
    longstaff_bound,
    longstaff_dlom,
    restricted_stock_dlom,
    selects_model_dlom,
)
from .hybrid import blend_hybrid, resolve_hybrid_weights
from .market_movement import apply_movement, market_movement
from .monte_carlo import allocate_monte_carlo
from .pwerm import allocate_pwerm
from .trace import Trace
from .volatility import estimate_volatility
from .wacc import compute_wacc
from .waterfall import allocate_waterfall, class_volatilities

ENGINE_VERSION = "py-1.0.0"

ALLOCATION_METHODS = ("opm", "pwerm", "hybrid", "cvm", "monte_carlo")
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


def _num(value, name: str, *, positive: bool = False, nonneg: bool = False) -> float | None:
    if value is None:
        return None
    # A bool is not a figure, and `float(True)` is `1.0` — so without this every
    # numeric input on the engine silently accepts `true` and values the company
    # as though the analyst had typed a 1.
    #
    # JSON makes this reachable rather than theoretical: the extraction agents,
    # the HRIS/cap-table importers and the intake forms all map upstream fields
    # onto this payload, and a source column that is a flag ("has terminal
    # growth?", "is participating?") lands here as `true` whenever a mapping is
    # off by one field. Nothing downstream can tell it apart from a deliberate 1.
    #
    # `validate._finite` has always refused bools for exactly this reason, which
    # is what keeps most of these fields safe today — `/compute` pre-flights, so
    # a bool share count is caught there and answered 422. That made this look
    # like dead defence, and it is not: `terminal_growth` was not covered by the
    # pre-flight (see `validate._check_income`), so `terminal_growth: true` was
    # read here as 100% perpetual growth and returned a fair market value three
    # times the correct one, with no error and no warning on the response.
    # `/sensitivity` has no pre-flight at all and calls `compute` directly.
    #
    # So the two layers are made to agree, rather than leaving `compute` relying
    # on a caller having run the validator first.
    if isinstance(value, bool):
        raise EngineInputError(f"{name} must be a number, not a true/false value")
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
    # `nonneg` is for the quantities that are *optionally* zero but never below
    # it — share counts and the preference stack. Zero is a real answer there
    # ("no preferred outstanding"); a negative one is a typo that every
    # allocation branch reads as zero, dropping the whole preference stack and
    # handing common the entire equity value without a word. See the matching
    # pre-flight checks in validate._check_cap_table.
    if nonneg and out < 0:
        raise EngineInputError(f"{name} cannot be negative")
    return out


def _flag(value, name: str) -> bool:
    """A true/false switch, or an EngineInputError naming the field.

    The mirror image of `_num`'s bool guard, and refused for the same reason
    read the other way round: a methodology switch is not a quantity, and
    ``mid_year_convention: 1`` or ``"true"`` arriving from a form that
    stringifies its checkboxes must not be read as a silent yes. The convention
    moves the income approach by 8-12%, so which of the two ran has to be a
    thing the caller said, not a coercion.
    """
    if value is None:
        return False
    if not isinstance(value, bool):
        raise EngineInputError(f"{name} must be true or false")
    return value


def _section(inputs: dict, name: str) -> dict:
    """Read a nested inputs object (`income`, `market`, `asset`) as a dict.

    `inputs.get(name) or {}` was the idiom, and it only defaults on a *falsy*
    value. A truthy non-object — `"income": "2026-01-01"`, `"market": 5`,
    a list left by a client that serialised its form state wrong — passed
    straight through, and the very next line called `.get` on it: an
    AttributeError, which is not an EngineInputError, so it left the service
    as a 500.

    `/compute` mostly hid this because `validate_payload` runs first and
    rejects the shape. `/sensitivity` has no pre-flight — it calls `compute`
    directly inside a `try` that only catches EngineInputError — so every one
    of these was a live 500 there, on a request the caller can only read as
    "the engine is broken" rather than "your `income` field is not an object".

    Absent and null still default to an empty section; the required-field
    checks downstream are what report what is actually missing.
    """
    section = inputs.get(name)
    if section is None:
        return {}
    if not isinstance(section, dict):
        raise EngineInputError(f"{name} must be an object")
    return section


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
            # `[:10]` on both, as `validate._check_dates` does on both. Only
            # `exit_timeline` was truncated here, so a `valuation_date` carrying
            # a time — the shape a timestamp column serialises to, and one
            # `_check_dates` accepts without complaint — passed preflight
            # validation clean and then failed the calculation it had just
            # cleared. `date.fromisoformat` rejects a datetime string outright.
            raw_valuation = inputs.get("valuation_date") or date.today()
            valuation_date = date.fromisoformat(str(raw_valuation)[:10])
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
        market_in = dict(_section(inputs, "market"))
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
            income_in = dict(_section(inputs, "income"))
            manual = income_in.get("discount_rate") is not None
            if not manual:
                income_in["discount_rate"] = result["wacc"]
                inputs["income"] = income_in
            meta["wacc"] = {**result, "used_manual_override": manual}

    return inputs, (meta or None)


#: params.market_method → the metric's name and the inputs key holding it per
#: horizon. `market_method` names *what* is multiplied, `market_horizon` names
#: *when* — the pair picks one figure.
_MARKET_METRIC_KEYS: dict[str, dict[str, str]] = {
    "revenue": {"ltm": "revenue_ltm", "ntm": "revenue_ntm"},
    "ebitda": {"ltm": "ebitda_ltm", "ntm": "ebitda_ntm"},
}


def _market_metric(params: dict, inputs: dict, market_in: dict) -> tuple[str, str | None, float]:
    """The (horizon, basis, metric) the market approach multiplies.

    An explicit ``inputs.market.metric`` wins — an analyst who typed a figure
    means that figure. Absent one, it is resolved from the extracted financials
    by the two params that until now only travelled with the payload:
    ``market_method`` (revenue / ebitda) and ``market_horizon`` (ltm / ntm).

    That resolution is the whole point. Extraction has always pulled
    ``revenue_ntm`` off the projections and nothing read it, so a valuation
    configured for forward multiples was silently struck on trailing revenue —
    the same 8.0× against a smaller number, understating a growing company by
    its growth rate with nothing on the result saying so. The horizon now picks
    the metric, and `market_multiples` records which one it picked.
    """
    horizon = str(params.get("market_horizon") or "ltm").lower()
    if horizon not in MARKET_HORIZONS:
        raise EngineInputError(
            f"market_horizon must be one of {list(MARKET_HORIZONS)} (got {horizon!r})"
        )
    method = params.get("market_method")
    basis = str(method).lower() if method else None

    explicit = _num(market_in.get("metric"), "market.metric")
    if explicit is not None:
        if explicit <= 0:
            raise EngineInputError("market.metric must be positive")
        return horizon, basis, explicit

    if basis not in _MARKET_METRIC_KEYS:
        raise EngineInputError(
            "market.metric is required (or set params.market_method to 'revenue' or "
            "'ebitda' so it can be read from the extracted financials)"
        )
    key = _MARKET_METRIC_KEYS[basis][horizon]
    resolved = _num(inputs.get(key), key)
    if resolved is None:
        other = _MARKET_METRIC_KEYS[basis]["ltm" if horizon == "ntm" else "ntm"]
        raise EngineInputError(
            f"market.metric is required: params select the {horizon.upper()} {basis} multiple, "
            f"so inputs.{key} must be set (inputs.{other} is the other horizon and is not "
            "interchangeable with it)"
        )
    if resolved <= 0:
        # EBITDA is routinely negative for a venture-backed company, and a
        # negative denominator makes a multiple meaningless rather than small.
        raise EngineInputError(
            f"inputs.{key} must be positive to strike a multiple against it (got {resolved:g}) — "
            "weight the market approach to zero, or value on revenue instead"
        )
    return horizon, basis, resolved


def _resolve_dloc(params: dict) -> float:
    """The discount for lack of control. Placeholder until the study-based
    derivation lands; see `_resolve_dloc_detail`."""
    return _num(params.get("dloc"), "dloc") or 0.0


def _resolve_discounts(
    params: dict,
    volatility: float | None,
    t: float,
    r: float,
    volatility_basis: str = "enterprise",
) -> tuple[float, float, str | None, dict | None]:
    """DLOC + DLOM (model, study, qualitative, or a weighted blend of those).

    The fourth return is the working behind the discount, or None for the
    methods that have none.

    A blend is requested with `dlom_methods`, and it takes precedence over the
    singular `dlom_method` in the sense that the two may not both be set — see
    `_blended_dlom` for why an appraiser weights several methods rather than
    picking one, and why the weights are not normalised for them.

    ``volatility_basis`` labels which volatility ``volatility`` *is* — the
    enterprise figure or the geared common-class one (see `_dlom_volatility`).
    It changes no arithmetic here; it travels so that the model detail records
    which of the two a reviewer is being shown.
    """
    dloc = _resolve_dloc(params)
    blend_in = params.get("dlom_methods")
    if blend_in is not None:
        if params.get("dlom_method") is not None:
            raise EngineInputError(
                "set either dlom_method (one method) or dlom_methods (a weighted blend), "
                "not both — the two would disagree about which discount was concluded"
            )
        detail = _blended_dlom(blend_in, params, volatility, t, r, volatility_basis)
        dlom = float(detail["dlom"])
        if not 0.0 <= dloc < 1.0 or not 0.0 <= dlom < 1.0:
            raise EngineInputError("dloc/dlom must be fractions in [0, 1)")
        return dloc, round(dlom, 4), "weighted", detail

    dlom, method, detail = _single_dlom(params, volatility, t, r, volatility_basis)
    if not 0.0 <= dloc < 1.0 or not 0.0 <= dlom < 1.0:
        raise EngineInputError("dloc/dlom must be fractions in [0, 1)")
    return dloc, round(dlom, 4), method, detail


def _single_dlom(
    params: dict,
    volatility: float | None,
    t: float,
    r: float,
    volatility_basis: str = "enterprise",
) -> tuple[float, str | None, dict | None]:
    """One method's discount and its working.

    Split out of `_resolve_discounts` so a weighted blend computes each of its
    components through exactly the path a single-method run would take. A blend
    whose components were derived by a second copy of these branches could
    report a Chaffee leg the single-method run does not agree with.
    """
    method = params.get("dlom_method")
    detail: dict | None = None
    if method == "chaffee":
        dlom = chaffee_dlom(volatility or 0.0, t, r)
        detail = _model_detail("chaffee", volatility, t, r, dlom, volatility_basis, uses_rate=True)
    elif method == "finnerty":
        dlom = finnerty_dlom(volatility or 0.0, t)
        detail = _model_detail("finnerty", volatility, t, r, dlom, volatility_basis)
    elif method == "ghaidarov":
        dlom = ghaidarov_dlom(volatility or 0.0, t)
        detail = _model_detail("ghaidarov", volatility, t, r, dlom, volatility_basis)
    elif method == "longstaff":
        dlom = longstaff_dlom(volatility or 0.0, t)
        # The bound itself, not just the discount derived from it — a report
        # concluding on Longstaff has to disclose that it is an upper bound.
        detail = {
            "method": "longstaff",
            "volatility": volatility,
            "volatility_basis": volatility_basis,
            "bound_multiple": round(longstaff_bound(volatility or 0.0, t), 6),
            "is_upper_bound": True,
        }
    elif method == "restricted_stock":
        study_in = params.get("dlom_studies")
        table_in = params.get("dlom_study_table")
        blend = restricted_stock_dlom(
            selected=study_in if isinstance(study_in, list) else None,
            studies=table_in if isinstance(table_in, list) else None,
            statistic=str(params.get("dlom_statistic") or "median"),
        )
        dlom = float(blend["dlom"])
        detail = blend
    elif method == "qualitative":
        dlom_q = _num(params.get("dlom_qualitative"), "dlom_qualitative")
        dlom = dlom_q if dlom_q is not None else _req(params.get("dlom"), "dlom")
        detail = {
            "method": "qualitative",
            "dlom": round(dlom, 6),
            "basis": "analyst judgement — no model or study was applied",
        }
    else:
        dlom = _num(params.get("dlom"), "dlom") or 0.0
    return dlom, method, detail


#: A blend narrower than this is a single method with extra steps. Two is the
#: point at which weighting means anything, and the appraisal literature's whole
#: argument for it is that the option models and the empirical studies measure
#: different things — so a blend of one is refused rather than quietly accepted.
_MIN_BLEND_METHODS = 2


def _blended_dlom(
    raw: object,
    params: dict,
    volatility: float | None,
    t: float,
    r: float,
    volatility_basis: str = "enterprise",
) -> dict:
    """Several DLOM methods, weighted into one concluded discount.

    Why a blend at all. A marketability discount is the one figure in a 409A
    with no single defensible derivation: the option models price the *cost of
    being unable to sell* from the subject's own volatility and holding period,
    and the restricted-stock studies report what the market actually paid for
    restricted shares. They are evidence of different kinds, and the standard
    appraisal answer is to weight them rather than to declare one correct —
    which is what the legacy deliverable's "DLOM Method / Weight / Selected
    DLOM" table is. The engine could only pick one, so an appraiser wanting a
    50/50 of Finnerty and the studies had to compute it by hand and enter the
    result as `qualitative`, which recorded their arithmetic as judgement and
    left the report unable to say where the number came from.

    The weights are not normalised. Weights that sum to 0.9 are a mistake in
    somebody's spreadsheet, not an instruction to scale up by a ninth, and
    silently rescaling them would conclude on a discount nobody chose. This is
    the same rule `_weights` applies to the approach weights, for the same
    reason and to the same tolerance.

    Each component is resolved through `_single_dlom`, so a leg of a blend and a
    single-method run of the same method are the same arithmetic on the same
    inputs, and each component's own working is kept: the concluded figure is a
    weighted average, and a reviewer checks a weighted average by reading the
    legs.
    """
    if not isinstance(raw, list) or not raw:
        raise EngineInputError("dlom_methods must be a non-empty list of {method, weight} objects")
    if len(raw) < _MIN_BLEND_METHODS:
        raise EngineInputError(
            f"dlom_methods needs at least {_MIN_BLEND_METHODS} methods to weight "
            "(use dlom_method for a single method)"
        )

    components: list[dict] = []
    seen: set[str] = set()
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise EngineInputError(f"dlom_methods[{i}] must be an object")
        name = entry.get("method")
        if not isinstance(name, str) or name not in DLOM_METHODS:
            raise EngineInputError(
                f"dlom_methods[{i}].method must be one of {sorted(DLOM_METHODS)} (got {name!r})"
            )
        if name in seen:
            # Two rows for one method are two weights on one number; whichever
            # the engine dropped would be the one the analyst meant.
            raise EngineInputError(f"dlom_methods names {name!r} twice — give it a single weight")
        seen.add(name)
        weight = entry.get("weight")
        if not isinstance(weight, (int, float)) or isinstance(weight, bool):
            raise EngineInputError(f"dlom_methods[{i}].weight must be a number")
        weight = float(weight)
        if not math.isfinite(weight) or not 0.0 <= weight <= 1.0:
            raise EngineInputError(
                f"dlom_methods[{i}].weight must be a fraction in [0, 1] (got {weight:g})"
            )

        components.append({"method": name, "weight": weight})

    total = sum(c["weight"] for c in components)
    if abs(total - 1.0) > 1e-6:
        raise EngineInputError(f"dlom_methods weights must sum to 1.0 (got {total:.4f})")

    for component in components:
        # Each leg sees the run's params with its own method selected, so a
        # `restricted_stock` leg still reads `dlom_studies` / `dlom_statistic`
        # and a `qualitative` leg still reads `dlom_qualitative`. A blend is a
        # choice about weighting, not a different set of inputs.
        leg_params = {**params, "dlom_method": component["method"]}
        leg_params.pop("dlom_methods", None)
        leg_dlom, _, leg_detail = _single_dlom(leg_params, volatility, t, r, volatility_basis)
        component["dlom"] = round(leg_dlom, 6)
        component["weighted"] = round(leg_dlom * component["weight"], 6)
        if leg_detail is not None:
            component["detail"] = leg_detail

    concluded = sum(c["weighted"] for c in components)
    return {
        "method": "weighted",
        "dlom": min(max(round(concluded, 6), 0.0), 0.99),
        "components": components,
        "weight_total": round(total, 6),
        "basis": (
            "Weighted average of the methods below. The option models price the cost of "
            "being unable to sell from the subject's own volatility and holding period; the "
            "restricted-stock studies report what the market paid for restricted shares. "
            "They are evidence of different kinds and are weighted rather than ranked."
        ),
    }


# The formula each option-based model applies, as the report prints it. Kept
# beside the branch that calls the model rather than in the report service: the
# engine is what knows which closed form actually ran, and a deliverable that
# names a different one than the arithmetic used is the defect this exists to
# prevent.
_DLOM_FORMULAE: dict[str, str] = {
    "chaffee": (
        "Chaffee protective put — an at-the-money European put over the holding period, "
        "priced by Black-Scholes on a unit share: the cost of insuring against the price "
        "moving while the holder cannot sell"
    ),
    "finnerty": (
        "Finnerty average-strike put — 2N(v/2) - 1 with effective variance "
        "v²T = σ²T + ln(2(e^{σ²T} − σ²T − 1)) − 2ln(e^{σ²T} − 1); "
        "the value forgone by giving up the choice of when to sell"
    ),
    "ghaidarov": (
        "Ghaidarov average-strike put — the same 2N(v/2) - 1 with the corrected "
        "effective variance v²T = ln(2(e^{σ²T} − σ²T − 1)/(σ²T)²), "
        "which removes Finnerty's ~32.3% ceiling"
    ),
}


def _model_detail(
    method: str,
    volatility: float | None,
    t: float,
    r: float,
    dlom: float,
    volatility_basis: str = "enterprise",
    uses_rate: bool = False,
) -> dict:
    """The inputs an option-based DLOM was struck on, and the discount they gave.

    Without this the result document carries a bare percentage. A reviewer
    asked to accept a 24.5% marketability discount has to be able to see the
    volatility and the holding period it came from, because those two inputs
    *are* the argument — the model itself is arithmetic nobody disputes. The
    same three numbers are what the report's DLOM exhibit tabulates, so they
    are recorded here rather than re-derived there from inputs that may have
    moved since the run.

    The risk-free rate is reported only for Chaffee, which is the only one of
    the three whose closed form uses it; listing it against Finnerty would
    imply a dependence the model does not have.

    ``volatility_basis`` names *which* volatility the figure above it is: the
    enterprise one, or the geared common-class one the waterfall implies. That
    label is not decoration — the two differ by the whole preference stack, and
    a reviewer handed a 79% volatility on a company whose enterprise volatility
    is 62% needs to be told which one they are reading before they check it.
    """
    out: dict = {
        "method": method,
        "volatility": volatility,
        "volatility_basis": volatility_basis,
        "time_to_liquidity_years": t,
        "dlom": round(dlom, 6),
        "formula": _DLOM_FORMULAE.get(method, ""),
    }
    if uses_rate:
        out["risk_free_rate"] = r
    return out


def _discounts_block(dloc: float, dlom: float, method: str | None, detail: dict | None) -> dict:
    """The `results.discounts` object every allocation path reports.

    One builder rather than four literals: the model detail was added in one
    place and silently missing from the other three when this was inlined, and
    the report exhibit reads whichever path the valuation happened to take.
    """
    block: dict = {"dloc": dloc, "dlom": round(dlom, 4), "dlom_method": method}
    if detail is not None:
        block["dlom_detail"] = detail
    return block


def _attach_market_movement(results: dict, we: dict) -> None:
    """Lift the market-movement adjustment to the top of the result document.

    It already rides on `approaches.opm_backsolve`, where the arithmetic used
    it. It is repeated here because it is a *conclusion-level* adjustment — the
    legacy deliverable gives it its own chapter — and a consumer building the
    reconciliation exhibit should not have to know which approach happened to
    carry it. Absent entirely when no benchmark was supplied, so its presence
    means an adjustment was made rather than that one was considered.
    """
    if we.get("market_movement") is not None:
        results["market_movement"] = we["market_movement"]


def _attach_class_volatility(results: dict, alloc: dict) -> None:
    """Same, for the per-class volatility schedule (only the waterfall has one)."""
    if alloc.get("class_volatility") is not None:
        results["class_volatility"] = alloc["class_volatility"]


def _pwerm_allocation(inputs: dict) -> dict:
    """Run the PWERM waterfall allocation from ``inputs`` (shared by the PWERM
    and hybrid paths). Returns the ``allocate_pwerm`` result dict."""
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
    return allocation


def _compute_pwerm(params: dict, inputs: dict, trace: Trace | None = None) -> dict:
    """PWERM allocation path (allocation_method == 'pwerm').

    The scenarios themselves determine equity value and its allocation to
    common, so PWERM bypasses the weighted-approach step the OPM path uses.
    Common per-share value then feeds the same DLOC/DLOM discounts.
    """
    tr = trace or Trace.off()
    # Recorded as a skipped step rather than simply left out. A trace whose
    # steps differ silently by allocation method makes the reader wonder
    # whether the weighting is missing or merely inapplicable, and that is the
    # single most load-bearing fact about how PWERM differs from the rest.
    tr.record(
        "weighting",
        "Weighted equity value",
        status="skipped",
        note="PWERM derives equity value from its scenarios; the four approaches do not run",
    )
    allocation = _pwerm_allocation(inputs)
    equity_value = allocation["equity_value"]
    tr.record(
        "allocation",
        "Allocation to common (pwerm)",
        inputs={"scenarios": inputs.get("pwerm")},
        outputs=allocation,
    )

    # Still required and still validated — a PWERM payload without a common
    # share count is incomplete, and a negative pool is a typo either way — but
    # the *reported* basis comes from the waterfall below, not from these. PWERM
    # allocates through `exit_allocation`, which values the option pool as its
    # own class, so its `common_per_share` is over the cap table's common
    # shares. See the note in `_opm_allocate`.
    _req(inputs.get("shares_outstanding_common"), "shares_outstanding_common", positive=True)
    _num(inputs.get("options_outstanding"), "options_outstanding", nonneg=True)
    fully_diluted_common = allocation["common_shares"]

    # Expected (probability-weighted) time to exit drives any model DLOM.
    t = allocation["expected_time_to_exit_years"]
    r = _num(inputs.get("risk_free_rate"), "risk_free_rate") or DEFAULT_RISK_FREE_RATE
    volatility = _num(inputs.get("volatility"), "volatility", positive=True)
    if selects_model_dlom(params) and volatility is None:
        raise EngineInputError("volatility is required for the selected model DLOM")

    dloc, dlom, dlom_method, dlom_detail = _resolve_discounts(params, volatility, t, r)

    # The waterfall already spread value across the cap table's common shares.
    common_per_share = allocation["common_per_share"]
    fmv_per_share = common_per_share * (1.0 - dloc) * (1.0 - dlom)
    _record_discounts(tr, params, common_per_share, dloc, dlom, dlom_method, dlom_detail, fmv_per_share)

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
        "discounts": _discounts_block(dloc, dlom, dlom_method, dlom_detail),
        "fully_diluted_common": fully_diluted_common,
        "fully_diluted_basis": "cap_table_common",
        "fmv_per_share": round(fmv_per_share, 4),
    }
    return {"engine_version": ENGINE_VERSION, "results": results}


def _weighted_equity(
    params: dict, inputs: dict, recompute: list[str] | None, prior: dict, trace: Trace | None = None
) -> dict:
    """Weighted marketable equity value across the four approaches.

    Shared by the OPM, hybrid and CVM paths (PWERM derives equity value from its
    scenarios instead). Returns the equity value, the per-approach results and
    weights, and the resolved time / rate / cash / debt.
    """
    tr = trace or Trace.off()

    def _fresh(name: str) -> bool:
        """Full runs compute everything; partial runs compute the selected
        approaches and anything the prior run can't supply."""
        return recompute is None or name in recompute or name not in prior

    def _record_approach(name: str, label: str, weight: float, section: dict | None) -> None:
        """One step per approach, including the ones that produced nothing.

        A zero-weight approach and one reused from an earlier run are both
        simply absent from `results.approaches`, and they mean opposite things:
        the first was excluded on purpose, the second is a number computed
        against inputs that may since have changed. The step view is the only
        place that distinction is visible.
        """
        if weight <= 0:
            tr.record(
                f"approach.{name}",
                label,
                status="skipped",
                inputs={"weight": weight},
                note="zero weight — excluded from the conclusion",
            )
        elif _fresh(name):
            tr.record(
                f"approach.{name}",
                label,
                inputs={"weight": weight, **(section or {})},
                outputs=approaches[name],
            )
        else:
            tr.record(
                f"approach.{name}",
                label,
                status="reused",
                inputs={"weight": weight},
                outputs=approaches[name],
                note="carried from the previous run — this recalculation did not name it",
            )

    weights = _weights(params)
    t = _time_to_exit(params, inputs)
    r = _num(inputs.get("risk_free_rate"), "risk_free_rate") or DEFAULT_RISK_FREE_RATE
    cash = _num(inputs.get("cash"), "cash") or 0.0
    debt = _num(inputs.get("debt"), "debt") or 0.0

    approaches: dict[str, dict] = {}
    market_movement_applied: dict | None = None

    if weights["weight_asset"] > 0:
        if _fresh("asset"):
            asset_in = _section(inputs, "asset")
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
                    # The pool travels with the common count, because
                    # `_opm_allocate` folds it into fully-diluted common and the
                    # backsolve inverts that same split. Leaving it out here
                    # solved the round against a cap table the allocation does
                    # not use — see `opm_backsolve`'s `fully_diluted_common`.
                    options_shares=_num(
                        inputs.get("options_outstanding"), "options_outstanding", nonneg=True
                    ),
                    t=t,
                    r=r,
                    sigma=vol_early,
                )
            else:
                post_money = _req(inputs.get("last_round_post_money"), "last_round_post_money", positive=True)
                approaches["opm_backsolve"] = opm_backsolve(post_money)
        else:
            approaches["opm_backsolve"] = _reused_prior(prior, "opm_backsolve")

        # The round the backsolve reads is dated; the valuation is not. Where
        # the analyst has supplied a benchmark for the interval between them,
        # the indication is moved by it before it is weighted — see
        # `market_movement`. The unadjusted figure is kept beside the adjusted
        # one, because "what the round said" and "what we concluded it implies
        # today" are two different assertions and a reviewer checks both.
        movement_in = inputs.get("market_movement")
        if isinstance(movement_in, dict) and movement_in:
            movement = market_movement(movement_in)
            unadjusted = approaches["opm_backsolve"]["equity_value"]
            adjusted = apply_movement(unadjusted, movement)
            approaches["opm_backsolve"] = {
                **approaches["opm_backsolve"],
                "equity_value": adjusted,
                "unadjusted_equity_value": unadjusted,
                "market_movement": movement,
            }
            market_movement_applied = movement
            tr.record(
                "market_movement",
                "Market movement adjustment",
                inputs={"unadjusted_equity_value": unadjusted, **movement},
                outputs={"equity_value": adjusted},
                note=(
                    f"the round indication moved {movement['index_return'] * 100:+.1f}% on the "
                    f"benchmark at beta {movement['beta']:g}"
                ),
            )

    if weights["weight_income"] > 0:
        if _fresh("income"):
            income_in = _section(inputs, "income")
            fcf = income_in.get("free_cash_flows")
            if not isinstance(fcf, list):
                raise EngineInputError("income.free_cash_flows (list of yearly FCF) is required")
            approaches["income"] = income_dcf(
                [_req(v, "income.free_cash_flows[]") for v in fcf],
                _req(income_in.get("discount_rate"), "income.discount_rate", positive=True),
                _num(income_in.get("terminal_growth"), "income.terminal_growth") or 0.0,
                cash=cash,
                debt=debt,
                mid_year_convention=_flag(
                    income_in.get("mid_year_convention"), "income.mid_year_convention"
                ),
                terminal_method=str(income_in.get("terminal_method") or "gordon"),
                exit_multiple=_num(income_in.get("exit_multiple"), "income.exit_multiple", positive=True),
                terminal_metric=_num(income_in.get("terminal_metric"), "income.terminal_metric"),
                terminal_metric_basis=(
                    str(income_in["terminal_metric_basis"])
                    if income_in.get("terminal_metric_basis") is not None
                    else None
                ),
            )
        else:
            approaches["income"] = _reused_prior(prior, "income")

    if weights["weight_market"] > 0:
        if _fresh("market"):
            market_in = _section(inputs, "market")
            multiples = market_in.get("multiples")
            if multiples is None and market_in.get("multiple") is not None:
                multiples = [market_in["multiple"]]
            if not isinstance(multiples, list):
                raise EngineInputError("market.multiples (from comparables) is required")
            horizon, basis, metric = _market_metric(params, inputs, market_in)
            # `float(m)` raised ValueError on "12.5x" and TypeError on a null,
            # neither of which is an EngineInputError — so a single unusable
            # entry in an otherwise fine list of comparables left the endpoint
            # as an unhandled 500 rather than the 422 the caller can act on.
            # Preflight validation does not catch it either: it drops the
            # unusable entries and passes the list as long as one good multiple
            # survives, so `[8.0, null]` cleared validation and then crashed the
            # calculation it had just cleared.
            approaches["market"] = market_multiples(
                metric,
                [_req(m, "market.multiples[]") for m in multiples],
                cash=cash,
                debt=debt,
                horizon=horizon,
                basis=basis,
            )
        else:
            approaches["market"] = _reused_prior(prior, "market")

    weight_by_approach = {
        "asset": weights["weight_asset"],
        "opm_backsolve": weights["weight_opm"],
        "income": weights["weight_income"],
        "market": weights["weight_market"],
    }
    _record_approach("asset", "Asset approach", weights["weight_asset"], _section(inputs, "asset"))
    _record_approach(
        "opm_backsolve",
        "OPM backsolve (last round)",
        weights["weight_opm"],
        {
            k: inputs.get(k)
            for k in (
                "last_round_post_money",
                "last_round_price_per_share",
                "last_round_class",
                "volatility",
            )
            if inputs.get(k) is not None
        },
    )
    _record_approach("income", "Income approach (DCF)", weights["weight_income"], _section(inputs, "income"))
    _record_approach("market", "Market approach (comparables)", weights["weight_market"], _section(inputs, "market"))

    equity_value = sum(
        approaches[name]["equity_value"] * w for name, w in weight_by_approach.items() if w > 0
    )
    if equity_value <= 0:
        raise EngineInputError(f"weighted equity value is not positive ({equity_value:.2f})")

    tr.record(
        "weighting",
        "Weighted equity value",
        # The multiplication itself, term by term. A weighted mean is the one
        # step where a reviewer's disagreement is almost always with a single
        # contribution rather than with the total, and reading it off the
        # result document means multiplying four pairs by hand.
        inputs={
            "terms": [
                {
                    "approach": name,
                    "equity_value": approaches[name]["equity_value"],
                    "weight": w,
                    "contribution": approaches[name]["equity_value"] * w,
                }
                for name, w in weight_by_approach.items()
                if w > 0
            ],
            "weight_total": sum(w for w in weight_by_approach.values() if w > 0),
        },
        outputs={"equity_value": equity_value, "time_to_exit_years": t, "risk_free_rate": r},
    )

    return {
        "equity_value": equity_value,
        "approaches": approaches,
        "weight_by_approach": weight_by_approach,
        "market_movement": market_movement_applied,
        "t": t,
        "r": r,
        "cash": cash,
        "debt": debt,
    }


def _require_preferred_behind_preference(preferred_shares: float, liquidation_preference: float) -> None:
    """Refuse a preference stack with nobody holding it.

    Every aggregate allocation branch — here and in ``current_value.allocate_cvm``
    — guards the preference with ``preferred_shares > 0 and liquidation_preference
    > 0``, because the split needs both: the preference sets the breakpoint and
    the preferred share count sets what fraction of the upside sits behind it.
    With a preference but no shares the guard simply fails, and the run falls
    through to as-converted (OPM) or common-only (CVM), where common receives the
    *entire* equity value and the preference is not mentioned again — no error, no
    warning, and nothing in the result naming what was dropped.

    That is the same failure mode, and the same direction, as the negative
    ``shares_outstanding_preferred`` that ``validate._check_cap_table`` already
    refuses: the whole preference stack silently leaves the model and the
    concluded FMV is overstated by whatever it was worth. Measured on the
    reference payload — 8M common, a 2M pool, $10M of preference — dropping the
    4M preferred count moves the concluded FMV from $0.9761 to $1.5789, and it is
    the option strike prices that are set from that figure.

    It is reachable by omission rather than by typo, which is what makes it
    likelier than the negative: ``shares_outstanding_preferred`` is optional on
    the analyst form and on the extraction schema, while the preference is the
    figure that gets typed first because it is the one on the term sheet.

    Nothing is inferred from the preference — a preference of $10M says nothing
    about how many shares hold it — so the honest answer is to refuse. Only on
    the aggregate paths: with ``share_classes`` present the waterfall reads the
    per-class preferences and these two scalars are not consulted at all.
    """
    if liquidation_preference > 0 and preferred_shares <= 0:
        raise EngineInputError(
            "liquidation_preference is set but shares_outstanding_preferred is not — the "
            "allocation splits the upside behind the preference by preferred share count, so "
            "both are required; enter the preferred shares outstanding, or clear the preference "
            "if there is no preferred stock"
        )


def _opm_allocate(equity_value: float, params: dict, inputs: dict, t: float, r: float) -> dict:
    """OPM allocation of ``equity_value`` to common (waterfall / single
    breakpoint / as-converted). Returns the allocation metadata, common equity,
    fully diluted common, volatility, and the pre-discount common per share.
    Shared by the OPM and hybrid paths."""
    common_shares = _req(inputs.get("shares_outstanding_common"), "shares_outstanding_common", positive=True)
    options = _num(inputs.get("options_outstanding"), "options_outstanding", nonneg=True) or 0.0
    preferred_shares = (
        _num(inputs.get("shares_outstanding_preferred"), "shares_outstanding_preferred", nonneg=True) or 0.0
    )
    liquidation_preference = (
        _num(inputs.get("liquidation_preference"), "liquidation_preference", nonneg=True) or 0.0
    )
    fully_diluted_common = common_shares + options

    share_classes = inputs.get("share_classes")
    has_waterfall = isinstance(share_classes, list) and len(share_classes) > 0

    if not has_waterfall:
        _require_preferred_behind_preference(preferred_shares, liquidation_preference)

    # Volatility must be strictly positive: a negative value would otherwise be
    # passed straight to bs_call (σ ≤ 0 → intrinsic) and silently produce a
    # wrong allocation instead of an error (audit T-1 P3).
    volatility = _num(inputs.get("volatility"), "volatility", positive=True)
    needs_vol = (
        liquidation_preference > 0
        or has_waterfall
        or selects_model_dlom(params)
    )
    if needs_vol and volatility is None:
        raise EngineInputError("volatility is required (OPM allocation / model DLOM)")

    # The share count the reported common per-share figure is actually divided
    # by, and a word naming which count it is.
    #
    # `common_shares + options` is right for the two aggregate branches below,
    # because both fold the pool into fully-diluted common and hand that whole
    # base one slice of the equity. The breakpoint waterfall does not: it values
    # the option pool as its own class, at its own strike, and `common_value` is
    # what is left for the *common* classes alone — so its `common_per_share` is
    # over the cap table's common shares.
    #
    # Reporting the fully-diluted count anyway made the deliverable disagree
    # with itself: on 8M common, a 2M pool and 4M preferred behind a $10M
    # preference, the summary page printed a $1.2004 concluded FMV, a
    # $9,603,107 common equity value and 10,000,000 fully diluted common — and
    # a reader dividing the two got $0.9603, 20% under the headline they were
    # asked to adopt. Both figures were individually right; only the pairing was
    # not. `current_value.allocate_cvm` already reports the waterfall's own
    # count for exactly this reason, so this is the OPM/PWERM paths catching up.
    share_basis = fully_diluted_common
    basis_kind = "common_plus_options"

    waterfall_per_share: float | None = None
    class_volatility: dict | None = None
    if has_waterfall:
        # Full cap-table waterfall (remaining-gaps §2 — multi-breakpoint).
        allocation = allocate_waterfall(equity_value, share_classes, t, r, volatility or 0.0)
        common_equity = allocation["common_value"]
        waterfall_per_share = allocation["common_per_share"]
        share_basis = allocation["common_shares"]
        basis_kind = "cap_table_common"
        # The gearing each class carries, from the same breakpoints. Only the
        # waterfall path can produce it: the two aggregate branches below do not
        # decompose the payoff into tranches, so there is no per-class delta to
        # take. A report on a valuation without a cap table therefore omits the
        # class-volatility schedule rather than printing the enterprise figure
        # against every class, which would assert something false.
        class_volatility = class_volatilities(
            equity_value, share_classes, t, r, volatility or 0.0
        )
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

    common_per_share = (
        waterfall_per_share if waterfall_per_share is not None else common_equity / fully_diluted_common
    )
    return {
        "allocation": allocation,
        "common_equity": common_equity,
        "fully_diluted_common": share_basis,
        "fully_diluted_basis": basis_kind,
        "volatility": volatility,
        "class_volatility": class_volatility,
        "common_volatility": (
            class_volatility.get("common_volatility") if class_volatility is not None else None
        ),
        "common_per_share": common_per_share,
    }


def _dlom_volatility(params: dict, alloc: dict) -> tuple[float | None, str]:
    """The volatility an option-based DLOM is struck on, and which one it is.

    "class" is the default and is the correct one: Chaffee, Finnerty, Ghaidarov
    and Longstaff all price the cost of being unable to sell *the interest being
    valued*, and the interest a 409A concludes on is common — which sits behind
    the whole preference stack and is therefore geared well above the
    enterprise. On the cap table in `test_class_volatility.py` a 62% enterprise
    volatility is a 74% common volatility, and through Chaffee that is a 42.4%
    DLOM rather than a 35.5% one: seven points of discount, on the per-share
    figure a board adopts.

    Passing the enterprise figure was the engine's behaviour until now, and it
    understated every model DLOM on a company with a preference stack — which is
    every venture-backed company the engine exists to value.

    "enterprise" is kept because a report already issued on the enterprise
    figure has to stay reproducible, and because an appraiser who concluded on
    it deliberately should be able to say so rather than be overridden. It is
    never the silent option: `discounts.dlom_detail.volatility_basis` and
    `assumptions.dlom_volatility_basis` name the basis either way, and the
    pre-flight warns when the enterprise figure is selected.

    Only the breakpoint waterfall can answer "class": the two aggregate OPM
    branches do not decompose the payoff into tranches, so there is no per-class
    delta to take and the enterprise figure is the only one there is. A payload
    asking for the class basis without a cap table therefore falls back rather
    than failing — the request is for the better figure where one exists, not an
    assertion that one does.
    """
    basis = str(params.get("dlom_volatility_basis") or "class").lower()
    if basis not in DLOM_VOLATILITY_BASES:
        raise EngineInputError(
            f"dlom_volatility_basis must be one of {list(DLOM_VOLATILITY_BASES)} (got {basis!r})"
        )
    enterprise = alloc.get("volatility")
    if basis == "enterprise":
        return enterprise, "enterprise"
    common = alloc.get("common_volatility")
    if common is None or not (common > 0):
        return enterprise, "enterprise"
    return common, "class"


# ── Step recorders shared by the allocation paths ────────────────────────────
# Written once rather than inlined four times, for the reason `_discounts_block`
# already exists: the last thing inlined across these four branches went missing
# from three of them, and a step view that is complete on the OPM path and
# silently short on the CVM one is worse than one that is short everywhere.


def _record_allocation(
    trace: Trace, key: str, equity_value: float, inputs: dict, alloc: dict, t: float, r: float
) -> None:
    """The step that turns an equity value into a per-share figure for common.

    `alloc["allocation"]["method"]` is the interesting output — waterfall,
    single breakpoint, or as-converted. Which one ran is decided from the shape
    of the cap table rather than from any parameter, so it is a decision nobody
    made explicitly and nothing else in the result document reports.
    """
    allocation = alloc.get("allocation") or {}
    trace.record(
        f"allocation.{key}" if key.startswith("hybrid") else "allocation",
        f"Allocation to common ({key})",
        inputs={
            "equity_value": equity_value,
            "time_to_exit_years": t,
            "risk_free_rate": r,
            "volatility": alloc.get("volatility"),
            "shares_outstanding_common": inputs.get("shares_outstanding_common"),
            "shares_outstanding_preferred": inputs.get("shares_outstanding_preferred"),
            "options_outstanding": inputs.get("options_outstanding"),
            "liquidation_preference": inputs.get("liquidation_preference"),
            "share_classes": inputs.get("share_classes"),
        },
        outputs={
            "method": allocation.get("method"),
            "allocation": allocation,
            "common_per_share": alloc.get("common_per_share"),
            "fully_diluted_common": alloc.get("fully_diluted_common"),
            "fully_diluted_basis": alloc.get("fully_diluted_basis"),
        },
    )


def _record_discounts(
    trace: Trace,
    params: dict,
    common_per_share: float,
    dloc: float,
    dlom: float,
    method: str | None,
    detail: dict | None,
    fmv_per_share: float,
) -> None:
    """The last step, and the one most often argued about.

    Both discounts are shown applied *multiplicatively and in order*, because
    the common error when checking this by hand is to subtract their sum: at
    10% DLOC and 30% DLOM that is 60% of the marketable value rather than 63%,
    and on a per-share figure the gap is the difference between two defensible
    conclusions.
    """
    marketable = common_per_share
    after_dloc = marketable * (1.0 - dloc)
    trace.record(
        "discounts",
        "DLOC and DLOM",
        inputs={
            "marketable_common_per_share": marketable,
            "dloc": dloc,
            "dlom": dlom,
            "dlom_method": method,
            "dlom_detail": detail,
        },
        outputs={
            "after_dloc": after_dloc,
            "after_dlom": after_dloc * (1.0 - dlom),
            "fmv_per_share": fmv_per_share,
            "combined_discount": 1.0 - (1.0 - dloc) * (1.0 - dlom),
        },
    )


def _compute_opm(
    params: dict, inputs: dict, recompute: list[str] | None, prior: dict, trace: Trace | None = None
) -> dict:
    """Default allocation path: weighted approaches → OPM allocation → DLOM."""
    tr = trace or Trace.off()
    we = _weighted_equity(params, inputs, recompute, prior, tr)
    equity_value, t, r = we["equity_value"], we["t"], we["r"]
    alloc = _opm_allocate(equity_value, params, inputs, t, r)
    _record_allocation(tr, "opm", equity_value, inputs, alloc, t, r)

    # The DLOM is struck on the volatility of the *interest being valued*, which
    # is common — geared by everything senior to it — and not on the enterprise
    # volatility that allocated the equity. See `_dlom_volatility`.
    dlom_vol, vol_basis = _dlom_volatility(params, alloc)
    dloc, dlom, method, dlom_detail = _resolve_discounts(params, dlom_vol, t, r, vol_basis)
    fmv_per_share = alloc["common_per_share"] * (1.0 - dloc) * (1.0 - dlom)
    _record_discounts(tr, params, alloc["common_per_share"], dloc, dlom, method, dlom_detail, fmv_per_share)

    results: dict = {
        "equity_value": round(equity_value, 2),
        "approaches": {
            name: {**data, "weight": we["weight_by_approach"][name]}
            for name, data in we["approaches"].items()
        },
        "allocation": alloc["allocation"],
        # The other three paths all name themselves; this one did not, and it is
        # the default. `allocation.method` is the *mechanism* the OPM used —
        # "opm_waterfall", "opm_single_breakpoint", "as_converted" — not the
        # allocation method, so a consumer falling back to it read a different
        # vocabulary. The report's summary page did exactly that and printed
        # "Allocation method: OPM_WATERFALL" on the deliverable a board reads.
        "allocation_method": "opm",
        "common_equity_value": round(alloc["common_equity"], 2),
        "assumptions": {
            "time_to_exit_years": round(t, 4),
            "risk_free_rate": r,
            "volatility": alloc["volatility"],
            # Two volatilities, named. `volatility` is the enterprise figure the
            # allocation ran on; this is the one the discount ran on. They are
            # the same number only when there is no cap table to gear common.
            "dlom_volatility": dlom_vol,
            "dlom_volatility_basis": vol_basis,
        },
        "discounts": _discounts_block(dloc, dlom, method, dlom_detail),
        "fully_diluted_common": alloc["fully_diluted_common"],
        "fully_diluted_basis": alloc["fully_diluted_basis"],
        "fmv_per_share": round(fmv_per_share, 4),
    }
    _attach_market_movement(results, we)
    _attach_class_volatility(results, alloc)
    if recompute is not None:
        results["recomputed"] = sorted(recompute)
    return {"engine_version": ENGINE_VERSION, "results": results}


def _compute_cvm(
    params: dict, inputs: dict, recompute: list[str] | None, prior: dict, trace: Trace | None = None
) -> dict:
    """Current Value Method: weighted equity value allocated by the σ→0
    deterministic waterfall (current_value.allocate_cvm), then DLOC/DLOM."""
    tr = trace or Trace.off()
    we = _weighted_equity(params, inputs, recompute, prior, tr)
    equity_value, t, r = we["equity_value"], we["t"], we["r"]
    allocation = allocate_cvm(equity_value, inputs)
    _record_allocation(tr, "cvm", equity_value, inputs, {"allocation": allocation, **allocation}, t, r)

    volatility = _num(inputs.get("volatility"), "volatility", positive=True)
    if selects_model_dlom(params) and volatility is None:
        raise EngineInputError("volatility is required for the selected model DLOM")

    dloc, dlom, method, dlom_detail = _resolve_discounts(params, volatility, t, r)
    fmv_per_share = allocation["common_per_share"] * (1.0 - dloc) * (1.0 - dlom)
    _record_discounts(
        tr, params, allocation["common_per_share"], dloc, dlom, method, dlom_detail, fmv_per_share
    )

    results: dict = {
        "equity_value": round(equity_value, 2),
        "approaches": {
            name: {**data, "weight": we["weight_by_approach"][name]}
            for name, data in we["approaches"].items()
        },
        "allocation": allocation,
        "allocation_method": "cvm",
        "common_equity_value": round(allocation["common_value"], 2),
        "assumptions": {
            "time_to_exit_years": round(t, 4),
            "risk_free_rate": r,
            "volatility": volatility,
        },
        "discounts": _discounts_block(dloc, dlom, method, dlom_detail),
        "fully_diluted_common": allocation["fully_diluted_common"],
        # `allocate_cvm` already reports the count its own per-share figure is
        # over — the cap table's common on the waterfall path, common + options
        # on the simplified one — so the label follows the method it chose.
        "fully_diluted_basis": (
            "cap_table_common" if allocation["method"] == "cvm_waterfall" else "common_plus_options"
        ),
        "fmv_per_share": round(fmv_per_share, 4),
    }
    _attach_market_movement(results, we)
    if recompute is not None:
        results["recomputed"] = sorted(recompute)
    return {"engine_version": ENGINE_VERSION, "results": results}


def _compute_monte_carlo(
    params: dict, inputs: dict, recompute: list[str] | None, prior: dict, trace: Trace | None = None
) -> dict:
    """Simulated allocation: weighted equity value → Monte Carlo → DLOC/DLOM.

    Structurally the OPM path with one substitution — the closed-form call-spread
    allocation is replaced by simulation — because that is exactly what it is.
    The weighting above it and the discounts below it are the same steps, run on
    the same inputs, so switching a valuation to this method changes the
    allocation and nothing else. See `monte_carlo.allocate_monte_carlo` for when
    that substitution is worth making (it is not, for a single lognormal).
    """
    tr = trace or Trace.off()
    we = _weighted_equity(params, inputs, recompute, prior, tr)
    equity_value, t, r = we["equity_value"], we["t"], we["r"]

    # Volatility is required rather than defaulted: it is the entire parameter
    # the simulation is about, and a run without one would be a very expensive
    # way to compute the deterministic waterfall.
    volatility = _num(inputs.get("volatility"), "volatility", positive=True)
    if volatility is None:
        raise EngineInputError("volatility is required for the Monte Carlo allocation")

    allocation = allocate_monte_carlo(equity_value, inputs, t=t, r=r, sigma=volatility)
    _record_allocation(
        tr,
        "monte_carlo",
        equity_value,
        inputs,
        {"allocation": allocation, "volatility": volatility, **allocation},
        t,
        r,
    )

    dloc, dlom, method, dlom_detail = _resolve_discounts(params, volatility, t, r)
    common_per_share = allocation["common_per_share"]
    fmv_per_share = common_per_share * (1.0 - dloc) * (1.0 - dlom)
    _record_discounts(tr, params, common_per_share, dloc, dlom, method, dlom_detail, fmv_per_share)

    results: dict = {
        "equity_value": round(equity_value, 2),
        "approaches": {
            name: {**data, "weight": we["weight_by_approach"][name]}
            for name, data in we["approaches"].items()
        },
        "allocation": allocation,
        "allocation_method": "monte_carlo",
        "common_equity_value": round(allocation["common_value"], 2),
        "assumptions": {
            "time_to_exit_years": round(t, 4),
            "risk_free_rate": r,
            "volatility": volatility,
        },
        "discounts": _discounts_block(dloc, dlom, method, dlom_detail),
        # The simulation spreads value over the cap table's *common* classes;
        # the option pool is its own class holding its own value, exactly as
        # under the breakpoint waterfall. See the note in `_opm_allocate`.
        "fully_diluted_common": allocation["common_shares"],
        "fully_diluted_basis": "cap_table_common",
        "fmv_per_share": round(fmv_per_share, 4),
    }
    _attach_market_movement(results, we)
    if recompute is not None:
        results["recomputed"] = sorted(recompute)
    return {"engine_version": ENGINE_VERSION, "results": results}


def _compute_hybrid(
    params: dict, inputs: dict, recompute: list[str] | None, prior: dict, trace: Trace | None = None
) -> dict:
    """Hybrid: blend the OPM common-per-share (weighted approaches + waterfall)
    with the PWERM common-per-share by configurable weights, then DLOC/DLOM."""
    tr = trace or Trace.off()
    weights = resolve_hybrid_weights(inputs)
    we = _weighted_equity(params, inputs, recompute, prior, tr)
    t, r = we["t"], we["r"]
    opm_alloc = _opm_allocate(we["equity_value"], params, inputs, t, r)
    _record_allocation(tr, "hybrid.opm_leg", we["equity_value"], inputs, opm_alloc, t, r)
    pwerm_allocation = _pwerm_allocation(inputs)
    tr.record(
        "allocation.pwerm_leg",
        "PWERM leg (scenario allocation)",
        inputs={"scenarios": inputs.get("pwerm")},
        outputs=pwerm_allocation,
    )

    blend = blend_hybrid(
        {
            "equity_value": we["equity_value"],
            "common_per_share": opm_alloc["common_per_share"],
            "time_to_exit_years": t,
            "allocation": opm_alloc["allocation"],
        },
        {
            "equity_value": pwerm_allocation["equity_value"],
            "common_per_share": pwerm_allocation["common_per_share"],
            "expected_time_to_exit_years": pwerm_allocation["expected_time_to_exit_years"],
        },
        weights,
    )

    t_blend = blend["blended_time_to_exit_years"]
    volatility = opm_alloc["volatility"]
    tr.record(
        "allocation.blend",
        "Hybrid blend of the two legs",
        inputs={
            "weights": weights,
            "opm_common_per_share": opm_alloc["common_per_share"],
            "pwerm_common_per_share": pwerm_allocation["common_per_share"],
        },
        outputs=blend,
    )
    dlom_vol, vol_basis = _dlom_volatility(params, opm_alloc)
    dloc, dlom, method, dlom_detail = _resolve_discounts(params, dlom_vol, t_blend, r, vol_basis)
    common_per_share = blend["common_per_share"]
    fully_diluted_common = opm_alloc["fully_diluted_common"]
    fmv_per_share = common_per_share * (1.0 - dloc) * (1.0 - dlom)
    _record_discounts(tr, params, common_per_share, dloc, dlom, method, dlom_detail, fmv_per_share)

    results: dict = {
        "equity_value": blend["equity_value"],
        "approaches": {
            name: {**data, "weight": we["weight_by_approach"][name]}
            for name, data in we["approaches"].items()
        },
        "allocation": blend,
        "allocation_method": "hybrid",
        "pwerm_allocation": pwerm_allocation,
        "common_equity_value": round(common_per_share * fully_diluted_common, 2),
        "assumptions": {
            "time_to_exit_years": t_blend,
            "risk_free_rate": r,
            "volatility": volatility,
            "dlom_volatility": dlom_vol,
            "dlom_volatility_basis": vol_basis,
        },
        "discounts": _discounts_block(dloc, dlom, method, dlom_detail),
        "fully_diluted_common": fully_diluted_common,
        "fully_diluted_basis": opm_alloc["fully_diluted_basis"],
        "fmv_per_share": round(fmv_per_share, 4),
    }
    _attach_market_movement(results, we)
    _attach_class_volatility(results, opm_alloc)
    if recompute is not None:
        results["recomputed"] = sorted(recompute)
    return {"engine_version": ENGINE_VERSION, "results": results}


def _assert_finite_results(node, path: str = "results") -> None:
    """Refuse a result document holding a non-finite float, naming where it is.

    The approach layer names the overflows it can see (`approaches._finite_result`),
    but it is not the only place the arithmetic leaves the finite floats. Every
    per-share figure is a division by a share count, and a share count only has
    to be *positive* — `1e-320` is a legal denormal that passes `_num(...,
    positive=True)`, and dividing a perfectly ordinary equity value by it gives
    `inf`. The same holds inside the waterfall, whose per-class `value / shares`
    is one division per class.

    Catching it here rather than at each division is deliberate. The failure is
    not a property of any one formula — it is the boundary between "a float this
    engine computed" and "a number JSON can carry", and Starlette renders with
    `allow_nan=False`, so anything non-finite that reaches it is a 500 naming
    nothing at all. One sweep over the finished document is the narrowest place
    that covers every path into it, including ones added later.
    """
    if isinstance(node, float):
        if not math.isfinite(node):
            raise EngineInputError(
                f"the calculation produced a non-finite value at {path} — check the input "
                "magnitudes (very large figures, or a share count near zero, overflow the "
                "arithmetic)"
            )
        return
    if isinstance(node, dict):
        for key, value in node.items():
            _assert_finite_results(value, f"{path}.{key}")
    elif isinstance(node, (list, tuple)):
        for i, value in enumerate(node):
            _assert_finite_results(value, f"{path}[{i}]")


def compute(
    params: dict,
    inputs: dict,
    recompute: list[str] | None = None,
    prior_approaches: dict | None = None,
    *,
    auto_volatility: bool = False,
    auto_wacc: bool = False,
    auto_comparables: bool = False,
    trace: bool = False,
) -> dict:
    """Full 409A computation, or — with `recompute` — a per-subsystem rerun.

    Dispatches on ``params.allocation_method`` (opm / pwerm / hybrid / cvm).
    When `recompute` names a subset of APPROACH_KEYS, only those approaches are
    computed fresh; the rest reuse `prior_approaches` (a previous run's
    results.approaches). Weighting, allocation and discounts always re-run.

    The `auto_*` flags run the estimation engines (volatility / WACC /
    comparables) to pre-fill their manual inputs before the calculation; a
    manual value always takes precedence, so the flags are backward compatible.

    With `trace`, the returned document carries a `trace` list: one entry per
    pipeline stage with what it consumed and produced. Opt-in because those
    payloads are the engine's entire working state and most callers never read
    them. It cannot change a number — `Trace` copies what it is handed and
    returns nothing to the arithmetic.
    """
    tr = Trace(enabled=trace)
    inputs, auto_meta = _apply_autopilot(
        params,
        inputs,
        auto_volatility=auto_volatility,
        auto_wacc=auto_wacc,
        auto_comparables=auto_comparables,
    )
    if auto_meta is not None:
        tr.record(
            "autopilot",
            "Estimation engines (pre-fill)",
            inputs={
                "auto_volatility": auto_volatility,
                "auto_wacc": auto_wacc,
                "auto_comparables": auto_comparables,
            },
            # What the estimators derived, and — the part worth having — which
            # of them a manual input overrode. An analyst who set volatility by
            # hand and still sees an auto figure here needs to know which one
            # the allocation used.
            outputs=auto_meta,
        )

    if recompute is not None:
        unknown = set(recompute) - set(APPROACH_KEYS)
        if unknown:
            raise EngineInputError(f"unknown recompute approaches: {sorted(unknown)}")
        if not recompute:
            raise EngineInputError("recompute must name at least one approach")
    prior = prior_approaches or {}

    allocation_method = params.get("allocation_method") or "opm"
    if allocation_method not in ALLOCATION_METHODS:
        raise EngineInputError(f"allocation_method must be one of {ALLOCATION_METHODS}")

    if allocation_method == "pwerm":
        # Self-contained: discrete exit scenarios set both equity value and its
        # allocation to common, bypassing the weighted-approach + OPM chain.
        out = _compute_pwerm(params, inputs, tr)
    elif allocation_method == "monte_carlo":
        out = _compute_monte_carlo(params, inputs, recompute, prior, tr)
    elif allocation_method == "cvm":
        out = _compute_cvm(params, inputs, recompute, prior, tr)
    elif allocation_method == "hybrid":
        out = _compute_hybrid(params, inputs, recompute, prior, tr)
    else:
        out = _compute_opm(params, inputs, recompute, prior, tr)

    if auto_meta is not None:
        out["results"]["auto"] = auto_meta
    _assert_finite_results(out["results"])
    # Outside `results`, deliberately. `results` is persisted as the answer, fed
    # to the report renderer and diffed between runs; a debug record that grew
    # a new step would read as the valuation having changed.
    if tr.enabled:
        out["trace"] = tr.as_list()
    return out
