"""The pre-IPO empirical DLOM family (Emory, Willamette).

The engine's only empirical leg was the restricted-stock table, whose
defensible default set is a single post-1997 study — which the engine itself
flags as `thin_study_set`. A DLOM opinion resting on one study is exactly what
the `dlom_methods` blend was built to avoid, and the second family the
literature offers is the pre-IPO studies.

They are added as a *separate method*, not as more rows in
`RESTRICTED_STOCK_STUDIES`, and most of what is tested here is that separation:
these discounts run roughly twice the restricted-stock ones for reasons that
are partly measurement rather than marketability, so an engine that let the two
average silently would be worse than one that only had the first.
"""

import pytest

from app.engine.compute import compute
from app.engine.dlom import (
    DEFAULT_PRE_IPO_SET,
    DLOM_METHODS,
    PRE_IPO_RECENCY_YEAR,
    PRE_IPO_STUDIES,
    STUDY_DLOM_METHODS,
    pre_ipo_dlom,
    restricted_stock_dlom,
)
from app.engine.errors import EngineInputError
from app.engine.validate import ERROR, WARNING, validate_payload


class TestTheTable:
    def test_every_row_is_a_fraction(self):
        for row in PRE_IPO_STUDIES:
            assert 0.0 < row["discount"] < 1.0, row["study"]

    def test_every_row_carries_its_observation_window(self):
        """The window is what makes a row reviewable, and what the recency
        caveat is keyed on."""
        for row in PRE_IPO_STUDIES:
            assert isinstance(row["period_start"], int), row["study"]
            assert row["period_end"] >= row["period_start"], row["study"]

    def test_every_row_says_whether_it_published_a_median_or_a_mean(self):
        for row in PRE_IPO_STUDIES:
            assert row["statistic"] in ("median", "mean"), row["study"]

    def test_study_names_are_unique(self):
        names = [row["study"] for row in PRE_IPO_STUDIES]
        assert len(names) == len(set(names))

    def test_both_study_families_are_represented(self):
        names = " ".join(row["study"] for row in PRE_IPO_STUDIES)
        assert "Emory" in names
        assert "Willamette" in names

    def test_the_default_set_names_rows_that_exist(self):
        known = {row["study"] for row in PRE_IPO_STUDIES}
        assert set(DEFAULT_PRE_IPO_SET) <= known

    def test_the_default_set_is_not_thin(self):
        """The restricted-stock default is one study wide and says so. This
        family has enough published windows that its default need not be."""
        assert pre_ipo_dlom()["thin_study_set"] is False

    def test_the_default_set_is_recent(self):
        """A 1980-1981 discount is weak evidence about a company valued today.
        Emory's combined figure is the deliberate exception — it is the whole
        series rather than a window someone chose."""
        by_name = {row["study"]: row for row in PRE_IPO_STUDIES}
        windows = [by_name[n] for n in DEFAULT_PRE_IPO_SET]
        assert all(
            w["period_end"] >= PRE_IPO_RECENCY_YEAR for w in windows
        ), "a default window should not end before the modern IPO market"


class TestTheBlend:
    def test_the_default_concludes_on_the_median_of_its_set(self):
        got = pre_ipo_dlom()
        assert got["method"] == "pre_ipo"
        assert 0.30 < got["dlom"] < 0.60
        assert got["study_count"] == len(DEFAULT_PRE_IPO_SET)

    def test_the_mean_is_available_too(self):
        assert pre_ipo_dlom(statistic="mean")["dlom"] != pre_ipo_dlom()["dlom"]

    def test_an_unknown_statistic_is_refused(self):
        with pytest.raises(EngineInputError, match="median.*mean"):
            pre_ipo_dlom(statistic="mode")

    def test_a_named_selection_is_honoured(self):
        got = pre_ipo_dlom(selected=["Emory 1980-2000 (combined)"])
        assert got["study_count"] == 1
        assert got["dlom"] == pytest.approx(0.46)
        assert got["thin_study_set"] is True

    def test_an_unknown_study_names_the_family_it_looked_in(self):
        """The restricted-stock names are unknown *here*, which is the mistake
        a caller makes first once there are two tables."""
        with pytest.raises(EngineInputError, match="unknown pre-IPO studies"):
            pre_ipo_dlom(selected=["Silber"])

    def test_a_caller_supplied_table_replaces_the_built_ins(self):
        """A firm with its own pre-IPO data, same as the restricted-stock path."""
        got = pre_ipo_dlom(
            studies=[{"study": "House study 2024", "discount": 0.38, "period_start": 2020}],
        )
        assert got["dlom"] == pytest.approx(0.38)
        assert got["studies"][0]["study"] == "House study 2024"

    def test_a_malformed_supplied_row_is_refused(self):
        with pytest.raises(EngineInputError):
            pre_ipo_dlom(studies=[{"study": "Bad", "discount": 1.4}])

    def test_the_set_travels_with_the_answer(self):
        """The whole objection to a study DLOM is set selection, so the number
        is not reviewable without the rows behind it."""
        got = pre_ipo_dlom()
        assert [r["study"] for r in got["studies"]] == list(DEFAULT_PRE_IPO_SET)
        assert got["low"] <= got["dlom"] <= got["high"]


