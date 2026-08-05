"""Every figure is finite; the arithmetic *between* them is not.

`test_nonfinite_guards.py` covers the front door — a NaN or Inf arriving on a
request. `test_overflow_guards.py` covers results that saturate to ``inf`` and
are caught by the finite-result sweep on the way out. These cover the gap
between the two: intermediate quantities that leave the representable doubles
and then *fail to look like a failure*, because the value the arithmetic
produces is a perfectly ordinary float.

Two shapes, both reachable from a payload the pre-flight validator clears:

* **A product or power that underflows to 0.0.** ``math.isfinite(0.0)`` is
  True, so an overflow guard does not see it. Whatever divides by it raises
  ZeroDivisionError — a 500 naming nothing — and whatever multiplies by it
  quietly rewrites the figure to zero and reports it as a normal result.

* **A sum or product that overflows to inf where nothing downstream reads a
  NaN.** The waterfall's residual slopes are ``class shares / pool shares``;
  an infinite pool makes every slope ``0.0``, which is finite, so the tranche
  is allocated to nobody and the whole exit value disappears into a 200.

The second is the more serious of the two, and the reason these are asserted on
value conservation rather than only on status codes: ``waterfall.py`` documents
``Sum of class values == exit_value`` as an invariant of the breakpoint method,
and an allocation that silently violates it is indistinguishable from a
correct one to everything that reads the response.
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.engine.compounding import compound_factor
from app.engine.errors import EngineInputError
from app.engine.fund_valuation import roll_forward_mark
from app.engine.pwerm import allocate_pwerm
from app.engine.waterfall import allocate_waterfall, class_per_share, exit_allocation
from app.main import app

client = TestClient(app, raise_server_exceptions=False)

COMMON = {"name": "Common", "kind": "common", "shares": 1_000_000}
T, R, SIGMA = 3.0, 0.04, 0.60

# The smallest positive double, and a ratio small enough that their product is
# not representable at all. Both figures pass every check the normaliser makes
# of them individually: finite, and greater than zero.
TINY = 5e-324


class TestCompoundFactorUnderflow:
    """``(1 + rate) ** periods`` can reach exactly 0.0 while staying finite."""

    def test_factor_underflowing_to_zero_is_refused(self) -> None:
        with pytest.raises(EngineInputError, match="compounds to zero"):
            compound_factor(-0.99, 400.0, "discount_rate")

    def test_the_message_names_the_caller_s_field(self) -> None:
        with pytest.raises(EngineInputError, match="scenarios\\[2\\].discount_rate"):
            compound_factor(-0.99, 1e6, "scenarios[2].discount_rate")

    @pytest.mark.parametrize("periods", [0.0, 1.0, 50.0, 154.0])
    def test_representable_factors_still_compute(self, periods: float) -> None:
        factor = compound_factor(-0.99, periods, "discount_rate")
        assert math.isfinite(factor) and factor > 0.0

    def test_pwerm_answers_422_rather_than_dividing_by_zero(self) -> None:
        """The scenario PV is ``value / factor`` — a zero factor was a 500.

        One exponent lower the factor is merely denormal, the quotient
        saturates to inf and the finite-result sweep answers 422; the caller
        therefore got a clean error for the smaller mistake and an unhandled
        ZeroDivisionError for the larger one.
        """
        with pytest.raises(EngineInputError, match="compounds to zero"):
            allocate_pwerm(
                [{"probability": 1.0, "equity_value": 1e7, "time_to_exit_years": 400.0}],
                [COMMON],
                default_discount_rate=-0.99,
            )

    def test_fund_roll_forward_does_not_mark_a_position_to_zero(self) -> None:
        """``pv * factor`` with a zero factor is a fair value of 0 reported as a
        normal accretion — the stale-mark objection `fund_valuation` already
        raises about a total return at or under -100%."""
        with pytest.raises(EngineInputError, match="compounds to zero"):
            roll_forward_mark(
                prior_fair_value=1_000_000.0,
                method="accretion",
                accretion_rate=-0.99,
                periods=1e6,
            )

    def test_compute_answers_422(self) -> None:
        body = {
            "params": {"allocation_method": "pwerm"},
            "inputs": {
                "shares_outstanding_common": 1000,
                "volatility": 0.6,
                "risk_free_rate": 0.04,
                "time_to_exit_years": 4.0,
                "share_classes": [{"kind": "common", "name": "C", "shares": 1000}],
                "pwerm": {
                    "discount_rate": -0.99,
                    "scenarios": [
                        {"probability": 1.0, "equity_value": 1e7, "time_to_exit_years": 400.0}
                    ],
                },
            },
        }
        response = client.post("/engine/v1/compute", json=body)
        assert response.status_code == 422
        assert "compounds to zero" in response.text


class TestAsConvertedShareCount:
    """``shares x conversion_ratio`` is what the residual algebra runs on."""

    UNDERFLOWING = [
        COMMON,
        {
            "name": "Series A",
            "kind": "preferred",
            "shares": TINY,
            "preference": 1_000_000,
            "conversion_ratio": 0.001,
        },
    ]
    OVERFLOWING = [
        COMMON,
        {
            "name": "Series A",
            "kind": "preferred",
            "shares": 1e308,
            "preference": 1_000_000,
            "conversion_ratio": 1000.0,
        },
    ]

    @pytest.mark.parametrize("classes", [UNDERFLOWING, OVERFLOWING])
    def test_allocate_waterfall_refuses(self, classes: list[dict]) -> None:
        with pytest.raises(EngineInputError, match="as-converted share count"):
            allocate_waterfall(10_000_000.0, classes, T, R, SIGMA)

    @pytest.mark.parametrize("classes", [UNDERFLOWING, OVERFLOWING])
    def test_exit_allocation_refuses(self, classes: list[dict]) -> None:
        with pytest.raises(EngineInputError, match="as-converted share count"):
            exit_allocation(10_000_000.0, classes)

    @pytest.mark.parametrize("classes", [UNDERFLOWING, OVERFLOWING])
    def test_the_backsolve_objective_refuses(self, classes: list[dict]) -> None:
        with pytest.raises(EngineInputError, match="as-converted share count"):
            class_per_share(10_000_000.0, classes, "Common", T, R, SIGMA)

    def test_the_message_names_the_class_and_both_factors(self) -> None:
        with pytest.raises(EngineInputError, match="'Series A'.*conversion_ratio"):
            exit_allocation(10_000_000.0, self.UNDERFLOWING)

    def test_a_participating_class_is_refused_too(self) -> None:
        """Participating classes join the pool up front rather than through the
        conversion breakpoint, so they reach the same division by a different
        route."""
        classes = [
            COMMON,
            {**self.OVERFLOWING[1], "participating": True},
        ]
        with pytest.raises(EngineInputError, match="as-converted share count"):
            exit_allocation(10_000_000.0, classes)

    @pytest.mark.parametrize("ratio", [0.001, 0.5, 1.0, 2.5, 1000.0])
    def test_ordinary_conversion_ratios_still_allocate(self, ratio: float) -> None:
        classes = [
            COMMON,
            {
                "name": "Series A",
                "kind": "preferred",
                "shares": 2_000_000,
                "preference": 5_000_000,
                "conversion_ratio": ratio,
            },
        ]
        result = exit_allocation(10_000_000.0, classes)
        assert sum(c["value"] for c in result["classes"].values()) == pytest.approx(1e7, abs=0.05)


class TestFullyDilutedPoolTotal:
    """Every class is representable and their *sum* is not.

    This is the quiet one. No NaN is ever produced: each residual slope is
    ``finite / inf``, which is 0.0, so the tranches are handed to nobody and
    the allocation returns successfully having allocated nothing at all.
    """

    OVERFLOWING = [{"name": f"Common {i}", "kind": "common", "shares": 1e308} for i in range(3)]

    def test_exit_allocation_refuses(self) -> None:
        with pytest.raises(EngineInputError, match="fully-diluted, as-converted share count"):
            exit_allocation(1_000_000.0, self.OVERFLOWING)

    def test_allocate_waterfall_refuses(self) -> None:
        with pytest.raises(EngineInputError, match="fully-diluted, as-converted share count"):
            allocate_waterfall(1_000_000.0, self.OVERFLOWING, T, R, SIGMA)

    def test_options_and_preferred_count_toward_the_total(self) -> None:
        classes = [
            {"name": "Common", "kind": "common", "shares": 1e308},
            {"name": "Pool", "kind": "option", "shares": 1e308, "strike": 0.5},
            {
                "name": "Series A",
                "kind": "preferred",
                "shares": 1e305,
                "preference": 1000.0,
                "conversion_ratio": 1000.0,
            },
        ]
        with pytest.raises(EngineInputError, match="fully-diluted, as-converted share count"):
            exit_allocation(1_000_000.0, classes)

    def test_a_large_but_representable_cap_table_still_allocates(self) -> None:
        classes = [{"name": f"Common {i}", "kind": "common", "shares": 1e307} for i in range(3)]
        result = exit_allocation(1_000_000.0, classes)
        # Per-class values are rounded to the cent in the response, so three
        # equal classes conserve to within a cent rather than exactly.
        assert sum(c["value"] for c in result["classes"].values()) == pytest.approx(1e6, abs=0.05)


class TestValueConservationHolds:
    """The invariant the silent failures broke, asserted end to end.

    Each payload below is the one that used to return 200 having allocated a
    fraction of the exit value (or none of it). They must now be refused — and
    an ordinary cap table on the same route must still conserve exactly.
    """

    @staticmethod
    def _body(classes: list[dict]) -> dict:
        return {
            "params": {
                "weight_asset": 0.0,
                "weight_income": 0.0,
                "weight_market": 0.0,
                "weight_opm": 1.0,
                "allocation_method": "pwerm",
            },
            "inputs": {
                "shares_outstanding_common": 1000,
                "volatility": 0.6,
                "risk_free_rate": 0.04,
                "time_to_exit_years": 4.0,
                "last_round_post_money": 1e7,
                "pwerm": {
                    "discount_rate": 0.0,
                    "scenarios": [
                        {"probability": 1.0, "equity_value": 1_000_000.0, "time_to_exit_years": 0.0}
                    ],
                },
                "share_classes": classes,
            },
        }

    def test_an_overflowing_as_converted_count_is_no_longer_a_200(self) -> None:
        classes = [
            {"kind": "common", "name": "C", "shares": 1000},
            {
                "kind": "preferred",
                "name": "P",
                "shares": 1e308,
                "preference": 100.0,
                "conversion_ratio": 1000.0,
            },
        ]
        response = client.post("/engine/v1/compute", json=self._body(classes))
        assert response.status_code == 422, response.text

    def test_an_overflowing_pool_total_is_no_longer_a_200(self) -> None:
        classes = [{"kind": "common", "name": f"C{i}", "shares": 1e308} for i in range(3)]
        response = client.post("/engine/v1/compute", json=self._body(classes))
        assert response.status_code == 422, response.text

    def test_an_ordinary_cap_table_conserves_the_exit_value(self) -> None:
        classes = [
            {"kind": "common", "name": "C", "shares": 8_000_000},
            {"kind": "preferred", "name": "P", "shares": 2_000_000, "preference": 5_000_000},
            {"kind": "option", "name": "O", "shares": 1_000_000, "strike": 0.5},
        ]
        response = client.post("/engine/v1/compute", json=self._body(classes))
        assert response.status_code == 200, response.text
        allocation = response.json()["results"]["allocation"]
        total = sum(c["present_value"] for c in allocation["classes"].values())
        assert total == pytest.approx(1_000_000.0, rel=1e-6)
