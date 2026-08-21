"""Unit tests for Newton-Raphson solver and implied volatility."""

import math
import pytest
from app.engine.newton import newton_raphson, implied_volatility, _bisect
from app.engine.errors import EngineInputError
from app.engine.bs import bs_call


class TestNewtonRaphson:
    def test_simple_quadratic(self):
        root, iters = newton_raphson(lambda x: x * x - 9.0, 1.0)
        assert root == pytest.approx(3.0, abs=1e-6)

    def test_cubic(self):
        root, _ = newton_raphson(lambda x: x ** 3 - 27.0, 2.0)
        assert root == pytest.approx(3.0, abs=1e-6)

    def test_trig(self):
        # Solve sin(x) = 0 near x=3 → should find π
        root, _ = newton_raphson(lambda x: math.sin(x), 3.0)
        assert root == pytest.approx(math.pi, abs=1e-6)

    def test_bisection_fallback(self):
        # Start at x=0 where derivative of x^3 is 0 → forces bisection fallback
        root, _ = newton_raphson(lambda x: x ** 3 - 8.0, 0.0, min_x=0.0, max_x=10.0)
        assert root == pytest.approx(2.0, abs=1e-4)

    def test_convergence_within_bounds(self):
        root, iters = newton_raphson(
            lambda x: x * x - 4.0, 10.0, min_x=0.0, max_x=100.0
        )
        assert root == pytest.approx(2.0, abs=1e-6)
        assert 0.0 <= root <= 100.0


class TestImpliedVolatility:
    def test_roundtrip(self):
        # Price a call at known vol, then recover it
        S, K, T, r, true_sigma = 100, 110, 2.0, 0.04, 0.45
        price = bs_call(S, K, T, r, true_sigma)
        iv = implied_volatility(price, S, K, T, r)
        assert iv == pytest.approx(true_sigma, abs=1e-3)

    def test_atm(self):
        S, K, T, r, true_sigma = 100, 100, 1.0, 0.05, 0.3
        price = bs_call(S, K, T, r, true_sigma)
        iv = implied_volatility(price, S, K, T, r)
        assert iv == pytest.approx(true_sigma, abs=1e-3)

    def test_deep_itm(self):
        S, K, T, r, true_sigma = 200, 50, 1.0, 0.05, 0.5
        price = bs_call(S, K, T, r, true_sigma)
        iv = implied_volatility(price, S, K, T, r)
        assert iv == pytest.approx(true_sigma, abs=0.05)  # wider tolerance, deep ITM

    def test_low_vol(self):
        S, K, T, r, true_sigma = 100, 105, 1.0, 0.05, 0.1
        price = bs_call(S, K, T, r, true_sigma)
        iv = implied_volatility(price, S, K, T, r)
        assert iv == pytest.approx(true_sigma, abs=1e-3)


class TestBisectSignComparison:
    """The bracket decision, when f's values are very small.

    Both of `_bisect`'s sign questions used to be asked as a product —
    `f_lo * f_hi > 0` and `f_lo * f_mid < 0`. For values around 1e-171 that
    product is around 1e-342, below the smallest subnormal double, so it
    underflows to a signed zero and `-0.0 < 0.0` is False: two opposite-signed
    values are reported as same-signed.

    This was recorded as a known gap and left, on the reasoning that no
    per-share objective the platform solves reaches that magnitude and that a
    fix would therefore be "a diff with no test that can fail without it". The
    first half is still true. The second half was not — these are those tests,
    and each of them fails on the product comparison.

    Why it is worth closing anyway: the failure is silent. Bisection told the
    root is in the wrong half discards the half containing it and returns an
    endpoint, with no error and nothing in the result that says so. A root
    finder that answers confidently and wrongly is a different risk from one
    that raises, and `_bisect` is the fallback the OPM backsolve and implied
    volatility rely on precisely when Newton has already failed.
    """

    def test_finds_the_root_when_every_value_underflows_a_product(self):
        # Root at 0.3; |f| never exceeds 7e-171, so f_lo * f_mid is -0.0.
        f = lambda x: (x - 0.3) * 1e-170
        root, _ = _bisect(f, 0.0, 1.0, tol=1e-9, max_iter=200)
        assert root == pytest.approx(0.3, abs=1e-6)

    def test_the_product_that_used_to_decide_it_is_a_signed_zero(self):
        # The mechanism, pinned separately: if this ever stops underflowing,
        # the test above stops testing what it says it does.
        f = lambda x: (x - 0.3) * 1e-170
        assert f(0.0) < 0.0 < f(0.5)
        assert f(0.0) * f(0.5) == 0.0
        assert not (f(0.0) * f(0.5) < 0.0)

    def test_rejects_an_unbracketed_interval_of_small_values(self):
        # Same underflow on the entry check: two same-signed tiny values give a
        # product of +0.0, which is not `> 0`, so the guard used to pass and
        # bisection ran on an interval with no root in it.
        f = lambda x: (x + 1.0) * 1e-170
        assert f(0.0) * f(1.0) == 0.0
        with pytest.raises(EngineInputError, match="not bracketed"):
            _bisect(f, 0.0, 1.0, tol=1e-9, max_iter=200)

    def test_ordinary_magnitudes_are_unaffected(self):
        # The guard against fixing the tail and breaking the body.
        f = lambda x: x * x - 9.0
        root, _ = _bisect(f, 0.0, 10.0, tol=1e-12, max_iter=200)
        assert root == pytest.approx(3.0, abs=1e-6)

    def test_still_rejects_an_ordinary_unbracketed_interval(self):
        with pytest.raises(EngineInputError, match="not bracketed"):
            _bisect(lambda x: x * x + 1.0, 0.0, 10.0, tol=1e-9, max_iter=200)

    def test_a_root_on_either_endpoint_is_returned_directly(self):
        assert _bisect(lambda x: x - 0.0, 0.0, 1.0, tol=1e-9, max_iter=200) == (0.0, 0)
        assert _bisect(lambda x: x - 1.0, 0.0, 1.0, tol=1e-9, max_iter=200) == (1.0, 0)

    def test_a_nan_is_refused_rather_than_solved(self):
        # A behaviour change, and the right way round: the product comparison
        # let a NaN through to produce a number nobody could attribute.
        with pytest.raises(EngineInputError, match="not bracketed"):
            _bisect(lambda x: math.nan, 0.0, 1.0, tol=1e-9, max_iter=200)

    def test_the_bisection_fallback_reaches_this_code(self):
        # Vacuity guard for the module rather than the function: `_bisect` is
        # only ever called as newton_raphson's fallback, so a refactor that
        # stopped calling it would leave every test above passing against
        # something the engine no longer uses.
        calls = []

        def f(x: float) -> float:
            calls.append(x)
            # Zero derivative everywhere Newton looks, so it must fall back.
            return -1.0 if x < 0.3 else 1.0

        root, _ = newton_raphson(f, 0.5, tol=1e-9, max_iter=5, min_x=0.0, max_x=1.0)
        assert root == pytest.approx(0.3, abs=1e-3)
        assert len(calls) > 5
