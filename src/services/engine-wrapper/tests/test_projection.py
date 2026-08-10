"""Projection engine tests."""

import pytest
from fastapi.testclient import TestClient

from app.engine.approaches import income_dcf
from app.engine.errors import EngineInputError
from app.engine.projection import (
    project_financials,
    terminal_value_exit_multiple,
    terminal_value_gordon,
)
from app.main import app

client = TestClient(app)


def test_growth_method_fcf_math():
    out = project_financials(
        method="growth",
        years=1,
        base_revenue=1000.0,
        revenue_growth=0.10,
        cogs_pct=0.60,
        opex_pct=0.20,
        da_pct=0.05,
        capex_pct=0.05,
        nwc_pct=0.10,
        prior_nwc=100.0,  # == base 1000 · 10%
        tax_rate=0.21,
    )
    row = out["projections"][0]
    assert row["revenue"] == pytest.approx(1100.0)
    assert row["cogs"] == pytest.approx(660.0)
    assert row["opex"] == pytest.approx(220.0)
    assert row["da"] == pytest.approx(55.0)
    ebit = 1100 - 660 - 220 - 55  # 165
    assert row["ebit"] == pytest.approx(ebit)
    nopat = ebit * 0.79
    delta_nwc = 110.0 - 100.0
    fcf = nopat + 55.0 - 55.0 - delta_nwc
    assert row["fcff"] == pytest.approx(fcf, abs=0.01)
    assert out["free_cash_flows"][0] == pytest.approx(fcf, abs=0.01)


def test_growth_compounds_revenue():
    out = project_financials(
        method="growth", base_revenue=100.0, revenue_growth=[0.1, 0.2], cogs_pct=0.5
    )
    revs = [p["revenue"] for p in out["projections"]]
    assert revs == pytest.approx([110.0, 132.0])


def test_driver_method_explicit_lines():
    out = project_financials(
        method="driver",
        revenue=[1000.0, 1200.0],
        cogs=[600.0, 700.0],
        opex=[200.0, 220.0],
        da=[50.0, 60.0],
        capex=[80.0, 90.0],
        nwc=[100.0, 130.0],
        prior_nwc=100.0,
        tax_rate=0.25,
    )
    assert out["years"] == 2
    y2 = out["projections"][1]
    ebit = 1200 - 700 - 220 - 60
    assert y2["ebit"] == pytest.approx(ebit)
    assert y2["delta_nwc"] == pytest.approx(30.0)


def test_terminal_value_helpers():
    assert terminal_value_gordon(100.0, 0.12, 0.02) == pytest.approx(100 * 1.02 / 0.10)
    assert terminal_value_exit_multiple(500.0, 8.0) == 4000.0
    with pytest.raises(EngineInputError):
        terminal_value_gordon(100.0, 0.02, 0.05)  # r <= g


def test_terminal_methods_in_projection():
    g = project_financials(
        method="growth", years=3, base_revenue=1000.0, revenue_growth=0.1, cogs_pct=0.5,
        da_pct=0.05, terminal_method="gordon", discount_rate=0.15, terminal_growth=0.03,
    )
    assert g["terminal_value"] is not None and g["terminal_value"] > 0
    x = project_financials(
        method="growth", years=3, base_revenue=1000.0, revenue_growth=0.1, cogs_pct=0.5,
        da_pct=0.05, terminal_method="exit_multiple", exit_multiple=10.0, exit_metric="ebitda",
    )
    assert x["terminal_value"] == pytest.approx(x["projections"][-1]["ebitda"] * 10.0)


def test_projection_feeds_income_dcf():
    proj = project_financials(
        method="growth", years=5, base_revenue=2000.0, revenue_growth=0.15,
        cogs_pct=0.55, opex_pct=0.25, da_pct=0.05, capex_pct=0.06, nwc_pct=0.08,
    )
    dcf = income_dcf(proj["free_cash_flows"], 0.18, 0.03)
    assert dcf["enterprise_value"] > 0


