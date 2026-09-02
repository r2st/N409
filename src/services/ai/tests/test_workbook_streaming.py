"""A worksheet is read row by row, not built as a tree (methodology M8).

The character budget (R338) already stopped the *loop* over a sheet's rows at
20,000 characters. It did not stop the parse: `_xlsx_text` handed the whole part
to `_parse_xml_part`, so expat built an `Element` for every row and every cell
of a sheet the reader was going to abandon a few hundred rows in, and
`root.iter()` was materialised into a list before it was sliced. Measured on a
40,000-row sheet — 0.6 MB compressed, 12 MB of XML — that was **339 ms and
209 MB of peak heap to produce 20,033 characters**, complete after row 700.
Streamed: 11 ms and 28 MB, byte-identical.

None of that is visible in what the reader returns, which is the same 20,033
characters either way — the same trap `test_extraction_budget_work` was written
for one layer up. These tests pin the parse instead: what the sheet part is
handed to, how far into it the reader gets, and what it keeps while it does.
"""

import gc
import io
import weakref
import zipfile

import pytest
from xml.etree import ElementTree

from app import documents
from app.documents import (
    MAX_XLSX_ROWS_PER_SHEET,
    MalformedDocument,
    _iter_sheet_rows,
    _row_values,
    _xlsx_text,
)

_SSML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _sheet_xml(rows: int, cell: str, *, doctype: bool = False) -> str:
    body = "".join(
        f'<row r="{n + 1}"><c r="A{n + 1}" t="inlineStr"><is><t>{cell}</t></is></c>'
        f'<c r="C{n + 1}"><v>{n + 1}</v></c></row>'
        for n in range(rows)
    )
    prolog = '<?xml version="1.0"?>'
    if doctype:
        prolog += '<!DOCTYPE worksheet [<!ENTITY a "aaaaaaaaaa">]>'
    return f'{prolog}<worksheet xmlns="{_SSML}"><sheetData>{body}</sheetData></worksheet>'


def _workbook(rows: int, cell: str, *, doctype: bool = False) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "xl/workbook.xml",
            f'<?xml version="1.0"?><workbook xmlns="{_SSML}"><sheets>'
            f'<sheet name="S1" sheetId="1" r:id="rId1" xmlns:r="{_REL}"/></sheets></workbook>',
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="{_REL}/worksheet"/>'
            "</Relationships>",
        )
        zf.writestr("xl/worksheets/sheet1.xml", _sheet_xml(rows, cell, doctype=doctype))
    return buf.getvalue()


def test_a_worksheet_part_is_never_handed_to_the_tree_parser(monkeypatch):
    """The assertion is over what the parser is *given*, not what comes back.

    `_parse_xml_part` is still right for the workbook, the relationships and the
    shared strings: those are small and are read end to end. A worksheet is the
    one part with an early stop, so a worksheet reaching that function is the
    defect, whatever the returned text looks like.
    """
    seen: list[bytes] = []
    real = documents._parse_xml_part
    monkeypatch.setattr(documents, "_parse_xml_part", lambda data: seen.append(data) or real(data))

    _xlsx_text(_workbook(rows=3_000, cell="y" * 40))

    assert seen, "the workbook and relationship parts are still read as trees"
    assert not [d for d in seen if b"<worksheet" in d]


def _rows_parsed(raw: bytes, monkeypatch) -> int:
    """How many `<row>` elements the reader's parser actually produced."""
    tally = [0]
    real = ElementTree.iterparse

    def counting(source, events=None):
        for event, element in real(source, events=events):
            if event == "end" and element.tag == f"{{{_SSML}}}row":
                tally[0] += 1
            yield event, element

    monkeypatch.setattr(documents.ElementTree, "iterparse", counting)
    _xlsx_text(raw)
    return tally[0]


def test_deepening_a_sheet_does_not_deepen_the_read(monkeypatch):
    """Rows parsed is a property of the budget, not of the workbook.

    Asserted as a difference — deepen the sheet tenfold and this must not move —
    because the absolute number is a property of the corpus: it is however many
    rows of *this* width cover 20,000 characters.
    """
    shallow = _rows_parsed(_workbook(rows=2_000, cell="y" * 40), monkeypatch)
    deep = _rows_parsed(_workbook(rows=20_000, cell="y" * 40), monkeypatch)

    # `shallow > 0` is not decoration: a reader that does not stream at all
    # parses no rows through this door, and 0 == 0 is a green light for exactly
    # the form under test.
    assert shallow > 0, "no rows reached the streaming parser at all"
    assert shallow == deep
    assert shallow < 1_000, "the character budget should stop this well inside the sheet"


