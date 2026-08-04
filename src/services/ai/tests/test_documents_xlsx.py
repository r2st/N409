"""XLSX extraction tests — a real minimal workbook built in-memory (no deps)."""

import base64
import io
import zipfile

from app.documents import extract_texts

_CONTENT_TYPES = """<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>"""

_WORKBOOK = """<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="Cap Table" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
  </sheets>
</workbook>"""

_SHARED_STRINGS = """<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Class</t></si>
  <si><t>Shares</t></si>
  <si><t>Series A</t></si>
</sst>"""

_SHEET1 = """<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2"><v>2000000</v></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>Common</t></is></c>
      <c r="B3"><v>7000000</v></c>
    </row>
  </sheetData>
</worksheet>"""


def _xlsx_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("xl/workbook.xml", _WORKBOOK)
        zf.writestr("xl/sharedStrings.xml", _SHARED_STRINGS)
        zf.writestr("xl/worksheets/sheet1.xml", _SHEET1)
    return buf.getvalue()


def _doc(raw: bytes, filename: str = "cap_table.xlsx") -> dict:
    return {
        "id": "doc1",
        "filename": filename,
        "kind": "cap_table",
        "content_base64": base64.b64encode(raw).decode(),
    }


def test_xlsx_extracts_sheet_rows():
    [doc] = extract_texts([_doc(_xlsx_bytes())])
    assert "=== Sheet: Cap Table ===" in doc.text
    assert "Class\tShares" in doc.text  # shared strings
    assert "Series A\t2000000" in doc.text  # shared string + number
    assert "Common\t7000000" in doc.text  # inline string


def test_xlsm_uses_the_same_parser():
    [doc] = extract_texts([_doc(_xlsx_bytes(), filename="model.xlsm")])
    assert "Series A" in doc.text


def test_corrupt_xlsx_degrades_to_note():
    [doc] = extract_texts([_doc(b"this is not a zip file")])
    assert doc.text.startswith("[could not extract text:")


# ── Sparse rows ──────────────────────────────────────────────────────────────
#
# Excel does not store empty cells, so a row whose middle column is blank has
# no <c> element for it at all. Every later value has to stay under its own
# header regardless.

_SPARSE_STRINGS = """<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Class</t></si>
  <si><t>Price</t></si>
  <si><t>Shares</t></si>
  <si><t>Series A</t></si>
  <si><t>Common</t></si>
</sst>"""

_SPARSE_SHEET = """<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>3</v></c>
      <c r="C2"><v>2000000</v></c>
    </row>
    <row r="3">
      <c r="C3"><v>7000000</v></c>
    </row>
    <row r="4">
      <c r="A4" t="s"><v>4</v></c>
      <c r="B4"><v>0.0001</v></c>
      <c r="C4"><v>9000000</v></c>
    </row>
  </sheetData>
</worksheet>"""


def _sparse_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("xl/workbook.xml", _WORKBOOK)
        zf.writestr("xl/sharedStrings.xml", _SPARSE_STRINGS)
        zf.writestr("xl/worksheets/sheet1.xml", _SPARSE_SHEET)
    return buf.getvalue()


def test_omitted_cell_keeps_later_values_under_their_own_header():
    [doc] = extract_texts([_doc(_sparse_bytes())])
    lines = doc.text.splitlines()
    assert lines[1] == "Class\tPrice\tShares"
    # Price is blank; 2,000,000 is a share count and must stay in column C.
    assert lines[2] == "Series A\t\t2000000"
    assert lines[2].split("\t")[2] == "2000000"


def test_row_missing_its_leading_cells_is_padded_from_column_a():
    [doc] = extract_texts([_doc(_sparse_bytes())])
    lines = doc.text.splitlines()
    assert lines[3] == "\t\t7000000"


def test_dense_row_is_unchanged():
    [doc] = extract_texts([_doc(_sparse_bytes())])
    assert "Common\t0.0001\t9000000" in doc.text


def test_trailing_blanks_are_not_padded_out():
    """Only the gaps between real cells are filled; nothing is invented past
    the last one, so the rows stay compact in the character budget."""
    [doc] = extract_texts([_doc(_xlsx_bytes())])
    for line in doc.text.splitlines()[1:]:
        assert not line.endswith("\t")


