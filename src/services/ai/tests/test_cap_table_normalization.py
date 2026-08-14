"""`_normalize_class`: the deterministic gate between the model and the engine.

Step 3 of the cap-table agent is the only thing standing between a model's
reading of a charter and the waterfall's `share_classes`. Every field is
coerced or dropped here, and what it cannot establish it has to say out loud —
the `issues` list is what reaches the analyst as `validation.issues`.
"""

from app.agents.cap_table import _normalize_class


def _preferred(**overrides) -> dict:
    base = {"name": "Series A Preferred", "kind": "preferred", "shares": 2_000_000}
    return {**base, **overrides}


# ── what gets dropped, and what it says on the way out ───────────────────────


def test_a_non_object_class_is_dropped():
    cls, issues = _normalize_class("Series A")
    assert cls is None
    assert issues == ["dropped a non-object share class"]


def test_a_class_with_no_name_is_dropped():
    cls, issues = _normalize_class({"kind": "common", "shares": 100})
    assert cls is None
    assert issues == ["dropped a share class with no name"]


def test_an_unrecognised_kind_is_dropped_rather_than_guessed():
    cls, issues = _normalize_class({"name": "Warrants B", "kind": "derivative", "shares": 100})
    assert cls is None
    assert "unrecognised kind" in issues[0] and "Warrants B" in issues[0]


def test_a_class_with_no_share_count_is_dropped():
    cls, issues = _normalize_class({"name": "Series A", "kind": "preferred", "shares": 0})
    assert cls is None
    assert "non-positive share count" in issues[0]


def test_an_option_without_a_strike_is_dropped():
    cls, issues = _normalize_class({"name": "2019 Pool", "kind": "option", "shares": 500_000})
    assert cls is None
    assert "positive strike" in issues[0]


# ── the spellings the model actually uses ────────────────────────────────────


def test_the_kind_aliases_the_model_tends_to_emit():
    for raw, canonical in [
        ("Common Stock", "common"),
        ("ordinary shares", "common"),
        ("Preferred Stock", "preferred"),
        ("Series A", "preferred"),
        ("Warrant", "option"),
        ("ESOP", "option"),
    ]:
        cls, _ = _normalize_class({"name": "X", "kind": raw, "shares": 100, "strike": 1.0})
        assert cls is not None and cls["kind"] == canonical, raw


# ── the liquidation preference ───────────────────────────────────────────────


def test_the_preference_is_read_from_either_key():
    cls, issues = _normalize_class(_preferred(liquidation_preference=5_000_000))
    assert cls["preference"] == 5_000_000
    assert issues == []


def test_a_missing_preference_defaults_to_zero_and_says_so():
    cls, issues = _normalize_class(_preferred())
    assert cls["preference"] == 0.0
    assert "no liquidation preference found, defaulted to 0" in issues[0]


# ── the participation cap, which the waterfall prices ────────────────────────
# `participation_cap is None` is what makes a participating class uncapped
# (waterfall.capped_drawing), so None is an assertion rather than an absence.


def test_an_explicit_cap_is_kept():
    cls, issues = _normalize_class(
        _preferred(preference=5_000_000, participating=True, participation_cap=15_000_000)
    )
    assert cls["participation_cap"] == 15_000_000
    assert issues == []


def test_uncapped_participation_is_recorded_as_uncapped():
    cls, issues = _normalize_class(
        _preferred(preference=5_000_000, participating=True, participation="uncapped")
    )
    assert "participation_cap" in cls and cls["participation_cap"] is None
    assert issues == []


def test_capped_participation_with_no_number_is_flagged_not_called_uncapped():
    # The reading pass is explicitly allowed to emit this pair — the prompt asks
    # for `"participation": "capped|uncapped|none|null"` alongside a
    # `participation_cap` that may be null — and a term sheet naming a cap the
    # model cannot resolve to a figure lands here. Recording None said
    # "uncapped" to the waterfall, which is the one reading the document had
    # ruled out: the class then drew its full share of the upside with no
    # ceiling, taking proceeds that belong to common.
    cls, issues = _normalize_class(
        _preferred(preference=5_000_000, participating=True, participation="capped")
    )
    assert "participation_cap" not in cls
    assert any("capped but no cap amount was read" in i for i in issues)


def test_a_class_the_document_says_does_not_participate_carries_no_cap():
    cls, issues = _normalize_class(
        _preferred(preference=5_000_000, participating=False, participation="none")
    )
    assert "participation_cap" not in cls
    assert cls["participating"] is False
    assert issues == []


def test_participation_is_read_from_either_spelling():
    cls, _ = _normalize_class(_preferred(preference=1.0, is_participating=True))
    assert cls["participating"] is True
