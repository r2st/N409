"""Edge cases and structural invariants for the valuation engine.

The existing suites check that each model returns the right number for a
representative cap table. These check the boundaries around those numbers: the
degenerate cap tables, the extreme parameters, and the identities that must
hold between two models that claim to describe the same payoff. An allocation
that quietly loses a few dollars of equity, or a DLOM that raises instead of
returning a discount, is the kind of thing a single well-chosen example never
catches.
"""

import math

import pytest

from app.engine.bs import bs_call, bs_put, norm_cdf
from app.engine.dlom import chaffee_dlom, finnerty_dlom
from app.engine.errors import EngineInputError
from app.engine.newton import implied_volatility, newton_raphson
from app.engine.waterfall import allocate_waterfall, class_per_share, exit_allocation
from app.engine.approaches import opm_backsolve

T, R, SIGMA = 3.0, 0.04, 0.6

COMMON = {"name": "Common", "kind": "common", "shares": 8_000_000}


def classes_of(*extra):
    return [COMMON, *extra]


# A deliberately awkward stack: two seniority ranks, a participating class, a
# converting class with anti-dilution, and two option pools either side of the
# money. Every invariant below is checked against it.
COMPLEX_STACK = classes_of(
    {"name": "SeriesB", "kind": "preferred", "shares": 3e6, "preference": 12e6, "seniority": 1},
    {
        "name": "SeriesA",
        "kind": "preferred",
        "shares": 2e6,
        "preference": 5e6,
        "seniority": 2,
        "conversion_ratio": 1.5,
    },
    {
        "name": "SeriesSeed",
        "kind": "preferred",
        "shares": 1e6,
        "preference": 2e6,
        "seniority": 2,
        "participating": True,
    },
    {"name": "PoolCheap", "kind": "option", "shares": 1.5e6, "strike": 0.40},
    {"name": "PoolRich", "kind": "option", "shares": 8e5, "strike": 4.25},
)


# ── waterfall: value conservation ────────────────────────────────────────────


@pytest.mark.parametrize("equity", [1.0, 1e3, 5e6, 19e6, 20e6, 250e6, 5e9])
def test_opm_conserves_value_across_the_whole_range(equity):
    """Σ class values == equity, at every scale from a dollar to five billion.

    The allocation is a sum of call spreads that is supposed to telescope to
    bs_call(E, 0) == E. A dropped or double-counted segment shows up here and
    almost nowhere else.
    """
    out = allocate_waterfall(equity, COMPLEX_STACK, T, R, SIGMA)
    # Reported class values are rounded to the cent, so six classes can differ
    # from the total by at most three cents. Anything larger is a real leak.
    assert sum(c["value"] for c in out["classes"].values()) == pytest.approx(equity, abs=0.05)


@pytest.mark.parametrize("sigma", [0.05, 0.2, 0.6, 1.5, 3.0])
@pytest.mark.parametrize("t", [0.25, 1.0, 7.0])
def test_opm_conserves_value_for_extreme_vol_and_term(sigma, t):
    out = allocate_waterfall(60e6, COMPLEX_STACK, t, R, sigma)
    assert sum(c["value"] for c in out["classes"].values()) == pytest.approx(60e6, abs=0.05)


@pytest.mark.parametrize("exit_value", [0.0, 1.0, 12e6, 17e6, 19e6, 100e6])
def test_deterministic_waterfall_conserves_value(exit_value):
    out = exit_allocation(exit_value, COMPLEX_STACK)
    assert sum(c["value"] for c in out["classes"].values()) == pytest.approx(exit_value, abs=0.05)


# ── waterfall: the two allocators must describe the same payoff ──────────────


@pytest.mark.parametrize("equity", [2e6, 12e6, 17.5e6, 45e6, 300e6])
def test_opm_degenerates_to_the_deterministic_waterfall(equity):
    """As σ → 0 and t → 0 the OPM expectation collapses onto the intrinsic
    payoff, so PWERM (which uses exit_allocation) and the OPM allocation must
    agree on the structure they are both pricing. If the two ever built
    different breakpoints, this is where it would show."""
    opm = allocate_waterfall(equity, COMPLEX_STACK, 1e-9, 0.0, 1e-9)
    intrinsic = exit_allocation(equity, COMPLEX_STACK)
    for name, cls in intrinsic["classes"].items():
        assert opm["classes"][name]["value"] == pytest.approx(cls["value"], abs=0.01)