def test_validation_and_endpoint():
    with pytest.raises(EngineInputError):
        project_financials(method="growth")  # missing base_revenue/growth
    with pytest.raises(EngineInputError):
        project_financials(method="bogus", revenue=[1.0])

    r = client.post(
        "/engine/v1/projection",
        json={"inputs": {"method": "growth", "years": 3, "base_revenue": 1000, "revenue_growth": 0.1, "cogs_pct": 0.6}},
    )
    assert r.status_code == 200
    assert len(r.json()["free_cash_flows"]) == 3

    bad = client.post("/engine/v1/projection", json={"inputs": {"method": "growth"}})
    assert bad.status_code == 422


# ── Forecast horizon bounds ──────────────────────────────────────────────────


def test_forecast_horizon_is_capped():
    # `{"years": 3000000, "revenue_growth": 0}` is 122 bytes and was measured at
    # nine seconds and 3.6 GB resident, before the response was serialised.
    with pytest.raises(EngineInputError) as exc:
        project_financials(method="growth", years=3_000_000, base_revenue=1e6, revenue_growth=0.0)
    assert "years must be <=" in str(exc.value)


def test_flat_growth_does_not_escape_the_cap():
    # A *positive* growth rate overflows out of a long horizon on its own around
    # year 7,300, which made the horizon look bounded when it was not. A flat or
    # negative rate compounds to nothing and runs every year asked for.
    with pytest.raises(EngineInputError):
        project_financials(method="growth", years=500_000, base_revenue=1e6, revenue_growth=-0.01)


def test_a_long_but_defensible_horizon_still_projects():
    out = project_financials(
        method="growth", years=100, base_revenue=1_000_000, revenue_growth=0.05, cogs_pct=0.4
    )
    assert len(out["free_cash_flows"]) == 100
    assert out["years"] == 100


def test_driver_method_horizon_is_capped_too():
    with pytest.raises(EngineInputError):
        project_financials(method="driver", revenue=[1.0] * 101)


def test_non_integer_years_names_the_field():
    # `[rate] * 1.5` is a bare TypeError; the caller should be told which input
    # was wrong.
    with pytest.raises(EngineInputError) as exc:
        project_financials(method="growth", years=1.5, base_revenue=1e6, revenue_growth=0.1)
    assert "years" in str(exc.value)


def test_oversized_projection_answers_422_over_http():
    from fastapi.testclient import TestClient

    from app.main import app

    res = TestClient(app).post(
        "/engine/v1/projection",
        json={"inputs": {"method": "growth", "years": 5_000_000, "base_revenue": 1e6, "revenue_growth": 0.0}},
    )
    assert res.status_code == 422
    assert "years must be <=" in res.json()["detail"]


# ── Which figure the exit multiple is struck on ──────────────────────────────
#
# `exit_metric` picked EBITDA on an exact string match and fell through to
# revenue for everything else, so the one thing a caller could not do was ask
# for a metric and be told it was not understood.


_EXIT_BASE: dict = dict(
    method="growth",
    years=2,
    base_revenue=1000.0,
    revenue_growth=0.1,
    cogs_pct=0.4,
    opex_pct=0.3,
    da_pct=0.05,
    terminal_method="exit_multiple",
    exit_multiple=8.0,
)


@pytest.mark.parametrize("metric", ["EBITDA", "Ebitda", "ebit", "eBiTdA", "", "net_income"])
def test_unrecognised_exit_metric_is_refused_not_read_as_revenue(metric):
    # The specific case this was found on: `"EBITDA"` differs from `"ebitda"` by
    # capitalisation alone and struck the multiple on revenue — 8 x 1,210 rather
    # than 8 x 363, a terminal value 3.3x too high, reported without complaint.
    with pytest.raises(EngineInputError) as exc:
        project_financials(**_EXIT_BASE, exit_metric=metric)
    assert "exit_metric" in str(exc.value)