class TestTheCaveats:
    def test_the_selection_bias_is_always_stated(self):
        """Not conditional on the set. It is a property of how the family is
        measured, and a report quoting 47% without it gets sent back."""
        assert "IPO" in pre_ipo_dlom()["selection_bias"]

    def test_a_dated_window_is_flagged(self):
        got = pre_ipo_dlom(selected=["Emory 1980-1981", "Willamette 1975-1978"])
        assert got["predates_modern_ipo_market"] is True

    def test_the_default_set_is_not_flagged(self):
        """Emory's combined series *opens* in 1980 and closes in 2000. Keying
        the caveat on the opening year would flag the default set — putting a
        permanent warning on the engine's own recommendation, which trains
        readers to ignore it. Recency is a question about when the observing
        stopped."""
        assert pre_ipo_dlom()["predates_modern_ipo_market"] is False

    def test_the_recency_key_is_the_opposite_of_the_rule_144_key(self):
        """The two caveats read the same field from opposite ends on purpose:
        `is_post_amendment` asks which security was observed (the start),
        recency asks how stale the evidence is (the end). A single window
        spanning the boundary is what tells them apart."""
        long_series = pre_ipo_dlom(selected=["Emory 1980-2000 (combined)"])
        assert long_series["predates_modern_ipo_market"] is False
        early_only = pre_ipo_dlom(selected=["Emory 1980-1981"])
        assert early_only["predates_modern_ipo_market"] is True

    def test_a_purely_recent_selection_is_clean(self):
        got = pre_ipo_dlom(selected=["Emory 1997-2000", "Willamette 1997"])
        assert got["predates_modern_ipo_market"] is False


class TestTheTwoFamiliesStayApart:
    def test_pre_ipo_discounts_are_roughly_twice_restricted_stock(self):
        """The reason they are not one table. If this ever stops holding, the
        separation needs re-arguing rather than quietly keeping."""
        assert pre_ipo_dlom()["dlom"] > 2 * restricted_stock_dlom()["dlom"]

    def test_neither_default_set_can_reach_the_other_table(self):
        rs_names = {r["study"] for r in restricted_stock_dlom()["studies"]}
        pre_names = {r["study"] for r in pre_ipo_dlom()["studies"]}
        assert not (rs_names & pre_names)

    def test_both_are_study_methods(self):
        assert STUDY_DLOM_METHODS == {"restricted_stock", "pre_ipo"}
        assert STUDY_DLOM_METHODS <= DLOM_METHODS

    def test_they_report_the_same_shape(self):
        """A blend reads both legs' working, so a field one has and the other
        lacks is a hole in the exhibit."""
        shared = {"method", "dlom", "statistic", "studies", "study_count", "low", "high",
                  "thin_study_set"}
        assert shared <= set(restricted_stock_dlom())
        assert shared <= set(pre_ipo_dlom())

    def test_a_pre_ipo_row_is_not_in_the_restricted_stock_table(self):
        with pytest.raises(EngineInputError, match="unknown restricted-stock studies"):
            restricted_stock_dlom(selected=["Emory 1997-2000"])


# ── through /compute ─────────────────────────────────────────────────────────

PARAMS = {
    "weight_asset": 0.0,
    "weight_opm": 1.0,
    "weight_income": 0.0,
    "weight_market": 0.0,
    "exit_timeline": "2030-06-30",
    "allocation_method": "opm",
}

INPUTS = {
    "valuation_date": "2026-06-30",
    "shares_outstanding_common": 7_000_000,
    "options_outstanding": 1_000_000,
    "shares_outstanding_preferred": 2_000_000,
    "liquidation_preference": 5_000_000,
    "volatility": 0.6,
    "risk_free_rate": 0.042,
    "last_round_post_money": 20_000_000,
}


def run(**param_overrides):
    return compute({**PARAMS, **param_overrides}, dict(INPUTS))["results"]