def test_the_row_ceiling_still_bounds_a_sheet_that_yields_no_characters(monkeypatch):
    """Blank rows spend no budget, so the row ceiling is the only thing left.

    The ceiling has to live in the streamed reader now — there is no list to
    slice — and a sheet of empty rows is the case that proves it is there.
    """
    parsed = _rows_parsed(_workbook(rows=MAX_XLSX_ROWS_PER_SHEET + 500, cell=""), monkeypatch)

    assert parsed == MAX_XLSX_ROWS_PER_SHEET


def test_a_finished_row_is_dropped_rather_than_accumulated():
    """The bound on memory is that the parser holds one row, not every row.

    Clearing the row itself frees its cells but leaves an empty `<row/>` behind
    on its parent, and at the row ceiling those are the whole leak — so the
    reader clears the parent, which detaches the finished row entirely. A row is
    live only until the next one is asked for, which is exactly as long as
    `_row_values` needs it.

    Asserted through a weak reference rather than by reading the parser's tree,
    because "detached" is the claim: an element the test is still holding is
    still alive whatever the parser did with it.
    """
    data = _sheet_xml(50, "value").encode()
    rows = _iter_sheet_rows(data, MAX_XLSX_ROWS_PER_SHEET)

    first = next(rows)
    assert len(first) == 2
    dead = weakref.ref(first)
    del first

    second = next(rows)
    assert len(second) == 2
    gc.collect()

    assert dead() is None, "the parser is still holding every row it has finished"


def test_the_streamed_rows_are_the_rows_the_tree_holds():
    """Equivalence with the form this replaced, cell by cell.

    A dense row, a sparse one, a blank one and a row whose cells are out of
    order — `_row_values` places cells by their `r` attribute, and reading rows
    in document order rather than out of a tree must not disturb that.
    """
    body = (
        '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c>'
        '<c r="B1" t="inlineStr"><is><t>b</t></is></c></row>'
        '<row r="2"><c r="C2"><v>3</v></c></row>'
        '<row r="3"></row>'
        '<row r="4"><c r="B4"><v>2</v></c><c r="A4"><v>1</v></c><c><v>x</v></c></row>'
    )
    data = f'<?xml version="1.0"?><worksheet xmlns="{_SSML}"><sheetData>{body}</sheetData></worksheet>'.encode()

    tree = documents._parse_xml_part(data)
    expected = [_row_values(r, []) for r in tree.iter(f"{{{_SSML}}}row")]
    streamed = [_row_values(r, []) for r in _iter_sheet_rows(data, MAX_XLSX_ROWS_PER_SHEET)]

    assert streamed == expected
    assert expected == [["a", "b"], ["", "", "3"], [], ["1", "2", "x"]]


def test_a_document_type_declaration_in_a_worksheet_is_still_refused():
    """The refusal moved with the parse and must not have been left behind.

    `iterparse` expands internal entities exactly as `fromstring` does, so a
    worksheet is as good a place to carry a billion laughs as the shared strings
    are — and this is the one part that no longer goes through the function that
    used to ask.
    """
    with pytest.raises(MalformedDocument):
        _xlsx_text(_workbook(rows=5, cell="y", doctype=True))

    with pytest.raises(MalformedDocument):
        next(_iter_sheet_rows(_sheet_xml(5, "y", doctype=True).encode(), 10))


def test_a_sheet_that_stops_short_of_its_damage_keeps_the_rows_it_read():
    """Where the budget ends the read, no claim is made about the rest.

    The note is owed where a read was attempted and failed. A streamed read that
    stops at the budget never reaches the damage — and this reader already says
    nothing at all about the sheets the budget stopped it from opening.
    """
    whole = _sheet_xml(2_000, "y" * 40)
    truncated = whole[: len(whole) // 2]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "xl/workbook.xml",
            f'<?xml version="1.0"?><workbook xmlns="{_SSML}"><sheets>'
            f'<sheet name="S1" sheetId="1" r:id="rId1" xmlns:r="{_REL}"/></sheets></workbook>',
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="{_REL}/worksheet"/>'
            "</Relationships>",
        )
        zf.writestr("xl/worksheets/sheet1.xml", truncated)

    text = _xlsx_text(buf.getvalue())

    assert "[this sheet could not be read]" not in text
    assert text.startswith("=== Sheet: S1 ===\n")

    # And where the budget does not get there first, the note is still what a
    # damaged part produces.
    assert "[this sheet could not be read]" in _xlsx_text(buf.getvalue(), limit=10**9)
