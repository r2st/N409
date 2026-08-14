"""Invariants that hold whatever the breakpoints are wrong about.

`test_allocation_properties.py` already asserts conservation, monotonicity and
the σ→0 limit over generated cap tables. R51 showed that is not enough. The
option-exercise bug fixed at a9664d2 — strike proceeds never credited against
`p_cur`, so every threshold struck after an exercise was late by exactly the
proceeds — moved $58,422 from an option pool to common and 2,963 engine tests
passed over it, *including* every conservation property in that file.

They had to. `_segments` emits a partition of [0, ∞) whose participant slopes
sum to 1 by construction, so `Σ class values == equity_value` holds no matter
where the breakpoints are placed. Conservation can only catch slopes that fail
to sum, NaN and overflow. It is structurally blind to "the split is wrong",
which is the entire interesting failure mode of a breakpoint waterfall.

What catches a misplaced breakpoint is an invariant that never mentions the
model. Each family below is a statement about the *company*, not about the
allocation: two things that are the same must be worth the same, and a change
that is purely notational must not move a dollar.

    1. Split-neutrality — writing one grant as three rows on the cap table is a
       bookkeeping choice, not a fact about the company. Splitting any class
       into N proportional pieces must leave every other class's value exactly
       where it was, and the pieces must sum to what the original held.
    2. Identical classes — two classes agreeing in every field but `name` must
       have the same value per share.
    3. Order independence — `share_classes` is a set written down in some order.
    4. Money homogeneity — the currency unit is not a fact about the company.
       Scale the equity value, preferences, strikes and caps by k and every
       allocated value scales by exactly k.
    5. Stock-split invariance — a k-for-1 split (share counts x k, strikes / k)
       leaves every class's *value* alone and divides every per-share figure
       by k.

Split-neutrality is the sharp one, and it is worth recording why. Re-running
these probes against a9664d2 with the fix reverted: split-neutrality fails on
26% of generated tables, by as much as $773,059 on a single class, at every
layer that consumes the waterfall (OPM, deterministic exit, PWERM, CVM, Monte
Carlo, class volatilities, the backsolve, and `compute()` on all five
allocation methods). Families 4 and 5 do *not* catch it — the uncredited
proceeds term scales in proportion under both, so homogeneity is satisfied by
the bug. That is the argument for keeping all five rather than the prettiest
one: they fail on different things.

Randomness is seeded per test, so a failure reproduces exactly and CI never
flakes. The generator emits participation caps, zero-preference classes,
seniority ties, conversion ratios either side of 1:1 and multiple option pools,
because the multi-pool table is the shape that made R51 visible — with one pool
and nothing struck after it, the allocation is right regardless.
"""

from __future__ import annotations

import random

import pytest

from app.engine.approaches import opm_backsolve
from app.engine.compute import compute
from app.engine.current_value import allocate_cvm
from app.engine.monte_carlo import allocate_monte_carlo
from app.engine.pwerm import allocate_pwerm
from app.engine.waterfall import allocate_waterfall, class_volatilities, exit_allocation

T, R, SIGMA = 3.0, 0.04, 0.6
EQUITY = 5e7

# Enough tables to cross the structural combinations without making the suite
# slow. The Monte Carlo and backsolve probes run fewer because each one is
# thousands of paths or a full Newton solve per table.
N_TABLES = 150


# ── generator ────────────────────────────────────────────────────────────────


def _random_cap_table(rng: random.Random, *, min_preferred: int = 0) -> list[dict]:
    """A cap table with 1 common class, 0-3 preferred and 0-2 option pools."""
    classes: list[dict] = [
        {"name": "Common", "kind": "common", "shares": float(rng.randrange(1_000_000, 20_000_000))}
    ]
    for i in range(rng.randint(min_preferred, 3)):
        preference = float(rng.randrange(0, 30_000_000))
        participating = rng.random() < 0.45
        cls = {
            "name": f"Series {chr(ord('A') + i)}",
            "kind": "preferred",
            "shares": float(rng.randrange(100_000, 10_000_000)),
            # 0 is legal and load-bearing: the class takes no tranche of the
            # stack but still participates in the residual.
            "preference": preference,
            # Ties are intentional — pari passu ranks split pro-rata.
            "seniority": rng.randint(1, 3),
            "participating": participating,
            "conversion_ratio": rng.choice([1.0, 1.0, 0.5, 2.0]),
        }
        # A cap is only representable above the preference (`_normalize`
        # refuses one at or below it, since that is `participating: false`).
        if participating and preference > 0 and rng.random() < 0.5:
            cls["participation_cap"] = preference * rng.choice([1.5, 2.0, 3.0])
        classes.append(cls)
    for i in range(rng.randint(0, 2)):
        classes.append(
            {
                "name": f"Pool {i}",
                "kind": "option",
                "shares": float(rng.randrange(100_000, 5_000_000)),
                "strike": rng.choice([0.01, 0.5, 1.0, 2.5, 10.0]),
            }
        )
    return classes


