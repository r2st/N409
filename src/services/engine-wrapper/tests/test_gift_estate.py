"""Gift & estate tax valuation — the discount chain and the reportable gift."""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.gift_estate import (
    REV_RUL_59_60_FACTORS,
    combined_discount,
    gift_estate_valuation,
)
from app.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def run(**over) -> dict:
    base = {"entity_value": 10_000_000.0, "percent_interest": 25.0}
    return gift_estate_valuation(**{**base, **over})


# ── the discount chain ───────────────────────────────────────────────────────


def test_discounts_are_multiplicative_not_additive():
    """The arithmetic error that costs these files on examination: a 20% DLOC
    and a 30% DLOM are a 44% discount, not a 50% one."""
    out = run(dloc=0.20, dlom=0.30)
    assert out["effective_discount"] == pytest.approx(0.44)
    assert out["effective_discount"] != pytest.approx(0.50)
    # 2,500,000 × 0.80 × 0.70
    assert out["concluded_value"] == pytest.approx(1_400_000)


def test_dlom_applies_to_the_post_dloc_value_not_the_pro_rata_value():
    out = run(dloc=0.20, dlom=0.30)
    assert out["pro_rata_value"] == pytest.approx(2_500_000)
    assert out["value_after_dloc"] == pytest.approx(2_000_000)
    # 30% of 2,000,000, not 30% of 2,500,000.
    dlom_step = next(s for s in out["value_bridge"] if s["step"] == "less_dlom")
    assert dlom_step["amount"] == pytest.approx(600_000)


def test_combined_discount_is_exposed_for_the_reviewer_to_recompute():
    assert combined_discount(0.20, 0.30) == pytest.approx(0.44)
    assert combined_discount(0.0, 0.0) == 0.0


def test_the_bridge_reads_in_order_and_ends_at_the_conclusion():
    out = run(dloc=0.15, dlom=0.25)
    assert [s["step"] for s in out["value_bridge"]] == [
        "pro_rata_interest",
        "less_dloc",
        "less_dlom",
    ]
    assert out["value_bridge"][-1]["value"] == pytest.approx(out["concluded_value"])
    assert out["total_discount_amount"] == pytest.approx(
        out["pro_rata_value"] - out["concluded_value"]
    )


def test_no_discounts_leaves_the_pro_rata_value_alone():
    out = run()
    assert out["concluded_value"] == pytest.approx(2_500_000)
    assert out["effective_discount"] == 0.0


def test_percent_interest_is_a_percentage_not_a_fraction():
    # "25 for a quarter interest" — reading it as a fraction would value the
    # interest at a quarter of a percent of the entity.
    assert run(percent_interest=25.0)["pro_rata_value"] == pytest.approx(2_500_000)
    assert run(percent_interest=100.0)["pro_rata_value"] == pytest.approx(10_000_000)


@pytest.mark.parametrize("bad", [-1.0, 101.0])
def test_a_percentage_outside_0_to_100_is_refused(bad):
    with pytest.raises(EngineInputError, match="percent_interest"):
        run(percent_interest=bad)


@pytest.mark.parametrize("field", ["dloc", "dlom"])
def test_a_discount_of_one_or_more_is_refused(field):
    with pytest.raises(EngineInputError, match=field):
        run(**{field: 1.0})


# ── the reportable gift ──────────────────────────────────────────────────────


def test_the_annual_exclusion_sits_between_the_appraisal_and_the_taxable_gift():
    out = run(dloc=0.20, dlom=0.30, annual_exclusion=19_000)
    assert out["concluded_value"] == pytest.approx(1_400_000)
    assert out["annual_exclusion"]["applied"] == pytest.approx(19_000)
    assert out["taxable_gift"] == pytest.approx(1_381_000)


def test_the_exclusion_is_per_donee():
    out = run(annual_exclusion=19_000, donees=4)
    assert out["annual_exclusion"]["available"] == pytest.approx(76_000)


def test_a_split_gift_doubles_the_available_exclusion():
    # §2513 — treated as made half by each spouse.
    out = run(annual_exclusion=19_000, donees=2, split_gift=True)
    assert out["annual_exclusion"]["available"] == pytest.approx(76_000)
    assert out["annual_exclusion"]["split_gift"] is True


@pytest.mark.parametrize("kind", ["estate", "gst"])
def test_the_annual_exclusion_does_not_apply_to_an_estate_or_gst_transfer(kind):
    out = run(transfer_type=kind, annual_exclusion=19_000)
    assert out["annual_exclusion"]["applies"] is False
    assert out["annual_exclusion"]["applied"] == 0.0
    assert out["taxable_gift"] == pytest.approx(out["concluded_value"])


def test_the_exclusion_cannot_take_the_taxable_gift_below_zero():
    out = run(percent_interest=0.1, annual_exclusion=19_000)  # 10,000 interest
    assert out["taxable_gift"] == 0.0
    assert out["annual_exclusion"]["applied"] == pytest.approx(10_000)


def test_prior_gifts_accumulate_without_changing_this_year_s_gift():
    out = run(prior_taxable_gifts=500_000)
    assert out["taxable_gift"] == pytest.approx(2_500_000)
    assert out["cumulative_taxable_gifts"] == pytest.approx(3_000_000)


