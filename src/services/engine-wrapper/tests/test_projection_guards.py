"""Every input `project_financials` refuses, and the message it refuses with.

`/engine/v1/projection` hands the analyst the cash flows a DCF is then run on,
so a figure it accepts becomes the engagement's forecast. The guards below are
the whole of what stands between a mistyped assumption and a projection that
looks arithmetically fine — and none of them had a test, so the only thing
pinning "years: 0" to an error rather than an empty forecast was the code
itself.

Each case asserts the field name in the message as well as the refusal. The
route maps `EngineInputError` onto a 422 whose detail is this string, so it is
the only thing telling the caller which of the fourteen assumptions was wrong.
"""

import math

import pytest

from app.engine.errors import EngineInputError
from app.engine.projection import (
    MAX_FORECAST_YEARS,
    project_financials,
    terminal_value_exit_multiple,
)

GROWTH = {"method": "growth", "years": 2, "base_revenue": 1000.0, "revenue_growth": 0.1}


def test_non_numeric_figure_names_its_field():
    # `float("lots")` is a ValueError, which is not an EngineInputError and so
    # never reached the route's 422 handler.
    with pytest.raises(EngineInputError, match="base_revenue must be a number"):
        project_financials(
            method="growth", years=1, base_revenue="lots", revenue_growth=0.1
        )


def test_negative_tax_rate_is_refused_as_negative():
    with pytest.raises(EngineInputError, match="tax_rate must be >= 0"):
        project_financials(**GROWTH, tax_rate=-0.1)


def test_tax_rate_of_one_leaves_no_profit_after_tax():
    with pytest.raises(EngineInputError, match=r"tax_rate must be in \[0, 1\)"):
        project_financials(**GROWTH, tax_rate=1.0)


def test_per_year_growth_list_must_match_the_horizon():
    # Two rates for a three-year forecast: the third year would otherwise have
    # been whatever `_rate_vector` happened to leave in place.
    with pytest.raises(EngineInputError, match="revenue_growth list must have 3 entries"):
        project_financials(
            method="growth", years=3, base_revenue=100.0, revenue_growth=[0.1, 0.2]
        )


def test_base_revenue_must_be_positive():
    with pytest.raises(EngineInputError, match="base_revenue must be positive"):
        project_financials(
            method="growth", years=1, base_revenue=0.0, revenue_growth=0.1
        )


def test_growth_method_needs_a_horizon():
    with pytest.raises(EngineInputError, match="growth method needs years"):
        project_financials(
            method="growth", years=0, base_revenue=100.0, revenue_growth=0.1
        )


def test_horizon_past_any_defensible_forecast_period():
    with pytest.raises(EngineInputError, match=f"years must be <= {MAX_FORECAST_YEARS}"):
        project_financials(
            method="growth",
            years=MAX_FORECAST_YEARS + 1,
            base_revenue=100.0,
            revenue_growth=0.1,
        )


def test_driver_method_needs_a_non_empty_revenue_line():
    with pytest.raises(EngineInputError, match="revenue list must be non-empty"):
        project_financials(method="driver", revenue=[])


def test_driver_lines_must_match_the_revenue_line():
    # A short `cogs` would otherwise have been indexed past its end, or the
    # extra years silently costed at zero.
    with pytest.raises(EngineInputError, match="cogs must have 2 entries to match revenue"):
        project_financials(method="driver", revenue=[100.0, 200.0], cogs=[10.0])


def test_gordon_terminal_value_needs_a_discount_rate():
    with pytest.raises(EngineInputError, match="gordon terminal value needs discount_rate"):
        project_financials(**GROWTH, terminal_method="gordon")


def test_exit_multiple_terminal_value_needs_a_multiple():
    with pytest.raises(EngineInputError, match="needs exit_multiple"):
        project_financials(**GROWTH, terminal_method="exit_multiple")


def test_unrecognised_terminal_method_is_not_silently_none():
    # "perpetuity" is the same idea as "gordon" under another name; taking it
    # for None returned a forecast with no terminal value and no complaint,
    # which on a five-year DCF drops the majority of the enterprise value.
    with pytest.raises(EngineInputError, match="terminal_method must be"):
        project_financials(**GROWTH, terminal_method="perpetuity")


def test_exit_multiple_itself_must_be_positive():
    with pytest.raises(EngineInputError, match="exit multiple must be positive"):
        terminal_value_exit_multiple(100.0, 0.0)


# ── the terminal value, which is `None` for two different reasons ─────────────
#
# `terminal_value` is `None` when no terminal value was asked for. It was also
# `None` when one was asked for and overflowed: `round(inf, 2)` is `inf`, which
# FastAPI serialises as `null`, so the response came back 200 and a consumer
# could not tell "you did not ask for one" from "the perpetuity left the
# doubles". `_finite` is applied to the projected revenue and to every free cash
# flow for exactly this reason; the terminal value is the third computed figure
# in the function and was the one it stopped short of.
#
# Reachable without a single non-finite input: the free cash flows here are
# ~1.98e307 and finite, and the Gordon denominator of 0.1 is what takes the
# quotient past the end of the doubles.
HUGE_FORECAST = {
    "method": "growth",
    "years": 2,
    "base_revenue": 1e308,
    "revenue_growth": 0.0,
    "cogs_pct": 0.4,
    "opex_pct": 0.3,
    "da_pct": 0.05,
    "capex_pct": 0.05,
    "nwc_pct": 0.0,
}


def test_an_overflowing_gordon_terminal_value_is_refused_rather_than_nulled():
    with pytest.raises(EngineInputError, match="Gordon terminal value overflowed"):
        project_financials(
            **HUGE_FORECAST, terminal_method="gordon", discount_rate=0.1, terminal_growth=0.0
        )


def test_an_overflowing_exit_multiple_terminal_value_is_refused_too():
    with pytest.raises(EngineInputError, match="exit-multiple terminal value overflowed"):
        project_financials(
            **HUGE_FORECAST, terminal_method="exit_multiple", exit_multiple=1e10, exit_metric="revenue"
        )


def test_the_message_names_what_to_look_at_rather_than_the_growth_rate():
    """The inherited hint — "check the growth and margin assumptions" — is right
    for a runaway forecast line and wrong here: this forecast is flat, and what
    overflowed is the perpetuity's own denominator."""
    with pytest.raises(EngineInputError) as err:
        project_financials(
            **HUGE_FORECAST, terminal_method="gordon", discount_rate=0.1, terminal_growth=0.0
        )
    assert "terminal growth rate" in str(err.value)
    assert "margin assumptions" not in str(err.value)


def test_the_flows_themselves_are_still_finite_on_that_forecast():
    """Otherwise the test above would be pinning the free-cash-flow guard that
    already existed rather than the terminal-value one that did not."""
    out = project_financials(**HUGE_FORECAST)
    assert all(math.isfinite(f) for f in out["free_cash_flows"])
    assert out["terminal_value"] is None


def test_an_ordinary_forecast_still_reports_both_terminal_values():
    ordinary = {**HUGE_FORECAST, "base_revenue": 1_000_000.0}
    gordon = project_financials(
        **ordinary, terminal_method="gordon", discount_rate=0.1, terminal_growth=0.0
    )
    assert gordon["terminal_value"] == pytest.approx(1_975_000.0)
    exit_mult = project_financials(
        **ordinary, terminal_method="exit_multiple", exit_multiple=8.0, exit_metric="ebitda"
    )
    assert exit_mult["terminal_value"] == pytest.approx(2_400_000.0)