def _tables(seed: int, n: int = N_TABLES, *, min_preferred: int = 0):
    rng = random.Random(seed)
    for _ in range(n):
        yield rng, _random_cap_table(rng, min_preferred=min_preferred)


# ── the three notational rewrites ────────────────────────────────────────────


def _split_class(cls: dict, n: int) -> list[dict]:
    """One class as n proportional pieces — the same claim, written out longer.

    Share counts, preferences and participation caps are extensive quantities
    and divide. Seniority, participation, conversion ratio and strike are
    per-share terms and are copied unchanged: that is what makes the pieces add
    back up to the original claim rather than to a different one.
    """
    pieces = []
    for i in range(n):
        piece = dict(cls)
        piece["name"] = f"{cls['name']} #{i}"
        piece["shares"] = cls["shares"] / n
        if cls["kind"] == "preferred":
            piece["preference"] = cls["preference"] / n
            if cls.get("participation_cap") is not None:
                piece["participation_cap"] = cls["participation_cap"] / n
        pieces.append(piece)
    return pieces


def _split_table(rng: random.Random, classes: list[dict]) -> tuple[str, int, list[dict]]:
    target = rng.choice(classes)
    n = rng.randint(2, 3)
    out: list[dict] = []
    for cls in classes:
        out.extend(_split_class(cls, n) if cls["name"] == target["name"] else [cls])
    return target["name"], n, out


def _scale_money(classes: list[dict], k: float) -> list[dict]:
    """Redenominate: every currency figure on the cap table x k."""
    out = []
    for cls in classes:
        scaled = dict(cls)
        if cls["kind"] == "preferred":
            scaled["preference"] = cls["preference"] * k
            if cls.get("participation_cap") is not None:
                scaled["participation_cap"] = cls["participation_cap"] * k
        elif cls["kind"] == "option":
            scaled["strike"] = cls["strike"] * k
        out.append(scaled)
    return out


def _stock_split(classes: list[dict], k: float) -> list[dict]:
    """A k-for-1 split: share counts x k, option strikes / k.

    Dividing the strike is what makes this a split rather than a repricing. The
    figure the residual event loop actually runs on is the pool's total exercise
    cost, ``strike x shares``, and a split leaves that alone. Preferences and
    caps are total currency amounts and do not move.
    """
    out = []
    for cls in classes:
        scaled = {**cls, "shares": cls["shares"] * k}
        if cls["kind"] == "option":
            scaled["strike"] = cls["strike"] / k
        out.append(scaled)
    return out


def _summed(allocation: dict, name: str, n: int, key: str = "value") -> float:
    """What the n pieces of `name` hold between them after a split."""
    return sum(allocation["classes"][f"{name} #{i}"][key] for i in range(n))


# ── 1. split-neutrality, layer by layer ──────────────────────────────────────


