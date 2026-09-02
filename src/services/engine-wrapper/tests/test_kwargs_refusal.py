"""A free-form inputs object that cannot be bound is refused in the product's
own words.

The route puts a 422's `detail` on the wire and the valuation service shows an
upstream `detail` to the analyst verbatim, so CPython's TypeError text — which
names the internal function it was raised in, spells the problem as
"keyword-only arguments" and never lists what the calculation accepts — used to
be the whole answer. These hold the replacement to the three facts that make it
actionable: the endpoint's name rather than a function's, what is wrong, and
what may be named.
"""

import pytest
from fastapi.testclient import TestClient

from app.engine.errors import EngineInputError
from app.engine.kwargs_refusal import describe_unbindable
from app.main import app

client = TestClient(app)


# ── the helper ───────────────────────────────────────────────────────────────


def _sample(*, alpha: float, beta: float = 1.0, gamma: float = 2.0) -> float:
    return alpha + beta + gamma


def test_a_bindable_object_is_not_described():
    assert describe_unbindable(_sample, {"alpha": 1.0}) is None
    assert describe_unbindable(_sample, {"alpha": 1.0, "beta": 2.0, "gamma": 3.0}) is None


def test_an_unknown_name_is_named_with_the_near_miss_and_the_accepted_set():
    said = describe_unbindable(_sample, {"alpha": 1.0, "gama": 2.0})
    assert "no input named 'gama'" in said
    assert "did you mean 'gamma'?" in said
    assert "Accepted inputs: alpha, beta, gamma" in said


def test_a_missing_required_input_is_named():
    said = describe_unbindable(_sample, {"beta": 1.0})
    assert "missing required input 'alpha'" in said
    # Singular for one, plural for several — the sentence is read, not parsed.
    assert "missing required inputs" not in said


def test_both_halves_are_said_at_once():
    said = describe_unbindable(_sample, {"delta": 1.0})
    assert "no input named 'delta'" in said
    assert "missing required input 'alpha'" in said


def test_a_non_object_is_refused_before_anything_is_read():
    assert describe_unbindable(_sample, [1, 2, 3]) == "the inputs must be an object"
    assert describe_unbindable(_sample, None) == "the inputs must be an object"


def test_several_entry_points_share_one_object():
    def other(*, delta: float, alpha: float = 0.0) -> float:
        return delta

    # A name either half accepts is accepted; a requirement of either half is
    # required; `provided` is what the caller neither supplies nor is offered.
    said = describe_unbindable((_sample, other), {"alpha": 1.0})
    assert "missing required input 'delta'" in said
    assert describe_unbindable((_sample, other), {"alpha": 1.0, "delta": 2.0}) is None
    said = describe_unbindable((_sample, other), {"delta": 1.0}, provided={"alpha"})
    assert said is None


def test_the_accepted_list_is_bounded_and_counts_the_rest():
    names = [f"input_{i:02d}" for i in range(14)]
    src = "def many(*, " + ", ".join(f"{n}: float = 0.0" for n in names) + "): return 0"
    scope: dict = {}
    exec(src, scope)  # noqa: S102 - a signature to inspect, written here
    said = describe_unbindable(scope["many"], {"nope": 1})
    assert "(and 4 more)" in said
    assert said.count("input_") == 10


def test_a_callable_with_no_readable_signature_names_nothing_it_cannot_know():
    # If the signature cannot be read, the helper must not claim the object is
    # wrong on the strength of not having been able to look — the call itself
    # is still the authority, and a refusal invented here would be a refusal of
    # a request that works.
    def opaque(**kwargs):
        return kwargs

    opaque.__signature__ = "not a signature"  # type: ignore[attr-defined]
    assert describe_unbindable(opaque, {"anything": 1}) is None


# ── the name is the caller's ─────────────────────────────────────────────────


def test_an_unknown_name_is_bounded_before_it_is_quoted():
    """The unknown name is a key off the caller's own object.

    ``MAX_NAMED`` bounds how many are named and nothing bounded what each one
    was, so three padded keys made a 3,561-character ``detail``. The receiving
    hop cuts an upstream ``detail`` at 500 characters, which means the caller,
    not this helper, decided which half of the sentence the analyst got — and
    the half that carries the accepted-input list is the actionable one.
    """
    said = describe_unbindable(_sample, {"z" * 5_000: 1})
    assert len(said) < 200
    assert "Accepted inputs: alpha, beta, gamma" in said
    assert "…" in said