# ── waterfall: monotonicity ──────────────────────────────────────────────────


def test_every_class_is_worth_more_as_the_company_is_worth_more():
    """Each class's payoff is non-decreasing in exit value, so its expected
    value must be non-decreasing in equity value. A mis-signed call spread
    would make some class worth *less* at a higher valuation."""
    ladder = [1e6, 5e6, 12e6, 18e6, 25e6, 60e6, 150e6, 400e6]
    previous = {c["name"]: -1.0 for c in COMPLEX_STACK}
    for equity in ladder:
        out = allocate_waterfall(equity, COMPLEX_STACK, T, R, SIGMA)
        for name, cls in out["classes"].items():
            assert cls["value"] >= previous[name] - 1e-6, f"{name} fell at equity {equity}"
            previous[name] = cls["value"]


def test_common_per_share_is_monotone_in_equity_value():
    # This is the property the backsolve relies on to be well-posed.
    values = [
        allocate_waterfall(e, COMPLEX_STACK, T, R, SIGMA)["common_per_share"]
        for e in (5e6, 10e6, 20e6, 50e6, 120e6)
    ]
    assert values == sorted(values)


# ── waterfall: degenerate cap tables ─────────────────────────────────────────


def test_common_only_cap_table_takes_everything():
    out = allocate_waterfall(9e6, classes_of(), T, R, SIGMA)
    assert out["common_value"] == pytest.approx(9e6, abs=0.01)
    assert out["common_per_share"] == pytest.approx(9e6 / 8e6, rel=1e-6)
    # No preference stack means a single residual segment.
    assert len(out["breakpoints"]) == 1
    assert out["breakpoints"][0]["from"] == 0 and out["breakpoints"][0]["to"] is None


def test_zero_preference_preferred_is_just_another_common_class():
    """A preference of 0 is legal (a founder-friendly class, or a stub row).
    It must not create an empty tranche — it simply shares the residual."""
    zero = {"name": "Z", "kind": "preferred", "shares": 2e6, "preference": 0.0}
    out = allocate_waterfall(10e6, classes_of(zero), T, R, SIGMA)
    assert len(out["breakpoints"]) == 1  # no preference segment was emitted
    assert out["classes"]["Z"]["per_share"] == pytest.approx(out["common_per_share"], rel=1e-6)
    assert out["classes"]["Z"]["value"] == pytest.approx(10e6 * 2 / 10, abs=0.01)


def test_a_zero_preference_member_is_dropped_from_its_pari_passu_rank():
    """Splitting a rank pro-rata by preference must not divide by a zero
    share, and must not hand a zero-preference class part of someone else's
    liquidation preference."""
    zero = {"name": "A", "kind": "preferred", "shares": 1e6, "preference": 0.0, "seniority": 1}
    real = {"name": "B", "kind": "preferred", "shares": 1e6, "preference": 4e6, "seniority": 1}
    out = allocate_waterfall(10e6, classes_of(zero, real), T, R, SIGMA)
    assert out["breakpoints"][0]["participants"] == {"B": 1.0}


def test_equity_far_below_the_preference_stack_leaves_common_almost_nothing():
    stack = classes_of({"name": "A", "kind": "preferred", "shares": 2e6, "preference": 50e6})
    out = allocate_waterfall(500_000, stack, 1.0, R, 0.3)
    # An option on a company worth 1% of its preference is nearly worthless,
    # but it is never negative and never exactly zero — common holds a call.
    assert 0.0 <= out["common_value"] < 500_000 * 0.01
    assert out["classes"]["A"]["value"] == pytest.approx(500_000, rel=0.02)


def test_conversion_ratio_scales_the_as_converted_stake():
    """A 2:1 anti-dilution ratio doubles the converted share count, so deep in
    the money the class is worth twice as much as a 1:1 class would be."""
    base = {"name": "A", "kind": "preferred", "shares": 1e6, "preference": 4e6}
    doubled = {**base, "conversion_ratio": 2.0}
    equity = 2e9  # far above any conversion point
    v_base = allocate_waterfall(equity, classes_of(base), T, R, SIGMA)["classes"]["A"]["value"]
    v_doubled = allocate_waterfall(equity, classes_of(doubled), T, R, SIGMA)["classes"]["A"]["value"]
    assert v_base == pytest.approx(equity * 1 / 9, rel=0.01)
    assert v_doubled == pytest.approx(equity * 2 / 10, rel=0.01)


