"""Unit tests for Newton-Raphson solver and implied volatility."""

import math
import pytest
from app.engine.newton import newton_raphson, implied_volatility
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
