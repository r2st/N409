"""PII anonymization tests — redaction must never eat financial figures."""

import base64

import pytest

from app import pipelines
from app.anonymize import (
    MAX_KNOWN_ENTITIES,
    AnonymizeInputError,
    Redactor,
    _entity_pattern,
    redact,
)
from app.openrouter import LlmResult


def test_redacts_emails_phones_ssn_ein():
    text = (
        "Contact founder@acme.io or call (415) 555-0143 / +1 415-555-0100. "
        "SSN 123-45-6789, EIN 12-3456789."
    )
    redacted, counts = redact(text)
    assert "[EMAIL]" in redacted and "founder@acme.io" not in redacted
    assert redacted.count("[PHONE]") == 2
    assert "[SSN]" in redacted and "123-45-6789" not in redacted
    assert "[EIN]" in redacted and "12-3456789" not in redacted
    assert counts == {"emails": 1, "ssns": 1, "eins": 1, "phones": 2}


def test_financial_figures_survive():
    text = "10000000 common shares, $1,500,000 preference, post-money 20000000.00, 4155550143"
    redacted, counts = redact(text)
    assert redacted == text
    assert counts == {}


def _doc(text: str) -> dict:
    return {
        "id": "d1",
        "filename": "notes.txt",
        "kind": "other",
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


def _mock_chat(monkeypatch, captured: dict):
    def fake_chat(system, user, *, model=None, client=None):
        captured["system"], captured["user"], captured["model"] = system, user, model
        return LlmResult(model="test/model", content='{"gaps": [], "notes": "ok"}')

    monkeypatch.setattr(pipelines, "chat", fake_chat)


def test_pipeline_redacts_corpus_and_reports_counts(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    payload = {"valuation": {"company_name": "Acme"}, "documents": [_doc("email founder@acme.io")]}
    _, result = pipelines.run_missing_data(payload)
    assert "founder@acme.io" not in captured["user"]
    assert result["anonymization"] == {
        "applied": True,
        "redacted": {"emails": 1},
        # The subject company is always declared; a pipeline payload declares
        # people only since round 233.
        "declared": {"companies": 1, "people": 0},
        "enforced": False,
    }


def test_anonymize_can_be_disabled(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    payload = {
        "valuation": {"company_name": "Acme"},
        "documents": [_doc("email founder@acme.io")],
        "options": {"anonymize": False},
    }
    _, result = pipelines.run_missing_data(payload)
    assert "founder@acme.io" in captured["user"]
    assert result["anonymization"] == {"applied": False, "redacted": {}}


# ── Named-entity redaction (audit B-1 P1) ────────────────────────────────────


def test_redacts_company_and_person_names():
    text = "Acme Robotics Inc raised a round. Prepared by: Ada Lovelace. Dr. Grace Hopper signed."
    redacted, counts = redact(
        text, company_names=["Acme Robotics Inc"], person_names=["Ada Lovelace"]
    )
    assert "Acme Robotics" not in redacted
    assert "[COMPANY]" in redacted
    # "Ada Lovelace" struck both as a known person and via the "Prepared by:" rule.
    assert "Ada Lovelace" not in redacted
    assert "Grace Hopper" not in redacted  # honorific-led name pattern
    assert counts.get("companies", 0) >= 1
    assert counts.get("names", 0) >= 1


def test_redacts_street_and_city_state_zip_addresses():
    text = "Offices at 123 Sand Hill Road and mail to San Mateo, CA 94402."
    redacted, counts = redact(text)
    assert "Sand Hill Road" not in redacted
    assert "94402" not in redacted
    assert counts.get("addresses", 0) == 2


def test_entity_redaction_still_spares_financial_figures():
    text = "Acme shares 10000000 outstanding, post-money 20000000.00, zip-like 94402 alone"
    redacted, counts = redact(text, company_names=["Acme"])
    assert "10000000" in redacted and "20000000.00" in redacted
    # A bare 5-digit number with no City, ST context is not an address.
    assert "94402" in redacted
    assert "addresses" not in counts
    assert redacted.count("[COMPANY]") == 1


def test_company_name_redacted_through_pipeline(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    payload = {
        "valuation": {"company_name": "Zephyr Dynamics"},
        "documents": [_doc("Zephyr Dynamics is a robotics startup.")],
    }
    _, result = pipelines.run_missing_data(payload)
    # The document body's mention of the company is struck; the deliberate
    # "Company: …" prompt header is out of scope (the model needs that context).
    assert "[COMPANY] is a robotics startup" in captured["user"]
    assert result["anonymization"]["redacted"].get("companies") == 1


def test_production_ignores_anonymize_false(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    monkeypatch.setenv("APP_ENV", "production")
    payload = {
        "valuation": {"company_name": "Acme"},
        "documents": [_doc("email founder@acme.io")],
        "options": {"anonymize": False},  # must be ignored in production
    }
    _, result = pipelines.run_missing_data(payload)
    assert "founder@acme.io" not in captured["user"]
    assert result["anonymization"]["applied"] is True
    assert result["anonymization"]["enforced"] is True


def test_anonymize_enforce_env_toggle(monkeypatch):
    from app.anonymize import anonymization_enforced

    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("ANONYMIZE_ENFORCE", raising=False)
    assert anonymization_enforced() is False
    monkeypatch.setenv("ANONYMIZE_ENFORCE", "1")
    assert anonymization_enforced() is True


# ── Entity names that don't start or end on a word character ─────────────────
#
# `\b{escaped}\b` only holds where the adjacent character of the entity is
# word-ish. A legal entity name almost always ends in punctuation — "Acme, Inc.",
# "Widgets Ltd.", "Acme (US)" — and for those the trailing `\b` could never
# match, so the single most identifying field on a 409A went to the external
# model untouched, with a redaction count of zero to say so.


def test_redacts_company_names_ending_in_punctuation():
    for name in ["Acme Robotics, Inc.", "Widgets Ltd.", "Northstar Capital L.L.C.", "Acme (US)"]:
        text = f"The subject company {name} was valued in Q3."
        redacted, counts = redact(text, company_names=[name])
        assert "[COMPANY]" in redacted, name
        assert name not in redacted, name
        assert counts.get("companies") == 1, name


def test_redacts_a_punctuated_name_at_the_end_of_the_text():
    redacted, counts = redact("Prepared for Acme Robotics, Inc.", company_names=["Acme Robotics, Inc."])
    assert redacted == "Prepared for [COMPANY]"
    assert counts.get("companies") == 1


def test_redacts_every_occurrence_of_a_punctuated_name():
    text = "Acme, Inc. filed. Later, Acme, Inc. raised. See Acme, Inc.'s cap table."
    redacted, counts = redact(text, company_names=["Acme, Inc."])
    assert "Acme" not in redacted
    assert counts.get("companies") == 3


def test_tolerates_the_whitespace_a_pdf_extractor_inserts():
    # Text pulled out of a PDF wraps mid-name and doubles spaces.
    text = "Issued by Acme\nRobotics,  Inc. on 1 May."
    redacted, counts = redact(text, company_names=["Acme Robotics, Inc."])
    assert "Acme" not in redacted and "Robotics" not in redacted
    assert counts.get("companies") == 1


def test_matches_a_name_whose_trailing_punctuation_the_document_omits():
    text = "Acme Robotics, Inc is the issuer."
    redacted, counts = redact(text, company_names=["Acme Robotics, Inc."])
    assert "Acme" not in redacted
    assert counts.get("companies") == 1


def test_punctuated_person_names_are_struck_too():
    text = "Signed by Lovelace, Ada. on behalf of the board."
    redacted, counts = redact(text, person_names=["Lovelace, Ada."])
    assert "Lovelace" not in redacted
    assert counts.get("names", 0) >= 1


def test_punctuation_does_not_widen_a_match_past_the_name():
    # The boundary must still stop the match running into an adjacent word.
    redacted, _ = redact("Acme Inc.orporated Systems", company_names=["Acme Inc."])
    assert "orporated Systems" in redacted


def test_punctuated_name_redacted_through_pipeline(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    payload = {
        "valuation": {"company_name": "Zephyr Dynamics, Inc."},
        "documents": [_doc("Zephyr Dynamics, Inc. is a robotics startup.")],
    }
    _, result = pipelines.run_missing_data(payload)
    assert "[COMPANY] is a robotics startup" in captured["user"]
    assert result["anonymization"]["redacted"].get("companies") == 1


def test_a_name_of_pure_punctuation_does_not_match_everything():
    # `_MIN_ENTITY_LEN` lets "..." through, and stripping its trailing
    # punctuation would leave an empty pattern that matches at every position.
    redacted, counts = redact("10000000 shares at $2.50", company_names=["..."])
    assert redacted == "10000000 shares at $2.50"
    assert "companies" not in counts


def test_an_entity_does_not_match_inside_a_longer_word():
    # Whole-entity matching has to hold on both sides: "Acme" must not strike
    # the tail of "MegaAcme" any more than the head of "Acmex".
    redacted, counts = redact("MegaAcme and Acmex and Acme", company_names=["Acme"])
    assert redacted == "MegaAcme and Acmex and [COMPANY]"
    assert counts.get("companies") == 1


# ── The company under its own name, without the legal suffix ─────────────────
#
# The only company name that always comes through is `valuation.company_name`,
# the registered one: "Acme Robotics, Inc." A document names the company that
# way once, on the cover, and then calls it "Acme Robotics" for thirty pages.
# Matching only the registered form struck the first mention and left every
# other one — the most identifying field on a 409A, sent to an external model.


def test_redacts_the_company_without_its_corporate_suffix():
    text = "Acme Robotics reported revenue of $5,000,000. The board of Acme Robotics met in June."
    redacted, counts = redact(text, company_names=["Acme Robotics, Inc."])
    assert "Acme" not in redacted and "Robotics" not in redacted
    assert counts.get("companies") == 2


def test_strikes_both_the_registered_name_and_the_short_one():
    text = "Acme Robotics, Inc. (“Acme Robotics”) is the issuer."
    redacted, counts = redact(text, company_names=["Acme Robotics, Inc."])
    assert "Acme" not in redacted
    # The registered form is matched first, so each mention costs one match
    # rather than the long name being left stranded behind the short one.
    assert counts.get("companies") == 2


def test_short_form_is_taken_from_every_suffix_style():
    for name, prose in [
        ("Widgets Ltd.", "Widgets grew."),
        ("Northstar Capital L.L.C.", "Northstar Capital grew."),
        ("Volvo AB", "Volvo grew."),
        ("Acme Robotics L.P.", "Acme Robotics grew."),
        ("Foo Co.", "Foo grew."),
    ]:
        redacted, counts = redact(prose, company_names=[name])
        assert redacted == "[COMPANY] grew.", name
        assert counts.get("companies") == 1, name


def test_the_comma_before_a_suffix_is_the_record_s_house_style_not_the_name():
    # The certificate says "Acme Robotics, Inc."; the minutes say it without
    # the comma. Both are the same company.
    redacted, counts = redact("Acme Robotics Inc. filed.", company_names=["Acme Robotics, Inc."])
    assert redacted == "[COMPANY] filed."
    assert counts.get("companies") == 1


def test_a_generic_one_word_stem_is_not_struck_on_its_own():
    # "Systems, Inc." must not turn every "systems" in an engineering memo into
    # [COMPANY]: the model is being asked to reason about the business, and a
    # document redacted into nonsense produces a worse valuation narrative.
    text = "Our systems integration revenue rose. Systems, Inc. is the filer."
    redacted, counts = redact(text, company_names=["Systems, Inc."])
    assert "Our systems integration revenue rose." in redacted
    assert counts.get("companies") == 1


def test_a_distinctive_one_word_name_still_loses_its_suffix():
    # The flip side: "Stripe" is a name before it is a word.
    redacted, counts = redact("Stripe processed payments.", company_names=["Stripe, Inc."])
    assert redacted == "[COMPANY] processed payments."
    assert counts.get("companies") == 1


def test_a_suffix_inside_a_single_word_is_not_a_suffix():
    # "Metacorp" does not become "Meta", and "Telco" does not become "Tel".
    for name, word in [("Metacorp", "Metacorp"), ("Telco", "Telco"), ("Vinco", "Vinco")]:
        redacted, _ = redact(f"{word} and Meta and Tel and Vin.", company_names=[name])
        assert "and Meta and Tel and Vin." in redacted, name


def test_a_stem_too_short_to_be_distinctive_is_left_alone():
    redacted, counts = redact("AB testing improved.", company_names=["AB, Inc."])
    assert redacted == "AB testing improved."
    assert "companies" not in counts


def test_person_names_are_not_stripped_of_a_trailing_word():
    # A person is not "Ada Lovelace, Inc." — but plenty of real surnames are
    # spelled like a corporate suffix ("Sá", "Ab", "Co"), and suffix-stripping
    # those would reduce the person to their given name and then strike every
    # unrelated Maria in the document.
    text = "Maria Sa signed the consent. Maria Rodrigues also attended."
    redacted, counts = redact(text, person_names=["Maria Sa"])
    assert "Maria Rodrigues also attended." in redacted
    assert "Maria Sa" not in redacted
    assert counts.get("names") == 1


def test_short_form_redacted_through_pipeline(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    payload = {
        "valuation": {"company_name": "Zephyr Dynamics, Inc."},
        "documents": [_doc("Zephyr Dynamics builds robots. Zephyr Dynamics, Inc. is the filer.")],
    }
    _, result = pipelines.run_missing_data(payload)
    assert "Zephyr" not in captured["user"]
    assert result["anonymization"]["redacted"].get("companies") == 2


# ── The prompt around the documents ──────────────────────────────────────────
#
# Every pipeline opens with "Company: …" read straight off the valuation
# record. Striking the name out of the documents and printing it on the line
# above them protects nothing: a model handed "Company: Acme Robotics, Inc."
# and a document reading "[COMPANY] holds 2,000,000 shares" has been told what
# the placeholder stands for, and the cap table is re-identified in one step.

_DOC_PIPELINES = ["run_missing_data", "run_extract", "run_comparables", "run_summarize"]
_ALL_PIPELINES = _DOC_PIPELINES + ["run_qa", "run_explain"]


def _payload(**over) -> dict:
    payload = {
        "valuation": {"company_name": "Zephyr Dynamics, Inc.", "kind": "409a", "currency": "USD"},
        "documents": [_doc("Zephyr Dynamics, Inc. holds 2,000,000 shares.")],
    }
    payload.update(over)
    return payload


def test_no_pipeline_names_the_company_in_its_prompt(monkeypatch):
    for name in _ALL_PIPELINES:
        captured: dict = {}
        _mock_chat(monkeypatch, captured)
        getattr(pipelines, name)(_payload())
        assert "Zephyr" not in captured["user"], name
        assert "[COMPANY]" in captured["user"], name


def test_the_placeholder_does_not_cost_the_model_the_rest_of_the_header(monkeypatch):
    # Only the name goes; kind and currency are not identifying and the model
    # needs them to reason about the engagement at all.
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    pipelines.run_qa(_payload())
    assert "409a valuation" in captured["user"] and "USD" in captured["user"]


def test_switching_redaction_off_restores_the_real_name(monkeypatch):
    # The caller that opts out is asking for the real thing, and says so.
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("ANONYMIZE_ENFORCE", raising=False)
    for name in _ALL_PIPELINES:
        captured: dict = {}
        _mock_chat(monkeypatch, captured)
        getattr(pipelines, name)(_payload(options={"anonymize": False}))
        assert "Zephyr Dynamics, Inc." in captured["user"], name


def test_production_keeps_the_placeholder_even_when_asked_not_to(monkeypatch):
    # The anonymize=false escape hatch is ignored in production (audit B-1 P1),
    # and the header has to be ignored along with the documents — otherwise the
    # enforcement leaves the most identifying field in the one place it looked
    # like it was protecting.
    monkeypatch.setenv("APP_ENV", "production")
    for name in _ALL_PIPELINES:
        captured: dict = {}
        _mock_chat(monkeypatch, captured)
        getattr(pipelines, name)(_payload(options={"anonymize": False}))
        assert "Zephyr" not in captured["user"], name


def test_a_valuation_with_no_company_name_still_renders(monkeypatch):
    captured: dict = {}
    _mock_chat(monkeypatch, captured)
    pipelines.run_explain({"valuation": {"kind": "409a"}})
    assert "Company:" in captured["user"]


def test_a_page_of_capitalized_words_does_not_cost_quadratic_time():
    # The city/state/ZIP pattern scans a run of capitalized words looking for
    # the comma that precedes the state code. Unbounded, that run walked the
    # rest of the document from every capitalized word it started at, so text
    # with no address in it at all cost O(words^2) — 0.55s for one document at
    # the 20k-char cap, ~1.7s for a full 60k-char request. `re` holds the GIL,
    # so that is the whole service stalled, not one slow request.
    #
    # Timed rather than asserted on shape: the bound is the point, and a future
    # rewrite of the pattern is free as long as it stays linear. The threshold
    # is ~50x the fixed version's cost and ~1/5th of the old one's, so it fails
    # on a regression without being flaky on a loaded machine.
    import time

    from app.documents import MAX_CHARS_PER_DOC

    text = ("Alpha " * (MAX_CHARS_PER_DOC // 6))[:MAX_CHARS_PER_DOC]
    started = time.perf_counter()
    redacted, counts = redact(text)
    elapsed = time.perf_counter() - started

    assert elapsed < 0.1, f"redact() took {elapsed:.3f}s on {MAX_CHARS_PER_DOC} chars"
    # Nothing here is an address, so nothing should have been struck.
    assert counts.get("addresses", 0) == 0
    assert redacted == text


def test_a_multi_word_locality_is_still_redacted():
    # The bound that makes the scan linear must not be tight enough to miss a
    # real locality. Six words is already past anything the USPS lists.
    for locality in (
        "San Francisco",
        "Research Triangle Park",
        "Winston Salem",
        "St. Louis",
        "Lake Havasu City",
    ):
        text = f"Registered office at {locality}, CA 94105 as of the date hereof."
        redacted, counts = redact(text)
        assert counts.get("addresses", 0) == 1, locality
        assert "94105" not in redacted, locality
        assert locality not in redacted, locality


def test_a_locality_run_never_swallows_the_words_before_it():
    # Bounding the run must not shift where the match starts: the ZIP-bearing
    # tail is what anchors it, and the prose ahead of the locality stays put.
    text = "The Company maintains its principal executive offices in Menlo Park, CA 94025."
    redacted, _ = redact(text)
    assert redacted.startswith("The Company maintains its principal executive offices in ")
    assert "Menlo Park" not in redacted


# ── Bound on the known-entity list ───────────────────────────────────────────
#
# `options.known_companies` / `options.known_people` are free-form lists inside
# a free-form `options` dict, so their length was bounded only by the 32 MB body
# cap. `_redact_entities` compiles a pattern per entity and scans the whole
# string with it, and `Redactor.text` runs once per document body, once per
# filename and once per interpolated prompt field — so the work was
# entities × fields × chars with only the last two bounded. Measured on a
# 20,000-char document: 2,000 names cost 0.6s for a single field and 20,000 cost
# 6.1s, for ~600 KB of request. `re` holds the GIL, so that is the whole service
# stopped, not one slow request.


def test_a_reasonable_known_entity_list_is_accepted():
    names = [f"Person{i} Surname{i}" for i in range(MAX_KNOWN_ENTITIES)]
    red = Redactor(company_names=["Acme Robotics, Inc."], person_names=names)
    assert red.text("Acme Robotics, Inc. employs Person7 Surname7.") == "[COMPANY] employs [NAME]."


def test_too_many_known_people_is_refused_rather_than_truncated():
    names = [f"Person{i} Surname{i}" for i in range(MAX_KNOWN_ENTITIES + 1)]
    with pytest.raises(AnonymizeInputError, match="too many known names"):
        Redactor(person_names=names)


def test_too_many_known_companies_is_refused():
    with pytest.raises(AnonymizeInputError, match="too many known companies"):
        Redactor(company_names=[f"Acme {i} Robotics" for i in range(MAX_KNOWN_ENTITIES + 1)])


def test_the_module_level_redact_is_bounded_too():
    """`redact` is reachable without a Redactor, so it carries the bound itself."""
    with pytest.raises(AnonymizeInputError, match="too many known names"):
        redact("some text", person_names=[f"Person{i} Surname{i}" for i in range(MAX_KNOWN_ENTITIES + 1)])


def test_an_over_size_entity_list_answers_422_not_500():
    from fastapi.testclient import TestClient

    from app.main import app

    res = TestClient(app, raise_server_exceptions=False).post(
        "/ai/v1/pipelines/missing_data",
        json={
            "valuation": {"company_name": "Acme Robotics, Inc."},
            "options": {"known_people": [f"Person{i} Surname{i}" for i in range(MAX_KNOWN_ENTITIES + 1)]},
        },
    )
    assert res.status_code == 422
    assert "too many known names" in res.json()["detail"]


def test_redaction_stays_fast_at_the_bound():
    """The bound is what makes the cost of one request predictable."""
    import time

    text = ("Acme Robotics raised money from investors in San Francisco. " * 340)[:20_000]
    red = Redactor(
        company_names=["Acme Robotics, Inc."],
        person_names=[f"Person{i} Surname{i}" for i in range(MAX_KNOWN_ENTITIES)],
    )
    started = time.perf_counter()
    red.text(text)
    # Generous next to the ~0.15s this actually costs, and two orders of
    # magnitude under the 6s an unbounded list bought for the same money.
    assert time.perf_counter() - started < 2.0


def test_the_compiled_pattern_is_memoised_across_fields():
    """A request redacts many strings against one entity list; compile once."""
    red = Redactor(company_names=["Acme Robotics, Inc."])
    before = _entity_pattern.cache_info()
    for _ in range(20):
        red.text("Acme Robotics, Inc. filed.")
    after = _entity_pattern.cache_info()
    assert after.hits > before.hits