def test_two_option_pools_exercise_in_strike_order():
    """The cheaper pool must join the residual first. Getting the event loop's
    ordering wrong produces plausible-looking but wrong per-share values."""
    cheap = {"name": "Cheap", "kind": "option", "shares": 1e6, "strike": 0.5}
    rich = {"name": "Rich", "kind": "option", "shares": 1e6, "strike": 5.0}
    out = allocate_waterfall(200e6, classes_of(cheap, rich), T, R, SIGMA)
    joined = [set(bp["participants"]) for bp in out["breakpoints"]]
    first_cheap = next(i for i, p in enumerate(joined) if "Cheap" in p)
    first_rich = next(i for i, p in enumerate(joined) if "Rich" in p)
    assert first_cheap < first_rich
    assert out["classes"]["Cheap"]["per_share"] > out["classes"]["Rich"]["per_share"]


def test_participating_preferred_never_loses_to_its_non_participating_twin():
    """Double-dipping is weakly dominant at every valuation, including the
    ones below the preference where the two are identical."""
    part = {
        "name": "P",
        "kind": "preferred",
        "shares": 2e6,
        "preference": 5e6,
        "participating": True,
    }
    non = {**part, "participating": False}
    for equity in (1e6, 5e6, 6e6, 20e6, 500e6):
        v_p = allocate_waterfall(equity, classes_of(part), T, R, SIGMA)["classes"]["P"]["value"]
        v_n = allocate_waterfall(equity, classes_of(non), T, R, SIGMA)["classes"]["P"]["value"]
        assert v_p >= v_n - 1e-6, f"participating lost at {equity}"


def test_deterministic_waterfall_at_zero_pays_nobody():
    out = exit_allocation(0.0, COMPLEX_STACK)
    assert all(c["value"] == 0.0 for c in out["classes"].values())
    assert out["common_per_share"] == 0.0


def test_deterministic_waterfall_exactly_on_a_breakpoint():
    """Landing exactly on the top of the preference stack must fill it
    completely and start nothing above it — no half-open-interval slip."""
    stack = classes_of({"name": "A", "kind": "preferred", "shares": 2e6, "preference": 5e6})
    out = exit_allocation(5e6, stack)
    assert out["classes"]["A"]["value"] == pytest.approx(5e6, abs=1e-6)
    assert out["classes"]["Common"]["value"] == pytest.approx(0.0, abs=1e-6)


def test_waterfall_rejects_a_non_positive_equity_value():
    with pytest.raises(EngineInputError, match="equity_value"):
        allocate_waterfall(0.0, COMPLEX_STACK, T, R, SIGMA)
    with pytest.raises(EngineInputError, match="equity_value"):
        allocate_waterfall(-1.0, COMPLEX_STACK, T, R, SIGMA)
    with pytest.raises(EngineInputError, match="exit_value"):
        exit_allocation(-0.01, COMPLEX_STACK)


def test_waterfall_rejects_structurally_impossible_classes():
    with pytest.raises(EngineInputError, match="shares"):
        allocate_waterfall(1e6, classes_of({"name": "A", "kind": "common", "shares": 0}), T, R, SIGMA)
    with pytest.raises(EngineInputError, match="shares"):
        allocate_waterfall(1e6, classes_of({"name": "A", "kind": "common", "shares": -5}), T, R, SIGMA)
    with pytest.raises(EngineInputError, match="conversion_ratio"):
        allocate_waterfall(
            1e6,
            classes_of({"name": "A", "kind": "preferred", "shares": 1e6, "preference": 1e6, "conversion_ratio": 0}),
            T,
            R,
            SIGMA,
        )
    with pytest.raises(EngineInputError, match="seniority"):
        allocate_waterfall(
            1e6,
            classes_of({"name": "A", "kind": "preferred", "shares": 1e6, "preference": 1e6, "seniority": 0}),
            T,
            R,
            SIGMA,
        )
    with pytest.raises(EngineInputError, match="seniority"):
        # bool is an int in Python; True must not pass as seniority 1.
        allocate_waterfall(
            1e6,
            classes_of({"name": "A", "kind": "preferred", "shares": 1e6, "preference": 1e6, "seniority": True}),
            T,
            R,
            SIGMA,
        )