def test_a_far_right_cell_does_not_pad_the_row_to_16k_columns():
    """One cell at XFD would otherwise turn every row into 16k tab characters
    and eat the document's whole character budget."""
    sheet = """<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>here</t></is></c>
                <c r="XFD1" t="inlineStr"><is><t>far</t></is></c></row>
  </sheetData>
</worksheet>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/workbook.xml", _WORKBOOK)
        zf.writestr("xl/worksheets/sheet1.xml", sheet)
    [doc] = extract_texts([_doc(buf.getvalue())])
    assert "here" in doc.text
    assert doc.text.count("\t") < 512


# ── Sheet name ↔ part pairing ────────────────────────────────────────────────
#
# The N in worksheets/sheetN.xml is a creation-order id, not a tab position.
# Reordering or deleting a tab in Excel makes the two diverge for good.

_REORDERED_WORKBOOK = """<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Cap Table"  sheetId="2" r:id="rId2"/>
    <sheet name="Financials" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>"""

_REORDERED_RELS = """<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>"""


def _one_cell_sheet(label: str) -> str:
    return f"""<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>{label}</t></is></c></row>
  </sheetData>
</worksheet>"""


def _reordered_bytes(rels: str | None = _REORDERED_RELS) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/workbook.xml", _REORDERED_WORKBOOK)
        if rels is not None:
            zf.writestr("xl/_rels/workbook.xml.rels", rels)
        zf.writestr("xl/worksheets/sheet1.xml", _one_cell_sheet("REVENUE-ROWS"))
        zf.writestr("xl/worksheets/sheet2.xml", _one_cell_sheet("CAP-TABLE-ROWS"))
    return buf.getvalue()


def test_sheet_names_follow_the_relationship_not_the_filename_number():
    [doc] = extract_texts([_doc(_reordered_bytes())])
    assert "=== Sheet: Cap Table ===\nCAP-TABLE-ROWS" in doc.text
    assert "=== Sheet: Financials ===\nREVENUE-ROWS" in doc.text


def test_sheets_are_emitted_in_workbook_tab_order():
    [doc] = extract_texts([_doc(_reordered_bytes())])
    assert doc.text.index("Cap Table") < doc.text.index("Financials")


def test_absent_rels_falls_back_to_positional_pairing():
    """A workbook with no relationships part can only be a simple one, so the
    positional guess is still the best available and must not be dropped."""
    [doc] = extract_texts([_doc(_reordered_bytes(rels=None))])
    assert "=== Sheet: Cap Table ===\nREVENUE-ROWS" in doc.text
    assert "=== Sheet: Financials ===\nCAP-TABLE-ROWS" in doc.text


def test_root_relative_and_dot_prefixed_targets_resolve():
    workbook = """<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Rooted" r:id="rId1"/>
    <sheet name="Dotted" r:id="rId2"/>
  </sheets>
</workbook>"""
    rels = """<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="./worksheets/sheet2.xml"/>
</Relationships>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", rels)
        zf.writestr("xl/worksheets/sheet1.xml", _one_cell_sheet("ROOTED"))
        zf.writestr("xl/worksheets/sheet2.xml", _one_cell_sheet("DOTTED"))
    [doc] = extract_texts([_doc(buf.getvalue())])
    assert "=== Sheet: Rooted ===\nROOTED" in doc.text
    assert "=== Sheet: Dotted ===\nDOTTED" in doc.text


def test_a_sheet_whose_part_is_missing_is_skipped_without_shifting_the_rest():
    workbook = """<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Gone" r:id="rId9"/>
    <sheet name="Here" r:id="rId1"/>
  </sheets>
</workbook>"""
    rels = """<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId9" Target="worksheets/sheet9.xml"/>
</Relationships>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", rels)
        zf.writestr("xl/worksheets/sheet1.xml", _one_cell_sheet("HERE-ROWS"))
    [doc] = extract_texts([_doc(buf.getvalue())])
    assert "=== Sheet: Here ===\nHERE-ROWS" in doc.text
    assert "Gone" not in doc.text


def test_cells_without_a_ref_still_trail_the_row():
    sheet = """<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c>
                <c t="inlineStr"><is><t>unplaced</t></is></c></row>
  </sheetData>
</worksheet>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/workbook.xml", _WORKBOOK)
        zf.writestr("xl/worksheets/sheet1.xml", sheet)
    [doc] = extract_texts([_doc(buf.getvalue())])
    assert "first\tunplaced" in doc.text


# ── Decompression budget ─────────────────────────────────────────────────────
#
# An `.xlsx` is a ZIP, and `zipfile` inflates a member as far as it goes. The
# character limits in this module bound extraction's *output* and nothing about
# the bytes read to produce it — a part is fully materialised before a single
# character is counted. Deflate reaches ~1000:1 on a run of one byte, so the
# 32 MB request-body cap bounded what an attacker sent and nothing at all about
# what this process allocated: measured, a 398 KiB archive grew resident memory
# by 1.2 GiB, and the body cap admits sixty of those in one request.

import struct

import pytest

