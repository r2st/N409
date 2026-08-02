"""Nothing identifying leaves the trust boundary — for every prompt, not just
the documents.

`test_anonymize.py` covers `redact` itself: what it strikes and what it must
leave alone. This file covers the other half of the problem, which is the half
that actually leaked. Redaction was applied to document *bodies*, and every
other string in the request went out in the clear:

* `business_overview` — free text a founder typed into a form, which routinely
  opens "Acme Robotics is a San Francisco robotics company founded by Ada
  Lovelace (ada@acme.io)". It reached five prompts intact (round-7 audit).
* Document filenames — "Acme Robotics - Cap Table 2025.xlsx" heads its own
  block in the corpus, naming the company directly above the body it had just
  been struck out of.
* Every agent prompt — the agents were written after the pipelines and never
  picked up any redaction at all.

So the assertions here are mostly about *where* redaction happens rather than
what it does, and the important one is `test_no_registered_pipeline_leaks`:
it enumerates the dispatch table rather than a hand-written list, so an agent
added next quarter is covered on the day it is registered.
"""

import base64
import json

import pytest

from app import pipelines
from app.agents import AGENT_PIPELINES, _common, comp_selection
from app.main import ALL_PIPELINES
from app.openrouter import LlmResult

# One payload carrying every identifying thing a real request carries, so a
# single assertion sweep can say "none of this reached the model".
COMPANY = "Zephyr Dynamics, Inc."
SHORT = "Zephyr Dynamics"
FOUNDER = "Ada Lovelace"
EMAIL = "ada@zephyrdynamics.io"
PHONE = "(415) 555-0143"
OVERVIEW = (
    f"{SHORT} is a San Francisco robotics company founded by {FOUNDER} "
    f"({EMAIL}, {PHONE}). Revenue reached $5,000,000 in 2025."
)
# A real extension for the bytes below: named ".xlsx", extraction fails and the
# corpus becomes "[could not extract text: …]", which would quietly empty out
# every sweep in this file while leaving it green.
FILENAME = "Zephyr Dynamics - Cap Table 2025.txt"
DOC_BODY_MARKER = "holds 2,000,000 shares"
# What the model is shown, and therefore the only filename it can echo back.
# Stubbing a reply with the real one tests a path production never takes: the
# lookup misses, falls through to the name as written, and a result that never
# maps anything back still looks correct.
SHOWN_FILENAME = FILENAME.replace(SHORT, "[COMPANY]")

# Every string above that must never appear in an outbound prompt. The dollar
# figure is deliberately absent: it is the thing the model is being paid to
# reason about, and it is asserted *present* separately.
SECRETS = [COMPANY, SHORT, FOUNDER, EMAIL, PHONE, "Zephyr"]


