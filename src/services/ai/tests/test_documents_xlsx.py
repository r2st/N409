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
