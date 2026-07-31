"""Unit tests for DLOM models (Chaffee protective put, Finnerty average-strike put)."""

import pytest
from app.engine.dlom import chaffee_dlom, finnerty_dlom


class TestChaffeeDlom:
    def test_basic_range(self):
        # Typical parameters should yield a discount between 0 and 1
        d = chaffee_dlom(sigma=0.5, t=2.0, r=0.04)
        assert 0 < d < 1

    def test_zero_volatility(self):
        # σ=0 → no uncertainty → DLOM = 0
        d = chaffee_dlom(sigma=0.0, t=2.0, r=0.04)
        assert d == pytest.approx(0.0, abs=1e-10)

    def test_higher_vol_higher_dlom(self):
        d_low = chaffee_dlom(sigma=0.3, t=2.0, r=0.04)
        d_high = chaffee_dlom(sigma=0.8, t=2.0, r=0.04)
        assert d_high > d_low

    def test_longer_time_higher_dlom(self):
        d_short = chaffee_dlom(sigma=0.5, t=0.5, r=0.04)
        d_long = chaffee_dlom(sigma=0.5, t=5.0, r=0.04)
        assert d_long > d_short

    def test_capped_at_099(self):
        # Extreme params should still be capped at 0.99
        d = chaffee_dlom(sigma=5.0, t=20.0, r=0.0)
        assert d <= 0.99


class TestFinnertyDlom:
    def test_basic_range(self):
        d = finnerty_dlom(sigma=0.5, t=2.0)
        assert 0 < d < 1

    def test_zero_volatility(self):
        d = finnerty_dlom(sigma=0.0, t=2.0)
        assert d == pytest.approx(0.0, abs=1e-10)

    def test_higher_vol_higher_dlom(self):
        d_low = finnerty_dlom(sigma=0.3, t=2.0)
        d_high = finnerty_dlom(sigma=0.8, t=2.0)
        assert d_high > d_low

    def test_longer_time_higher_dlom(self):
        d_short = finnerty_dlom(sigma=0.5, t=0.5)
        d_long = finnerty_dlom(sigma=0.5, t=5.0)
        assert d_long > d_short

    def test_capped_at_099(self):
        d = finnerty_dlom(sigma=5.0, t=20.0)
        assert d <= 0.99

    def test_chaffee_vs_finnerty_similar_inputs(self):
        # Both models should yield comparable DLOM for typical inputs
        c = chaffee_dlom(sigma=0.5, t=2.0, r=0.04)
        f = finnerty_dlom(sigma=0.5, t=2.0)
        # They're different models, but should be in the same general range
        assert abs(c - f) < 0.3
