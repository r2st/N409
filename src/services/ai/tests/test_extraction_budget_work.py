"""The extractors stop at the budget the caller keeps (R338, methodology M8).

`extract_texts` ends every document with `text.strip()[:MAX_CHARS_PER_DOC]`, so
anything the PDF and workbook readers produce past that character is extracted
and immediately discarded. These tests pin the work, not just the output: a page
that is never opened and a row that is never walked are the whole point, and an
assertion on the returned string cannot tell a bounded reader from an unbounded
one — both return the same 20,000 characters.
"""

import base64
import io
import zipfile

import pytest

from app.documents import MAX_CHARS_PER_DOC, MAX_XLSX_ROWS_PER_SHEET, _pdf_text, _xlsx_text

# A page's worth of text, sized so the budget is reached well before the
# forty-page ceiling that used to be the only bound.
_PAGE_CHARS = 4_000


class _Page:
    def __init__(self, tally: list[int], index: int) -> None:
        self._tally = tally
        self._index = index

    def extract_text(self) -> str:
        self._tally.append(self._index)
        return "x" * _PAGE_CHARS


class _Reader:
    """Stands in for `PdfReader`; counts which pages were actually decoded."""

    def __init__(self, tally: list[int], count: int) -> None:
        self.pages = [_Page(tally, i) for i in range(count)]


@pytest.fixture()
def decoded(monkeypatch):
    tally: list[int] = []
    monkeypatch.setattr("app.documents.PdfReader", lambda _stream: _Reader(tally, 40))
    return tally


def test_the_pdf_reader_stops_once_the_budget_is_covered(decoded):
    text = _pdf_text(b"%PDF-1.4 stub")

    # Enough pages to fill the budget, and not one more: 20,000 characters at
    # 4,000 a page is five pages.
    assert len(decoded) == MAX_CHARS_PER_DOC // _PAGE_CHARS
    assert len(text) >= MAX_CHARS_PER_DOC


def test_the_pdf_reader_returns_what_the_unbounded_one_would_have(decoded):
    bounded = _pdf_text(b"%PDF-1.4 stub")
    unbounded = _pdf_text(b"%PDF-1.4 stub", limit=10**9)

    # The kept prefix is identical — stopping early is a saving, not a change of
    # answer. The forty-page ceiling still applies to the unbounded read.
    assert bounded[:MAX_CHARS_PER_DOC] == unbounded[:MAX_CHARS_PER_DOC]
    assert len(decoded) == 40 + MAX_CHARS_PER_DOC // _PAGE_CHARS


def test_a_sparse_pdf_still_stops_at_the_page_ceiling(monkeypatch):
    """A scan of images yields no characters, so the budget cannot bound it."""
    tally: list[int] = []

    class _Blank(_Page):
        def extract_text(self) -> str:
            tally.append(self._index)
            return ""

    class _BlankReader:
        def __init__(self) -> None:
            self.pages = [_Blank(tally, i) for i in range(500)]

    monkeypatch.setattr("app.documents.PdfReader", lambda _stream: _BlankReader())
    # The ceiling is what this test is about, and it still holds. The refusal
    # is R397's: forty pages of nothing is a scan, not a blank document, and
    # returning "" said the second thing. See
    # `test_a_pdf_with_no_extractable_text_is_declared_not_read_as_blank`.
    with pytest.raises(ValueError):
        _pdf_text(b"%PDF-1.4 stub")
    assert len(tally) == 40


# ── Workbooks ────────────────────────────────────────────────────────────────

_CONTENT_TYPES = """<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>"""


def _sheet_xml(rows: int, wide: str) -> str:
    body = "".join(
        f'<row r="{n + 1}"><c r="A{n + 1}" t="inlineStr"><is><t>{wide}</t></is></c></row>'
        for n in range(rows)
    )
    return (
        '<?xml version="1.0"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{body}</sheetData></worksheet>"
    )


