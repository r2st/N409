"""Document text extraction for the AI pipelines.

The valuation service ships documents as base64 (they live on its disk).
Supported: PDF (pypdf), XLSX/XLSM (stdlib zip + XML — cap tables and
financials usually arrive as Excel), and anything text-like
(csv/tsv/txt/md/json). Extraction failures degrade to a note so one bad
file never sinks a run.
"""

from __future__ import annotations

import base64
import io
import re
import zipfile
from dataclasses import dataclass
from xml.etree import ElementTree

from pypdf import PdfReader

MAX_CHARS_PER_DOC = 20_000
MAX_TOTAL_CHARS = 60_000
MAX_XLSX_SHEETS = 20
MAX_XLSX_ROWS_PER_SHEET = 2_000

_SSML = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


@dataclass
class DocText:
    id: str
    filename: str
    kind: str
    text: str


def _pdf_text(raw: bytes) -> str:
    reader = PdfReader(io.BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages[:40]]
    return "\n".join(pages)


def _xlsx_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(zf.read("xl/sharedStrings.xml"))
    except (KeyError, ElementTree.ParseError):
        return []
    # Each <si> may hold one <t> or rich-text runs of <r><t>; join the runs.
    return ["".join(t.text or "" for t in si.iter(f"{_SSML}t")) for si in root.iter(f"{_SSML}si")]


def _xlsx_sheet_names(zf: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(zf.read("xl/workbook.xml"))
        return [s.get("name") or "" for s in root.iter(f"{_SSML}sheet")]
    except (KeyError, ElementTree.ParseError):
        return []


def _xlsx_cell_value(cell: ElementTree.Element, shared: list[str]) -> str:
    kind = cell.get("t")
    if kind == "inlineStr":
        return "".join(t.text or "" for t in cell.iter(f"{_SSML}t"))
    v = cell.find(f"{_SSML}v")
    raw = v.text if v is not None and v.text is not None else ""
    if kind == "s":
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            return ""
    if kind == "b":
        return "TRUE" if raw == "1" else "FALSE"
    return raw


def _col_index(ref: str | None) -> int:
    """'BC12' → 0-based column 54; missing refs sort to the end of the row."""
    if not ref:
        return 1 << 14
    idx = 0
    for ch in ref:
        if not ch.isalpha():
            break
        idx = idx * 26 + (ord(ch.upper()) - 64)
    return idx - 1 if idx else 1 << 14


def _xlsx_text(raw: bytes) -> str:
    """Tab-separated rows per sheet — enough structure for the LLM to read a
    cap table without a spreadsheet dependency."""
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        shared = _xlsx_shared_strings(zf)
        names = _xlsx_sheet_names(zf)
        sheet_paths = sorted(
            (p for p in zf.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", p)),
            key=lambda p: int(re.search(r"\d+", p).group()),  # type: ignore[union-attr]
        )[:MAX_XLSX_SHEETS]
        blocks: list[str] = []
        for i, path in enumerate(sheet_paths):
            try:
                root = ElementTree.fromstring(zf.read(path))
            except ElementTree.ParseError:
                continue
            name = names[i] if i < len(names) else f"Sheet{i + 1}"
            lines = [f"=== Sheet: {name} ==="]
            for row in list(root.iter(f"{_SSML}row"))[:MAX_XLSX_ROWS_PER_SHEET]:
                cells = sorted(row.findall(f"{_SSML}c"), key=lambda c: _col_index(c.get("r")))
                values = [_xlsx_cell_value(c, shared) for c in cells]
                if any(v.strip() for v in values):
                    lines.append("\t".join(values).rstrip())
            blocks.append("\n".join(lines))
        return "\n\n".join(blocks)


def extract_texts(documents: list[dict]) -> list[DocText]:
    out: list[DocText] = []
    total = 0
    for doc in documents:
        if total >= MAX_TOTAL_CHARS:
            break
        try:
            raw = base64.b64decode(doc.get("content_base64") or "")
        except Exception:
            raw = b""
        name = str(doc.get("filename") or "document")
        try:
            if name.lower().endswith(".pdf"):
                text = _pdf_text(raw)
            elif name.lower().endswith((".xlsx", ".xlsm")):
                text = _xlsx_text(raw)
            else:
                text = raw.decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001 — degrade, don't fail the run
            text = f"[could not extract text: {exc}]"
        text = text.strip()[:MAX_CHARS_PER_DOC]
        total += len(text)
        out.append(
            DocText(
                id=str(doc.get("id") or ""),
                filename=name,
                kind=str(doc.get("kind") or "other"),
                text=text,
            )
        )
    return out


def render_corpus(docs: list[DocText]) -> str:
    if not docs:
        return "(no documents uploaded)"
    blocks = [
        f'--- DOCUMENT {i + 1}: "{d.filename}" (type: {d.kind}) ---\n{d.text or "(empty)"}'
        for i, d in enumerate(docs)
    ]
    return "\n\n".join(blocks)
