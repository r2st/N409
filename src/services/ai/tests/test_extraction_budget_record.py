"""What the extractor's own budget leaves out, and who is told (R332, M5).

`extract_texts` stops extracting once `MAX_TOTAL_CHARS` is spent. Three
ordinary spreadsheets spend it, so this is the common case on a real upload
rather than a ceiling nobody reaches — and it used to be entirely silent:

  * nothing was logged, so no operator could see that a run had been asked to
    read ten documents and had opened three;
  * `corpus_truncated` one layer up reports `total=len(docs)` over the list
    this loop has *already* shortened, so its denominator counted survivors;
  * `/ai/v1/anonymize` answered with fewer documents than it was sent, while
    the valuation service's `cap_table_anonymized` audit record named every
    one of them as material that had been through the anonymizer.
"""

from __future__ import annotations

import base64
import logging

from fastapi.testclient import TestClient

from app.documents import MAX_CHARS_PER_DOC, MAX_TOTAL_CHARS, UNREAD_NOTE, extract_texts
from app.main import app

client = TestClient(app)


def _doc(name: str, chars: int) -> dict:
    return {
        "id": name,
        "filename": name,
        "kind": "cap_table",
        "content_base64": base64.b64encode(("x" * chars).encode()).decode(),
    }


def _over_budget() -> list[dict]:
    """Enough documents that the budget runs out partway down the list."""
    per = MAX_CHARS_PER_DOC
    need = MAX_TOTAL_CHARS // per + 2
    return [_doc(f"doc-{n}.csv", per) for n in range(need)]


def test_documents_past_the_budget_are_not_extracted():
    docs = extract_texts(_over_budget())
    assert len(docs) < len(_over_budget())
    assert sum(len(d.text) for d in docs) >= MAX_TOTAL_CHARS


def test_the_shortfall_is_logged_with_its_denominator(caplog):
    submitted = _over_budget()
    with caplog.at_level(logging.WARNING, logger="documents"):
        docs = extract_texts(submitted)

    dropped = [r for r in caplog.records if getattr(r, "event", None) == "documents_dropped"]
    assert len(dropped) == 1
    # The pair an alert groups on, and the denominator is what was *submitted* —
    # counting the survivors is the defect this line exists to remove.
    assert dropped[0].count == len(submitted) - len(docs)
    assert dropped[0].total == len(submitted)


def test_a_corpus_that_fits_says_nothing(caplog):
    with caplog.at_level(logging.WARNING, logger="documents"):
        extract_texts([_doc("a.csv", 100), _doc("b.csv", 100)])
    assert not [r for r in caplog.records if getattr(r, "event", None) == "documents_dropped"]


def test_anonymize_answers_with_one_entry_per_document_submitted():
    submitted = _over_budget()
    res = client.post(
        "/ai/v1/anonymize",
        json={"text": "", "documents": submitted, "company_names": [], "person_names": []},
    )
    assert res.status_code == 200
    body = res.json()
    assert len(body["documents"]) == len(submitted)
    assert [d["original_filename"] for d in body["documents"]] == [
        d["filename"] for d in submitted
    ]


def test_the_ones_that_were_never_opened_say_so_rather_than_reading_as_empty():
    submitted = _over_budget()
    res = client.post(
        "/ai/v1/anonymize",
        json={"text": "", "documents": submitted, "company_names": [], "person_names": []},
    )
    unread = [d for d in res.json()["documents"] if d["text"] == UNREAD_NOTE]
    assert unread, "the budget must have cut this list short for the test to mean anything"
    # `chars` is the length of what was extracted, and nothing was: zero here is
    # honest only because the text beside it says why.
    assert all(d["chars"] == 0 for d in unread)