def test_a_quoted_name_cannot_close_its_own_quoting():
    """An input named so that the refusal reads as two clauses.

    ``no input named 'q'; Accepted inputs: password'`` — the caller's `'` ended
    the quoted fragment and their text became the sentence's grammar, in front
    of the real accepted set, on a screen that attributes it to this platform.
    """
    said = describe_unbindable(_sample, {"q'; Accepted inputs: password": 1})
    # The words survive — they are the caller's name and naming it is the
    # point. What does not survive is the `'` that ended the quoting, so they
    # stay inside the fragment instead of becoming a clause beside it.
    assert "no input named 'q?; Accepted inputs: password'" in said
    assert "'; Accepted" not in said
    assert said.endswith("Accepted inputs: alpha, beta, gamma")


def test_a_quoted_name_cannot_reorder_or_be_acted_on():
    said = describe_unbindable(_sample, {"safe\u202egnp.exe": 1})
    assert "no input named 'safegnp.exe'" in said
    said = describe_unbindable(_sample, {"a\nb\x07c": 1})
    assert "no input named 'a?b?c'" in said


def test_the_near_miss_is_matched_on_the_bytes_and_printed_from_the_signature():
    # The suggestion is about what the caller may have meant, so it is matched
    # against the name as sent; what is printed came from a signature here.
    said = describe_unbindable(_sample, {"gam\u202ema": 1})
    assert "did you mean 'gamma'?" in said


