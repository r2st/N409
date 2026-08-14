"""DLOC input guards — the refusals, and the paths a malformed study table takes.

`test_dloc.py` covers what the three methods compute. This file covers what they
refuse. That matters more here than in most modules: the DLOC inputs arrive from
a form an appraiser fills in, `dloc_study_table` is free-form rows, and every one
of these branches is the difference between a 400 naming the field and a 500 —
or worse, a silently wrong discount. A premium that arrives as the string
"0.30" must not be read as a number by accident, and a negative premium is a
finding about one transaction rather than evidence for a discount, so it is
turned away rather than inverted into a nonsense figure.
"""

import pytest

from app.engine.dloc import (
    _num,
    control_premium_dloc,
    control_premium_from_dloc,
    dloc_from_control_premium,
    level_of_value_detail,
    minority_basis_share,
    resolve_dloc,
    studies_dloc,
)
from app.engine.errors import EngineInputError


# ── _num ─────────────────────────────────────────────────────────────────────


def test_a_non_numeric_premium_is_refused_by_name():
    with pytest.raises(EngineInputError, match="control_premium must be a number"):
        dloc_from_control_premium("thirty percent")
    with pytest.raises(EngineInputError, match="control_premium must be a number"):
        dloc_from_control_premium(None)
    with pytest.raises(EngineInputError, match="control_premium must be a number"):
        dloc_from_control_premium([0.3])


def test_a_boolean_is_not_a_premium():
    # `float(True)` is 1.0, so without the explicit check a checkbox posted into
    # the premium field would read as a 100% control premium — a 50% discount.
    with pytest.raises(EngineInputError, match="must be a number"):
        dloc_from_control_premium(True)
    with pytest.raises(EngineInputError, match="must be a number"):
        dloc_from_control_premium(False)


def test_non_finite_premiums_are_refused():
    with pytest.raises(EngineInputError, match="must be finite"):
        dloc_from_control_premium(float("nan"))
    with pytest.raises(EngineInputError, match="must be finite"):
        dloc_from_control_premium(float("inf"))


def test_a_negative_premium_is_below_the_floor():
    with pytest.raises(EngineInputError, match=r"must be >= 0"):
        dloc_from_control_premium(-0.1)


def test_a_discount_above_the_ceiling_is_refused():
    with pytest.raises(EngineInputError, match=r"must be <= 0.95"):
        control_premium_from_dloc(0.99)


def test_num_accepts_a_numeric_string_at_the_boundaries():
    assert _num("0.25", "x", minimum=0.0, maximum=1.0) == 0.25
    assert _num(0.0, "x", minimum=0.0) == 0.0
    assert _num(1.0, "x", maximum=1.0) == 1.0


# ── _premium_rows: a caller-supplied study table ─────────────────────────────


def test_a_study_table_must_be_a_non_empty_list():
    with pytest.raises(EngineInputError, match="non-empty list of study rows"):
        studies_dloc(studies=[])
    with pytest.raises(EngineInputError, match="non-empty list of study rows"):
        studies_dloc(studies={"study": "x", "premium": 0.3})


def test_each_study_row_must_be_an_object():
    with pytest.raises(EngineInputError, match=r"studies\[1\] must be an object"):
        studies_dloc(studies=[{"study": "a", "premium": 0.3}, "not a row"])


def test_a_study_row_needs_a_name():
    with pytest.raises(EngineInputError, match=r"studies\[0\].study is required"):
        studies_dloc(studies=[{"premium": 0.3}])
    with pytest.raises(EngineInputError, match=r"studies\[0\].study is required"):
        studies_dloc(studies=[{"study": "   ", "premium": 0.3}])
    with pytest.raises(EngineInputError, match=r"studies\[0\].study is required"):
        studies_dloc(studies=[{"study": 7, "premium": 0.3}])


def test_a_study_premium_must_be_a_number():
    with pytest.raises(EngineInputError, match=r"studies\[0\].premium must be a number"):
        studies_dloc(studies=[{"study": "a", "premium": "0.30"}])
    with pytest.raises(EngineInputError, match=r"studies\[0\].premium must be a number"):
        studies_dloc(studies=[{"study": "a", "premium": None}])
    # A bool would otherwise pass `isinstance(x, (int, float))`.
    with pytest.raises(EngineInputError, match=r"studies\[0\].premium must be a number"):
        studies_dloc(studies=[{"study": "a", "premium": True}])


def test_a_negative_or_non_finite_study_premium_is_refused():
    with pytest.raises(EngineInputError, match="non-negative fraction"):
        studies_dloc(studies=[{"study": "a", "premium": -0.2}])
    with pytest.raises(EngineInputError, match="non-negative fraction"):
        studies_dloc(studies=[{"study": "a", "premium": float("nan")}])


def test_a_study_name_is_stripped_before_it_is_matched():
    out = studies_dloc(selected=["Firm set"], studies=[{"study": "  Firm set  ", "premium": 0.4}])
    assert out["studies"][0]["study"] == "Firm set"
    assert out["observed_control_premium"] == 0.4


# ── Selection ────────────────────────────────────────────────────────────────


