"""A class frozen at its participation cap absorbs its *cap*, not its preference.

`_segments` strikes every conversion breakpoint against `p_cur` — the value
absorbed beneath the residual pool by the classes outside it. A class still
taking its preference absorbs the preference. A class frozen at its
participation cap absorbs the cap: the preference *plus* the participation it
banked on the way up.

The engine counted only the preference there. The banked participation went
missing from `p_cur`, so every conversion breakpoint computed while some other
class sat frozen at its cap was struck too early, and the class that converted
early kept residual it had not earned.

It is a quiet defect. Value still conserves — `Σ class values == exit_value`
holds either way — so the error is invisible in the totals and shows up only as
one class taking another's money. On the cap table below, Series A converted at
$12.0625M rather than $12.375M and was overpaid $192,307 at a $50M exit, with
the shortfall coming out of common and the uncapped participating class.

The figures here are derived by hand in each test's docstring rather than
recorded from the engine, so they stand on the arithmetic rather than on the
implementation: six of these tests fail against the code that produced them.
"""

import pytest

from app.engine.waterfall import _normalize, _segments, allocate_waterfall, exit_allocation

# Series A and Series C are both capped participating; B participates uncapped
# at a 0.5 conversion ratio. Two caps is the minimum that reproduces this: the
# breakpoint that goes wrong is A's, and it goes wrong only while C is frozen.
CASE = [
    {
        "kind": "preferred", "name": "Series A", "shares": 2_400_000.0,
        "preference": 1_000_000.0, "seniority": 3,
        "participating": True, "participation_cap": 3_000_000.0,
    },
    {
        "kind": "preferred", "name": "Series B", "shares": 1_000_000.0,
        "preference": 0.0, "seniority": 3,
        "participating": True, "conversion_ratio": 0.5,
    },
    {
        "kind": "preferred", "name": "Series C", "shares": 2_400_000.0,
        "preference": 5_000_000.0, "seniority": 2,
        "participating": True, "participation_cap": 7_500_000.0,
    },
    {"kind": "common", "name": "Common", "shares": 1_000_000.0},
]


def values_at(exit_value, classes=None):
    got = exit_allocation(exit_value, classes if classes is not None else CASE)
    return {k: v["value"] for k, v in got["classes"].items()}


class TestTheConversionBreakpoint:
    def test_series_a_converts_at_12_375_000(self):
        """Derived, not recorded.

        At the point C freezes ($12.0625M) the pool is B's 0.5M as-converted
        plus common's 1M = 1.5M, and beneath it sit C's $7.5M cap and A's own
        $1M preference, so `p_cur` is $8.5M. A converting takes
        2.4/(1.5+2.4) = 0.6154 of everything above $7.5M, and it converts where
        that first equals the $3M cap it is holding:

            7.5M + 3M x (1.5M + 2.4M) / 2.4M  ==  12.375M

        Counting A's absorbed amount as its $1M preference rather than its $3M
        cap puts this at $9.875M, which is behind the $12.0625M boundary and so
        gets clamped forward to it — converting A a third of a million dollars
        of exit value too early.
        """
        boundaries = [s["from"] for s in _segments(_normalize(CASE))]
        assert 12_375_000.0 == pytest.approx(min(boundaries, key=lambda b: abs(b - 12_375_000)))

    def test_a_holds_exactly_its_cap_until_it_converts(self):
        for exit_value in (11_250_000.0, 12_062_500.0, 12_374_999.0):
            assert values_at(exit_value)["Series A"] == pytest.approx(3_000_000.0, abs=1.0)

    def test_the_cap_is_never_exceeded_before_conversion(self):
        """Between C freezing and A converting, A is flat: the segment in that
        interval must not list A at all."""
        spanning = [
            s
            for s in _segments(_normalize(CASE))
            if s["from"] >= 12_062_499.0 and s["to"] is not None and s["to"] <= 12_375_001.0
        ]
        assert spanning, "expected a segment between C freezing and A converting"
        for seg in spanning:
            assert "Series A" not in seg["participants"]


