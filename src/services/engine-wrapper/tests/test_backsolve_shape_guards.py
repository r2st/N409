"""The backsolve and the sensitivity sweep have to answer 422, not 500.

Three shapes of malformed payload used to leave the engine as an unhandled
exception. All three were reachable over HTTP, and two of them only through
``/engine/v1/sensitivity`` — which, unlike ``/engine/v1/compute``, runs no
pre-flight ``validate_payload`` and calls ``compute`` inside a ``try`` that
catches ``EngineInputError`` and nothing else. Anything the validator would
have caught is therefore load-bearing on that endpoint in a way it is not on
compute, and these are the cases where that mattered:

1. A ``share_classes`` entry that is not a well-formed class. The backsolve
   summed ``float(c.get("shares"))`` over the *raw* list before the waterfall
   normaliser ever saw it, so a null, a bare number or a non-numeric share
   count raised AttributeError / TypeError / ValueError out of a generator.
2. A nested inputs section (``income`` / ``market`` / ``asset``) that is a
   truthy non-object. ``inputs.get(name) or {}`` only defaults on a *falsy*
   value, so ``"income": "2026-01-01"`` passed through and the next ``.get``
   raised AttributeError.
3. A cap table whose common count is negligible beside its preferred, so the
   implied-volatility inversion divided by ``1 − f_p`` after ``f_p`` had
   rounded to exactly 1.0.

The distinction each test is drawing is not "does it fail" but *how*: a 422
names the field an analyst can fix, a 500 names nothing and reads as an engine
outage.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from app.engine.approaches import opm_backsolve
from app.engine.compute import compute
from app.engine.errors import EngineInputError

os.environ.setdefault("RATE_LIMIT_RPM", "0")

from app.main import app  # noqa: E402  — after RATE_LIMIT_RPM so the fuzz-rate limiter is off

client = TestClient(app)

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 0.6,
    "weight_income": 0.15,
    "weight_market": 0.25,
    "dloc": 0.1,
    "dlom_method": "finnerty",
    "exit_timeline": "2029-06-30",
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "cash": 1_500_000,
    "debt": 200_000,
    "last_round_post_money": 20_000_000,
    "income": {
        "free_cash_flows": [-500_000, 250_000, 1_200_000],
        "discount_rate": 0.3,
        "terminal_growth": 0.03,
    },
    "market": {"metric": 4_000_000, "multiples": [6.0, 4.0]},
}

GOOD_COMMON = {"name": "Common", "kind": "common", "shares": 7_000_000}
GOOD_PREFERRED = {
    "name": "Series A",
    "kind": "preferred",
    "shares": 2_000_000,
    "preference": 5_000_000,
    "seniority": 1,
}


def with_inputs(**overrides: object) -> dict:
    return {"params": dict(PARAMS), "inputs": {**INPUTS, **overrides}}


def test_the_sensitivity_baseline_still_computes() -> None:
    """The guard rail below is only meaningful if the good payload still passes."""
    assert client.post("/engine/v1/sensitivity", json=with_inputs()).status_code == 200
    assert client.post("/engine/v1/compute", json=with_inputs()).status_code == 200


# ── 1. A malformed share class reaching the backsolve ────────────────────────


class TestBacksolveShareClasses:
    """`share_classes` is read by the backsolve before the normaliser runs."""

    BAD_ENTRIES = [
        pytest.param(1.5, id="bare-float"),
        pytest.param(None, id="null"),
        pytest.param("Common", id="string"),
        pytest.param([], id="list"),
        pytest.param(True, id="bool"),
    ]

    @pytest.mark.parametrize("bad", BAD_ENTRIES)
    def test_a_class_that_is_not_an_object_is_a_422_not_a_500(self, bad: object) -> None:
        body = with_inputs(
            share_classes=[GOOD_COMMON, bad],
            last_round_price_per_share=2.5,
            last_round_class="Common",
        )
        for endpoint in ("/engine/v1/compute", "/engine/v1/sensitivity"):
            res = client.post(endpoint, json=body)
            assert res.status_code == 422, f"{endpoint} answered {res.status_code}"

    @pytest.mark.parametrize("bad", ["x", "1,000,000", [1], {"n": 1}, "9999-12-31"])
    def test_a_share_count_that_is_not_a_number_is_a_422_not_a_500(self, bad: object) -> None:
        body = with_inputs(
            share_classes=[{**GOOD_COMMON, "shares": bad}, GOOD_PREFERRED],
            last_round_price_per_share=2.5,
            last_round_class="Series A",
        )
        for endpoint in ("/engine/v1/compute", "/engine/v1/sensitivity"):
            assert client.post(endpoint, json=body).status_code == 422

    def test_the_error_names_the_offending_class(self) -> None:
        """The message is what the service turns into a field-level issue."""
        with pytest.raises(EngineInputError, match=r"share_classes\[1\] must be an object"):
            opm_backsolve(
                20_000_000,
                last_round_pps=2.5,
                share_classes=[GOOD_COMMON, 1.5],  # type: ignore[list-item]
                last_round_class="Common",
                t=3.0,
                r=0.04,
                sigma=0.6,
            )

    def test_a_well_formed_cap_table_still_backsolves(self) -> None:
        out = opm_backsolve(
            20_000_000,
            last_round_pps=2.5,
            share_classes=[GOOD_COMMON, GOOD_PREFERRED],
            last_round_class="Series A",
            t=3.0,
            r=0.04,
            sigma=0.6,
        )
        assert out["method"] == "backsolve_waterfall"
        assert out["equity_value"] > 0
        assert out["solved_pps"] == pytest.approx(2.5, abs=1e-6)


# ── 2. A nested inputs section that is not an object ─────────────────────────


class TestNestedSectionShape:
    """`inputs.get(name) or {}` defaults on falsy, not on "not an object"."""

    NOT_OBJECTS = [
        pytest.param("2026-01-01", id="date-string"),
        pytest.param("x", id="string"),
        pytest.param(5, id="int"),
        pytest.param(1.5, id="float"),
        pytest.param(True, id="bool"),
        pytest.param([1, 2], id="list"),
        pytest.param([{"a": 1}], id="list-of-objects"),
    ]

    @pytest.mark.parametrize("section", ["income", "market"])
    @pytest.mark.parametrize("bad", NOT_OBJECTS)
    def test_a_section_that_is_not_an_object_is_a_422_not_a_500(
        self, section: str, bad: object
    ) -> None:
        body = with_inputs(**{section: bad})
        for endpoint in ("/engine/v1/compute", "/engine/v1/sensitivity"):
            res = client.post(endpoint, json=body)
            assert res.status_code == 422, f"{endpoint} answered {res.status_code}"

    # Each section is only read when its own approach carries weight, so the
    # weights have to put the run on the branch under test — otherwise the
    # asset approach fails first on its own missing inputs and the assertion
    # passes for the wrong reason.
    SOLE_WEIGHT = {
        "income": {"weight_asset": 0.0, "weight_opm": 0.0, "weight_income": 1.0, "weight_market": 0.0},
        "market": {"weight_asset": 0.0, "weight_opm": 0.0, "weight_income": 0.0, "weight_market": 1.0},
        "asset": {"weight_asset": 1.0, "weight_opm": 0.0, "weight_income": 0.0, "weight_market": 0.0},
    }

    @pytest.mark.parametrize("section", ["income", "market", "asset"])
    def test_the_message_names_the_section(self, section: str) -> None:
        params = {**PARAMS, **self.SOLE_WEIGHT[section]}
        with pytest.raises(EngineInputError, match=f"{section} must be an object"):
            compute(params, {**INPUTS, section: "not-an-object"})

    @pytest.mark.parametrize("section,missing", [("income", "free_cash_flows"), ("market", "multiples")])
    def test_absent_and_null_still_default_to_an_empty_section(
        self, section: str, missing: str
    ) -> None:
        """Null must keep reporting the missing *field*, not the section shape."""
        params = {**PARAMS, **self.SOLE_WEIGHT[section]}
        for absent in ({section: None}, {}):
            inputs = {k: v for k, v in INPUTS.items() if k != section} | absent
            with pytest.raises(EngineInputError) as excinfo:
                compute(params, inputs)
            assert "must be an object" not in str(excinfo.value)
            assert missing in str(excinfo.value)

    def test_a_falsy_section_is_still_rejected_rather_than_defaulted(self) -> None:
        """`0` and `""` were absorbed by `or {}`; they are not objects either."""
        for bad in (0, ""):
            res = client.post("/engine/v1/sensitivity", json=with_inputs(income=bad))
            assert res.status_code == 422


# ── 3. The implied-volatility inversion on a degenerate cap table ────────────


class TestImpliedVolatilityInversion:
    """`1 − f_p` reaches exactly zero long before the share counts do."""

    DEGENERATE = [
        pytest.param(1e-320, 2_000_000, id="common-underflows"),
        pytest.param(7_000_000, 1e308, id="preferred-overflows-the-ratio"),
        pytest.param(1.0, 1e300, id="one-common-share"),
    ]

    @pytest.mark.parametrize("common,preferred", DEGENERATE)
    def test_a_degenerate_share_ratio_does_not_500(
        self, common: float, preferred: float
    ) -> None:
        body = with_inputs(
            shares_outstanding_common=common,
            shares_outstanding_preferred=preferred,
            last_round_price_per_share=1.0,
        )
        res = client.post("/engine/v1/sensitivity", json=body)
        assert res.status_code < 500

    @pytest.mark.parametrize(
        "common,preferred",
        # Not the whole DEGENERATE set: a preferred count of 1e308 makes the
        # *root* unbracketable, which is its own EngineInputError → 422 and a
        # different code path. These two solve fine and only lose the vol.
        [
            pytest.param(1e-320, 2_000_000, id="common-underflows"),
            pytest.param(1.0, 1e300, id="one-common-share"),
        ],
    )
    def test_the_equity_value_still_solves_without_the_implied_vol(
        self, common: float, preferred: float
    ) -> None:
        """The inversion is a disclosure extra; losing it must not fail the run."""
        out = opm_backsolve(
            20_000_000,
            last_round_pps=1.0,
            preferred_shares=preferred,
            liquidation_preference=5_000_000,
            common_shares=common,
            t=3.0,
            r=0.04,
            sigma=0.6,
        )
        assert out["equity_value"] > 0
        assert "implied_volatility" not in out

    def test_an_unbracketable_root_is_still_an_input_error_not_a_crash(self) -> None:
        """The other degenerate case: the solver refuses, in the 422 vocabulary."""
        with pytest.raises(EngineInputError):
            opm_backsolve(
                20_000_000,
                last_round_pps=1.0,
                preferred_shares=1e308,
                liquidation_preference=5_000_000,
                common_shares=7_000_000,
                t=3.0,
                r=0.04,
                sigma=0.6,
            )

    def test_a_normal_cap_table_still_reports_an_implied_volatility(self) -> None:
        out = opm_backsolve(
            20_000_000,
            last_round_pps=2.5,
            preferred_shares=2_000_000,
            liquidation_preference=5_000_000,
            common_shares=7_000_000,
            t=3.0,
            r=0.04,
            sigma=0.6,
        )
        assert out["equity_value"] > 0
        assert out["implied_volatility"] > 0