def _workbook(sheets: int, rows: int, cell: str) -> bytes:
    names = "".join(
        f'<sheet name="S{i + 1}" sheetId="{i + 1}" r:id="rId{i + 1}" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>'
        for i in range(sheets)
    )
    rels = "".join(
        f'<Relationship Id="rId{i + 1}" Target="worksheets/sheet{i + 1}.xml" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>'
        for i in range(sheets)
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f"<sheets>{names}</sheets></workbook>",
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{rels}</Relationships>",
        )
        for i in range(sheets):
            zf.writestr(f"xl/worksheets/sheet{i + 1}.xml", _sheet_xml(rows, cell))
    return buf.getvalue()


def test_the_workbook_reader_stops_once_the_budget_is_covered():
    # Twenty sheets of two hundred rows: far past the budget, well inside both
    # declared ceilings, so only the budget can stop it.
    raw = _workbook(sheets=20, rows=200, cell="y" * 200)
    text = _xlsx_text(raw)

    assert len(text) >= MAX_CHARS_PER_DOC
    # One sheet's rows are ~40,000 characters, so the walk ends inside the first
    # sheet rather than parsing all twenty.
    assert text.count("=== Sheet:") == 1
    assert len(text) < 2 * MAX_CHARS_PER_DOC


def test_the_workbook_prefix_matches_the_unbounded_read():
    raw = _workbook(sheets=20, rows=200, cell="y" * 200)
    bounded = _xlsx_text(raw)
    unbounded = _xlsx_text(raw, limit=10**9)

    assert bounded[:MAX_CHARS_PER_DOC] == unbounded[:MAX_CHARS_PER_DOC]
    assert unbounded.count("=== Sheet:") == 20


def test_an_empty_workbook_still_stops_at_the_row_ceiling():
    """Blank rows yield no characters, so the row ceiling is what bounds them."""
    raw = _workbook(sheets=1, rows=MAX_XLSX_ROWS_PER_SHEET + 500, cell="")
    text = _xlsx_text(raw)
    # Nothing but the header: every row is empty and skipped, and the walk still
    # terminates rather than running to the end of the sheet.
    assert text == "=== Sheet: S1 ==="


def test_a_budgeted_document_reaches_extract_texts_intact(monkeypatch):
    from app.documents import extract_texts

    raw = _workbook(sheets=20, rows=200, cell="y" * 200)
    doc = {
        "id": "d1",
        "filename": "cap.xlsx",
        "kind": "cap_table",
        "content_base64": base64.b64encode(raw).decode(),
    }
    out = extract_texts([doc])
    assert len(out) == 1
    assert len(out[0].text) == MAX_CHARS_PER_DOC


# ── A PDF whose pages carry no text ──────────────────────────────────────────


def test_a_pdf_with_no_extractable_text_is_declared_not_read_as_blank(monkeypatch):
    """Every page returning "" made the reader return "\n", which reached the
    corpus as a document with nothing under its heading — indistinguishable
    from one that had nothing in it. R397 (M11)."""
    from app.documents import extract_texts

    class _Blank:
        def extract_text(self) -> str:
            return ""

    class _BlankReader:
        pages = [_Blank(), _Blank()]

    monkeypatch.setattr("app.documents.PdfReader", lambda _stream: _BlankReader())
    doc = {
        "id": "d",
        "filename": "board_consent.pdf",
        "kind": "other",
        "content_base64": base64.b64encode(b"%PDF-1.4 stub").decode(),
    }
    [out] = extract_texts([doc])
    assert out.text.startswith("[could not extract text:")
    # The sentence has to name the fix — it is the one thing separating this
    # from every other unreadable file.
    assert "OCR" in out.text


def test_a_pdf_whose_pages_carry_text_is_untouched(monkeypatch):
    class _Reader1:
        pages = [type("P", (), {"extract_text": lambda self: "Board consent"})()]

    monkeypatch.setattr("app.documents.PdfReader", lambda _stream: _Reader1())
    assert _pdf_text(b"%PDF-1.4 stub") == "Board consent"