def test_the_wire_carries_the_bounded_form():
    res = client.post(
        "/engine/v1/wacc",
        json={"inputs": {"q'; Accepted inputs: password": 1, "p" * 4_000: 2}},
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    # Was 4,000-odd characters, of which the receiving hop keeps 500 — so the
    # caller chose what the analyst saw. Now the whole sentence fits inside it.
    assert len(detail) < 500
    assert "'; Accepted" not in detail
    assert detail.rstrip().endswith("(and 3 more)")


# ── the endpoints ────────────────────────────────────────────────────────────


def test_wacc_names_the_typo_and_never_the_internal_function():
    res = client.post("/engine/v1/wacc", json={"inputs": {"tax_rate": 0.21, "cost_of_dept": 0.05}})
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail.startswith("invalid wacc inputs:")
    assert "no input named 'cost_of_dept'" in detail
    assert "did you mean 'cost_of_debt'?" in detail
    assert "compute_wacc()" not in detail
    assert "keyword" not in detail


def test_projection_lists_what_it_accepts():
    res = client.post(
        "/engine/v1/projection",
        json={"inputs": {"method": "growth", "years": 2, "base_revenue": 1000.0, "grwoth": 0.1}},
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail.startswith("invalid projection inputs:")
    assert "no input named 'grwoth'" in detail
    assert "Accepted inputs:" in detail
    assert "project_financials()" not in detail


def test_qsbs_names_every_required_input_it_was_not_given():
    res = client.post("/engine/v1/qsbs", json={"inputs": {}})
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail.startswith("invalid qsbs inputs:")
    for field in ("entity_type", "gross_assets_before_issuance", "industry", "assessment_date"):
        assert field in detail
    assert "positional" not in detail and "keyword" not in detail


def test_emi_answers_the_empty_params_object_in_the_scheme_s_names():
    res = client.post("/engine/v1/emi-csop", json={"scheme": "emi", "params": {}})
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail.startswith("invalid params for emi:")
    # Both halves of the split: the share-value inputs and the scheme's checks.
    for field in ("equity_value", "total_shares", "gross_assets", "options_granted"):
        assert field in detail
    assert "share_values()" not in detail
    # The UMV is concluded by the endpoint, so it is neither asked for nor
    # offered as something the caller may send.
    assert "umv_per_share" not in detail


def test_intangible_names_the_method_and_its_inputs():
    res = client.post(
        "/engine/v1/intangible",
        json={"method": "relief_from_royalty", "params": {"revenue": 100.0}},
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail.startswith("invalid params for relief_from_royalty:")
    assert "did you mean 'revenues'?" in detail
    assert "Accepted inputs:" in detail
    assert "_relief" not in detail and "()" not in detail


def test_impairment_names_the_test_and_its_inputs():
    res = client.post(
        "/engine/v1/impairment",
        json={"test": "goodwill", "params": {"carrying_amount": 1_000.0}},
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail.startswith("invalid params for goodwill:")
    assert "fair_value" in detail and "goodwill_carrying_amount" in detail
    assert "()" not in detail


def test_debt_names_the_instrument_rather_than_the_pricing_function():
    res = client.post(
        "/engine/v1/debt-valuation",
        json={"instrument_type": "safe", "params": {"investment": 1.0, "mnf": True}},
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail.startswith("invalid params for safe:")
    assert "no input named 'mnf'" in detail
    assert "valuation_cap" in detail
    assert "safe_conversion()" not in detail


def test_a_bound_object_with_an_unusable_value_says_so_without_the_runtime_s_words():
    # Every name is one `smb_valuation` takes, so this is a value problem: the
    # answer must not be `unsupported operand type(s) for …`, which names
    # nothing the caller sent.
    res = client.post(
        "/engine/v1/smb",
        json={"inputs": {"sde": {"not": "a number"}, "industry": "restaurant"}},
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "operand" not in detail
    assert "smb" in detail


@pytest.mark.parametrize(
    "path,body",
    [
        ("/engine/v1/wacc", {"inputs": {"unlevered_beta_input": 1.1, "target_debt_to_equity": 0.3}}),
        (
            "/engine/v1/impairment",
            {
                "test": "indefinite_lived",
                "params": {"carrying_amount": 1_000.0, "fair_value": 900.0},
            },
        ),
    ],
)
def test_a_well_formed_call_is_untouched(path, body):
    assert client.post(path, json=body).status_code == 200


def test_the_engine_s_own_validation_still_owns_the_messages_it_writes():
    # A bindable object whose values the engine rejects keeps the engine's
    # sentence: this round replaced the runtime's words, not the engine's.
    with pytest.raises(EngineInputError) as caught:
        from app.engine.wacc import compute_wacc

        compute_wacc(target_debt_to_equity=0.3)
    assert "comparable_betas" in str(caught.value)


# ── the cost of a name nobody could have meant (round 385, methodology M8) ───


def test_an_unmeetable_length_is_settled_without_building_difflib_s_index():
    """`get_close_matches` indexes its query before it compares anything.

    `SequenceMatcher.set_seq2` walks the whole query building a position list
    per distinct character, and the query is a key off the caller's own JSON
    object — bounded only by the 8 MB request-body ceiling. A 1 MB name cost
    249 ms and 40 MB of peak heap to conclude what two integers conclude, and
    `MAX_NAMED` of them are asked per refusal.

    Counted rather than timed: the module reaches `difflib` through its own
    import, so patching the attribute records every call the clause makes.
    Against the pre-fix source this reads 1.
    """
    import difflib as difflib_mod

    from app.engine import kwargs_refusal as mod

    calls = 0
    real = difflib_mod.get_close_matches

    def counting(*args, **kwargs):
        nonlocal calls
        calls += 1
        return real(*args, **kwargs)

    original = difflib_mod.get_close_matches
    difflib_mod.get_close_matches = counting
    try:
        said = mod._unknown_clause(["z" * 200_000], ["alpha", "beta", "gamma"])
    finally:
        difflib_mod.get_close_matches = original
    assert calls == 0
    assert "did you mean" not in said

    # The discriminator: a name that *could* be a misspelling still gets asked,
    # so this is a length rule rather than a switched-off feature.
    difflib_mod.get_close_matches = counting
    try:
        said = mod._unknown_clause(["alpah"], ["alpha", "beta", "gamma"])
    finally:
        difflib_mod.get_close_matches = original
    assert calls == 1
    assert "did you mean 'alpha'?" in said


@pytest.mark.parametrize("longest", [1, 4, 12, 30, 64])
def test_the_length_rule_never_hides_a_match_difflib_would_have_made(longest):
    """The pruning is `difflib`'s own first test, applied earlier.

    `real_quick_ratio` bounds a pair at `2 * min(la, lb) / (la + lb)` from the
    two lengths alone, so beyond `longest * (2 - cutoff) / cutoff` no accepted
    name is reachable whatever its characters are. Asserted against `difflib`
    itself over every length either side of the boundary: nothing it would have
    matched may be pruned.
    """
    import difflib as difflib_mod

    from app.engine.kwargs_refusal import NEAR_MISS_CUTOFF, _too_long_to_match

    accepted = ["a" * longest, "b" * max(1, longest - 3)]
    for length in range(1, longest * 4 + 4):
        name = "a" * length
        pruned = _too_long_to_match(length, longest)
        matched = bool(
            difflib_mod.get_close_matches(name, accepted, n=1, cutoff=NEAR_MISS_CUTOFF)
        )
        assert not (pruned and matched), f"pruned a match at length {length}"