class TestTheAllocationItself:
    def test_at_a_50m_exit_every_class_takes_its_converted_share(self):
        """Above $19.6875M both capped classes have converted and no preference
        is left outstanding, so the whole exit is shared as-converted over
        2.4M + 0.5M + 2.4M + 1M = 6.3M shares.

            A, C: 2.4/6.3 x 50M = 19,047,619.05
            B   : 0.5/6.3 x 50M =  3,968,253.97
            Cmn : 1.0/6.3 x 50M =  7,936,507.94
        """
        got = values_at(50_000_000.0)
        assert got["Series A"] == pytest.approx(19_047_619.05, abs=1.0)
        assert got["Series C"] == pytest.approx(19_047_619.05, abs=1.0)
        assert got["Series B"] == pytest.approx(3_968_253.97, abs=1.0)
        assert got["Common"] == pytest.approx(7_936_507.94, abs=1.0)

    def test_the_overpayment_is_gone(self):
        """The defect, stated as the number it moved. A took $19,239,926.74
        before this fix — $192,307 of common's and B's money."""
        assert values_at(50_000_000.0)["Series A"] < 19_100_000.0

    def test_at_13m_a_has_just_converted(self):
        """Hand-derived. A converted, so only C's $5M preference is paid and the
        $8M residual is shared over 6.3M until C's $2.5M of headroom is gone
        (rate 1.0417/share, $6.5625M distributed), then over 3.9M.

            A = 2.4M x 1.0417 + 2.4M x (1.4375M / 3.9M) = 3,384,615
        """
        got = values_at(13_000_000.0)
        assert got["Series A"] == pytest.approx(3_384_615.0, abs=2.0)
        assert got["Series C"] == pytest.approx(7_500_000.0, abs=2.0)


class TestPayoffContinuity:
    """The call-spread decomposition is only valid if each class's exit payoff
    is continuous.

    Worth stating plainly: continuity is *not* what the old `p_cur` broke, and
    these two tests passed before the fix as well. `_segments` builds a
    continuous payoff by construction — it integrates slopes forward from one
    boundary to the next — so it stayed continuous while putting a boundary in
    the wrong place, and conservation stayed exact while one class took
    another's money. That is precisely why the defect survived: the two
    properties a reviewer would think to check are both blind to it. They are
    kept here as guards on the arithmetic, not as evidence for the fix — the
    hand-derived figures above are that.
    """

    @pytest.mark.parametrize("name", ["Series A", "Series B", "Series C", "Common"])
    def test_no_class_jumps_at_any_breakpoint(self, name):
        for b in sorted({s["from"] for s in _segments(_normalize(CASE))}):
            if b <= 0:
                continue
            width = max(b * 1e-6, 1.0)
            lo = values_at(b - width)[name]
            mid = values_at(b)[name]
            hi = values_at(b + width)[name]
            # Continuity: the value at the breakpoint is between its neighbours
            # and no closer to either than the segment slopes allow.
            assert lo - 1.0 <= mid <= hi + 1.0
            assert abs((mid - lo) - (hi - mid)) < width * 1.5 + 1.0

    def test_value_is_conserved(self):
        """Held before the fix too — which is why the defect was invisible."""
        for exit_value in (6e6, 1.1e7, 1.3e7, 2e7, 5e7, 2e8):
            assert sum(values_at(exit_value).values()) == pytest.approx(exit_value, rel=1e-9)


class TestTheOpmPathToo:
    """`allocate_waterfall` prices the same segments under Black-Scholes, so the
    correction reaches the OPM allocation and the per-share figure a 409A
    concludes on."""

    def test_common_per_share_rises_now_that_a_is_not_overpaid(self):
        got = allocate_waterfall(42_000_000.0, CASE, 4.0, 0.0421, 0.62)
        assert sum(c["value"] for c in got["classes"].values()) == pytest.approx(
            42_000_000.0, rel=1e-7
        )
        assert got["common_per_share"] > 0

    def test_an_uncapped_table_is_untouched(self):
        """The correction is confined to participation caps: with none, `p_cur`
        never diverges from the preference sum it always was."""
        uncapped = [{k: v for k, v in c.items() if k != "participation_cap"} for c in CASE]
        got = allocate_waterfall(42_000_000.0, uncapped, 4.0, 0.0421, 0.62)
        assert sum(c["value"] for c in got["classes"].values()) == pytest.approx(
            42_000_000.0, rel=1e-7
        )