class TestSplittingAClassMovesNothing:
    """Writing one claim as several rows is not a valuation event.

    This is the family that catches a misplaced breakpoint. Every assertion
    below fails on the pre-a9664d2 engine.
    """

    def test_the_opm_waterfall_is_split_neutral(self):
        for rng, classes in _tables(20260901):
            name, n, split = _split_table(rng, classes)
            base = allocate_waterfall(EQUITY, classes, T, R, SIGMA)
            after = allocate_waterfall(EQUITY, split, T, R, SIGMA)
            for other in classes:
                want = base["classes"][other["name"]]["value"]
                got = (
                    _summed(after, name, n)
                    if other["name"] == name
                    else after["classes"][other["name"]]["value"]
                )
                assert got == pytest.approx(want, rel=1e-6, abs=1.0), (
                    f"{other['name']!r} moved when {name!r} was split into {n}",
                    classes,
                )
            assert after["common_per_share"] == pytest.approx(
                base["common_per_share"], rel=1e-6, abs=1e-6
            ), (name, n, classes)

    def test_the_deterministic_exit_waterfall_is_split_neutral(self):
        for rng, classes in _tables(20260902):
            name, n, split = _split_table(rng, classes)
            base = exit_allocation(EQUITY, classes)
            after = exit_allocation(EQUITY, split)
            for other in classes:
                want = base["classes"][other["name"]]["value"]
                got = (
                    _summed(after, name, n)
                    if other["name"] == name
                    else after["classes"][other["name"]]["value"]
                )
                assert got == pytest.approx(want, rel=1e-6, abs=1.0), (
                    f"{other['name']!r} moved when {name!r} was split into {n}",
                    classes,
                )

    def test_pwerm_is_split_neutral_across_every_scenario(self):
        """The split has to be neutral at each exit value *and* after weighting.

        PWERM allocates each scenario with `exit_allocation`, so a breakpoint
        error that happens to cancel at one exit value will not cancel at three.
        """
        scenarios = [
            {"probability": 0.2, "equity_value": 1e6, "time_to_exit_years": 1.0},
            {"probability": 0.5, "equity_value": 6e7, "time_to_exit_years": 3.0},
            {"probability": 0.3, "equity_value": 4e8, "time_to_exit_years": 5.0},
        ]
        for rng, classes in _tables(20260903):
            name, n, split = _split_table(rng, classes)
            base = allocate_pwerm(scenarios, classes, default_discount_rate=0.2)
            after = allocate_pwerm(scenarios, split, default_discount_rate=0.2)
            for other in classes:
                want = base["classes"][other["name"]]["present_value"]
                got = (
                    _summed(after, name, n, key="present_value")
                    if other["name"] == name
                    else after["classes"][other["name"]]["present_value"]
                )
                assert got == pytest.approx(want, rel=1e-6, abs=1.0), (
                    f"{other['name']!r} moved when {name!r} was split into {n}",
                    classes,
                )

    def test_the_cvm_is_split_neutral(self):
        for rng, classes in _tables(20260904):
            name, n, split = _split_table(rng, classes)
            base = allocate_cvm(EQUITY, {"share_classes": classes})
            after = allocate_cvm(EQUITY, {"share_classes": split})
            assert after["common_per_share"] == pytest.approx(
                base["common_per_share"], rel=1e-6, abs=1e-6
            ), (name, n, classes)

    def test_the_monte_carlo_allocation_is_split_neutral(self):
        """Same seed, same paths — so any difference is the payoff, not the draw.

        `_common_payoff_factory` builds the breakpoint segments once and reuses
        them for every path, which means a misplaced breakpoint is baked into
        the whole simulation rather than averaging out.
        """
        config = {"monte_carlo": {"paths": 400, "seed": 11}}
        for rng, classes in _tables(20260905, n=40):
            name, n, split = _split_table(rng, classes)
            base = allocate_monte_carlo(
                EQUITY, {"share_classes": classes, **config}, t=T, r=R, sigma=SIGMA
            )
            after = allocate_monte_carlo(
                EQUITY, {"share_classes": split, **config}, t=T, r=R, sigma=SIGMA
            )
            assert after["common_per_share"] == pytest.approx(
                base["common_per_share"], rel=1e-6, abs=1e-6
            ), (name, n, classes)

    def test_class_volatilities_are_split_neutral(self):
        """The gearing of the common claim cannot depend on how it was typed.

        Each class's delta is the participation-weighted sum of its tranches'
        spread deltas, so this reads the same segments the values do — from the
        derivative side, where a breakpoint in the wrong place shifts which
        spread a class is geared to.
        """
        for rng, classes in _tables(20260906):
            name, n, split = _split_table(rng, classes)
            base = class_volatilities(EQUITY, classes, T, R, SIGMA)
            after = class_volatilities(EQUITY, split, T, R, SIGMA)
            assert after["common_volatility"] == pytest.approx(
                base["common_volatility"], rel=1e-5, abs=1e-5
            ), (name, n, classes)
            assert after["delta_total"] == pytest.approx(base["delta_total"], abs=1e-5)

    def test_the_backsolve_solves_the_same_equity_value(self):
        """Splitting a class the round did not price cannot move the solve.

        The backsolve inverts `class_per_share` on the priced class, so a
        breakpoint error anywhere in the table walks straight into the concluded
        equity value — and unlike the forward allocation, nothing downstream
        conserves against it.
        """
        for rng, classes in _tables(20260907, n=80, min_preferred=1):
            round_class = next(c for c in classes if c["kind"] == "preferred")["name"]
            others = [c for c in classes if c["name"] != round_class]
            target = rng.choice(others)
            n = rng.randint(2, 3)
            split: list[dict] = []
            for cls in classes:
                split.extend(
                    _split_class(cls, n) if cls["name"] == target["name"] else [cls]
                )
            def solve(table: list[dict]) -> float:
                return opm_backsolve(
                    share_classes=table,
                    last_round_pps=2.5,
                    last_round_class=round_class,
                    t=T,
                    r=R,
                    sigma=SIGMA,
                )["equity_value"]

            base_equity, after_equity = solve(classes), solve(split)
            assert after_equity == pytest.approx(base_equity, rel=1e-6), (
                f"splitting {target['name']!r} into {n} moved the solve",
                classes,
            )