def test_an_unknown_transfer_type_is_refused():
    with pytest.raises(EngineInputError, match="transfer_type"):
        run(transfer_type="bequest")


# ── Rev. Rul. 59-60 §4.01 ────────────────────────────────────────────────────


def test_all_eight_factors_are_reported_with_none_addressed_by_default():
    out = run()
    factors = out["rev_rul_59_60"]
    assert factors["total_count"] == 8
    assert len(factors["factors"]) == 8
    assert factors["addressed_count"] == 0
    # An unaddressed factor is a finding, not a silence.
    assert len(factors["unaddressed"]) == 8


def test_addressed_factors_are_marked_and_removed_from_the_findings():
    addressed = ["earning_capacity", "book_value"]
    out = run(factors_addressed=addressed)
    factors = out["rev_rul_59_60"]
    assert factors["addressed_count"] == 2
    assert set(factors["unaddressed"]).isdisjoint(addressed)
    assert next(f for f in factors["factors"] if f["key"] == "book_value")["addressed"] is True


def test_every_named_factor_key_is_accepted():
    keys = [key for key, _label in REV_RUL_59_60_FACTORS]
    assert run(factors_addressed=keys)["rev_rul_59_60"]["unaddressed"] == []


def test_an_unknown_factor_key_is_refused_rather_than_ignored():
    with pytest.raises(EngineInputError, match="unknown factor"):
        run(factors_addressed=["vibes"])


# ── HTTP surface ─────────────────────────────────────────────────────────────


def test_endpoint_is_listed_and_computes(client: TestClient):
    assert "/engine/v1/gift-estate" in client.get("/").json()["endpoints"]
    res = client.post(
        "/engine/v1/gift-estate",
        json={
            "inputs": {
                "entity_value": 10_000_000,
                "percent_interest": 25,
                "transfer_date": "2026-04-15",
                "dloc": 0.2,
                "dlom": 0.3,
            }
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["concluded_value"] == pytest.approx(1_400_000)
    assert body["transfer_date"] == "2026-04-15"


def test_endpoint_maps_an_input_error_to_422(client: TestClient):
    res = client.post(
        "/engine/v1/gift-estate",
        json={"inputs": {"entity_value": 1_000, "percent_interest": 500}},
    )
    assert res.status_code == 422


def test_endpoint_unknown_input_name_is_422(client: TestClient):
    res = client.post(
        "/engine/v1/gift-estate",
        json={"inputs": {"entity_value": 1_000, "percent_interest": 10, "nonsense": 1}},
    )
    assert res.status_code == 422


def test_an_unsupplied_exclusion_is_reported_as_undetermined_not_as_nil():
    """The default is the unanswered question, not a nil determination.

    Nothing in the platform sent `annual_exclusion` until the questionnaire
    grew a field for it, so every gift ran with the default — and a default of
    0.0 is indistinguishable from an analyst who determined that none was
    available. The return line and the cumulative total both read as
    conclusions the file had not reached.
    """
    out = run()
    assert out["annual_exclusion"]["determined"] is False
    assert out["annual_exclusion"]["per_donee"] == 0.0
    assert out["annual_exclusion"]["available"] == 0.0
    assert out["annual_exclusion"]["applied"] == 0.0
    # The arithmetic is unchanged — only what it claims about itself.
    assert out["taxable_gift"] == pytest.approx(out["concluded_value"])


def test_a_supplied_exclusion_of_zero_is_a_determination():
    """A future-interest gift gets no exclusion, and saying so is an answer."""
    out = run(annual_exclusion=0)
    assert out["annual_exclusion"]["determined"] is True
    assert out["annual_exclusion"]["applied"] == 0.0


def test_a_supplied_exclusion_is_determined():
    out = run(annual_exclusion=19_000)
    assert out["annual_exclusion"]["determined"] is True


def test_an_undetermined_exclusion_still_refuses_a_bad_one():
    with pytest.raises(EngineInputError, match="gifts.annual_exclusion"):
        run(annual_exclusion=-1)


def test_an_unstated_factor_checklist_is_unstated_not_eight_refusals():
    """`None` and `[]` are the same eight "no"s and opposite statements.

    Nothing in the platform passed `factors_addressed`, so every gift exhibit
    printed the Rev. Rul. 59-60 checklist as "0 of 8" with a No against each
    factor — an appraisal reporting that it addressed none of the eight factors
    it is graded on.
    """
    out = run()["rev_rul_59_60"]
    assert out["stated"] is False
    assert out["addressed_count"] == 0
    assert len(out["unaddressed"]) == len(REV_RUL_59_60_FACTORS)


def test_an_empty_checklist_is_a_statement():
    out = run(factors_addressed=[])["rev_rul_59_60"]
    assert out["stated"] is True
    assert out["addressed_count"] == 0


def test_a_completed_checklist_is_stated():
    out = run(factors_addressed=["book_value", "earning_capacity"])["rev_rul_59_60"]
    assert out["stated"] is True
    assert out["addressed_count"] == 2
