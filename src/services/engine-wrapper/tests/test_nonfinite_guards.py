"""No calculation may answer with a number that is not a number.

The engine's standing rule (audit T-1 P3) is that NaN and Inf are rejected at
the boundary, because once inside they propagate silently: every downstream
figure becomes NaN and the run still looks like a success. FastAPI makes that
worse rather than better — it serialises NaN as ``null``, so the caller gets a
200 with holes in it instead of anything that reads as a failure.

The rule is easy to break in a way no ordinary test catches, because the usual
range check does not stop it: ``NaN <= 0`` is False, so ``must be positive``
lets NaN straight through. These tests cover the numeric front doors of each
module and assert the same thing at every one — a clear EngineInputError, not
a quietly poisoned result.

`Infinity` and `NaN` do arrive over the wire: Python's json.loads accepts both
literals, so a payload can contain them and a middleware cannot filter what
Pydantic has already parsed into a float.
"""

from __future__ import annotations

import json
import math

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.projection import project_financials
from app.engine.volatility import estimate_volatility
from app.engine.waterfall import allocate_waterfall, exit_allocation
from app.main import app

NAN = float("nan")
INF = float("inf")
NEG_INF = float("-inf")

COMMON = {"name": "Common", "kind": "common", "shares": 1_000_000}
T, R, SIGMA = 3.0, 0.04, 0.60

client = TestClient(app)


def has_nonfinite(value: object) -> bool:
    """True if any float anywhere in the structure is NaN or infinite."""
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, dict):
        return any(has_nonfinite(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return any(has_nonfinite(v) for v in value)
    return False


class TestCapTable:
    """The cap table is the most load-bearing input on a 409A."""

    @pytest.mark.parametrize("bad", [NAN, INF, NEG_INF])
    def test_share_count_must_be_finite(self, bad: float) -> None:
        with pytest.raises(EngineInputError, match="finite"):
            exit_allocation(1e6, [{"name": "Common", "kind": "common", "shares": bad}])

    def test_a_nan_share_count_is_not_saved_by_the_positivity_check(self) -> None:
        # The check reads `shares <= 0`, which is False for NaN. Without the
        # finite guard this allocated NaN to every class and returned 200.
        err = pytest.raises(
            EngineInputError, exit_allocation, 1e6, [{**COMMON, "shares": NAN}]
        )
        assert "finite" in str(err.value)

    @pytest.mark.parametrize("bad", [NAN, INF])
    def test_preference_must_be_finite(self, bad: float) -> None:
        classes = [COMMON, {"name": "A", "kind": "preferred", "shares": 1e6, "preference": bad}]
        with pytest.raises(EngineInputError, match="finite"):
            exit_allocation(1e6, classes)

    @pytest.mark.parametrize("bad", [NAN, INF])
    def test_conversion_ratio_must_be_finite(self, bad: float) -> None:
        classes = [
            COMMON,
            {
                "name": "A",
                "kind": "preferred",
                "shares": 1e6,
                "preference": 1e6,
                "conversion_ratio": bad,
            },
        ]
        with pytest.raises(EngineInputError, match="finite"):
            exit_allocation(1e6, classes)

    @pytest.mark.parametrize("bad", [NAN, INF])
    def test_option_strike_must_be_finite(self, bad: float) -> None:
        classes = [COMMON, {"name": "Pool", "kind": "option", "shares": 1e5, "strike": bad}]
        with pytest.raises(EngineInputError, match="finite"):
            exit_allocation(1e6, classes)

    @pytest.mark.parametrize("bad", [NAN, INF, NEG_INF])
    def test_opm_equity_value_must_be_finite(self, bad: float) -> None:
        with pytest.raises(EngineInputError, match="finite"):
            allocate_waterfall(bad, [COMMON], T, R, SIGMA)

    @pytest.mark.parametrize("bad", [NAN, INF])
    def test_deterministic_exit_value_must_be_finite(self, bad: float) -> None:
        with pytest.raises(EngineInputError, match="finite"):
            exit_allocation(bad, [COMMON])

    def test_a_healthy_cap_table_is_unaffected(self) -> None:
        alloc = exit_allocation(1e6, [COMMON])
        assert not has_nonfinite(alloc)
        assert alloc["common_value"] == pytest.approx(1e6)


class TestProjection:
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"base_revenue": INF, "revenue_growth": 0.1, "years": 3},
            {"base_revenue": NAN, "revenue_growth": 0.1, "years": 3},
            {"base_revenue": 1e6, "revenue_growth": NAN, "years": 3},
            {"base_revenue": 1e6, "revenue_growth": INF, "years": 3},
        ],
    )
    def test_non_finite_inputs_are_rejected(self, kwargs: dict) -> None:
        with pytest.raises(EngineInputError, match="finite"):
            project_financials(method="growth", **kwargs)

    def test_a_per_year_growth_list_is_checked_element_by_element(self) -> None:
        with pytest.raises(EngineInputError, match="finite"):
            project_financials(
                method="growth", base_revenue=1e6, revenue_growth=[0.2, NAN, 0.1], years=3
            )

    def test_finite_inputs_that_overflow_while_compounding_are_caught(self) -> None:
        # Nothing here is non-finite on the way in. Fifteen years of a
        # fat-fingered growth rate overflows on its own, and inf − inf is NaN,
        # so the projection ended up part astronomical and part null.
        with pytest.raises(EngineInputError, match="overflow"):
            project_financials(
                method="growth", base_revenue=1e6, revenue_growth=1e30, years=15
            )

    def test_the_overflow_message_names_the_year_it_happened(self) -> None:
        err = pytest.raises(
            EngineInputError,
            project_financials,
            method="growth",
            base_revenue=1e6,
            revenue_growth=1e30,
            years=15,
        )
        assert "year 11" in str(err.value)

    def test_a_driver_revenue_list_must_be_finite(self) -> None:
        with pytest.raises(EngineInputError, match="finite"):
            project_financials(method="driver", revenue=[1e6, INF, 1.2e6])

    def test_a_large_but_survivable_projection_still_works(self) -> None:
        # The guard must not turn a merely aggressive forecast into an error.
        out = project_financials(
            method="growth", base_revenue=1e6, revenue_growth=2.0, years=10
        )
        assert not has_nonfinite(out)
        assert len(out["free_cash_flows"]) == 10


