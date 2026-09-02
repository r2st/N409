"""Extraction, redaction and budgeting are one pass (R375, methodology M8).

`extract_texts` allowed 60 000 characters across a corpus; every pipeline then
fitted what it got into 15 000, 30 000 or 45 000 and dropped the rest. The
documents in between were decoded, parsed and redacted before being thrown
away — and redaction is `re` holding the GIL, so on a ten-document upload
against the smallest budget it was half the request spent on text no model was
ever going to see.

The corpus is filled in order and stops at the first document that does not
fit, so the pipeline's budget is a stopping point for the *extractor* too.
These tests pin the work rather than the answer: what reaches the model is
identical either way, so an assertion on the corpus cannot tell the single pass
from the eager one. Run every one of them against the eager form and it fails.
"""

from __future__ import annotations

import base64

from app import documents as docs_mod
from app import pipelines
from app.anonymize import Redactor
from app.documents import ExtractionTally, extract_texts, iter_extracted


def _doc(name: str, text: str, kind: str = "cap_table") -> dict:
    return {
        "id": name,
        "filename": name,
        "kind": kind,
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


def _payload(docs: list[dict], **options) -> dict:
    return {
        "valuation": {"company_name": "Acme Robotics Inc", "kind": "409a"},
        "options": {"anonymize": True, **options},
        "documents": docs,
    }


def _eager(payload: dict, red: Redactor, limit: int):
    """What the two-step loader did: extract everything, redact everything,
    then budget. The discriminator every assertion below is measured against."""
    docs = extract_texts(payload.get("documents") or [])
    for doc in docs:
        doc.text = red.text(doc.text)
    return pipelines._corpus(docs, red, limit)


# ── The work that is no longer done ──────────────────────────────────────────


def _counting_decoder(monkeypatch) -> list[str]:
    """Records every document body the extractor actually decodes."""
    seen: list[str] = []
    real = docs_mod.decode_text

    def spy(raw: bytes) -> str:
        seen.append(raw[:20].decode("utf-8", "replace"))
        return real(raw)

    monkeypatch.setattr(docs_mod, "decode_text", spy)
    return seen


def test_a_document_past_the_budget_is_never_decoded(monkeypatch):
    seen = _counting_decoder(monkeypatch)
    docs = [_doc(f"{i}.csv", f"doc{i} " + "x" * 9_000) for i in range(6)]

    _, _, reviewed = pipelines._load_corpus(_payload(docs), Redactor.for_request({}), 15_000)

    # 15 000 characters holds one 9 000-character document whole; the second is
    # priced, refused and cut short; nothing after it is opened at all.
    assert [d.filename for d in reviewed] == ["0.csv", "1.csv"]
    assert seen == ["doc0 xxxxxxxxxxxxxxx", "doc1 xxxxxxxxxxxxxxx"]


def test_the_whole_upload_is_still_read_when_the_budget_holds_it(monkeypatch):
    """The discriminator. A reader that simply stopped early would pass the
    test above and fail this one."""
    seen = _counting_decoder(monkeypatch)
    docs = [_doc(f"{i}.csv", f"doc{i} " + "x" * 900) for i in range(6)]

    _, _, reviewed = pipelines._load_corpus(_payload(docs), Redactor.for_request({}), 45_000)

    assert len(reviewed) == 6
    assert len(seen) == 6


def test_text_past_the_budget_is_never_redacted():
    """Redaction is the expensive half and the one that holds the GIL.

    Counted through the report rather than through a spy, because the report is
    also the claim the analyst reads: it now says what was struck out of the
    material that actually left the trust boundary.

    The document the budget *refuses* is still redacted — its size after
    redaction is the thing being priced, so it has to be. It is the ones after
    it, which are never priced at all, that are the saving.
    """
    docs = [
        _doc("first.csv", "founder@acme.example.com " + "x" * 9_000),
        _doc("refused.csv", "y" * 8_000),
        _doc("unread.csv", " ".join(f"holder{i}@acme.example.com" for i in range(50))),
    ]
    red = Redactor.for_request({})

    _, _, reviewed = pipelines._load_corpus(_payload(docs), red, 9_400)

    assert [d.filename for d in reviewed] == ["first.csv"]
    assert red.report()["redacted"]["emails"] == 1


# ── The answers are the same ones ────────────────────────────────────────────


def test_the_corpus_is_character_for_character_what_the_eager_loader_built():
    docs = [
        _doc("Acme Robotics - Cap Table.csv", "founder@acme.example.com " + "x" * 9_000),
        _doc("Ada Lovelace Option Grant.pdf", "y" * 8_000, kind="grant"),
        _doc("Grace Hopper Option Grant.pdf", "z" * 8_000, kind="grant"),
    ]
    for limit in (120, 9_000, 15_000, 30_000, 45_000):
        payload = _payload(docs)
        want = _eager(payload, pipelines._redactor(payload), limit)
        got = pipelines._load_corpus(_payload(docs), pipelines._redactor(payload), limit)
        assert got[0] == want[0], limit
        assert [d.filename for d in got[2]] == [d.filename for d in want[2]], limit
        assert [d.text for d in got[2]] == [d.text for d in want[2]], limit


def test_colliding_redacted_names_are_numbered_the_same_way_a_prefix_at_a_time():
    """`_distinct_filenames` numbered a whole list at once; the single pass
    numbers one name against those already shown. The prefix must match, or a
    budget that stops early renames the documents it did send."""
    names = ["a.pdf", "a.pdf", "README", "a.pdf", "a (2).pdf"]
    used: set[str] = set()
    assert [pipelines._next_distinct(used, n) for n in names] == pipelines._distinct_filenames(
        names
    )


# ── The extractor's own ceilings and lines are unchanged ─────────────────────


def test_the_iterator_and_the_list_agree_document_for_document():
    docs = [_doc(f"{i}.csv", f"doc{i}") for i in range(4)] + [
        {"id": "bad", "filename": "bad.pdf", "kind": "other", "content_base64": "!!!not base64"}
    ]
    tally = ExtractionTally()

    assert [d.text for d in iter_extracted(docs, tally)] == [d.text for d in extract_texts(docs)]
    assert tally.failed == 1


def test_the_extraction_ceiling_still_stops_a_caller_that_wants_everything():
    docs = [_doc(f"{i}.csv", "x" * 20_000) for i in range(6)]
    tally = ExtractionTally()

    got = list(iter_extracted(docs, tally))

    assert len(got) == docs_mod.MAX_TOTAL_CHARS // docs_mod.MAX_CHARS_PER_DOC == 3
    assert tally.dropped == 3


def test_a_walk_that_stops_early_counts_no_drops(caplog):
    """`documents_dropped` says the extraction budget was spent. A caller that
    stopped for its own budget spent nothing, and `corpus_truncated` — which is
    the only line that knows which budget it was — is what reports it."""
    docs = [_doc(f"{i}.csv", "x" * 9_000) for i in range(6)]

    with caplog.at_level("WARNING"):
        pipelines._load_corpus(_payload(docs), Redactor.for_request({}), 15_000)

    events = [getattr(r, "event", None) for r in caplog.records]
    assert "documents_dropped" not in events
    truncated = [r for r in caplog.records if getattr(r, "event", None) == "corpus_truncated"]
    assert len(truncated) == 1
    # The denominator is every document the caller sent, not the shortened list
    # an eager extractor would have handed on.
    assert (truncated[0].count, truncated[0].total) == (2, 6)