class TestSplitNeutralityThroughCompute:
    """The same invariant at the request boundary, on every allocation method.

    `compute()` derives its own fully-diluted count, applies the discounts and
    picks the DLOM volatility — all of which read the allocation. Asserting here
    as well as on the primitives is what pins the *reported* figure rather than
    an intermediate one.
    """

    WEIGHTS = {
        "weight_asset": 0.0,
        "weight_opm": 1.0,
        "weight_income": 0.0,
        "weight_market": 0.0,
        "dloc": 0.05,
        "dlom": 0.10,
    }
    BASE = {
        "volatility": 0.65,
        "risk_free_rate": 0.04,
        "time_to_exit_years": 4.0,
        "last_round_post_money": 20_000_000,
    }
    SCENARIOS = [
        {"name": "IPO", "probability": 0.6, "equity_value": 50_000_000, "time_to_exit_years": 3.0},
        {"name": "Wind-down", "probability": 0.4, "equity_value": 8_000_000, "time_to_exit_years": 2.0},
    ]
    CASES = {
        "opm": ({}, {}),
        "pwerm": ({"allocation_method": "pwerm"}, {"pwerm": {"scenarios": SCENARIOS}}),
        "hybrid": (
            {"allocation_method": "hybrid"},
            {
                "pwerm": {"scenarios": SCENARIOS},
                "hybrid": {"opm_weight": 0.5, "pwerm_weight": 0.5},
            },
        ),
        "cvm": ({"allocation_method": "cvm"}, {}),
        "monte_carlo": (
            {"allocation_method": "monte_carlo"},
            {"monte_carlo": {"paths": 2_000, "seed": 5}},
        ),
    }

    @staticmethod
    def _scalars(classes: list[dict]) -> dict:
        """The aggregate scalar inputs implied by a class list.

        `compute()` takes both, and they have to agree: the scalars are what the
        single-breakpoint fallbacks and the disclosed counts are built from.
        Deriving them from the cap table keeps the split a pure rewrite — the
        sums are identical either way, which is the point.
        """
        return {
            "shares_outstanding_common": sum(
                c["shares"] for c in classes if c["kind"] == "common"
            ),
            "options_outstanding": sum(c["shares"] for c in classes if c["kind"] == "option"),
            "shares_outstanding_preferred": sum(
                c["shares"] for c in classes if c["kind"] == "preferred"
            ),
            "liquidation_preference": sum(
                c.get("preference", 0.0) for c in classes if c["kind"] == "preferred"
            ),
        }

    @pytest.mark.parametrize("method", sorted(CASES))
    def test_the_concluded_fmv_does_not_depend_on_how_the_table_was_typed(self, method):
        params_extra, inputs_extra = self.CASES[method]
        trials = 30 if method == "monte_carlo" else 60
        for rng, classes in _tables(20260908 + len(method), n=trials):
            name, n, split = _split_table(rng, classes)

            def run(table: list[dict]) -> dict:
                return compute(
                    {**self.WEIGHTS, **params_extra},
                    {
                        **self.BASE,
                        **self._scalars(table),
                        "share_classes": table,
                        **inputs_extra,
                    },
                )["results"]

            base, after = run(classes), run(split)
            for field in (
                "fmv_per_share",
                "common_equity_value",
                "fully_diluted_common",
                "equity_value",
            ):
                assert after[field] == pytest.approx(base[field], rel=1e-6, abs=1e-6), (
                    f"{field} moved on {method} when {name!r} was split into {n}",
                    classes,
                )


