"""A malformed cap table or scenario set must be named, not absorbed.

These are the paths where the caller sent something structurally wrong — a
share class that is a string, a scenario with no exit value, a probability that
is a word. Each one has to come back as an EngineInputError whose message says
which entry and which field, because the valuation service turns that message
into the field-level issue an analyst sees next to the control they have to
fix (see the `issues` array in main.py's pre-flight).

The thing being defended against is not the crash. It is the near miss: a
silent default that produces a plausible fair market value from a cap table
nobody checked.
"""

from __future__ import annotations

import pytest

from app.engine.current_value import allocate_cvm
from app.engine.errors import EngineInputError
from app.engine.pwerm import allocate_pwerm
from app.engine.waterfall import exit_allocation

COMMON = {"name": "Common", "kind": "common", "shares": 1_000_000}
PREFERRED = {"name": "A", "kind": "preferred", "shares": 500_000, "preference": 500_000}


def alloc(*classes: dict) -> dict:
    return exit_allocation(2_000_000, list(classes))


class TestShareClassShape:
    @pytest.mark.parametrize("bad", ["Common", 42, None, ["Common"]])
    def test_a_class_that_is_not_an_object_is_rejected(self, bad: object) -> None:
        with pytest.raises(EngineInputError, match=r"share_classes\[1\] must be an object"):
            alloc(COMMON, bad)  # type: ignore[arg-type]

    @pytest.mark.parametrize("bad", [{}, {"name": ""}, {"name": "   "}, {"name": None}])
    def test_a_class_without_a_name_is_rejected(self, bad: dict) -> None:
        with pytest.raises(EngineInputError, match=r"share_classes\[1\]\.name is required"):
            alloc(COMMON, {**bad, "kind": "common", "shares": 1})

    def test_the_message_points_at_the_offending_index(self) -> None:
        # An analyst fixing a fifty-row cap table needs the row, not the fact
        # that one of them is wrong.
        err = pytest.raises(EngineInputError, alloc, COMMON, PREFERRED, {"kind": "common"})
        assert "share_classes[2]" in str(err.value)

    @pytest.mark.parametrize("bad", ["equity", "Preferred", "", None, "founder"])
    def test_an_unknown_kind_is_rejected(self, bad: object) -> None:
        # Case matters: "Preferred" is not "preferred", and silently accepting
        # it would drop the liquidation preference entirely.
        with pytest.raises(EngineInputError, match="kind must be one of"):
            alloc(COMMON, {"name": "X", "kind": bad, "shares": 1})

    @pytest.mark.parametrize("bad", ["lots", None, {}, [1]])
    def test_a_non_numeric_share_count_is_rejected(self, bad: object) -> None:
        with pytest.raises(EngineInputError, match="shares must be a number"):
            alloc(COMMON, {"name": "X", "kind": "common", "shares": bad})

    @pytest.mark.parametrize("bad", [0, -1, -1e6])
    def test_a_non_positive_share_count_is_rejected(self, bad: float) -> None:
        with pytest.raises(EngineInputError, match="shares must be positive"):
            alloc(COMMON, {"name": "X", "kind": "common", "shares": bad})

    def test_a_numeric_string_share_count_is_accepted(self) -> None:
        # Cap tables arrive from spreadsheet and CSV imports, where every cell
        # is a string. Rejecting "1000000" would fail the common case.
        assert alloc({"name": "Common", "kind": "common", "shares": "1000000"})


class TestPreferredTerms:
    def test_a_negative_preference_is_rejected(self) -> None:
        with pytest.raises(EngineInputError, match="preference must be >= 0"):
            alloc(COMMON, {**PREFERRED, "preference": -1})

    @pytest.mark.parametrize("bad", [0, 1.5, -1, "2", True, None])
    def test_seniority_must_be_a_whole_rank(self, bad: object) -> None:
        # True is an int in Python and would otherwise pass as rank 1; a
        # fractional rank means the stack has no defined order.
        with pytest.raises(EngineInputError, match="seniority must be an integer"):
            alloc(COMMON, {**PREFERRED, "seniority": bad})

    @pytest.mark.parametrize("bad", ["1:1", {}, []])
    def test_a_non_numeric_conversion_ratio_is_rejected(self, bad: object) -> None:
        with pytest.raises(EngineInputError, match="conversion_ratio must be a number"):
            alloc(COMMON, {**PREFERRED, "conversion_ratio": bad})

    @pytest.mark.parametrize("bad", [0, -1])
    def test_a_non_positive_conversion_ratio_is_rejected(self, bad: float) -> None:
        # Not defaulted to 1:1 — that would value the class as if it converted
        # normally, which is the silent-wrong-answer case.
        with pytest.raises(EngineInputError, match="conversion_ratio must be positive"):
            alloc(COMMON, {**PREFERRED, "conversion_ratio": bad})

    def test_an_absent_conversion_ratio_defaults_to_one_to_one(self) -> None:
        assert alloc(COMMON, PREFERRED) == alloc(COMMON, {**PREFERRED, "conversion_ratio": 1.0})

    def test_an_explicit_null_conversion_ratio_also_defaults(self) -> None:
        assert alloc(COMMON, {**PREFERRED, "conversion_ratio": None}) == alloc(COMMON, PREFERRED)