class TestThroughCompute:
    def test_the_method_reaches_the_result(self):
        got = run(dlom_method="pre_ipo")["discounts"]
        assert got["dlom_method"] == "pre_ipo"
        assert got["dlom"] == pytest.approx(pre_ipo_dlom()["dlom"])

    def test_the_working_travels_with_it(self):
        detail = run(dlom_method="pre_ipo")["discounts"]["dlom_detail"]
        assert detail["study_count"] == len(DEFAULT_PRE_IPO_SET)
        assert "selection_bias" in detail

    def test_a_selection_is_honoured_through_its_own_key(self):
        detail = run(
            dlom_method="pre_ipo", dlom_pre_ipo_studies=["Emory 1980-2000 (combined)"]
        )["discounts"]["dlom_detail"]
        assert detail["study_count"] == 1

    def test_the_restricted_stock_key_does_not_reach_it(self):
        """`dlom_studies` addresses the other table. The two share no names, so
        one key could not address both — and a pre-IPO run must ignore it
        rather than fail on it."""
        detail = run(dlom_method="pre_ipo", dlom_studies=["Johnson"])["discounts"]["dlom_detail"]
        assert [r["study"] for r in detail["studies"]] == list(DEFAULT_PRE_IPO_SET)

    def test_a_caller_supplied_table_reaches_it(self):
        detail = run(
            dlom_method="pre_ipo",
            dlom_pre_ipo_table=[{"study": "House 2025", "discount": 0.4, "period_start": 2022}],
        )["discounts"]["dlom_detail"]
        assert detail["studies"][0]["study"] == "House 2025"

    def test_an_unknown_selection_is_a_422(self):
        with pytest.raises(EngineInputError, match="unknown pre-IPO studies"):
            run(dlom_method="pre_ipo", dlom_pre_ipo_studies=["Nope"])

    def test_it_needs_no_volatility(self):
        """A lookup, not a model — so it must not be swept into the set that
        demands one."""
        inputs = {k: v for k, v in INPUTS.items() if k != "volatility"}
        inputs.pop("liquidation_preference")
        inputs.pop("shares_outstanding_preferred")
        got = compute({**PARAMS, "dlom_method": "pre_ipo"}, inputs)["results"]
        assert got["discounts"]["dlom"] > 0


class TestBlendingTheFamilies:
    """The supported way to use both: explicit weights, both legs shown."""

    BLEND = [
        {"method": "restricted_stock", "weight": 0.5},
        {"method": "pre_ipo", "weight": 0.5},
    ]

    def test_a_blend_sits_between_the_two(self):
        got = run(dlom_methods=self.BLEND)["discounts"]
        assert restricted_stock_dlom()["dlom"] < got["dlom"] < pre_ipo_dlom()["dlom"]

    def test_each_leg_reports_its_own_set(self):
        components = run(dlom_methods=self.BLEND)["discounts"]["dlom_detail"]["components"]
        legs = {c["method"]: c for c in components}
        assert legs["pre_ipo"]["detail"]["study_count"] == len(DEFAULT_PRE_IPO_SET)
        assert "straddles_rule_144_amendment" in legs["restricted_stock"]["detail"]
        assert "selection_bias" in legs["pre_ipo"]["detail"]

    def test_the_weights_are_the_conclusion(self):
        got = run(dlom_methods=self.BLEND)["discounts"]["dlom"]
        expected = 0.5 * restricted_stock_dlom()["dlom"] + 0.5 * pre_ipo_dlom()["dlom"]
        assert got == pytest.approx(round(expected, 4), abs=1e-4)


class TestThePreFlight:
    def test_a_pre_ipo_run_validates(self):
        issues = validate_payload({**PARAMS, "dlom_method": "pre_ipo"}, dict(INPUTS))
        assert not any(i.severity == ERROR for i in issues)

    def test_the_selection_bias_is_surfaced_at_save_time(self):
        issues = validate_payload({**PARAMS, "dlom_method": "pre_ipo"}, dict(INPUTS))
        assert any(
            i.code == "pre_ipo_selection_bias" and i.severity == WARNING for i in issues
        )

    def test_an_unknown_study_is_an_error(self):
        issues = validate_payload(
            {**PARAMS, "dlom_method": "pre_ipo", "dlom_pre_ipo_studies": ["Nope"]},
            dict(INPUTS),
        )
        assert any(
            i.field == "params.dlom_pre_ipo_studies" and i.severity == ERROR for i in issues
        )

    def test_a_dated_window_is_a_warning(self):
        issues = validate_payload(
            {
                **PARAMS,
                "dlom_method": "pre_ipo",
                "dlom_pre_ipo_studies": ["Emory 1980-1981"],
            },
            dict(INPUTS),
        )
        assert any(i.code == "dated_study_window" and i.severity == WARNING for i in issues)

    def test_an_empty_selection_is_an_error(self):
        issues = validate_payload(
            {**PARAMS, "dlom_method": "pre_ipo", "dlom_pre_ipo_studies": []}, dict(INPUTS)
        )
        assert any(
            i.field == "params.dlom_pre_ipo_studies" and i.severity == ERROR for i in issues
        )

    def test_a_blend_leg_is_checked_too(self):
        issues = validate_payload(
            {
                **PARAMS,
                "dlom_methods": [
                    {"method": "pre_ipo", "weight": 0.5},
                    {"method": "finnerty", "weight": 0.5},
                ],
                "dlom_pre_ipo_studies": ["Nope"],
            },
            dict(INPUTS),
        )
        assert any(
            i.field == "params.dlom_pre_ipo_studies" and i.severity == ERROR for i in issues
        )

    def test_a_restricted_stock_run_draws_no_pre_ipo_caveat(self):
        issues = validate_payload({**PARAMS, "dlom_method": "restricted_stock"}, dict(INPUTS))
        assert not any(i.code == "pre_ipo_selection_bias" for i in issues)