# ── 2. identical classes ─────────────────────────────────────────────────────


class TestTwoIdenticalClassesAreWorthTheSame:
    """Agreeing in every field but `name` must mean agreeing in value per share.

    Weaker than split-neutrality — it compares two classes inside one run rather
    than two runs — but it needs no reference allocation, so it holds on tables
    where there is nothing to compare against.
    """

    def test_under_the_opm_waterfall(self):
        for rng, classes in _tables(20260910):
            target = rng.choice(classes)
            twin = {**target, "name": f"{target['name']} (twin)"}
            out = allocate_waterfall(EQUITY, [*classes, twin], T, R, SIGMA)
            assert out["classes"][twin["name"]]["per_share"] == pytest.approx(
                out["classes"][target["name"]]["per_share"], rel=1e-6, abs=1e-9
            ), (target["name"], classes)

    def test_under_the_deterministic_exit_waterfall(self):
        for rng, classes in _tables(20260911):
            target = rng.choice(classes)
            twin = {**target, "name": f"{target['name']} (twin)"}
            out = exit_allocation(EQUITY, [*classes, twin])
            assert out["classes"][twin["name"]]["per_share"] == pytest.approx(
                out["classes"][target["name"]]["per_share"], rel=1e-6, abs=1e-9
            ), (target["name"], classes)

    def test_their_class_volatilities_agree(self):
        for rng, classes in _tables(20260912):
            target = rng.choice(classes)
            twin = {**target, "name": f"{target['name']} (twin)"}
            out = class_volatilities(EQUITY, [*classes, twin], T, R, SIGMA)
            a = out["classes"][target["name"]]["volatility"]
            b = out["classes"][twin["name"]]["volatility"]
            # Both None is agreement: a class no tranche reaches has no defined
            # return volatility, and its twin must not have one either.
            if a is None or b is None:
                assert a is None and b is None, (target["name"], classes)
                continue
            assert b == pytest.approx(a, rel=1e-5, abs=1e-6), (target["name"], classes)


# ── 3. order independence ────────────────────────────────────────────────────


class TestTheOrderOfShareClassesDoesNotMatter:
    """`share_classes` is a set that arrives in a list.

    Seniority is carried by the field, not by position, so a client that sorts
    its cap table differently — or a JSONB round-trip that does — must get the
    same allocation back.
    """

    def test_the_opm_waterfall_is_order_independent(self):
        for rng, classes in _tables(20260913):
            shuffled = classes[:]
            rng.shuffle(shuffled)
            base = allocate_waterfall(EQUITY, classes, T, R, SIGMA)
            after = allocate_waterfall(EQUITY, shuffled, T, R, SIGMA)
            for cls in classes:
                assert after["classes"][cls["name"]]["value"] == pytest.approx(
                    base["classes"][cls["name"]]["value"], rel=1e-9, abs=0.01
                ), (cls["name"], classes)

    def test_the_deterministic_exit_waterfall_is_order_independent(self):
        for rng, classes in _tables(20260914):
            shuffled = classes[:]
            rng.shuffle(shuffled)
            base = exit_allocation(EQUITY, classes)
            after = exit_allocation(EQUITY, shuffled)
            for cls in classes:
                assert after["classes"][cls["name"]]["value"] == pytest.approx(
                    base["classes"][cls["name"]]["value"], rel=1e-9, abs=0.01
                ), (cls["name"], classes)


# ── 4. money homogeneity ─────────────────────────────────────────────────────


