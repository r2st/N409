"""The option-pricing schedule behind the OPM waterfall (report Appendix IV).

The whole point of the schedule is that a reviewer can check it, so these tests
check it the way a reviewer would: recompute a row from the four inputs by hand,
and verify that the tranche values on the exhibit beside it are the differences
between consecutive call values. A schedule that did not reconcile to the
allocation would be a page of arithmetic about some other cap table.
"""

import math

import pytest

from app.engine.bs import bs_call, bs_call_terms, norm_cdf
from app.engine.waterfall import allocate_waterfall

CLASSES = [
    {"name": "Series A", "kind": "preferred", "shares": 4_000_000, "preference": 5_000_000, "seniority": 1},
    {"name": "Common", "kind": "common", "shares": 8_000_000},
]
EQUITY = 20_000_000.0
T, R, SIGMA = 4.0, 0.042, 0.62


def _alloc():
    return allocate_waterfall(EQUITY, CLASSES, T, R, SIGMA)


class TestBsCallTerms:
    def test_agrees_with_bs_call_on_every_branch(self):
        """The value on the page has to be the value in the conclusion."""
        cases = [
            (100.0, 80.0, 2.0, 0.04, 0.5),  # ordinary
            (100.0, 0.0, 2.0, 0.04, 0.5),  # struck at zero — the first tranche
            (100.0, 80.0, 0.0, 0.04, 0.5),  # no time
            (100.0, 80.0, 2.0, 0.04, 0.0),  # no volatility
            (0.0, 80.0, 2.0, 0.04, 0.5),  # worthless underlying
        ]
        for s, k, t, r, sigma in cases:
            assert bs_call_terms(s, k, t, r, sigma)["call"] == pytest.approx(bs_call(s, k, t, r, sigma))

    def test_states_the_working_a_reviewer_recomputes(self):
        terms = bs_call_terms(100.0, 80.0, 2.0, 0.04, 0.5)
        sqrt_t = math.sqrt(2.0)
        d1 = (math.log(100.0 / 80.0) + (0.04 + 0.5 * 0.25) * 2.0) / (0.5 * sqrt_t)
        assert terms["d1"] == pytest.approx(d1)
        assert terms["d2"] == pytest.approx(d1 - 0.5 * sqrt_t)
        assert terms["n_d1"] == pytest.approx(norm_cdf(d1))
        assert terms["discount_factor"] == pytest.approx(math.exp(-0.04 * 2.0))
        # And the row reconciles to itself: S·N(d1) − K·e^{−rT}·N(d2).
        assert terms["call"] == pytest.approx(
            100.0 * terms["n_d1"] - 80.0 * terms["discount_factor"] * terms["n_d2"]
        )

    def test_leaves_d1_and_d2_absent_where_they_do_not_exist(self):
        """A zero-volatility call is intrinsic value, not a probability-weighted
        one. Printing a fabricated 0.0 in a column a reviewer recomputes would
        be worse than printing nothing."""
        for terms in (
            bs_call_terms(100.0, 80.0, 0.0, 0.04, 0.5),
            bs_call_terms(100.0, 80.0, 2.0, 0.04, 0.0),
        ):
            assert terms["d1"] is None
            assert terms["d2"] is None

    def test_a_call_struck_at_zero_is_the_underlying(self):
        terms = bs_call_terms(100.0, 0.0, 2.0, 0.04, 0.5)
        assert terms["call"] == pytest.approx(100.0)
        # Stated as the limit rather than left blank: the first tranche of every
        # waterfall is struck here, and a row of dashes where the reader expects
        # the whole equity value reads as a defect.
        assert terms["n_d1"] == 1.0
        assert terms["n_d2"] == 1.0


class TestOptionSchedule:
    def test_one_row_per_distinct_strike(self):
        alloc = _alloc()
        strikes = [row["strike"] for row in alloc["option_schedule"]]
        # Zero; the top of the preference, where the residual begins; and the
        # conversion point, where Series A does better as-converted than taking
        # its $5m — (0) + 5m·(8m + 4m)/4m = 15m.
        assert strikes == [0.0, 5_000_000.0, 15_000_000.0]
        # And every boundary the exhibit tabulates is priced, in both
        # directions: a strike with no row would leave a tranche unexplained,
        # and a row with no strike would be arithmetic about nothing.
        boundaries = {b["from"] for b in alloc["breakpoints"]}
        boundaries |= {b["to"] for b in alloc["breakpoints"] if b["to"] is not None}
        assert set(strikes) == boundaries

    def test_the_tranche_values_are_the_differences_between_consecutive_calls(self):
        """The reconciliation the appendix exists for.

        Every tranche is a call spread, so the exhibit's value column has to be
        recoverable from this schedule alone. If it is not, the page is
        arithmetic about a different allocation.
        """
        alloc = _alloc()
        calls = {row["strike"]: row["call"] for row in alloc["option_schedule"]}
        for bp in alloc["breakpoints"]:
            upper = 0.0 if bp["to"] is None else calls[bp["to"]]
            assert bp["value"] == pytest.approx(calls[bp["from"]] - upper, abs=0.02)

    def test_the_first_row_is_the_whole_equity_value(self):
        """C(0) = S. It is the invariant the class values conserve against —
        Σ class values == bs_call(E, 0) == E — so a reader can check the total
        without leaving the page."""
        assert _alloc()["option_schedule"][0]["call"] == pytest.approx(EQUITY, abs=0.01)

    def test_every_row_reconciles_to_its_own_inputs(self):
        for row in _alloc()["option_schedule"]:
            if row["d1"] is None:
                continue
            assert row["call"] == pytest.approx(
                EQUITY * row["n_d1"] - row["strike"] * row["discount_factor"] * row["n_d2"],
                rel=1e-4,
            )

    def test_survives_a_cap_table_with_no_preferences_at_all(self):
        """One class, one tranche, one strike — and the schedule still states
        it rather than coming back empty."""
        alloc = allocate_waterfall(EQUITY, [{"name": "Common", "kind": "common", "shares": 1_000}], T, R, SIGMA)
        assert [row["strike"] for row in alloc["option_schedule"]] == [0.0]
        assert alloc["option_schedule"][0]["call"] == pytest.approx(EQUITY, abs=0.01)

    def test_a_multi_rank_stack_prices_every_boundary(self):
        classes = [
            {
                "name": "Series B",
                "kind": "preferred",
                "shares": 2_000_000,
                "preference": 8_000_000,
                "seniority": 1,
            },
            {
                "name": "Series A",
                "kind": "preferred",
                "shares": 4_000_000,
                "preference": 5_000_000,
                "seniority": 2,
            },
            {"name": "Common", "kind": "common", "shares": 8_000_000},
        ]
        alloc = allocate_waterfall(EQUITY, classes, T, R, SIGMA)
        strikes = [row["strike"] for row in alloc["option_schedule"]]
        # Senior rank first, then the junior one stacked on top of it — the two
        # boundaries the preference stack creates, plus the zero strike.
        assert strikes[:3] == [0.0, 8_000_000.0, 13_000_000.0]
        assert strikes == sorted(set(strikes))

    def test_does_not_disturb_the_allocation_it_documents(self):
        """The schedule is a record of work already done. Adding it must not
        move a single concluded figure."""
        alloc = _alloc()
        assert alloc["common_per_share"] == pytest.approx(
            allocate_waterfall(EQUITY, CLASSES, T, R, SIGMA)["common_per_share"]
        )
        assert sum(c["value"] for c in alloc["classes"].values()) == pytest.approx(EQUITY, abs=0.02)
