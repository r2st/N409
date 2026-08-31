"""The corpus budget, and the record of what it left out.

`extract_texts` allows 20 000 characters per document and 60 000 across the
corpus; every pipeline fits that into a `limit` below 60 000, and one of them
into 15 000. So the budget is not a theoretical ceiling — three ordinary
spreadsheets overrun the smallest of them on their own.

What used to happen there was `render_corpus(shown)[:limit]`: a cut landing
wherever it landed, and `documents_reviewed` listing every document handed to
the pipeline regardless. Both halves are silent, and each is a claim:

  * to the model, that the document it was given ends where the slice ended —
    a cap table cut above the preferred rows reads exactly like a cap table
    with no preferred rows;
  * to the analyst, in an audit work product, that the model read documents it
    was never shown.
"""

from __future__ import annotations

from app.anonymize import Redactor
from app.documents import DocText
from app.pipelines import _corpus


def _red() -> Redactor:
    return Redactor.for_request({"anonymize": False})


def _doc(name: str, chars: int) -> DocText:
    return DocText(id=name, filename=name, kind="other", text="x" * chars)


def test_a_document_that_does_not_fit_is_left_out_rather_than_half_sent():
    docs = [_doc("a.csv", 8_000), _doc("b.csv", 8_000), _doc("c.csv", 8_000)]
    corpus, _, reviewed = _corpus(docs, _red(), 18_000)

    assert len(corpus) <= 18_000
    # The first fits whole; the second is cut and says so; the third is absent.
    assert "a.csv" in corpus
    assert "b.csv" in corpus
    assert "c.csv" not in corpus
    assert [d.filename for d in reviewed] == ["a.csv", "b.csv"]


def test_the_cut_is_declared_to_the_reader_who_can_act_on_it():
    docs = [_doc("cap-table.csv", 40_000)]
    corpus, _, reviewed = _corpus(docs, _red(), 15_000)

    assert len(corpus) <= 15_000
    assert corpus.endswith("the rest was not sent]")
    # Partly read is still read: the document is on the record, and the record
    # is honest about it because the model was told where it stops.
    assert [d.filename for d in reviewed] == ["cap-table.csv"]


def test_the_whole_corpus_is_reviewed_when_it_fits():
    docs = [_doc("a.csv", 100), _doc("b.csv", 100)]
    corpus, by_shown, reviewed = _corpus(docs, _red(), 45_000)

    assert "cut short" not in corpus
    assert [d.filename for d in reviewed] == ["a.csv", "b.csv"]
    assert list(by_shown) == ["a.csv", "b.csv"]


def test_a_run_over_no_documents_still_says_so():
    corpus, by_shown, reviewed = _corpus([], _red(), 45_000)
    assert corpus == "(no documents uploaded)"
    assert by_shown == {}
    assert reviewed == []


def test_the_map_back_still_covers_every_document_handed_in():
    """`by_shown_filename` is not the reviewed list and must not become it.

    It answers "the model echoed this filename — which document is that?", and
    a model that echoes the name of a document it was not shown is exactly the
    case the caller has to be able to recognise. Losing the entry turns that
    into a silent fall-back to the model's own spelling.
    """
    docs = [_doc("a.csv", 8_000), _doc("b.csv", 8_000), _doc("c.csv", 8_000)]
    _, by_shown, reviewed = _corpus(docs, _red(), 9_000)

    assert list(by_shown) == ["a.csv", "b.csv", "c.csv"]
    assert [d.filename for d in reviewed] == ["a.csv"]


def test_a_budget_smaller_than_the_note_still_yields_the_document():
    # Degenerate — every real limit is five figures — but a budget that cannot
    # hold the note must not answer "no documents uploaded" for a run that had
    # one.
    corpus, _, reviewed = _corpus([_doc("a.csv", 500)], _red(), 60)
    assert len(corpus) == 60
    assert [d.filename for d in reviewed] == ["a.csv"]
