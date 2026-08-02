"""Summarize-attachments pipeline tests (mocked OpenRouter)."""

import base64
import json

from app import pipelines
from app.openrouter import LlmResult


def _doc(filename: str, text: str, kind: str = "projections") -> dict:
    return {
        "id": filename,
        "filename": filename,
        "kind": kind,
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


COMPLETION = {
    "summaries": [
        {
            "filename": "forecast.txt",
            "summary": "Three-year revenue forecast reaching $12M ARR.",
            "key_figures": ["FY27 revenue $12,000,000", "burn $250k/mo"],
        },
        {"filename": "made_up.txt", "summary": "Not in the corpus."},
        "garbage-entry",
    ],
    "overall": "Early-stage SaaS with aggressive growth assumptions.",
}


def test_summarize_result_schema(monkeypatch):
    captured: dict = {}

    def fake_chat(system, user, *, model=None, client=None):
        captured["system"], captured["model"] = system, model
        return LlmResult(model="test/model", content=json.dumps(COMPLETION))

    monkeypatch.setattr(pipelines, "chat", fake_chat)

    model, result = pipelines.run_summarize(
        {
            "valuation": {"company_name": "Acme", "kind": "409a"},
            "documents": [_doc("forecast.txt", "FY27 revenue 12,000,000")],
        }
    )
    assert model == "test/model"
    assert result["documents_reviewed"] == ["forecast.txt"]
    assert result["overall"].startswith("Early-stage")

    [known, unknown] = result["summaries"]  # garbage entry dropped
    assert known["filename"] == "forecast.txt"
    assert known["kind"] == "projections"  # joined back to the uploaded doc
    assert known["key_figures"] == ["FY27 revenue $12,000,000", "burn $250k/mo"]
    assert unknown["kind"] == "other"  # filename the model invented


def test_summarize_registered_and_honors_prompt_override(monkeypatch):
    assert "summarize" in pipelines.PIPELINES

    captured: dict = {}

    def fake_chat(system, user, *, model=None, client=None):
        captured["system"], captured["model"] = system, model
        return LlmResult(model="custom/model", content="{}")

    monkeypatch.setattr(pipelines, "chat", fake_chat)
    pipelines.run_summarize(
        {
            "valuation": {},
            "documents": [],
            "prompt": {"system": "Custom summarizer.", "model": "custom/model"},
        }
    )
    assert captured["system"] == "Custom summarizer."
    assert captured["model"] == "custom/model"


# ── Redacted filenames collide, and the map back was keyed on them ───────────
#
# Redaction is many-to-one, and filenames are where it collides in practice: a
# 409A engagement uploads one grant letter per employee and they are named after
# the grantee, so every "<Employee> Option Grant.pdf" becomes "[NAME] Option
# Grant.pdf". The corpus map was `{shown_filename: doc}`, so N uploads collapsed
# to one entry and every summary came back attributed to whichever document was
# last — Ada's figures under Grace's filename, in an audit work product. The
# model was also shown several identically-headed blocks and asked for "one
# entry per document" keyed by filename, which is not answerable.


def _grant_payload() -> dict:
    return {
        "valuation": {"company_name": "Acme", "kind": "409a"},
        "options": {"known_people": ["Ada Lovelace", "Grace Hopper"]},
        "documents": [
            _doc("Ada Lovelace Option Grant.pdf", "holds 1,000 shares", kind="cap_table"),
            _doc("Grace Hopper Option Grant.pdf", "holds 2,000 shares", kind="other"),
        ],
    }


def test_documents_whose_redacted_names_collide_stay_distinct_in_the_corpus():
    red = pipelines._redactor(_grant_payload())
    docs, _ = pipelines._load_docs(_grant_payload(), red)
    corpus, by_shown = pipelines._corpus(docs, red, 45_000)

    # One key per document, or the lookup silently answers with the wrong file.
    assert len(by_shown) == len(docs)
    assert [d.filename for d in by_shown.values()] == [
        "Ada Lovelace Option Grant.pdf",
        "Grace Hopper Option Grant.pdf",
    ]
    # The disambiguator is positional, so it cannot carry back what was struck.
    assert "Ada" not in corpus and "Grace" not in corpus and "Lovelace" not in corpus
    assert "[NAME] Option Grant.pdf" in corpus
    assert "[NAME] Option Grant (2).pdf" in corpus


def test_summaries_are_attributed_to_the_right_upload_when_names_collide(monkeypatch):
    def fake_chat(system, user, *, model=None, client=None):
        return LlmResult(
            model="test/model",
            content=json.dumps(
                {
                    "summaries": [
                        {"filename": "[NAME] Option Grant.pdf", "summary": "1,000 shares."},
                        {"filename": "[NAME] Option Grant (2).pdf", "summary": "2,000 shares."},
                    ],
                    "overall": "Two grant letters.",
                }
            ),
        )

    monkeypatch.setattr(pipelines, "chat", fake_chat)
    _, result = pipelines.run_summarize(_grant_payload())

    first, second = result["summaries"]
    assert (first["filename"], first["summary"]) == (
        "Ada Lovelace Option Grant.pdf",
        "1,000 shares.",
    )
    assert (second["filename"], second["summary"]) == (
        "Grace Hopper Option Grant.pdf",
        "2,000 shares.",
    )
    # `kind` is joined back from the same lookup, so it goes wrong with it.
    assert [s["kind"] for s in result["summaries"]] == ["cap_table", "other"]


def test_uploads_genuinely_sharing_a_name_are_disambiguated_too(monkeypatch):
    # Same failure with redaction off entirely: two files really called the
    # same thing collapse to one map entry just as readily.
    payload = {
        "valuation": {"company_name": "Acme", "kind": "409a"},
        "options": {"anonymize": False},
        "documents": [_doc("cap table.xlsx", "A"), _doc("cap table.xlsx", "B")],
    }
    red = pipelines._redactor(payload)
    docs, _ = pipelines._load_docs(payload, red)
    _, by_shown = pipelines._corpus(docs, red, 45_000)
    assert list(by_shown) == ["cap table.xlsx", "cap table (2).xlsx"]


def test_the_ordinal_goes_before_the_extension_and_survives_odd_names():
    # Extensionless names and dotfiles have no stem to number, so the ordinal
    # goes on the end rather than producing " (2)." glued to a bare suffix.
    assert pipelines._distinct_filenames(["a.pdf", "a.pdf", "a.pdf"]) == [
        "a.pdf",
        "a (2).pdf",
        "a (3).pdf",
    ]
    assert pipelines._distinct_filenames(["README", "README"]) == ["README", "README (2)"]
    assert pipelines._distinct_filenames([".env", ".env"]) == [".env", ".env (2)"]
    # A name that already looks numbered must not be handed a duplicate key.
    assert pipelines._distinct_filenames(["a.pdf", "a (2).pdf", "a.pdf"]) == [
        "a.pdf",
        "a (2).pdf",
        "a (3).pdf",
    ]
