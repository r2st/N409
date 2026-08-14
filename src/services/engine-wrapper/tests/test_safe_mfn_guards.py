"""The MFN terms in a SAFE, held to the same contract as the terms they replace.

`safe_conversion` takes a discount and a cap, and an MFN provision that can
substitute a more favourable version of either. The primary terms were guarded;
their MFN twins were not, and the two gaps failed differently:

  * `mfn_discount` skipped the `< 1` check `discount` gets. A discount of 1.5
    drove the conversion price negative, and the caller was told "conversion
    price resolved to zero" — an error naming neither the field at fault nor
    what was wrong with it.

  * the cap was compared *raw*: `min(valuation_cap, mfn_cap)`. `params` on
    `/engine/v1/debt-valuation` is a free-form dict, so a cap arriving as a
    numeric string is ordinary — and it priced correctly on its own, then
    raised a bare `TypeError: '<' not supported between float and str` the
    moment an MFN cap appeared beside it. The route turns that into a 422
    whose detail is a Python internal, which is the failure mode `_int` and
    `_sequence` exist to prevent everywhere else in this engine.

Both are asymmetries rather than plain omissions, which is what made them
survive: every test pointed at the primary term passed.
"""

import pytest

from app.engine.debt_valuation import safe_conversion
from app.engine.errors import EngineInputError

ROUND = dict(investment=100_000.0, next_round_pre_money=10_000_000.0, next_round_shares=10_000_000.0)
# The round prices at $1.00/share, so every figure below reads directly.


class TestTheMfnDiscount:
    def test_it_is_held_to_the_same_ceiling_as_the_discount_it_replaces(self):
        with pytest.raises(EngineInputError, match="mfn_discount must be < 1"):
            safe_conversion(valuation_cap=None, discount=0.2, mfn_discount=1.5, **ROUND)

    def test_the_primary_discount_still_names_itself(self):
        # The pair of messages has to stay distinguishable — an analyst fixing
        # one needs to know which one they typed.
        with pytest.raises(EngineInputError, match="discount must be < 1"):
            safe_conversion(valuation_cap=None, discount=1.5, **ROUND)

    def test_a_negative_mfn_discount_is_refused(self):
        with pytest.raises(EngineInputError, match="mfn_discount must be >= 0"):
            safe_conversion(valuation_cap=None, discount=0.2, mfn_discount=-0.1, **ROUND)

    def test_the_more_favourable_discount_wins(self):
        # What MFN is for: a later investor's better terms are adopted.
        out = safe_conversion(valuation_cap=None, discount=0.2, mfn_discount=0.35, **ROUND)
        assert out["conversion_price"] == pytest.approx(0.65)

    def test_a_worse_mfn_discount_is_ignored(self):
        out = safe_conversion(valuation_cap=None, discount=0.2, mfn_discount=0.05, **ROUND)
        assert out["conversion_price"] == pytest.approx(0.80)


class TestTheMfnCap:
    def test_a_string_cap_prices_the_same_with_and_without_an_mfn_cap(self):
        # The regression. Both calls must resolve the $5M MFN cap to $0.50.
        alone = safe_conversion(valuation_cap="8000000", discount=0.2, **ROUND)
        with_mfn = safe_conversion(valuation_cap="8000000", discount=0.2, mfn_cap=5_000_000, **ROUND)
        numeric = safe_conversion(valuation_cap=8_000_000, discount=0.2, mfn_cap=5_000_000, **ROUND)

        assert alone["conversion_price"] == pytest.approx(0.80)  # discount beats the $8M cap
        assert with_mfn["conversion_price"] == pytest.approx(0.50)
        assert with_mfn["conversion_price"] == numeric["conversion_price"]
        assert with_mfn["converted_via"] == "cap"

    def test_the_lower_cap_wins(self):
        out = safe_conversion(valuation_cap=5_000_000, discount=0.2, mfn_cap=8_000_000, **ROUND)
        assert out["cap_price"] == pytest.approx(0.50)

    def test_an_mfn_cap_alone_is_adopted(self):
        out = safe_conversion(valuation_cap=None, discount=0.2, mfn_cap=4_000_000, **ROUND)
        assert out["cap_price"] == pytest.approx(0.40)
        assert out["converted_via"] == "cap"

    def test_a_bad_mfn_cap_names_itself_rather_than_the_primary_field(self):
        # It used to be validated under the name `valuation_cap`, so the caller
        # was sent to correct a field they had not supplied.
        with pytest.raises(EngineInputError, match="mfn_cap must be >= 0"):
            safe_conversion(valuation_cap=None, discount=0.2, mfn_cap=-5, **ROUND)

    def test_a_non_numeric_mfn_cap_is_named_too(self):
        with pytest.raises(EngineInputError, match="mfn_cap must be a number"):
            safe_conversion(valuation_cap=None, discount=0.2, mfn_cap="cheap", **ROUND)

    def test_a_bad_primary_cap_still_names_itself(self):
        with pytest.raises(EngineInputError, match="valuation_cap must be >= 0"):
            safe_conversion(valuation_cap=-1, discount=0.2, **ROUND)