from app.documents import (
    MAX_XLSX_INFLATED_BUDGET,
    MIN_XLSX_INFLATED_BUDGET,
    DocumentTooLarge,
    _BoundedZip,
    xlsx_inflated_budget,
)


def _bomb(inflated_bytes: int, *, declare: int | None = None) -> bytes:
    """An archive whose sharedStrings part inflates to `inflated_bytes`.

    `declare` rewrites the uncompressed-size fields so the header lies, leaving
    only the metered read able to stop it.
    """
    buf = io.BytesIO()
    payload = b"<sst><si><t>" + b"A" * inflated_bytes + b"</t></si></sst>"
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("xl/sharedStrings.xml", payload)
        z.writestr("xl/workbook.xml", "<workbook/>")
    raw = bytearray(buf.getvalue())
    if declare is not None:
        for i in range(len(raw) - 4):
            if struct.unpack_from("<I", raw, i)[0] == len(payload):
                struct.pack_into("<I", raw, i, declare)
    return bytes(raw)


class TestInflatedBudget:
    def test_a_small_archive_still_gets_a_workable_floor(self):
        # No legitimate small workbook may be refused for being small.
        assert xlsx_inflated_budget(1) == MIN_XLSX_INFLATED_BUDGET
        assert xlsx_inflated_budget(100 * 1024) == MIN_XLSX_INFLATED_BUDGET

    def test_the_budget_scales_with_the_archive_between_floor_and_ceiling(self):
        # Scaling with the input is what bounds the amplification an attacker
        # can buy: they must send a megabyte to cost us twenty.
        assert xlsx_inflated_budget(4 * 1024 * 1024) == 80 * 1024 * 1024

    def test_no_archive_whatsoever_gets_past_the_ceiling(self):
        assert xlsx_inflated_budget(1024 * 1024 * 1024) == MAX_XLSX_INFLATED_BUDGET


class TestZipBomb:
    def test_the_measured_bomb_is_refused_instead_of_resident(self):
        archive = _bomb(400 * 1024 * 1024)
        # Still a small upload — this is the whole point.
        assert len(archive) < 1024 * 1024
        docs = extract_texts([_doc(archive, "cap.xlsx")])
        assert "decompression limit" in docs[0].text

    def test_a_header_that_lies_about_the_size_is_caught_by_the_read(self):
        # The declared uncompressed size is a number the archive chose, so it is
        # a cheap pre-check and never the guard.
        archive = _bomb(300 * 1024 * 1024, declare=1024)
        docs = extract_texts([_doc(archive, "cap.xlsx")])
        # Refused one way or the other — what must not happen is 300 MB resident.
        assert docs[0].text.startswith("[could not extract text:")

    def test_one_bad_workbook_does_not_sink_the_rest_of_the_run(self):
        # The module's contract: extraction failures degrade to a note.
        docs = extract_texts(
            [_doc(_bomb(400 * 1024 * 1024), "bomb.xlsx"), _doc(_xlsx_bytes(), "real.xlsx")]
        )
        assert "decompression limit" in docs[0].text
        assert "Series A" in docs[1].text

    def test_an_ordinary_workbook_is_untouched_by_the_budget(self):
        docs = extract_texts([_doc(_xlsx_bytes())])
        assert "=== Sheet: Cap Table ===" in docs[0].text
        assert "Series A" in docs[0].text


class TestBoundedZip:
    def _archive(self, parts: dict[str, bytes]) -> zipfile.ZipFile:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in parts.items():
                z.writestr(name, data)
        return zipfile.ZipFile(io.BytesIO(buf.getvalue()))

    def test_the_budget_is_shared_across_parts_not_per_part(self):
        # A per-part limit is one a hundred parts could each sit just under.
        payload = b"B" * 4096
        zf = _BoundedZip(self._archive({f"p{i}.xml": payload for i in range(4)}), 10_000)
        assert len(zf.read("p0.xml")) == 4096
        assert len(zf.read("p1.xml")) == 4096
        with pytest.raises(DocumentTooLarge):
            zf.read("p2.xml")

    def test_a_missing_member_is_still_a_key_error(self):
        # The callers catch KeyError to mean "this part isn't in the archive";
        # metering must not change that into something they don't handle.
        zf = _BoundedZip(self._archive({"a.xml": b"<a/>"}), 10_000)
        with pytest.raises(KeyError):
            zf.read("nope.xml")

    def test_a_part_that_exactly_fills_the_budget_is_allowed(self):
        payload = b"C" * 1000
        zf = _BoundedZip(self._archive({"a.xml": payload}), 1000)
        assert zf.read("a.xml") == payload
        # ...and the next read has nothing left.
        with pytest.raises(DocumentTooLarge):
            zf.read("a.xml")
