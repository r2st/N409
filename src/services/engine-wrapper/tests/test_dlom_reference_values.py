"""The DLOM models against the formulas the papers state.

Every other DLOM test in this suite is behavioural — monotone in volatility,
bounded, continuous across a threshold, agreeing with a neighbour in a limit.
Those are the right tests for the properties they check, and none of them would
notice if the whole family were scaled by 0.9.

These check the *level*. Each model is recomputed here from its published closed
form, in the literal algebra, using only `math` and `statistics.NormalDist` —
not `bs.py`, not `norm_cdf`, nothing the engine also uses. Where the two agree,
the engine's implementation is right; where they disagree, one of them is wrong
and the disagreement says which figures to look at.

That matters here more than it usually would, because the engine's versions are
not the literal algebra. `finnerty_dlom` and `ghaidarov_dlom` are both factored
to survive an `e^{σ²T}` that would overflow a double past σ²T ≈ 709, and both
switch to a series expansion below a small-variance threshold to avoid losing
the answer to cancellation. Those are two correct rewrites of a formula, and a
rewrite is exactly the kind of change that can be subtly wrong while every
behavioural test still passes.

The reference forms are evaluated only in the range where they are numerically
safe — which is the range the rewrites exist to escape, and the range every real
valuation lives in.
"""

import math
from statistics import NormalDist

import pytest

from app.engine.dlom import (
    chaffee_dlom,
    finnerty_dlom,
    ghaidarov_dlom,
    longstaff_bound,
    longstaff_dlom,
)

PHI = NormalDist().cdf

# (volatility, years) — the range 409A engagements actually occupy: 30%–90%
# volatility over one to seven years to a liquidity event.
REALISTIC = [
    (0.30, 1.0),
    (0.45, 2.0),
    (0.60, 2.0),
    (0.62, 4.0),
    (0.70, 3.5),
    (0.90, 5.0),
    (0.55, 7.0),
]


def reference_chaffee(sigma: float, t: float, r: float) -> float:
    """Chaffee (1993): an at-the-money European put on the restricted security,
    priced by Black-Scholes, as a fraction of the marketable value.

    Written out rather than called: `bs.bs_put` is what the engine uses, so
    using it here would test that the engine calls itself consistently.
    """
    d1 = (r + 0.5 * sigma * sigma) * t / (sigma * math.sqrt(t))
    d2 = d1 - sigma * math.sqrt(t)
    return math.exp(-r * t) * PHI(-d2) - PHI(-d1)


def reference_finnerty(sigma: float, t: float) -> float:
    """Finnerty (2012) average-strike put, in the literal form.

        v²T = σ²T + ln(2(e^{σ²T} − σ²T − 1)) − 2 ln(e^{σ²T} − 1)
        D   = 2Φ(v√T/2) − 1

    `e^{σ²T}` is evaluated directly, which is precisely what the engine's
    factored version avoids — and is fine at the variances below.
    """
    v = sigma * sigma * t
    e = math.exp(v)
    v_sq_t = v + math.log(2.0 * (e - v - 1.0)) - 2.0 * math.log(e - 1.0)
    half = math.sqrt(v_sq_t) / 2.0
    return PHI(half) - PHI(-half)


def reference_ghaidarov(sigma: float, t: float) -> float:
    """Ghaidarov (2009): the same option with the corrected effective variance.

        v²T = ln( 2(e^{σ²T} − σ²T − 1) / (σ²T)² )
    """
    v = sigma * sigma * t
    e = math.exp(v)
    v_sq_t = math.log(2.0 * (e - v - 1.0) / (v * v))
    half = math.sqrt(v_sq_t) / 2.0
    return PHI(half) - PHI(-half)


def reference_longstaff_bound(sigma: float, t: float) -> float:
    """Longstaff (1995): the value of perfect market timing, as a multiple.

        E[max S]/S₀ = (2 + σ²T/2)·Φ(√(σ²T)/2) + √(σ²T/2π)·e^{−σ²T/8}
    """
    v = sigma * sigma * t
    a = math.sqrt(v)
    return (2.0 + v / 2.0) * PHI(a / 2.0) + math.sqrt(v / (2.0 * math.pi)) * math.exp(-v / 8.0) - 1.0


