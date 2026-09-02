"""XLSX extraction tests — a real minimal workbook built in-memory (no deps)."""

import base64
import codecs
import io
import logging
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


def test_an_unreadable_rels_part_numbers_the_sheets_rather_than_guessing():
    """An index that is present and will not parse is not an absent one.

    Both used to answer `{}`, and `{}` is licence to pair the Nth declared sheet
    with `sheet{N}.xml` — so a workbook whose tabs had been reordered came out
    with "=== Sheet: Cap Table ===" over its revenue rows, asserted in the
    corpus under the client's own tab names, with nothing raised and nothing
    counted. The heading is the model's only cue for what a block of rows is.

    The rows are all kept; only the pairing, which is the thing that was
    actually lost, goes with it.
    """
    [doc] = extract_texts([_doc(_reordered_bytes(rels="<Relationships><Relat"))])
    assert "CAP-TABLE-ROWS" in doc.text and "REVENUE-ROWS" in doc.text
    assert "Cap Table" not in doc.text
    assert "Financials" not in doc.text
    assert "=== Sheet: Sheet1 ===\nREVENUE-ROWS" in doc.text
    assert "=== Sheet: Sheet2 ===\nCAP-TABLE-ROWS" in doc.text


def test_an_unreadable_rels_part_is_said_out_loud(caplog):
    """The corpus heading claims nothing now, and nothing in it says why. One
    file is a client's odd export; the same line under every upload is this
    reader."""
    with caplog.at_level(logging.WARNING, logger="documents"):
        extract_texts([_doc(_reordered_bytes(rels="<Relationships><Relat"))])
    assert any(
        getattr(r, "event", None) == "xlsx_sheet_index_unreadable" for r in caplog.records
    )


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


# --- phonetic guides ---------------------------------------------------------
#
# Furigana. A workbook typed with a Japanese IME stores, beside the text, the
# reading the typist entered to produce it — `<rPh>` runs inside the same `<si>`
# or `<is>`, keyed to a span of the value. Excel prints them above the cell;
# they are not the cell. `iter()` descends, so joining every `<t>` under the
# container appended the reading to the value: a shareholder called 山田太郎
# extracted as 山田太郎ヤマダタロウ, in the text that *is* the model's input to
# the extraction pipeline.

_PHONETIC_SHARED_STRINGS = """<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>山田太郎</t><rPh sb="0" eb="2"><t>ヤマダ</t></rPh><rPh sb="2" eb="4"><t>タロウ</t></rPh><phoneticPr fontId="1" type="Hiragana"/></si>
  <si><r><rPr><b/></rPr><t>Acme</t></r><r><t xml:space="preserve"> Holdings</t></r><rPh sb="0" eb="4"><t>アクメ</t></rPh></si>
</sst>"""

_PHONETIC_SHEET = """<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="inlineStr"><is><t>佐藤</t><rPh sb="0" eb="2"><t>サトウ</t></rPh></is></c>
    </row>
  </sheetData>
</worksheet>"""


def _phonetic_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("xl/workbook.xml", _WORKBOOK)
        zf.writestr("xl/sharedStrings.xml", _PHONETIC_SHARED_STRINGS)
        zf.writestr("xl/worksheets/sheet1.xml", _PHONETIC_SHEET)
    return buf.getvalue()


def test_a_shared_string_drops_its_phonetic_guide():
    [doc] = extract_texts([_doc(_phonetic_bytes())])
    assert "山田太郎\t" in doc.text
    assert "ヤマダ" not in doc.text
    assert "タロウ" not in doc.text


def test_formatting_runs_are_kept_alongside_a_guide():
    # `<r>` splits one string across styles and is the value; `<rPh>` sits
    # beside it and is not. Only the second is dropped.
    [doc] = extract_texts([_doc(_phonetic_bytes())])
    assert "Acme Holdings" in doc.text
    assert "アクメ" not in doc.text


def test_an_inline_string_drops_its_phonetic_guide():
    [doc] = extract_texts([_doc(_phonetic_bytes())])
    assert doc.text.rstrip().endswith("佐藤")
    assert "サトウ" not in doc.text


# ── XML entity expansion ─────────────────────────────────────────────────────
#
# The decompression budget bounds what `zipfile` inflates and nothing about what
# the XML parser then allocates. `ElementTree` expands internal entities, so a
# few hundred bytes of declarations inside a part that is well within budget
# expands by a factor of ten per level once it is parsed.

