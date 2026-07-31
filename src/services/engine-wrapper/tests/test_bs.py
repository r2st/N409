"""Unit tests for Black-Scholes primitives."""

import math
import pytest
from app.engine.bs import norm_cdf, bs_call, bs_put


class TestNormCdf:
    def test_symmetry(self):
        assert norm_cdf(0.0) == pytest.approx(0.5, abs=1e-10)

    def test_large_positive(self):
        assert norm_cdf(6.0) == pytest.approx(1.0, abs=1e-8)

    def test_large_negative(self):
        assert norm_cdf(-6.0) == pytest.approx(0.0, abs=1e-8)

    def test_known_value(self):
        # N(1.0) ≈ 0.8413
        assert norm_cdf(1.0) == pytest.approx(0.8413, abs=1e-3)

    def test_complementary(self):
        # N(x) + N(-x) = 1
        for x in [0.5, 1.0, 2.0, 3.0]:
            assert norm_cdf(x) + norm_cdf(-x) == pytest.approx(1.0, abs=1e-12)


class TestBsCall:
    def test_at_the_money_positive(self):
        # ATM call should be roughly S * N(0.5*σ√T) - K*e^{-rT}*N(-0.5*σ√T)
        val = bs_call(s=100, k=100, t=1.0, r=0.05, sigma=0.3)
        assert val > 0
        assert val < 100  # call < S always

    def test_deep_in_the_money(self):
        # Deep ITM call ≈ S - K*e^{-rT}
        val = bs_call(s=200, k=50, t=1.0, r=0.05, sigma=0.3)
        intrinsic = 200 - 50 * math.exp(-0.05)
        assert val == pytest.approx(intrinsic, rel=0.02)

    def test_deep_out_of_money(self):
        # Deep OTM call ≈ 0
        val = bs_call(s=10, k=200, t=1.0, r=0.05, sigma=0.3)
        assert val == pytest.approx(0.0, abs=0.01)

    def test_zero_volatility(self):
        # σ=0 → max(S - K*e^{-rT}, 0)
        val = bs_call(s=100, k=90, t=1.0, r=0.05, sigma=0.0)
        expected = max(100 - 90 * math.exp(-0.05), 0)
        assert val == pytest.approx(expected, abs=1e-6)

    def test_zero_time(self):
        # T=0 → max(S-K, 0) intrinsic
        val = bs_call(s=110, k=100, t=0.0, r=0.05, sigma=0.3)
        assert val == pytest.approx(10.0, abs=1e-6)

    def test_zero_time_otm(self):
        val = bs_call(s=90, k=100, t=0.0, r=0.05, sigma=0.3)
        assert val == pytest.approx(0.0, abs=1e-6)


class TestBsPut:
    def test_put_call_parity(self):
        # C - P = S - K*e^{-rT}
        S, K, T, r, sigma = 100, 105, 1.5, 0.04, 0.35
        c = bs_call(S, K, T, r, sigma)
        p = bs_put(S, K, T, r, sigma)
        parity = S - K * math.exp(-r * T)
        assert (c - p) == pytest.approx(parity, abs=1e-6)

    def test_deep_itm_put(self):
        # Deep ITM put ≈ K*e^{-rT} - S
        val = bs_put(s=10, k=200, t=1.0, r=0.05, sigma=0.3)
        expected = 200 * math.exp(-0.05) - 10
        assert val == pytest.approx(expected, rel=0.02)

    def test_deep_otm_put(self):
        val = bs_put(s=200, k=10, t=1.0, r=0.05, sigma=0.3)
        assert val == pytest.approx(0.0, abs=0.01)

    def test_zero_vol_put(self):
        val = bs_put(s=80, k=100, t=1.0, r=0.05, sigma=0.0)
        expected = max(100 * math.exp(-0.05) - 80, 0)
        assert val == pytest.approx(expected, abs=1e-6)