def test_class_per_share_names_the_missing_class():
    with pytest.raises(EngineInputError, match="Series Z"):
        class_per_share(10e6, COMPLEX_STACK, "Series Z", T, R, SIGMA)


# ── backsolve ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("known_equity", [6e6, 18e6, 19.5e6, 75e6, 900e6])
def test_backsolve_inverts_the_waterfall_at_every_scale(known_equity):
    """Round-trip across every region of the cap table, including equity that
    lands inside the preference stack and equity past the last conversion."""
    pps = allocate_waterfall(known_equity, COMPLEX_STACK, T, R, SIGMA)["classes"]["SeriesB"]["per_share"]
    out = opm_backsolve(
        last_round_pps=pps,
        share_classes=COMPLEX_STACK,
        last_round_class="SeriesB",
        t=T,
        r=R,
        sigma=SIGMA,
    )
    assert out["equity_value"] == pytest.approx(known_equity, rel=1e-4)


def test_backsolve_round_trips_a_class_that_has_to_convert():
    """SeriesA only reaches its as-converted value above its conversion point,
    so solving from its price exercises the part of the objective where the
    slope changes."""
    known_equity = 400e6
    pps = allocate_waterfall(known_equity, COMPLEX_STACK, T, R, SIGMA)["classes"]["SeriesA"]["per_share"]
    out = opm_backsolve(
        last_round_pps=pps,
        share_classes=COMPLEX_STACK,
        last_round_class="SeriesA",
        t=T,
        r=R,
        sigma=SIGMA,
    )
    assert out["equity_value"] == pytest.approx(known_equity, rel=1e-3)


# ── Black-Scholes primitives ─────────────────────────────────────────────────


def test_put_call_parity_holds():
    for k in (50.0, 100.0, 250.0):
        call = bs_call(100.0, k, 2.0, 0.03, 0.4)
        put = bs_put(100.0, k, 2.0, 0.03, 0.4)
        assert call - put == pytest.approx(100.0 - k * math.exp(-0.03 * 2.0), abs=1e-9)


@pytest.mark.parametrize(
    ("s", "k", "t", "sigma", "expected"),
    [
        (100.0, 90.0, 0.0, 0.4, 10.0),  # expired: intrinsic
        (100.0, 90.0, 2.0, 0.0, 100.0 - 90.0 * math.exp(-0.03 * 2.0)),  # no vol: forward intrinsic
        (0.0, 90.0, 2.0, 0.4, 0.0),  # worthless underlying
        (100.0, 0.0, 2.0, 0.4, 100.0),  # zero strike: the whole company
        (100.0, -5.0, 2.0, 0.4, 100.0),  # negative strike is treated as zero
    ],
)
def test_bs_call_degenerate_inputs(s, k, t, sigma, expected):
    assert bs_call(s, k, t, 0.03, sigma) == pytest.approx(expected, abs=1e-9)


def test_bs_call_is_bounded_by_the_underlying():
    # No matter how wild the volatility, a call is never worth more than spot.
    for sigma in (0.1, 1.0, 5.0, 25.0):
        assert bs_call(100.0, 10.0, 5.0, 0.04, sigma) <= 100.0 + 1e-9


def test_norm_cdf_tails_and_centre():
    assert norm_cdf(0.0) == pytest.approx(0.5)
    assert norm_cdf(-40.0) == pytest.approx(0.0, abs=1e-12)
    assert norm_cdf(40.0) == pytest.approx(1.0, abs=1e-12)


# ── DLOM ─────────────────────────────────────────────────────────────────────


def test_dlom_is_zero_without_volatility_or_time():
    for model in (lambda s, t: chaffee_dlom(s, t, 0.04), finnerty_dlom):
        assert model(0.0, 2.0) == 0.0
        assert model(-1.0, 2.0) == 0.0
        assert model(0.6, 0.0) == 0.0
        assert model(0.6, -1.0) == 0.0


@pytest.mark.parametrize("model", [lambda s, t: chaffee_dlom(s, t, 0.04), finnerty_dlom])
def test_dlom_rises_with_volatility_and_holding_period(model):
    by_sigma = [model(s, 2.0) for s in (0.2, 0.4, 0.8, 1.2)]
    assert by_sigma == sorted(by_sigma)
    by_term = [model(0.6, t) for t in (0.5, 1.0, 3.0, 6.0)]
    assert by_term == sorted(by_term)