def test_the_two_recognised_exit_metrics_strike_the_figure_they_name():
    ebitda = project_financials(**_EXIT_BASE, exit_metric="ebitda")
    revenue = project_financials(**_EXIT_BASE, exit_metric="revenue")
    last = ebitda["projections"][-1]
    assert ebitda["terminal_value"] == pytest.approx(last["ebitda"] * 8.0)
    assert revenue["terminal_value"] == pytest.approx(last["revenue"] * 8.0)
    # And they are genuinely different figures, so a test that confused them
    # could not pass by coincidence.
    assert ebitda["terminal_value"] != revenue["terminal_value"]


def test_the_default_exit_metric_is_ebitda():
    out = project_financials(**_EXIT_BASE)
    assert out["terminal_value"] == pytest.approx(out["projections"][-1]["ebitda"] * 8.0)


def test_unrecognised_exit_metric_answers_422_over_http():
    res = client.post(
        "/engine/v1/projection",
        json={"inputs": {**_EXIT_BASE, "exit_metric": "EBITDA"}},
    )
    assert res.status_code == 422
    assert "exit_metric" in res.json()["detail"]


# ── A terminal metric a multiple cannot be struck against ────────────────────


def test_negative_terminal_metric_is_refused_here_as_income_dcf_refuses_it():
    # A terminal year that loses money returned a *negative* terminal value,
    # which `approaches.income_dcf` then refuses outright — so the endpoint
    # handed the analyst figures the calculation would not accept.
    with pytest.raises(EngineInputError) as exc:
        project_financials(
            method="growth",
            years=1,
            base_revenue=1000.0,
            revenue_growth=0.0,
            cogs_pct=0.7,
            opex_pct=0.6,
            terminal_method="exit_multiple",
            exit_multiple=8.0,
        )
    assert "positive" in str(exc.value)


def test_exit_multiple_helper_refuses_a_non_positive_metric():
    assert terminal_value_exit_multiple(500.0, 8.0) == 4000.0
    for metric in (0.0, -1.0, -500.0):
        with pytest.raises(EngineInputError):
            terminal_value_exit_multiple(metric, 8.0)


# ── Driver lines that are not lines ──────────────────────────────────────────


@pytest.mark.parametrize("line", ["cogs", "opex", "da", "capex", "nwc"])
def test_a_scalar_driver_line_names_the_field(line):
    # `len(5)` was a bare `TypeError: object of type 'int' has no len()` —
    # a 422, but with no field in the detail for the caller to act on.
    with pytest.raises(EngineInputError) as exc:
        project_financials(method="driver", revenue=[100.0, 200.0], **{line: 5})
    assert line in str(exc.value)


@pytest.mark.parametrize("revenue", [123, 4.5, {"2026": 100}, None])
def test_a_driver_revenue_that_is_not_a_list_names_the_field(revenue):
    with pytest.raises(EngineInputError) as exc:
        project_financials(method="driver", revenue=revenue)
    assert "revenue" in str(exc.value)


def test_a_string_driver_line_is_not_iterated_over_its_characters():
    # `"100"` is iterable, so it used to reach `_num` three times and produce a
    # three-year forecast of 1, 0 and 0 from what was plainly a typo.
    with pytest.raises(EngineInputError) as exc:
        project_financials(method="driver", revenue="100")
    assert "must be a list" in str(exc.value)


def test_a_scalar_driver_line_answers_422_with_the_field_named():
    res = client.post(
        "/engine/v1/projection",
        json={"inputs": {"method": "driver", "revenue": [100, 200], "cogs": 5}},
    )
    assert res.status_code == 422
    assert "cogs" in res.json()["detail"]


def test_driver_lines_that_are_lists_still_project():
    out = project_financials(
        method="driver",
        revenue=[100.0, 200.0],
        cogs=(40.0, 80.0),  # a tuple is a per-year line too
    )
    assert [p["cogs"] for p in out["projections"]] == pytest.approx([40.0, 80.0])
