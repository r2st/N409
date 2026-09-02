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


def test_the_map_back_covers_what_the_model_was_shown_and_stops_there():
    """`by_shown_filename` answers "the model echoed this filename — which
    document is that?", and only a document the model was shown can honestly be
    the answer.

    It used to cover every document handed in, on the argument that a model
    echoing an unshown name is a case the caller must be able to recognise.
    Neither caller does recognise it — `run_summarize` and the cap-table
    agent's `_citations` both fall back to the model's own spelling, which is
    already redacted and so cannot leak. What the wide map actually did was
    resolve a name the model was never shown into a real filename, and write it
    into an audit work product as the source of a citation. Of the two, the
    silent fall-back is the safe one: it records what the model said, not a
    document it never saw.

    R375 makes the map narrow for a second reason — the documents past the
    budget are no longer extracted at all, so there is nothing to name them
    with — but the contract above is the one that matters and it is the better
    of the two.
    """
    docs = [_doc("a.csv", 8_000), _doc("b.csv", 8_000), _doc("c.csv", 8_000)]
    _, by_shown, reviewed = _corpus(docs, _red(), 9_000)

    assert [d.filename for d in reviewed] == ["a.csv"]
    # "b.csv" is the one the budget refused, so it is priced and named before
    # the walk stops; "c.csv" is never reached.
    assert "c.csv" not in by_shown
    assert by_shown["a.csv"].filename == "a.csv"


def test_a_budget_smaller_than_the_note_still_yields_the_document():
    # Degenerate — every real limit is five figures — but a budget that cannot
    # hold the note must not answer "no documents uploaded" for a run that had
    # one.
    corpus, _, reviewed = _corpus([_doc("a.csv", 500)], _red(), 60)
    assert len(corpus) == 60
    assert [d.filename for d in reviewed] == ["a.csv"]