@pytest.mark.parametrize("model", [lambda s, t: chaffee_dlom(s, t, 0.04), finnerty_dlom])
def test_dlom_stays_a_fraction(model):
    for sigma in (0.1, 0.6, 2.0, 8.0):
        for t in (0.1, 2.0, 30.0):
            assert 0.0 <= model(sigma, t) <= 0.99


def test_finnerty_survives_a_volatility_nobody_meant_to_type():
    """σ²T past ~709 overflowed the intermediate e^{σ²T} and took the whole
    calculation down with an OverflowError. The volatility band is a warning,
    not a hard limit, so a mistyped 3000% vol is reachable from the UI."""
    assert finnerty_dlom(30.0, 1.0) == pytest.approx(0.3228, abs=1e-3)
    assert finnerty_dlom(50.0, 10.0) == pytest.approx(0.3228, abs=1e-3)
    assert finnerty_dlom(1e5, 1e5) == pytest.approx(0.3228, abs=1e-3)


def test_finnerty_converges_to_its_known_ceiling():
    # The model asymptotes to 2Φ(√ln2 / 2) − 1 ≈ 32.28%, never to 99%.
    ceiling = 2.0 * norm_cdf(math.sqrt(math.log(2.0)) / 2.0) - 1.0
    assert finnerty_dlom(100.0, 100.0) == pytest.approx(ceiling, abs=1e-9)
    assert ceiling < 0.33


def test_finnerty_is_accurate_for_a_barely_illiquid_holding():
    """The literal formula subtracts two nearly-equal logarithms, which loses
    the answer entirely for small σ²T — it reported a discount two orders of
    magnitude too large. v²T → σ²T/3 in the limit."""
    for var_t in (1e-6, 1e-5, 1e-4):
        sigma = math.sqrt(var_t)
        expected = 2.0 * norm_cdf(math.sqrt(var_t / 3.0) / 2.0) - 1.0
        assert finnerty_dlom(sigma, 1.0) == pytest.approx(expected, rel=0.02)


def test_finnerty_is_continuous_across_its_small_value_threshold():
    below = finnerty_dlom(math.sqrt(9.9e-5), 1.0)
    at = finnerty_dlom(math.sqrt(1.0e-4), 1.0)
    above = finnerty_dlom(math.sqrt(1.01e-4), 1.0)
    assert below < at < above
    assert at - below == pytest.approx(above - at, rel=0.05)


# ── root finding ─────────────────────────────────────────────────────────────


def test_newton_returns_immediately_when_the_guess_is_the_root():
    root, iters = newton_raphson(lambda x: x - 3.0, 3.0)
    assert root == 3.0 and iters == 0


def test_newton_finds_a_root_sitting_on_a_bound():
    root, _ = newton_raphson(lambda x: x - 2.0, 7.0, min_x=2.0, max_x=10.0)
    assert root == pytest.approx(2.0, abs=1e-6)


def test_newton_without_bounds_raises_rather_than_returning_a_wrong_answer():
    # No bracket to fall back on: better a clear failure than a stray iterate.
    with pytest.raises(EngineInputError, match="converge"):
        newton_raphson(lambda x: 1.0 if x > 0 else -1.0, 1.0)


def test_implied_volatility_at_the_no_arbitrage_edges():
    # Exactly at intrinsic and exactly at spot are the boundary prices; just
    # outside them there is no volatility that reproduces the quote.
    with pytest.raises(EngineInputError, match="no-arbitrage"):
        implied_volatility(100.0001, 100.0, 90.0, 2.0, 0.03)
    with pytest.raises(EngineInputError, match="positive spot and term"):
        implied_volatility(5.0, 0.0, 90.0, 2.0, 0.03)
    with pytest.raises(EngineInputError, match="positive spot and term"):
        implied_volatility(5.0, 100.0, 90.0, 0.0, 0.03)


@pytest.mark.parametrize("sigma", [0.05, 0.25, 0.9, 2.5])
def test_implied_volatility_round_trips_across_the_band(sigma):
    price = bs_call(120.0, 100.0, 1.5, 0.025, sigma)
    assert implied_volatility(price, 120.0, 100.0, 1.5, 0.025) == pytest.approx(sigma, abs=1e-4)