def _doc(filename: str, text: str) -> dict:
    return {
        "id": "d1",
        "filename": filename,
        "kind": "cap_table",
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


def payload(**over) -> dict:
    base = {
        "valuation": {
            "company_name": COMPANY,
            "kind": "409a",
            "currency": "USD",
            "service_countries": ["US"],
        },
        "params": {"business_overview": OVERVIEW, "dlom_method": "chaffee"},
        "documents": [_doc(FILENAME, f"{SHORT} holds 2,000,000 shares. Contact {EMAIL}.")],
        "calculation": {"equity_value": 42_000_000, "fmv_per_share": 1.23},
        "qa_checks": [{"check": "fmv_vs_last_round", "detail": f"{SHORT} priced above its round"}],
        "comp_context": {"description": OVERVIEW},
        "options": {"known_people": [FOUNDER]},
    }
    base.update(over)
    return base


@pytest.fixture
def prompts(monkeypatch):
    """Capture every prompt the request sends, through both seams.

    The pipelines call `pipelines.chat` and the agents call `_common.chat`;
    patching one and not the other is how a leak stays invisible in a test that
    looks like it covers everything.
    """
    sent: list[dict] = []

    def fake_chat(system, user, *, model=None, client=None):
        sent.append({"system": system, "user": user})
        return LlmResult(model="test/model", content=json.dumps(_STUB))

    monkeypatch.setattr(pipelines, "chat", fake_chat)
    monkeypatch.setattr(_common, "chat", fake_chat)
    monkeypatch.setattr(comp_selection, "verify_tickers", lambda tickers, **kw: _VERIFIED)
    return sent


# Enough of a response that each runner's normalisation finds something to
# keep; the shapes are unioned so one stub serves every pipeline.
_STUB = {
    "gaps": [],
    "notes": "ok",
    "engine_inputs": {},
    "extractions": [],
    "comparables": [{"name": "Acme Public Co", "ticker": "APC", "rationale": "same sector"}],
    "sector": "Robotics",
    "caveats": "estimates",
    "summaries": [{"filename": SHOWN_FILENAME, "summary": "a cap table", "key_figures": []}],
    "overall": "ok",
    "findings": [],
    "assessment": "ok",
    "verdict": "pass",
    "summary": "ok",
    "methodology": [],
    "drivers": [],
    "classes": [],
    "share_classes": [],
    "selected": [],
    "excluded": [],
    "recommendations": {},
    "challenges": [],
    "weaknesses": [],
    "sections": {},
    "material_changes": [],
}
_VERIFIED = {"companies": [], "not_found": ["APC"], "count": 0}


def _leaks(text: str) -> list[str]:
    return [s for s in SECRETS if s in text]


# ── The sweep ────────────────────────────────────────────────────────────────


def test_no_registered_pipeline_leaks(prompts):
    """Every runner in the dispatch table, against one payload that carries the
    company name, a founder, an email, a phone number and an identifying
    filename in every field that accepts one."""
    assert set(ALL_PIPELINES) >= set(AGENT_PIPELINES), "dispatch table lost the agents"
    saw_corpus = False
    for name, run in ALL_PIPELINES.items():
        prompts.clear()
        run(payload())
        assert prompts, f"{name} sent no prompt at all"
        saw_corpus |= any(DOC_BODY_MARKER in sent["user"] for sent in prompts)
        for sent in prompts:
            assert not _leaks(sent["user"]), f"{name} user prompt: {_leaks(sent['user'])}"
            assert not _leaks(sent["system"]), f"{name} system prompt: {_leaks(sent['system'])}"
    # A fixture whose document fails to extract turns the sweep above into an
    # assertion about an empty corpus, and it stays green while proving nothing.
    assert saw_corpus, "no runner put the document body in a prompt"


def test_every_runner_reports_what_it_redacted(prompts):
    # A result that does not say whether redaction ran is a result nobody can
    # audit after the fact — and six of the twelve runners did not say.
    for name, run in ALL_PIPELINES.items():
        _, result = run(payload())
        assert result.get("anonymization", {}).get("applied") is True, name


# ── business_overview: the round-7 finding ───────────────────────────────────


def test_the_business_overview_is_redacted_not_just_the_documents(prompts):
    pipelines.run_comparables(payload())
    user = prompts[0]["user"]
    assert "Business overview:" in user  # the field is still sent, just clean
    assert "[COMPANY]" in user and "[NAME]" in user and "[EMAIL]" in user


def test_the_overview_survives_as_prose_the_model_can_use(prompts):
    # Redaction that reduces the overview to placeholders would cost the
    # comparables run the only description of the business it has.
    pipelines.run_comparables(payload())
    user = prompts[0]["user"]
    assert "San Francisco robotics company" in user
    assert "$5,000,000" in user


def test_the_overview_reaches_the_agents_redacted_too(prompts):
    # comp_selection builds its own target summary from comp_context and params
    # rather than going through the pipelines' prompt helpers.
    comp_selection.run_comp_selection(payload())
    assert prompts, "no prompt captured"
    assert not _leaks(prompts[0]["user"])


# ── Filenames ────────────────────────────────────────────────────────────────


def test_the_corpus_does_not_announce_the_company_in_a_filename(prompts):
    pipelines.run_extract(payload())
    user = prompts[0]["user"]
    assert FILENAME not in user
    assert "[COMPANY] - Cap Table 2025.txt" in user  # the rest of it is still useful
    assert DOC_BODY_MARKER in user  # and the body it heads is really there


def test_the_analyst_gets_back_the_filename_they_uploaded(prompts):
    # The model can only echo the redacted name; a result that named files
    # "[COMPANY] - Cap Table 2025.xlsx" would not match anything in the
    # workspace the analyst is looking at.
    _, result = pipelines.run_summarize(payload())
    assert result["documents_reviewed"] == [FILENAME]
    assert [s["filename"] for s in result["summaries"]] == [FILENAME]


def test_a_filename_the_model_invented_is_not_mapped_to_a_real_file(monkeypatch, prompts):
    monkeypatch.setattr(
        pipelines,
        "chat",
        lambda s, u, *, model=None, client=None: LlmResult(
            model="m",
            content=json.dumps(
                {"summaries": [{"filename": "hallucinated.pdf", "summary": "x"}], "overall": ""}
            ),
        ),
    )
    _, result = pipelines.run_summarize(payload())
    assert result["summaries"][0]["filename"] == "hallucinated.pdf"
    assert result["summaries"][0]["kind"] == "other"


def test_a_cap_table_citation_points_at_the_real_document(prompts, monkeypatch):
    identified = {
        "classes": [
            {
                "name": "Common",
                "kind": "common",
                "shares": 2_000_000,
                "citations": [
                    {
                        "field": "shares",
                        "value": "2,000,000",
                        # What the model saw, and so what it echoes back.
                        "source_document": SHOWN_FILENAME,
                        "quote": "2,000,000 shares",
                        "confidence": 0.9,
                    }
                ],
            }
        ]
    }
    structured = {"share_classes": [{"name": "Common", "kind": "common", "shares": 2_000_000}]}
    replies = iter([json.dumps(identified), json.dumps(structured)])
    monkeypatch.setattr(
        _common,
        "chat",
        lambda s, u, *, model=None, client=None: LlmResult(model="m", content=next(replies)),
    )
    _, result = AGENT_PIPELINES["cap_table"](payload())
    assert result["citations"][0]["source_document"] == FILENAME


# ── The gate ─────────────────────────────────────────────────────────────────


def test_an_operator_written_system_prompt_is_redacted_too(prompts):
    # The Bot Prompts registry ships the system prompt from the database. It is
    # the one part of the request that no review of a client payload would
    # think to check.
    pipelines.run_explain(payload(prompt={"system": f"You are valuing {COMPANY}."}))
    assert not _leaks(prompts[0]["system"])
    assert "You are valuing [COMPANY]." == prompts[0]["system"]


def test_the_gate_counts_what_it_struck_outside_the_documents(prompts):
    # run_explain loads no documents at all, so everything in its report came
    # from the prompt around them.
    _, result = pipelines.run_explain(payload())
    redacted = result["anonymization"]["redacted"]
    assert redacted.get("emails") == 1
    assert redacted.get("companies", 0) >= 1


def test_redacting_twice_does_not_double_count(prompts):
    # `business_overview` is struck where it is assembled *and* again at the
    # gate. If the second pass re-counted, the job record would claim twice as
    # much PII as the request contained.
    _, result = pipelines.run_comparables(payload())
    assert result["anonymization"]["redacted"].get("emails") == 2  # overview + document


def test_figures_survive_the_gate(prompts):
    # The gate now runs over the calculation summary, which is nothing but
    # numbers. A share count read as a phone number would silently corrupt
    # every QA review.
    pipelines.run_qa(payload())
    user = prompts[0]["user"]
    assert "42000000" in user and "1.23" in user


# ── The escape hatch, at the gate ────────────────────────────────────────────


def test_switching_redaction_off_sends_the_real_request(monkeypatch, prompts):
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("ANONYMIZE_ENFORCE", raising=False)
    pipelines.run_comparables(payload(options={"anonymize": False}))
    assert COMPANY in prompts[0]["user"]
    assert EMAIL in prompts[0]["user"]


def test_production_ignores_the_escape_hatch_for_every_runner(monkeypatch, prompts):
    # audit B-1 P1. Asserted across the dispatch table because the enforcement
    # is only worth anything if the runner nobody remembered honours it too.
    monkeypatch.setenv("APP_ENV", "production")
    for name, run in ALL_PIPELINES.items():
        prompts.clear()
        run(payload(options={"anonymize": False, "known_people": [FOUNDER]}))
        for sent in prompts:
            assert not _leaks(sent["user"]), f"{name}: {_leaks(sent['user'])}"


def test_a_request_with_nothing_to_redact_still_reports(prompts):
    _, result = pipelines.run_explain({"valuation": {"kind": "409a"}})
    assert result["anonymization"] == {"applied": True, "redacted": {}, "enforced": False}
