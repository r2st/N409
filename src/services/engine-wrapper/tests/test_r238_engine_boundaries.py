"""R238 — boundaries where a technically-valid input produces a degenerate answer.

Not overflow and not a refused input: every value below clears the pre-flight
validator and every guard the engine already holds, and the arithmetic completes.
What is wrong is the *conclusion* — a fair market value of zero, a schedule for
an instrument that has already matured, a weighting whose legs disagree about
what they are weighting. Each case here is a payload an analyst could plausibly
send, and each one used to come back as a successful 200.
"""

from __future__ import annotations

import pytest

from app.engine.compute import compute
from app.engine.errors import EngineInputError

# The ordinary shape of a 2023-24 down round: $80M of preference stacked over a
# $5M post-money. Common is deeply out of the money but not worthless.
DOWN_ROUND_PARAMS = {
    "weight_asset": 0,
    "weight_opm": 1,
    "weight_income": 0,
    "weight_market": 0,
    "dlom": 0.2,
}
DOWN_ROUND_INPUTS = {
    "last_round_post_money": 5e6,
    "shares_outstanding_common": 8e6,
    "options_outstanding": 1e6,
    "shares_outstanding_preferred": 4e6,
    "liquidation_preference": 8e7,
    "volatility": 0.6,
}


# ── a conclusion of $0.0000 a share is not a conclusion ──────────────────────


def test_a_positive_allocation_below_the_quantum_is_refused_not_rounded_to_zero():
    """`fmv_per_share: 0.0` beside a non-zero `common_equity_value`.

    At 40% volatility this cap table leaves common $1.15e-05 a share — a
    positive number smaller than half the 1e-4 the conclusion is stated at. It
    used to round to 0.0 and be returned as a 200, in the same `results` object
    as a `common_equity_value` of $128.92, which is the same allocation stated
    over the whole class. The document asserted both.
    """
    with pytest.raises(EngineInputError) as exc:
        compute(DOWN_ROUND_PARAMS, {**DOWN_ROUND_INPUTS, "volatility": 0.4})
    message = str(exc.value)
    assert "rounds to $0.0000" in message
    # The unrounded figure, because that is the number to argue with — the
    # rounded one is the same zero the message is complaining about.
    assert "1.15e-05" in message
    assert "0.0001" in message
    assert "positive but below" in message


def test_an_allocation_of_exactly_zero_is_still_reported():
    """The other side of the guard, and deliberately open.

    A $1M equity value against a $500M preference at 20% volatility leaves common
    exactly 0.0 — not a rounding artifact but the model's own answer. Every
    figure in the result agrees with it, `common_equity_value` included, so it is
    a conclusion about the security rather than a quantum erasing one. That is
    also what the current-value method means on any underwater cap table, and
    refusing it would make `allocation_method: cvm` unusable for the tables it
    exists to describe.
    """
    out = compute(
        DOWN_ROUND_PARAMS,
        {
            **DOWN_ROUND_INPUTS,
            "last_round_post_money": 1e6,
            "liquidation_preference": 5e8,
            "volatility": 0.2,
        },
    )
    assert out["results"]["fmv_per_share"] == 0.0
    assert out["results"]["common_equity_value"] == 0.0


def test_the_same_cap_table_one_notch_above_the_quantum_still_concludes():
    """The guard is on the quantum, not on "deeply out of the money".

    Same stack at 50% volatility concludes $0.0003 a share. A discount that
    small is unusual and entirely valid, and refusing it would make the engine
    unable to value the down rounds it exists to value.
    """
    out = compute(DOWN_ROUND_PARAMS, {**DOWN_ROUND_INPUTS, "volatility": 0.5})
    assert out["results"]["fmv_per_share"] == 0.0003
    assert out["results"]["common_equity_value"] > 0
    # The unrounded figure is untouched by the guard: it is not a conclusion.
    assert out["fmv_per_share_unrounded"] == pytest.approx(2.826e-4, rel=1e-3)