@pytest.mark.parametrize("sigma, t", REALISTIC)
class TestAgainstThePublishedFormulas:
    def test_chaffee(self, sigma, t):
        assert chaffee_dlom(sigma, t, 0.042) == pytest.approx(reference_chaffee(sigma, t, 0.042), abs=1e-9)

    def test_finnerty(self, sigma, t):
        assert finnerty_dlom(sigma, t) == pytest.approx(reference_finnerty(sigma, t), abs=1e-9)

    def test_ghaidarov(self, sigma, t):
        assert ghaidarov_dlom(sigma, t) == pytest.approx(reference_ghaidarov(sigma, t), abs=1e-9)

    def test_longstaff_bound(self, sigma, t):
        assert longstaff_bound(sigma, t) == pytest.approx(reference_longstaff_bound(sigma, t), abs=1e-9)

    def test_longstaff_discount_is_the_bound_read_as_a_fraction(self, sigma, t):
        # L / (1 + L): the restricted interest is worth S₀ where a timeable one
        # is worth S₀(1 + L).
        bound = reference_longstaff_bound(sigma, t)
        assert longstaff_dlom(sigma, t) == pytest.approx(bound / (1.0 + bound), abs=1e-9)


class TestKnownLevels:
    """Figures worked by hand, so a wrong answer is caught by arithmetic rather
    than by a second implementation that could share a mistake."""

    def test_the_finnerty_discount_on_the_reference_engagement(self):
        """σ = 62%, T = 4y — the sample 409A this platform renders.

            σ²T   = 0.3844 × 4          = 1.5376
            e^-v                        = 0.214887
            ln(1 − (v+1)e^-v)           = ln(0.454700)  = −0.788177
            2·ln(1 − e^-v)              = 2·ln(0.785113) = −0.483923
            v²T   = ln2 − 0.788177 + 0.483923            =  0.388893
            v√T   = 0.623613,  half = 0.311806
            D     = 2Φ(0.311806) − 1                     =  0.24480
        """
        assert finnerty_dlom(0.62, 4.0) == pytest.approx(0.2448, abs=5e-5)

    def test_the_finnerty_ceiling_is_where_the_algebra_puts_it(self):
        # v²T → ln2, so v√T → 0.832555 and D → 2Φ(0.416277) − 1 = 0.322771.
        # The ~32.3% figure the model is known for, and a property of Finnerty's
        # algebra rather than of marketability — which is the whole reason
        # Ghaidarov is offered beside it.
        assert finnerty_dlom(3.0, 100.0) == pytest.approx(2 * PHI(math.sqrt(math.log(2)) / 2) - 1, abs=1e-6)

    def test_chaffee_at_sixty_percent_over_two_years(self):
        """σ = 60%, T = 2, r = 4%, at the money.

            d₁ = (0.04 + 0.18)·2 / (0.6·√2) = 0.518545
            d₂ = d₁ − 0.848528              = −0.329983
            P  = e^-0.08·Φ(0.329983) − Φ(−0.518545) = 0.278862
        """
        assert chaffee_dlom(0.60, 2.0, 0.04) == pytest.approx(0.2789, abs=5e-5)


class TestTheModelsDisagreeTheWayTheyShould:
    """The relationships a reviewer relies on when choosing between them."""

    @pytest.mark.parametrize("sigma, t", REALISTIC)
    def test_ghaidarov_is_at_least_finnerty(self, sigma, t):
        # They agree to first order and part company above it: Finnerty's extra
        # terms drive its effective variance to ln2, Ghaidarov's keeps growing.
        assert ghaidarov_dlom(sigma, t) >= finnerty_dlom(sigma, t) - 1e-12

    @pytest.mark.parametrize("sigma, t", REALISTIC)
    def test_longstaff_is_the_loosest_of_the_three(self, sigma, t):
        # It prices perfect market timing, which is worth more than the right
        # to sell at one date — so it bounds the option models from above, and a
        # report concluding on it should say it is an upper bound.
        assert longstaff_dlom(sigma, t) >= ghaidarov_dlom(sigma, t)

    @pytest.mark.parametrize("sigma, t", REALISTIC)
    def test_every_model_lands_in_a_range_a_reviewer_would_accept(self, sigma, t):
        # Not a mathematical property — a sanity floor and ceiling on the whole
        # family across the range real engagements occupy. A model returning 2%
        # or 95% here is a bug, whatever its algebra says.
        for value in (chaffee_dlom(sigma, t, 0.042), finnerty_dlom(sigma, t), ghaidarov_dlom(sigma, t)):
            assert 0.05 < value < 0.90