class TestOptions:
    @pytest.mark.parametrize("bad", [0, -0.5])
    def test_a_non_positive_strike_is_rejected(self, bad: float) -> None:
        with pytest.raises(EngineInputError, match="strike must be positive"):
            alloc(COMMON, {"name": "Pool", "kind": "option", "shares": 100_000, "strike": bad})

    def test_a_non_numeric_strike_is_rejected(self) -> None:
        with pytest.raises(EngineInputError, match="strike is required"):
            alloc(COMMON, {"name": "Pool", "kind": "option", "shares": 100_000, "strike": "free"})


class TestPwermScenarios:
    CLASSES = [COMMON, PREFERRED]

    def scenarios(self, **overrides: object) -> list[dict]:
        base = {"probability": 1.0, "equity_value": 10_000_000, "time_to_exit_years": 2.0}
        return [{**base, **overrides}]

    def run(self, scenarios: list[dict]) -> dict:
        return allocate_pwerm(scenarios, self.CLASSES, default_discount_rate=0.25)

    @pytest.mark.parametrize("bad", ["soon", None, [1]])
    def test_a_scenario_that_is_not_an_object_is_rejected(self, bad: object) -> None:
        with pytest.raises(EngineInputError, match=r"scenarios\[0\] must be an object"):
            self.run([bad])  # type: ignore[list-item]

    @pytest.mark.parametrize("bad", ["likely", None, {}])
    def test_a_non_numeric_probability_is_rejected(self, bad: object) -> None:
        with pytest.raises(EngineInputError, match="probability must be a number"):
            self.run(self.scenarios(probability=bad))

    def test_a_negative_probability_is_rejected(self) -> None:
        with pytest.raises(EngineInputError, match="probability must be >= 0"):
            self.run(self.scenarios(probability=-0.5))

    def test_an_unknown_scenario_type_is_rejected(self) -> None:
        # The type drives which narrative and discount convention apply, so a
        # typo must not fall through to an unlabelled scenario.
        with pytest.raises(EngineInputError, match="type must be one of"):
            self.run(self.scenarios(type="acqui-hire"))

    def test_a_known_scenario_type_is_accepted(self) -> None:
        assert self.run(self.scenarios(type="ipo"))["scenarios"]

    def test_a_negative_exit_equity_value_is_rejected(self) -> None:
        with pytest.raises(EngineInputError, match="negative"):
            self.run(self.scenarios(equity_value=-1))

    def test_an_enterprise_value_bridged_below_zero_is_rejected(self) -> None:
        # EV + cash − debt can land negative on a leveraged downside case; the
        # waterfall has no meaning there.
        with pytest.raises(EngineInputError, match="negative"):
            allocate_pwerm(
                [{"probability": 1.0, "enterprise_value": 1_000_000}],
                self.CLASSES,
                default_discount_rate=0.25,
                cash=0.0,
                debt=5_000_000,
            )

    def test_a_negative_time_to_exit_is_rejected(self) -> None:
        with pytest.raises(EngineInputError, match="time_to_exit_years must be >= 0"):
            self.run(self.scenarios(time_to_exit_years=-1))

    def test_a_discount_rate_of_minus_one_or_worse_is_rejected(self) -> None:
        # (1 + r)^t is zero or undefined there, so the present value is not a
        # number the model can produce.
        with pytest.raises(EngineInputError, match="discount_rate must exceed -1"):
            self.run(self.scenarios(discount_rate=-1))

    def test_more_than_fifty_scenarios_is_rejected(self) -> None:
        many = [{"probability": 0.02, "equity_value": 1e7} for _ in range(51)]
        with pytest.raises(EngineInputError, match="at most 50"):
            self.run(many)

    def test_exactly_fifty_scenarios_is_allowed(self) -> None:
        many = [{"probability": 0.02, "equity_value": 1e7} for _ in range(50)]
        assert len(self.run(many)["scenarios"]) == 50


class TestCurrentValueMethod:
    @pytest.mark.parametrize("bad", ["some", {}, []])
    def test_a_non_numeric_cap_table_figure_is_rejected(self, bad: object) -> None:
        with pytest.raises(EngineInputError, match="must be a number"):
            allocate_cvm(1_000_000, {"shares_outstanding_common": bad})

    @pytest.mark.parametrize("bad", [0, -1])
    def test_a_non_positive_equity_value_is_rejected(self, bad: float) -> None:
        with pytest.raises(EngineInputError, match="not positive"):
            allocate_cvm(bad, {"shares_outstanding_common": 1_000_000})

    def test_a_non_finite_cap_table_figure_is_rejected(self) -> None:
        with pytest.raises(EngineInputError, match="finite"):
            allocate_cvm(1_000_000, {"shares_outstanding_common": float("inf")})

    def test_a_non_positive_share_count_is_rejected(self) -> None:
        with pytest.raises(EngineInputError, match="positive"):
            allocate_cvm(1_000_000, {"shares_outstanding_common": 0})