def test_a_custom_table_sharing_no_names_with_the_default_set_blends_what_there_is():
    # The default selection names the engine's own two decade rows. A firm that
    # supplied its own subscription extraction shares none of those names, and
    # the right answer is to blend the table it passed rather than to refuse.
    out = studies_dloc(
        studies=[
            {"study": "BVR SIC 7372, 2024", "premium": 0.20},
            {"study": "BVR SIC 7372, 2023", "premium": 0.30},
        ]
    )
    assert out["study_count"] == 2
    assert out["observed_control_premium"] == 0.25  # median of the two
    assert out["indicative_table"] is False  # nothing came from the built-ins


def test_an_empty_selection_against_a_custom_table_is_refused():
    # `selected=[]` is not "use the defaults" — it is a selection naming
    # nothing, and there is no premium to conclude on.
    with pytest.raises(EngineInputError, match="at least one selected study"):
        studies_dloc(selected=[], studies=[{"study": "Firm set", "premium": 0.3}])


def test_an_unknown_study_name_lists_what_is_available():
    with pytest.raises(EngineInputError, match="unknown control-premium studies"):
        studies_dloc(selected=["US public targets, 1980s"])


def test_an_unrecognised_statistic_is_refused():
    with pytest.raises(EngineInputError, match="must be 'median' or 'mean'"):
        studies_dloc(statistic="mode")


def test_the_mean_statistic_blends_on_the_premium_scale():
    out = studies_dloc(
        selected=["a", "b"],
        studies=[{"study": "a", "premium": 0.2}, {"study": "b", "premium": 0.6}],
        statistic="mean",
    )
    assert out["observed_control_premium"] == 0.4
    # Inverted once, at the end — not the mean of the two inverted discounts,
    # which would be (1/6 + 3/8)/2 ≈ 0.2708.
    assert out["dloc"] == pytest.approx(1.0 - 1.0 / 1.4, abs=1e-6)


# ── minority_basis_share ─────────────────────────────────────────────────────


def test_unreadable_weights_are_skipped_rather_than_crashing():
    # These arrive out of a stored engagement, so a hand-edited or partially
    # migrated blob must degrade to "ignore that entry", not to a 500.
    share = minority_basis_share(
        {"income": 0.5, "market": 0.5, "asset": "n/a", "opm_backsolve": None}
    )
    assert share == pytest.approx(0.5)


def test_non_finite_and_non_positive_weights_do_not_count():
    share = minority_basis_share(
        {"income": 1.0, "market": float("nan"), "asset": -1.0, "opm_backsolve": 0.0}
    )
    assert share == 0.0  # only the income weight survived, and it is control


def test_weights_that_are_all_unusable_read_as_no_information():
    assert minority_basis_share({"income": "n/a"}) is None
    assert minority_basis_share({"income": 0.0}) is None
    assert minority_basis_share({}) is None
    assert minority_basis_share(None) is None
    assert minority_basis_share([("income", 1.0)]) is None


def test_level_detail_is_silent_without_weights_or_without_a_discount():
    assert level_of_value_detail(0.2, None) is None
    assert level_of_value_detail(0.0, {"opm_backsolve": 1.0}) is None
    assert level_of_value_detail(-0.1, {"opm_backsolve": 1.0}) is None


# ── resolve_dloc ─────────────────────────────────────────────────────────────


def test_a_non_string_method_is_refused_before_it_is_matched():
    with pytest.raises(EngineInputError, match="dloc_method must be a string"):
        resolve_dloc({"dloc_method": 3})


def test_an_unrecognised_method_names_the_vocabulary():
    with pytest.raises(EngineInputError, match="dloc_method must be one of"):
        resolve_dloc({"dloc_method": "mergerstat"})


def test_the_studies_method_reads_its_selection_and_table_from_params():
    dloc, method, detail = resolve_dloc(
        {
            "dloc_method": "studies",
            "dloc_studies": ["Firm 2024"],
            "dloc_study_table": [
                {"study": "Firm 2024", "premium": 0.25},
                {"study": "Firm 2023", "premium": 0.45},
            ],
            "dloc_statistic": "mean",
        }
    )
    assert method == "studies"
    assert detail["study_count"] == 1
    assert detail["observed_control_premium"] == 0.25
    assert dloc == pytest.approx(1.0 - 1.0 / 1.25, abs=1e-6)


def test_the_studies_method_ignores_a_selection_of_the_wrong_type():
    # A malformed `dloc_studies` falls back to the default set rather than
    # exploding — the same forgiving read the table gets.
    _, _, detail = resolve_dloc({"dloc_method": "studies", "dloc_studies": "2010s"})
    assert detail["study_count"] == 2
    assert detail["indicative_table"] is True


def test_the_studies_method_defaults_the_statistic_when_it_is_blank():
    _, _, detail = resolve_dloc({"dloc_method": "studies", "dloc_statistic": ""})
    assert detail["statistic"] == "median"


def test_the_qualitative_method_needs_a_stated_discount():
    with pytest.raises(EngineInputError, match="qualitative DLOC method needs params.dloc"):
        resolve_dloc({"dloc_method": "qualitative"})


def test_the_studies_method_carries_the_synergy_share_through():
    _, _, detail = resolve_dloc({"dloc_method": "studies", "dloc_synergy_share": 0.5})
    assert detail["synergy_share"] == 0.5
    assert detail["control_premium_applied"] == pytest.approx(
        detail["observed_control_premium"] * 0.5
    )


def test_a_synergy_share_at_or_above_the_ceiling_is_refused():
    with pytest.raises(EngineInputError, match="synergy_share must be <= 0.99"):
        control_premium_dloc(0.4, 1.0)