def _entity_bomb_shared_strings(levels: int) -> str:
    """`levels` nested declarations, each ten references to the one below."""
    decls = ['<!ENTITY e0 "' + "a" * 50 + '">']
    for i in range(1, levels):
        decls.append(f'<!ENTITY e{i} "{("&e" + str(i - 1) + ";") * 10}">')
    return (
        '<?xml version="1.0"?>\n<!DOCTYPE sst [\n' + "\n".join(decls) + "\n]>\n"
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<si><t>&e{levels - 1};</t></si></sst>'
    )


def _bomb_xlsx(levels: int = 6) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("xl/workbook.xml", _WORKBOOK)
        zf.writestr("xl/sharedStrings.xml", _entity_bomb_shared_strings(levels))
        zf.writestr("xl/worksheets/sheet1.xml", _SHEET1)
    return buf.getvalue()


def test_entity_bomb_is_refused_rather_than_expanded():
    raw = _bomb_xlsx()
    # Well inside the decompression budget — the point of the test is that the
    # budget is not what stops this.
    assert len(raw) < 4096
    [doc] = extract_texts([_doc(raw)])
    assert doc.text.startswith("[could not extract text:")
    assert "document type declaration" in doc.text
    # 6 levels expand to ~50 MB of 'a'; nothing of the kind reached the output.
    assert "aaaaaaaaaa" not in doc.text


def test_a_doctype_is_refused_wherever_it_leads_a_part():
    """The scan reads the prolog, so a declaration behind a comment still counts."""
    from app.documents import _has_doctype

    assert _has_doctype(b'<?xml version="1.0"?>\n<!DOCTYPE sst []>\n<sst/>')
    assert _has_doctype(b"<!-- written by a tool --> <!DOCTYPE sst []><sst/>")
    assert _has_doctype(codecs.BOM_UTF8 + b"<!DOCTYPE sst []><sst/>")
    # A cell whose text merely says so is past the root element, and escaped.
    assert not _has_doctype(b'<?xml version="1.0"?><sst><si><t>&lt;!DOCTYPE x&gt;</t></si></sst>')
    assert not _has_doctype(b"<sst/>")


def _bomb_xlsx_in(encoding: str, *, bom: bytes = b"", levels: int = 6) -> bytes:
    """The same bomb, with its shared-strings part written in a wide encoding."""
    part = bom + _entity_bomb_shared_strings(levels).encode(encoding)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("xl/workbook.xml", _WORKBOOK)
        zf.writestr("xl/sharedStrings.xml", part)
        zf.writestr("xl/worksheets/sheet1.xml", _SHEET1)
    return buf.getvalue()


@pytest.mark.parametrize(
    ("encoding", "bom"),
    [
        ("utf-16-le", codecs.BOM_UTF16_LE),
        ("utf-16-be", codecs.BOM_UTF16_BE),
        ("utf-16-le", b""),
        ("utf-16-be", b""),
        ("utf-32-le", codecs.BOM_UTF32_LE),
        ("utf-32-be", codecs.BOM_UTF32_BE),
        ("utf-32-le", b""),
        ("utf-32-be", b""),
    ],
)
def test_a_doctype_is_refused_in_every_encoding_expat_detects(encoding: str, bom: bytes):
    """The refusal has to read the bytes the way the parser behind it does.

    expat resolves the encoding from the document's first bytes — the XML 1.0
    autodetection table — so a part whose markup is spelled two or four bytes to
    the character is still a part whose entities it will expand. The scan looked
    for `<!DOCTYPE` spelled in single bytes and found none in any of these.
    """
    raw = _bomb_xlsx_in(encoding, bom=bom)
    [doc] = extract_texts([_doc(raw)])
    assert doc.text.startswith("[could not extract text:")
    assert "document type declaration" in doc.text
    assert "aaaaaaaaaa" not in doc.text


def test_a_wide_part_with_no_declaration_is_still_read():
    """The transcode is a reading, not a refusal — an ordinary UTF-16 part parses."""
    from app.documents import _has_doctype

    clean = '<?xml version="1.0"?><sst><si><t>hi</t></si></sst>'
    assert not _has_doctype(codecs.BOM_UTF16_LE + clean.encode("utf-16-le"))
    assert not _has_doctype(clean.encode("utf-16-be"))