class TestVolatility:
    @pytest.mark.parametrize("bad", [NAN, INF])
    def test_a_non_finite_price_is_a_422_not_a_500(self, bad: float) -> None:
        # Unguarded, statistics.stdev raised a bare ValueError on the NaN log
        # returns, which reached the caller as an Internal Server Error.
        with pytest.raises(EngineInputError, match="finite"):
            estimate_volatility([{"ticker": "X", "prices": [100.0, bad, 102.0, 103.0]}])

    def test_a_healthy_price_series_still_estimates(self) -> None:
        out = estimate_volatility(
            [{"ticker": "X", "prices": [100.0, 101.0, 99.5, 102.0, 103.5, 101.0]}]
        )
        assert not has_nonfinite(out)
        assert out["recommended_volatility"] > 0


class TestOverTheWire:
    """The guards hold through the API, where the literals actually arrive."""

    def test_json_accepts_the_nan_literal_so_the_guard_has_to(self) -> None:
        # Proof the threat is real rather than theoretical: this is the parser
        # FastAPI uses, and it produces a float nobody can compute with.
        assert math.isnan(json.loads('{"x": NaN}')["x"])
        assert math.isinf(json.loads('{"x": Infinity}')["x"])

    def test_projection_endpoint_rejects_a_non_finite_literal(self) -> None:
        res = client.post(
            "/engine/v1/projection",
            content='{"inputs": {"method": "growth", "base_revenue": NaN, '
            '"revenue_growth": 0.1, "years": 3}}',
            headers={"content-type": "application/json"},
        )
        assert res.status_code == 422
        assert "finite" in res.json()["detail"]

    def test_projection_endpoint_rejects_an_overflowing_forecast(self) -> None:
        res = client.post(
            "/engine/v1/projection",
            json={
                "inputs": {
                    "method": "growth",
                    "base_revenue": 1e6,
                    "revenue_growth": 1e30,
                    "years": 15,
                }
            },
        )
        assert res.status_code == 422

    def test_a_successful_projection_carries_no_nulls_where_a_number_belongs(self) -> None:
        # The old failure mode: 200 OK, and the later free cash flows `null`.
        res = client.post(
            "/engine/v1/projection",
            json={
                "inputs": {
                    "method": "growth",
                    "base_revenue": 1e6,
                    "revenue_growth": 0.25,
                    "years": 5,
                    "cogs_pct": 0.4,
                }
            },
        )
        assert res.status_code == 200
        assert None not in res.json()["free_cash_flows"]

    def test_volatility_endpoint_rejects_a_non_finite_price(self) -> None:
        res = client.post(
            "/engine/v1/volatility",
            content='{"comparables": [{"ticker": "X", "prices": [100.0, NaN, 102.0]}]}',
            headers={"content-type": "application/json"},
        )
        assert res.status_code == 422
