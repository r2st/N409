"""A confidence score the model did not give on the scale it was asked for.

Round 216, methodology M5. `clamp_confidence` is the one normaliser every agent
runs a model-emitted certainty through, and it reaches four surfaces an analyst
reads as evidence: a tag's confidence on the engagement classification, a
metric's on the company profile, the profile's own overall score, and the
per-field confidence beside each cap-table citation.

It clamped. That is right for a value that is merely imprecise and wrong for one
that says the model was not answering the question, because a clamp turns
nonsense into the *strongest* reading of it: `confidence: 9999` arrived as
`1.0` — maximum confidence, displayed beside whatever the model had just
invented. `-1` arrived as `0.0`, a real score meaning "none", and so could not
be told apart from a model that had actually said so.

The fold from 0-100 stays: a model asked for 0-1 answering `85` is using a
different scale, not making a different claim. Past 100 there is no scale left
to guess at.
"""

import pytest

from app.agents._common import MAX_CONFIDENCE_SCALE, clamp_confidence


class TestScoresOnEitherScale:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (0, 0.0),
            (0.42, 0.42),
            (1, 1.0),
            ("0.75", 0.75),
            (85, 0.85),
            (100, 1.0),
            (12.5, 0.125),
        ],
    )
    def test_it_reads_as_a_fraction(self, value, expected):
        assert clamp_confidence(value) == expected

    def test_zero_is_a_score_and_survives_as_one(self):
        """"The model has no confidence in this" is a finding. It must stay
        distinguishable from "the model did not say", which is what makes the
        refusals below matter."""
        assert clamp_confidence(0) == 0.0
        assert clamp_confidence(0) is not None


class TestScoresOnNoScaleAtAll:
    @pytest.mark.parametrize("value", [9999, 101, MAX_CONFIDENCE_SCALE + 0.001, 1e9])
    def test_a_score_above_every_scale_is_not_certainty(self, value):
        """The failure this change exists for. Clamped to 1.0 it read as the
        model's strongest possible endorsement of a value it had just made up."""
        assert clamp_confidence(value) is None

    @pytest.mark.parametrize("value", [-1, -0.0001, -100])
    def test_a_negative_score_is_not_the_absence_of_confidence(self, value):
        assert clamp_confidence(value) is None

    @pytest.mark.parametrize("value", ["nope", None, {}, [], True, float("nan"), float("inf")])
    def test_a_non_number_is_still_refused(self, value):
        """Unchanged, and the reason the refusals above cost nothing: every
        surface has always had to render a null score."""
        assert clamp_confidence(value) is None