def test_an_ordinary_workbook_still_parses():
    [doc] = extract_texts([_doc(_xlsx_bytes())])
    assert "Series A\t2000000" in doc.text


# ── A part that will not parse (R344, methodology M5) ────────────────────────


def _xlsx_with(parts: dict[str, str]) -> bytes:
    """The minimal workbook with named parts replaced or added."""
    base = {
        "[Content_Types].xml": _CONTENT_TYPES,
        "xl/workbook.xml": _WORKBOOK,
        "xl/sharedStrings.xml": _SHARED_STRINGS,
        "xl/worksheets/sheet1.xml": _SHEET1,
    }
    base.update(parts)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, body in base.items():
            zf.writestr(name, body)
    return buf.getvalue()


#: Well-formed up to the point where it stops — what a truncated upload,
#: a partial write or a repaired file leaves behind.
_TRUNCATED_STRINGS = (
    '<?xml version="1.0"?>'
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    "<si><t>Class</t></si"
)


def test_an_unreadable_string_table_is_declared_and_not_blanked(caplog):
    """Every `t="s"` cell resolves through this table; `[]` empties all of them.

    The numbers survive a broken string table and the text does not, so the
    silent version of this produced a cap table with the right share counts
    against no security classes at all — which is not a degraded reading of the
    file, it is a different file.
    """
    with caplog.at_level("WARNING"):
        [doc] = extract_texts([_doc(_xlsx_with({"xl/sharedStrings.xml": _TRUNCATED_STRINGS}))])

    assert doc.text.startswith("[could not extract text:")
    assert "shared string table" in doc.text
    # The half-read workbook must not reach the corpus beside the note.
    assert "2000000" not in doc.text
    assert [r for r in caplog.records if getattr(r, "event", None) == "document_extract_failed"]
    tally = [r for r in caplog.records if getattr(r, "event", None) == "documents_unreadable"]
    assert [(r.count, r.total) for r in tally] == [(1, 1)]


def test_a_workbook_with_no_string_table_is_read_as_it_always_was():
    """The other half of the pair: an absent part is a fact, not a failure.

    A sheet whose text is written inline carries no `sharedStrings.xml` at all,
    and refusing that would refuse an ordinary workbook.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES)
        zf.writestr("xl/workbook.xml", _WORKBOOK)
        zf.writestr("xl/worksheets/sheet1.xml", _SHEET1)
    [doc] = extract_texts([_doc(buf.getvalue())])

    assert not doc.text.startswith("[could not extract text:")
    assert "Common\t7000000" in doc.text  # the inline string is still there


_TWO_SHEET_WORKBOOK = """<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="Cap Table" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
    <sheet name="Financials" sheetId="2" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
  </sheets>
</workbook>"""

_SHEET2 = """<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Revenue</t></is></c><c r="B1"><v>4200000</v></c></row>
  </sheetData>
</worksheet>"""


def test_an_unreadable_sheet_is_named_rather_than_dropped(caplog):
    """A tab the workbook declares must not disappear out of the extraction.

    Dropped, the corpus reads exactly like a workbook that never had that tab —
    and the sheet headings are the only evidence in this text of how many there
    were.
    """
    raw = _xlsx_with(
        {
            "xl/workbook.xml": _TWO_SHEET_WORKBOOK,
            "xl/worksheets/sheet1.xml": '<?xml version="1.0"?><worksheet><sheetData><row',
            "xl/worksheets/sheet2.xml": _SHEET2,
        }
    )
    with caplog.at_level("WARNING"):
        [doc] = extract_texts([_doc(raw)])

    assert "=== Sheet: Cap Table ===" in doc.text
    assert "[this sheet could not be read]" in doc.text
    # And the sheet that is fine is still read in full.
    assert "Revenue\t4200000" in doc.text
    # Not counted as a failed document: the file was read, one part of it was not.
    assert not doc.text.startswith("[could not extract text:")
    [line] = [r for r in caplog.records if getattr(r, "event", None) == "xlsx_sheets_unreadable"]
    assert (line.count, line.total) == (1, 2)


def test_an_intact_workbook_logs_nothing_about_its_sheets(caplog):
    """Vacuity guard: the line above is a condition, not a constant."""
    with caplog.at_level("WARNING"):
        extract_texts([_doc(_xlsx_bytes())])
    assert not [r for r in caplog.records if getattr(r, "event", None) == "xlsx_sheets_unreadable"]
