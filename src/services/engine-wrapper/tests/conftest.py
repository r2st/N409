"""Shared test setup.

The one thing that has to hold for every test in this suite: nothing reaches the
network. The comparable screen resolves its universe against the live feed by
default, and "by default" means *wherever ``yfinance`` is importable* — which is
the developer machine that happens to have it and the CI image that happens to
install it, not a decision anyone made per test run. A suite whose comp rankings
depend on today's market is a suite that fails on a Tuesday for reasons nobody
can reproduce.

So the universe is pinned to the curated snapshot here, and the shared feed
client is torn down after each test. A test that wants the live path says so
explicitly — ``live=True`` overrides the environment — and injects a stub
provider to be the market.
"""

import pytest

from app.engine.market_universe import LIVE_ENV_VAR, reset_cache, set_client


@pytest.fixture(autouse=True)
def offline_universe(monkeypatch):
    monkeypatch.setenv(LIVE_ENV_VAR, "off")
    reset_cache()
    yield
    set_client(None)  # also drops any universe resolved through a stub
