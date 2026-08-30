"""The two cap-table model calls, checked against each other.

Round 216, methodology M5. `_normalize_class` (tested next door) is a gate on
one class at a time: it coerces every field, whitelists every attribute and
drops what the engine strictly requires and cannot get. What it cannot see is
the *set* — and the two failures that live there are the ones a language model
actually produces.

**A class returned twice.** The engine takes `share_classes` as given and sums
it. "Series A Preferred" repeated is 2,000,000 shares counted as 4,000,000: the
fully-diluted denominator every per-share figure divides by, doubled by a model
repeating itself. Nothing downstream can catch it, and the one check that might
— reconciling against `total_shares_stated` — is inert on the charters that do
not state a fully-diluted total, which is most of them. `reconciles` comes back
null and the run reads as clean.

**A class added or lost between the passes.** The structuring prompt says "do
not add classes that were not identified" and "keep every number identical", and
nothing checked either direction. An invented class inflates the same
denominator; an omitted one deflates it.

The agreement check is on counts rather than names deliberately: the two steps
legitimately re-spell a class, and an issue an analyst cannot act on is worse
than no issue at all.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.agents import _common
from app.main import app
from app.openrouter import LlmResult


@pytest.fixture
def client():
    return TestClient(app)


def seq_chat(responses, default_model="test/fake-model"):
    payloads = [r if isinstance(r, str) else json.dumps(r) for r in responses]

    def _chat(system, user, *, model=None, client=None):
        idx = len(_chat.calls)
        _chat.calls.append({"system": system, "user": user, "model": model})
        return LlmResult(model=model or default_model, content=payloads[min(idx, len(payloads) - 1)])

    _chat.calls = []
    return _chat


def run(monkeypatch, client, identify, structure):
    monkeypatch.setattr(_common, "chat", seq_chat([identify, structure]))
    resp = client.post("/ai/v1/pipelines/cap_table", json={"valuation": {"company_name": "Acme"}})
    assert resp.status_code == 200
    return resp.json()["result"]


def named(count: int) -> list[dict]:
    """A reading step that identified `count` classes, shape irrelevant here."""
    return [{"name": f"Class {i}", "kind": "common", "shares": 1} for i in range(count)]


COMMON = {"name": "Common Stock", "kind": "common", "shares": 6_000_000}
SERIES_A = {
    "name": "Series A Preferred",
    "kind": "preferred",
    "shares": 2_000_000,
    "preference": 4_000_000,
}


# ── a class returned twice ───────────────────────────────────────────────────


class TestADuplicateClass:
    @pytest.fixture
    def result(self, monkeypatch, client):
        return run(
            monkeypatch,
            client,
            {"classes": named(2)},
            {"share_classes": [COMMON, SERIES_A, dict(SERIES_A)]},
        )

    def test_the_duplicate_does_not_reach_the_engine_schema(self, result):
        assert [cl["name"] for cl in result["share_classes"]] == [
            "Common Stock",
            "Series A Preferred",
        ]

    def test_the_share_total_is_not_doubled(self, result):
        """The whole point: this number is the denominator of every per-share
        figure the valuation concludes."""
        assert result["validation"]["share_total_computed"] == 8_000_000

    def test_it_says_which_class_was_repeated_and_what_was_dropped(self, result):
        joined = " ".join(result["validation"]["issues"])
        assert "Series A Preferred" in joined
        assert "returned twice" in joined
        # The dropped entry's share count, so the analyst can tell a verbatim
        # repeat from two rows that disagree — and written the way a cap table
        # writes it, not as `2e+06`.
        assert "2,000,000 shares" in joined

    def test_the_class_count_is_what_survived(self, result):
        assert result["validation"]["class_count"] == 2


def test_the_same_name_under_a_different_kind_is_kept(monkeypatch, client):
    """An option pool named after the class it sits under is a real cap table.
    Deduplicating on the name alone would drop a class the documents contain."""
    result = run(
        monkeypatch,
        client,
        {"classes": named(2)},
        {
            "share_classes": [
                {"name": "Series A", "kind": "preferred", "shares": 2_000_000, "preference": 1},
                {"name": "Series A", "kind": "option", "shares": 500_000, "strike": 0.1},
            ]
        },
    )
    assert len(result["share_classes"]) == 2
    assert result["validation"]["share_total_computed"] == 2_500_000


def test_a_respelling_of_one_class_is_still_a_duplicate(monkeypatch, client):
    """Case and surrounding space are the model's, not the document's."""
    result = run(
        monkeypatch,
        client,
        {"classes": named(1)},
        {"share_classes": [COMMON, {**COMMON, "name": "  common stock "}]},
    )
    assert len(result["share_classes"]) == 1


# ── the two passes disagreeing about how many classes there are ──────────────


class TestTheStructuringStepAgreesWithTheReading:
    def test_an_invented_class_is_reported(self, monkeypatch, client):
        result = run(
            monkeypatch,
            client,
            {"classes": named(2)},
            {
                "share_classes": [
                    COMMON,
                    SERIES_A,
                    {"name": "Series B Preferred", "kind": "preferred", "shares": 1, "preference": 1},
                ]
            },
        )
        joined = " ".join(result["validation"]["issues"])
        assert "returned 3 classes from the 2" in joined
        assert "added" in joined

    def test_a_lost_class_is_reported(self, monkeypatch, client):
        result = run(monkeypatch, client, {"classes": named(3)}, {"share_classes": [COMMON, SERIES_A]})
        joined = " ".join(result["validation"]["issues"])
        assert "returned 2 classes from the 3" in joined
        assert "lost" in joined

    def test_agreement_says_nothing(self, monkeypatch, client):
        result = run(monkeypatch, client, {"classes": named(2)}, {"share_classes": [COMMON, SERIES_A]})
        assert result["validation"]["issues"] == []

    def test_the_count_is_what_the_model_returned_not_what_survived(self, monkeypatch, client):
        """Counted before this module's own drops, which already have issues of
        their own. Counting survivors would report a second time on a class the
        analyst has already been told about, and stay silent when the numbers
        happened to cancel."""
        result = run(
            monkeypatch,
            client,
            {"classes": named(2)},
            # Two returned, one unusable: the passes agree, and the drop is
            # reported by `_normalize_class`.
            {"share_classes": [COMMON, {"name": "Pool", "kind": "option", "shares": 10}]},
        )
        joined = " ".join(result["validation"]["issues"])
        assert "returned" not in joined
        assert "positive strike" in joined

    def test_a_reading_step_that_named_nothing_makes_no_claim(self, monkeypatch, client):
        """No count to compare against is not a disagreement."""
        result = run(monkeypatch, client, {"classes": []}, {"share_classes": [COMMON]})
        assert result["validation"]["issues"] == []

    def test_a_non_list_classes_field_does_not_become_a_count(self, monkeypatch, client):
        """A model answering off-contract with an object would otherwise have
        its keys counted and reconciled against nothing meaningful."""
        result = run(
            monkeypatch,
            client,
            {"classes": {"common": {"shares": 1}, "preferred": {"shares": 2}}},
            {"share_classes": [COMMON]},
        )
        assert result["validation"]["issues"] == []
        assert result["citations"] == []


# ── the figures the issues quote ─────────────────────────────────────────────


def test_a_reconciliation_failure_states_both_totals_legibly(monkeypatch, client):
    """`{:g}` renders every real share count as an exponent. An analyst asked to
    compare two numbers has to be able to read both of them."""
    result = run(
        monkeypatch,
        client,
        {"classes": named(1), "total_shares_stated": 10_000_000},
        {"share_classes": [COMMON]},
    )
    joined = " ".join(result["validation"]["issues"])
    assert "6,000,000" in joined and "10,000,000" in joined
    assert "e+0" not in joined


# ── the basis the stated total is on ─────────────────────────────────────────


class TestAConvertingClassAgainstAStatedTotal:
    """R229, methodology M2.

    The identify prompt asks for "the fully-diluted total the documents state",
    and a fully-diluted total is an as-converted one. `_validate` compared it
    against the raw sum of `shares`, so a charter that stated its own total
    correctly was reported as failing to reconcile the moment any class
    converted at other than 1:1 — a 2:1 ratio is 100% out and no tolerance
    reaches that.

    `domain/capTable.validateCapTable` already answers the same question about
    an uploaded sheet's totals row by accepting either basis, on the stated
    reasoning that a sheet is not asked to say which it meant. A charter is not
    asked either.
    """

    CONVERTING = {
        "name": "Series A Preferred",
        "kind": "preferred",
        "shares": 2_000_000,
        "preference": 4_000_000,
        "conversion_ratio": 2,
    }

    def run_with(self, monkeypatch, client, stated):
        return run(
            monkeypatch,
            client,
            {"classes": named(2), "total_shares_stated": stated},
            {"share_classes": [COMMON, self.CONVERTING]},
        )

    def test_the_as_converted_total_reconciles(self, monkeypatch, client):
        # 6,000,000 common + 2,000,000 x 2 = 10,000,000 fully diluted.
        v = self.run_with(monkeypatch, client, 10_000_000)["validation"]
        assert v["share_total_computed"] == 8_000_000
        assert v["share_total_as_converted"] == 10_000_000
        assert v["reconciles"] is True
        assert v["issues"] == []

    def test_the_unconverted_total_still_reconciles(self, monkeypatch, client):
        """The other basis a document may state, and the one that always
        worked. Accepting the new reading must not cost the old one."""
        v = self.run_with(monkeypatch, client, 8_000_000)["validation"]
        assert v["reconciles"] is True

    def test_a_total_on_neither_basis_is_still_a_mismatch(self, monkeypatch, client):
        v = self.run_with(monkeypatch, client, 15_000_000)["validation"]
        assert v["reconciles"] is False
        # Both figures in the message, so the analyst can see which basis the
        # documents were closer to rather than being handed one number.
        assert "8,000,000" in v["issues"][0]
        assert "10,000,000 as converted" in v["issues"][0]
