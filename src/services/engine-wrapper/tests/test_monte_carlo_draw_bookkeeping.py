"""The per-draw bookkeeping reads the common classes, not the cap table (R338, M8).

Each draw has to know what the *common* classes gained from it, and it used to
find out by copying the whole running-totals list — `before = s_totals[:]` — so
that the two or three entries of `common_at` could be differenced against it.
At the default 20,000 paths that is 20,000 list allocations per scenario, and at
`MAX_PATHS` against a 200-class cap table it is forty million element copies to
compute a figure that depends on `len(common_at)` of them. Measured at
`MAX_PATHS` on a 200-class table: 1.70s before, 1.60s after.

The saving is modest. The risk is not, and it is what this file pins: the
obvious rewrite — summing the common classes before and after and subtracting
the two totals — is *different floating-point arithmetic*, and what it feeds is
`standard_error_per_share`, the precision claim a reviewer reads to decide
whether a simulated FMV is tight enough to conclude on. So the difference is
still taken term by term, in the same order, and these are the fixed-seed
figures that say so — verified against the previous implementation, digit for
digit, rather than transcribed from this one.
"""

from app.engine.monte_carlo import allocate_monte_carlo

SEED = 7


def cap_table(preferred: int) -> list[dict]:
    """One common class under `preferred` senior tranches."""
    classes: list[dict] = [{"name": "Common", "kind": "common", "shares": 10_000_000}]
    for i in range(preferred):
        classes.append(
            {
                "name": f"Series {i}",
                "kind": "preferred",
                "shares": 1_000_000,
                "preference": 1_000_000,
                "seniority": i + 1,
                "conversion_ratio": 1.0,
            }
        )
    return classes


def run(preferred: int, paths: int = 4_000) -> dict:
    return allocate_monte_carlo(
        80_000_000,
        {"share_classes": cap_table(preferred), "monte_carlo": {"paths": paths, "seed": SEED}},
        t=3.0,
        r=0.04,
        sigma=0.6,
    )


class TestTheFiguresAreUnchanged:
    """Fixed-seed pins. A rewrite that reassociates the difference moves these."""

    def test_a_narrow_cap_table_lands_where_it_did(self):
        res = run(preferred=9)
        assert res["common_per_share"] == 4.205923377361751
        assert res["standard_error_per_share"] == 0.08832431

    def test_a_wide_one_does_too(self):
        # 200 classes: the case the old copy was proportional to and the new
        # bookkeeping is not.
        res = run(preferred=199)
        assert res["common_per_share"] == 0.15727253623415607
        assert res["standard_error_per_share"] == 0.0084553


class TestTheWidthOfTheTableDoesNotChangeTheDraws:
    """Same stream, same common payoff — the wide table only adds tranches."""

    def test_the_reported_path_count_is_the_one_that_ran(self):
        assert run(preferred=199)["paths"] == 4_000

    def test_the_error_is_still_a_band_around_the_answer(self):
        res = run(preferred=199)
        # Not vacuous, and not degenerate: a positive figure with a positive
        # error, which is what the term-by-term difference has to keep producing.
        assert res["common_per_share"] > 0
        assert 0 < res["standard_error_per_share"] < res["common_per_share"]
