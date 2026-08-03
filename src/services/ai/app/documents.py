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
_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_OFFICE_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


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


def _xlsx_rels(zf: zipfile.ZipFile) -> dict[str, str]:
    """Relationship id → part target, from the workbook's relationships part."""
    try:
        root = ElementTree.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    except (KeyError, ElementTree.ParseError):
        return {}
    out: dict[str, str] = {}
    for rel in root.iter(f"{_PKG_REL}Relationship"):
        rid, target = rel.get("Id"), rel.get("Target")
        if rid and target:
            out[rid] = target
    return out


def _xlsx_sheets(zf: zipfile.ZipFile) -> list[tuple[str, str]]:
    """(sheet name, part path) in workbook tab order.

    The name and the part have to be resolved together. `xl/workbook.xml` lists
    the sheets in tab order and carries their names; the file each one lives in
    is reached only through the `r:id` on the entry and the relationships part.
    The `N` in `worksheets/sheetN.xml` is a creation-order id, not a position —
    reorder or delete a tab in Excel and the two diverge permanently.

    Pairing the Nth workbook entry with the Nth numerically-sorted part, as this
    used to, therefore mislabels every sheet in such a workbook: the header said
    "=== Sheet: Cap Table ===" above the revenue rows and "=== Sheet:
    Financials ===" above the cap table. That heading is the model's only cue
    for what it is reading, so the extraction pipeline confidently pulled
    share classes out of a P&L.
    """
    try:
        root = ElementTree.fromstring(zf.read("xl/workbook.xml"))
    except (KeyError, ElementTree.ParseError):
        return []
    rels = _xlsx_rels(zf)
    present = set(zf.namelist())
    sheets: list[tuple[str, str]] = []
    for i, entry in enumerate(root.iter(f"{_SSML}sheet")):
        name = entry.get("name") or f"Sheet{i + 1}"
        rid = entry.get(f"{_OFFICE_REL}id")
        target = rels.get(rid) if rid else None
        if target:
            # Targets are relative to xl/ unless rooted at the package root.
            path = target[1:] if target.startswith("/") else "xl/" + re.sub(r"^\./", "", target)
        else:
            # No relationships part (or an entry without an r:id) — fall back to
            # the positional guess, which is right for the simple workbooks that
            # is all such a file can be.
            path = f"xl/worksheets/sheet{i + 1}.xml"
        if path in present:
            sheets.append((name, path))
    return sheets


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


def _col_index(ref: str | None) -> int | None:
    """'BC12' → 0-based column 54; None when the ref is missing or unparseable."""
    if not ref:
        return None
    idx = 0
    for ch in ref:
        if not ch.isalpha():
            break
        idx = idx * 26 + (ord(ch.upper()) - 64)
    return idx - 1 if idx else None


# Widest row we will pad out to. A cell ref may name any column up to XFD
# (16384), and padding blindly would let one crafted cell turn every row into
# 16k tabs — 32MB of empty strings across a sheet, and enough output to consume
# a document's whole character budget on nothing. 512 columns is far past what a
# cap table or a monthly ten-year model needs.
MAX_XLSX_COLS = 512


def _row_values(row: ElementTree.Element, shared: list[str]) -> list[str]:
    """A row's cells as a dense left-to-right list, gaps included.

    XLSX does not store empty cells: a row whose Price is blank simply has no
    <c r="B2"> element. Reading the <c> elements in order therefore yields a
    *shorter* row than the header, and joining them with tabs slid every later
    value one column left — a share count landed under "Price", a price under
    "Class". Nothing downstream could detect it, because the row it received was
    a perfectly well-formed line of TSV; the LLM read 2,000,000 as a per-share
    price and the extracted cap table was wrong in a way that looked right.

    So place each cell at the column its `r` attribute names and fill the holes.
    Cells without a usable ref keep the old behaviour of trailing the row.
    """
    placed: dict[int, str] = {}
    floating: list[str] = []
    for cell in row.findall(f"{_SSML}c"):
        value = _xlsx_cell_value(cell, shared)
        idx = _col_index(cell.get("r"))
        if idx is None:
            floating.append(value)
        elif idx < MAX_XLSX_COLS:
            # Two cells claiming one column is malformed; last one wins, which
            # is what a spreadsheet reader would show.
            placed[idx] = value
    width = max(placed) + 1 if placed else 0
    values = [placed.get(i, "") for i in range(width)]
    values.extend(floating)
    return values


def _xlsx_text(raw: bytes) -> str:
    """Tab-separated rows per sheet — enough structure for the LLM to read a
    cap table without a spreadsheet dependency."""
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        shared = _xlsx_shared_strings(zf)
        sheets = _xlsx_sheets(zf)
        if not sheets:
            # No readable workbook part: fall back to whatever worksheets the
            # archive holds, numbered, so a damaged file still yields its rows.
            sheets = [
                (f"Sheet{i + 1}", p)
                for i, p in enumerate(
                    sorted(
                        (p for p in zf.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", p)),
                        key=lambda p: int(re.search(r"\d+", p).group()),  # type: ignore[union-attr]
                    )
                )
            ]
        blocks: list[str] = []
        for name, path in sheets[:MAX_XLSX_SHEETS]:
            try:
                root = ElementTree.fromstring(zf.read(path))
            except (KeyError, ElementTree.ParseError):
                continue
            lines = [f"=== Sheet: {name} ==="]
            for row in list(root.iter(f"{_SSML}row"))[:MAX_XLSX_ROWS_PER_SHEET]:
                values = _row_values(row, shared)
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