class TestTheAllocationIsHomogeneousInMoney:
    """Denominating the cap table in cents instead of dollars changes nothing.

    Degree-1 homogeneity: scale the equity value and every currency figure on
    the table by k and every allocated value scales by exactly k. What this
    catches is an absolute threshold hiding in the algebra — a breakpoint
    compared against a hardcoded amount, or an epsilon that is a fixed number of
    dollars rather than a fraction, neither of which survives k = 1e-3.

    Not a substitute for split-neutrality: the R51 proceeds term scaled in
    proportion, so this family was satisfied by the bug.
    """

    @pytest.mark.parametrize("k", [1e-3, 0.5, 2.0, 1000.0])
    def test_the_opm_waterfall_scales_with_the_currency_unit(self, k):
        for rng, classes in _tables(20260915, n=60):
            equity = float(rng.randrange(1_000_000, 300_000_000))
            base = allocate_waterfall(equity, classes, T, R, SIGMA)
            after = allocate_waterfall(equity * k, _scale_money(classes, k), T, R, SIGMA)
            for cls in classes:
                want = base["classes"][cls["name"]]["value"] * k
                assert after["classes"][cls["name"]]["value"] == pytest.approx(
                    want, rel=1e-6, abs=max(0.5 * k, 0.5)
                ), (cls["name"], k, classes)

    @pytest.mark.parametrize("k", [1e-3, 0.5, 2.0, 1000.0])
    def test_the_deterministic_exit_waterfall_scales_with_the_currency_unit(self, k):
        for rng, classes in _tables(20260916, n=60):
            equity = float(rng.randrange(1_000_000, 300_000_000))
            base = exit_allocation(equity, classes)
            after = exit_allocation(equity * k, _scale_money(classes, k))
            for cls in classes:
                want = base["classes"][cls["name"]]["value"] * k
                assert after["classes"][cls["name"]]["value"] == pytest.approx(
                    want, rel=1e-6, abs=max(0.5 * k, 0.5)
                ), (cls["name"], k, classes)


# ── 5. stock splits ──────────────────────────────────────────────────────────


class TestAStockSplitIsNotAValuationEvent:
    """k-for-1: share counts x k, option strikes / k.

    Every class's *value* is unchanged and every per-share figure is divided by
    k. This is the invariant a board asks about directly — a 10-for-1 split must
    take the 409A price to a tenth and nothing else — and it exercises the same
    residual algebra as split-neutrality from the other side, since it moves the
    share counts the slopes are struck on while leaving the money alone.
    """

    @pytest.mark.parametrize("k", [0.5, 2.0, 10.0, 1000.0])
    def test_the_opm_waterfall_survives_a_stock_split(self, k):
        for rng, classes in _tables(20260917, n=60):
            equity = float(rng.randrange(1_000_000, 300_000_000))
            base = allocate_waterfall(equity, classes, T, R, SIGMA)
            after = allocate_waterfall(equity, _stock_split(classes, k), T, R, SIGMA)
            for cls in classes:
                assert after["classes"][cls["name"]]["value"] == pytest.approx(
                    base["classes"][cls["name"]]["value"], rel=1e-6, abs=1.0
                ), (cls["name"], k, classes)
            # Tolerance is the response's rounding, not the algebra's. Both
            # `per_share` figures are `round(..., 6)`, so each carries up to
            # 5e-7 of quantization, and dividing the *base* one by k does not
            # divide the error with it — at k = 1000 a 6dp figure of 0.009866
            # is being asked to reproduce 0.009866329. The money assertion above
            # is the exact one: common's value is unchanged to the cent.
            assert after["common_per_share"] == pytest.approx(
                base["common_per_share"] / k, rel=1e-5, abs=1e-6
            ), (k, classes)

    @pytest.mark.parametrize("k", [0.5, 2.0, 10.0, 1000.0])
    def test_the_deterministic_exit_waterfall_survives_a_stock_split(self, k):
        for rng, classes in _tables(20260918, n=60):
            equity = float(rng.randrange(1_000_000, 300_000_000))
            base = exit_allocation(equity, classes)
            after = exit_allocation(equity, _stock_split(classes, k))
            for cls in classes:
                assert after["classes"][cls["name"]]["value"] == pytest.approx(
                    base["classes"][cls["name"]]["value"], rel=1e-6, abs=1.0
                ), (cls["name"], k, classes)

    @pytest.mark.parametrize("k", [0.5, 2.0, 10.0])
    def test_class_volatilities_survive_a_stock_split(self, k):
        """Gearing is a property of the claim, not of the unit it is cut into."""
        for rng, classes in _tables(20260919, n=60):
            equity = float(rng.randrange(1_000_000, 300_000_000))
            base = class_volatilities(equity, classes, T, R, SIGMA)
            after = class_volatilities(equity, _stock_split(classes, k), T, R, SIGMA)
            if base["common_volatility"] is None:
                continue
            assert after["common_volatility"] == pytest.approx(
                base["common_volatility"], rel=1e-5, abs=1e-5
            ), (k, classes)
