"""Document text extraction for the AI pipelines.

The valuation service ships documents as base64 (they live on its disk).
Supported: PDF (pypdf), XLSX/XLSM (stdlib zip + XML — cap tables and
financials usually arrive as Excel), and anything text-like
(csv/tsv/txt/md/json). Extraction failures degrade to a note so one bad
file never sinks a run.
"""

from __future__ import annotations

import base64
import codecs
import io
import logging
import re
import zipfile
from dataclasses import dataclass
from xml.etree import ElementTree

from pypdf import PdfReader

_log = logging.getLogger("documents")

MAX_CHARS_PER_DOC = 20_000
MAX_TOTAL_CHARS = 60_000

#: What stands in for a document `MAX_TOTAL_CHARS` stopped the extractor before.
#:
#: The same convention the extraction failures use: a document that could not
#: be read comes back carrying a note where its text would be, because a reader
#: acting on this material has to be able to tell "there was nothing in it" from
#: "we did not read it". A budget spent is the second of those, and the only one
#: of the two that was silent.
UNREAD_NOTE = (
    "[not read: the extraction budget was already spent on the documents above, "
    "so this one was not opened]"
)
MAX_XLSX_SHEETS = 20
MAX_XLSX_ROWS_PER_SHEET = 2_000

# ── XLSX decompression budget ────────────────────────────────────────────────
#
# An `.xlsx` is a ZIP, and `zipfile` will inflate a member as far as it goes.
# The character limits above bound the *output* of extraction and nothing about
# the bytes read to produce it: a part is fully materialised as a `bytes` before
# a single character is counted.
#
# Deflate reaches roughly 1000:1 on the runs of a single byte a bomb is built
# from, so the 32 MB request-body cap bounds what an attacker sends and nothing
# at all about what this process allocates. Measured: a 398 KiB archive grew
# resident memory by 1.2 GiB, and the body cap admits sixty of those in one
# request. The valuation service's TypeScript reader (`domain/zipReader.ts`) has
# had a budget for exactly this since it was written; the Python extractor
# reading the same uploads did not.
#
# The budget is what an archive may expand *to*, not the ratio it expands *by*:
# a ratio alone lets a large archive of highly compressible XML — which is what
# every genuine workbook is — sail past a limit that a small one trips. Scaling
# with the input bounds the amplification an attacker can buy, while the floor
# and ceiling keep both ends sane.
MAX_XLSX_EXPANSION_RATIO = 20
MIN_XLSX_INFLATED_BUDGET = 16 * 1024 * 1024
MAX_XLSX_INFLATED_BUDGET = 128 * 1024 * 1024


class DocumentTooLarge(Exception):
    """An archive asked to expand past its decompression budget."""


def xlsx_inflated_budget(archive_bytes: int) -> int:
    """Total inflated bytes an archive of `archive_bytes` may produce."""
    return min(
        MAX_XLSX_INFLATED_BUDGET,
        max(MIN_XLSX_INFLATED_BUDGET, archive_bytes * MAX_XLSX_EXPANSION_RATIO),
    )


class _BoundedZip:
    """A ZipFile whose members are read against one shared byte budget.

    `zf.read(name)` is the only way this module touches archive contents, so
    metering it here covers every part — shared strings, the workbook, the
    relationships, each sheet — with one running total rather than a per-part
    limit that a hundred parts could each sit just under.
    """

    def __init__(self, zf: zipfile.ZipFile, budget: int) -> None:
        self._zf = zf
        self._remaining = budget
        self._budget = budget

    def namelist(self) -> list[str]:
        return self._zf.namelist()

    def read(self, name: str) -> bytes:
        """Read one member, stopping the moment it passes what is left.

        Read through the stream with a cap rather than calling `zf.read`: the
        declared uncompressed size is a number the archive chose, so it is a
        cheap pre-check and never the guard. One extra byte is requested so a
        member that exactly fills the budget is still distinguishable from one
        that overruns it.
        """
        if self._remaining <= 0:
            raise DocumentTooLarge(self._message(name))
        info = self._zf.getinfo(name)
        if info.file_size > self._remaining:
            raise DocumentTooLarge(self._message(name))
        with self._zf.open(name) as handle:
            data = handle.read(self._remaining + 1)
        if len(data) > self._remaining:
            raise DocumentTooLarge(self._message(name))
        self._remaining -= len(data)
        return data

    def _message(self, name: str) -> str:
        mb = round(self._budget / (1024 * 1024))
        return f'"{name}" expands past the {mb} MB decompression limit for an archive this size'


_SSML = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_OFFICE_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


@dataclass
class DocText:
    id: str
    filename: str
    kind: str
    text: str


class MalformedDocument(Exception):
    """A part of an archive is XML this reader will not parse at all."""


def _parse_xml_part(data: bytes) -> ElementTree.Element:
    """Parse one XML part of a workbook, refusing any document type declaration.

    `ElementTree` expands internal entities. Six nested declarations of ten
    references each turn fifty bytes into fifty megabytes, and each further
    level multiplies by ten — the billion-laughs bomb, and `zipfile` never sees
    it: the payload is a 427-byte `xl/sharedStrings.xml` in an 845-byte archive,
    so the decompression budget above is spent to four figures and the
    allocation happens in the parser afterwards. Measured on this reader before
    this existed.

    A DTD is refused rather than the expansion being metered. No part of an
    OOXML package carries one — the format's own schema is XSD, and every writer
    from Excel to openpyxl emits an XML declaration and nothing else — so there
    is no legitimate workbook to trade against, and "no entities to expand"
    is a property one scan can establish, where "expanded to less than N" is a
    budget that has to be threaded through a parser that does not offer a hook
    for it.

    The exception type is deliberately not `ParseError`: the callers below skip
    an unreadable part and carry on, which is right for a truncated sheet and
    wrong for a hostile one. This reaches `extract_texts`, which reports it as
    the document's text, so the run says what it refused.
    """
    if _has_doctype(data):
        raise MalformedDocument(
            "this workbook contains an XML document type declaration, which no spreadsheet "
            "writes and which cannot be read safely"
        )
    return ElementTree.fromstring(data)


#: The encodings an XML processor resolves from the first bytes of a document,
#: as the XML 1.0 autodetection table gives them (Appendix F.1). expat reads a
#: document in whichever of these its bytes announce — before, and regardless
#: of, what the encoding *declaration* inside then says — so this is the reading
#: the scan below has to share with it.
#:
#: Ordered longest signature first: a UTF-32LE BOM begins with a UTF-16LE BOM,
#: and asking in the other order calls the one the other.
_XML_BOMS: tuple[tuple[bytes, str], ...] = (
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)

#: The same table for a document with no BOM, keyed on how its first character —
#: which XML requires to be `<` — is spelled in each width.
_XML_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\x00\x00\x00<", "utf-32-be"),
    (b"<\x00\x00\x00", "utf-32-le"),
    (b"\x00<", "utf-16-be"),
    (b"<\x00", "utf-16-le"),
)


def _ascii_compatible(data: bytes) -> bytes:
    """This part with its markup spelled in single bytes, for the scan below.

    Returns `data` itself for everything whose first bytes do not announce a
    wide encoding, which is every workbook any writer in existence produces —
    the common path allocates nothing and scans exactly the bytes it was given.

    A wide part is transcoded whole. That is safe to do and is only ever paid
    for here: `_BoundedZip` has already metered these bytes against the
    archive's inflation budget, so the copy is bounded, and it is bought by
    hostile or exotic input alone. `errors="replace"` rather than a raise —
    bytes that do not decode are bytes expat will refuse too, and a mangled
    prolog must still be *asked* the question below rather than skipping it on
    the way out through an exception.
    """
    for bom, encoding in _XML_BOMS:
        if data.startswith(bom):
            return data.decode(encoding, errors="replace").encode("utf-8", errors="replace")
    for signature, encoding in _XML_SIGNATURES:
        if data.startswith(signature):
            return data.decode(encoding, errors="replace").encode("utf-8", errors="replace")
    return data


def _has_doctype(data: bytes) -> bool:
    """Whether a document type declaration leads this XML part.

    Only the prolog is examined — everything before the first element — so a
    cell whose *text* is the literal `<!DOCTYPE html>` cannot be mistaken for
    one (it is escaped in the part, and past the root element either way). What
    may legitimately precede it is whitespace, the XML declaration, processing
    instructions, and comments; each is skipped, and anything else ends the
    scan.

    ## The bytes have to be read the way expat reads them

    This scanned for markup spelled in single bytes, and a UTF-16 part does not
    spell it that way: `<!DOCTYPE` is `<\x00!\x00D\x00…`, which begins with
    none of the three markers, so the scan fell out at its first test and
    answered "no document type declaration" — while expat, auto-detecting
    UTF-16 from the BOM exactly as the specification tells it to, read the
    declaration and expanded every entity in it. The 427-byte bomb the
    docstring above measures, re-encoded to UTF-16, walked through the refusal
    this function *is*. See `_ascii_compatible`.
    """
    rest = _ascii_compatible(data).lstrip(codecs.BOM_UTF8).lstrip()
    while True:
        if rest.startswith(b"<!DOCTYPE"):
            return True
        if rest.startswith(b"<!--"):
            end = rest.find(b"-->", 4)
        elif rest.startswith(b"<?"):
            end = rest.find(b"?>", 2)
        else:
            return False
        if end < 0:
            # Unterminated: there is no well-formed document after it, so the
            # parser is about to raise anyway. Not a DTD.
            return False
        rest = rest[end + (3 if rest.startswith(b"<!--") else 2) :].lstrip()


def _pdf_text(raw: bytes) -> str:
    reader = PdfReader(io.BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages[:40]]
    return "\n".join(pages)


def _rich_text(node: ElementTree.Element) -> str:
    """The value of a rich-text container — one `<si>` or one `<is>`.

    A container holds two kinds of `<t>`, and only one of them is the value.
    `<t>` directly, or `<r><t>` where the string is split across styles, is the
    text. `<rPh sb=".." eb=".."><t>` is not: it is the reading the typist
    entered to produce a span of that text, which Excel stores beside the string
    and renders *above* the cell. Every workbook typed with a Japanese IME
    carries them, on names in particular.

    `iter()` descends, so joining every `<t>` under the container appended the
    furigana to the value — 山田太郎 read as 山田太郎ヤマダタロウ. This text is
    what the extraction pipeline sends to the model, and that heading is all the
    model has to go on, so the corruption reaches every field pulled out of a
    Japanese workbook.

    Written as a whitelist of the two element names that carry the value rather
    than as a skip-list of `rPh`, so `<phoneticPr>` and anything else the schema
    grows are excluded by construction instead of by enumeration.
    """
    parts: list[str] = []
    for child in node:
        if child.tag == f"{_SSML}t":
            parts.append(child.text or "")
        elif child.tag == f"{_SSML}r":
            parts.extend(t.text or "" for t in child.iter(f"{_SSML}t"))
    return "".join(parts)


def _xlsx_shared_strings(zf: _BoundedZip) -> list[str]:
    try:
        root = _parse_xml_part(zf.read("xl/sharedStrings.xml"))
    except (KeyError, ElementTree.ParseError):
        return []
    # Each <si> may hold one <t> or rich-text runs of <r><t>; join the runs.
    return [_rich_text(si) for si in root.iter(f"{_SSML}si")]


def _xlsx_rels(zf: _BoundedZip) -> dict[str, str]:
    """Relationship id → part target, from the workbook's relationships part."""
    try:
        root = _parse_xml_part(zf.read("xl/_rels/workbook.xml.rels"))
    except (KeyError, ElementTree.ParseError):
        return {}
    out: dict[str, str] = {}
    for rel in root.iter(f"{_PKG_REL}Relationship"):
        rid, target = rel.get("Id"), rel.get("Target")
        if rid and target:
            out[rid] = target
    return out


def _xlsx_sheets(zf: _BoundedZip) -> list[tuple[str, str]]:
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
        root = _parse_xml_part(zf.read("xl/workbook.xml"))
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
        # `<is>` is the same rich-text container `<si>` is, phonetic guides and
        # all — see `_rich_text`.
        inline = cell.find(f"{_SSML}is")
        return _rich_text(inline) if inline is not None else ""
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
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        zf = _BoundedZip(archive, xlsx_inflated_budget(len(raw)))
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
                root = _parse_xml_part(zf.read(path))
            except (KeyError, ElementTree.ParseError):
                continue
            lines = [f"=== Sheet: {name} ==="]
            for row in list(root.iter(f"{_SSML}row"))[:MAX_XLSX_ROWS_PER_SHEET]:
                values = _row_values(row, shared)
                if any(v.strip() for v in values):
                    lines.append("\t".join(values).rstrip())
            blocks.append("\n".join(lines))
        return "\n\n".join(blocks)


# ── Text decoding ────────────────────────────────────────────────────────────
#
# `raw.decode("utf-8", errors="replace")` is three assumptions in one call: that
# the file is text, that the text is UTF-8, and that anything else is close
# enough. None of them holds for the files an analyst attaches, every failure is
# silent — `errors="replace"` substitutes rather than raising — and what the
# substitution produces is fed straight to a model with no operator in the loop
# to notice. Measured, before this existed:
#
#   - **UTF-16**, which is what "Save as → Unicode Text" writes, decoded to
#     `c\x00l\x00a\x00s\x00s\x00` — every character with a NUL beside it,
#     because NUL is itself valid UTF-8. The model receives a document that is
#     half padding and, at 2 bytes per character against `MAX_CHARS_PER_DOC`,
#     half as much of it.
#   - **Latin-1 / Windows-1252**, which Excel on Windows writes unless "CSV
#     UTF-8" is picked, turned `Série A` into `S\ufffdrie A` — a corrupted
#     security-class name extracted into a cap table as fact.
#   - **A renamed binary** — a PDF or a password-protected workbook called
#     `.csv` — was sent to the model as its own bytes.
#
# This is the same defect, and the same fix, as `domain/sheetText.ts` in the
# valuation service; the two readers share no code, so the format bug was a
# candidate in both. See the note there for what a cap-table importer actually
# receives.

_BINARY_SIGNATURES: list[tuple[bytes, str]] = [
    (
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
        "this is a password-protected or legacy Excel workbook, which cannot be read",
    ),
    (b"{\\rtf", "this is RTF, not a spreadsheet or text file"),
    (b"\x7fELF", "this is a binary executable, not a document"),
]


def _looks_like_utf16(raw: bytes, offset: int) -> bool:
    """Two bytes per character with a zero high byte, sampled over the head.

    A majority rather than all: a UTF-16 file with an astral character in it has
    surrogate pairs whose halves are not ASCII, and one emoji in a company name
    should not decide the encoding.
    """
    end = min(len(raw), 1024)
    zeros = pairs = 0
    for i in range(offset, end - 1, 2):
        pairs += 1
        if raw[i] == 0:
            zeros += 1
    return pairs >= 8 and zeros > pairs / 2


def decode_text(raw: bytes) -> str:
    """Decode an attached text-like file, or say what it is instead.

    Raises `ValueError` for bytes that are not text; `extract_texts` turns that
    into the same `[could not extract text: …]` note every other failure
    degrades to, which is a statement a reader can act on rather than a page of
    replacement characters that looks like the document was empty.
    """
    for magic, message in _BINARY_SIGNATURES:
        if raw.startswith(magic):
            raise ValueError(message)
    # UTF-32 writes a UTF-16 BOM followed by two more zero bytes, so it is named
    # rather than mis-decoded as UTF-16 with empty characters between.
    if raw.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
        raise ValueError("this file is UTF-32 text — re-save it as UTF-8")
    if raw.startswith(b"\xff\xfe"):
        text = raw[2:].decode("utf-16-le", errors="replace")
    elif raw.startswith(b"\xfe\xff"):
        text = raw[2:].decode("utf-16-be", errors="replace")
    elif raw.startswith(b"\xef\xbb\xbf"):
        text = raw[3:].decode("utf-8", errors="replace")
    elif _looks_like_utf16(raw, 1):
        text = raw.decode("utf-16-le", errors="replace")
    elif _looks_like_utf16(raw, 0):
        text = raw.decode("utf-16-be", errors="replace")
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            # Only bytes that are not valid UTF-8 reach here, so every UTF-8
            # file decodes exactly as it did before.
            text = raw.decode("cp1252", errors="replace")
    # Whatever it was read as, a NUL is not something a document writes: the
    # file is a container this does not recognise, and sending its bytes to a
    # model as document text is worse than saying so.
    if "\x00" in text:
        raise ValueError("this file is not a document or a text file")
    return text


def extract_texts(documents: list[dict]) -> list[DocText]:
    """Every document as text, with each failure declared and counted.

    ## Why a degraded extraction is also a log line (R301, methodology M6)

    The degrade is right and stays: one unreadable file must not sink a run,
    and the note goes into the corpus because the model is the reader who can
    act on it — a cap table replaced by "[could not extract text: …]" reads
    very differently from a cap table with no rows.

    But the note was the *only* place any of it was recorded. Nothing in this
    module logged, so a failure here reached exactly two audiences: the model,
    inside a prompt, and the analyst, as a per-document summary that says
    nothing came out. The one audience it never reached was us. A pypdf that
    stops reading a whole class of PDFs, an `.xlsx` export whose shape changed,
    a deployment where the extractor is failing on every upload — all of that
    is a healthy 200 with a full corpus of apologies, and the only way to see
    it is to read the prompts.

    So each failure is warned with its reason, and a run with any failures ends
    on a `count`/`total` line, which is the pair an alert can group on. Neither
    carries the filename: it is the client's own — conventionally the company
    name and the document type — and this log is written to disk on a host the
    corpus never touches. `kind` says what it was meant to be, which is the
    part a diagnosis needs.
    """
    out: list[DocText] = []
    total = 0
    failed = 0
    dropped = 0
    for doc in documents:
        if total >= MAX_TOTAL_CHARS:
            # `MAX_TOTAL_CHARS` is reached by three ordinary spreadsheets, so
            # this arm is the common case on a real upload rather than a
            # theoretical ceiling — and until R332 it left no trace anywhere.
            # The documents after it are not extracted, not returned, and not
            # counted, which makes every denominator downstream a count of the
            # survivors: `corpus_truncated` reports `total=len(docs)` over a
            # list this loop has already shortened, and `/ai/v1/anonymize`
            # answers with fewer documents than it was sent while the valuation
            # service's `cap_table_anonymized` record names all of them.
            #
            # Counted rather than broken on, so the line below can carry the
            # denominator the same way `documents_unreadable` does.
            dropped += 1
            continue
        name = str(doc.get("filename") or "document")
        kind = str(doc.get("kind") or "other")
        try:
            try:
                raw = base64.b64decode(doc.get("content_base64") or "")
            except Exception as exc:
                # Inside the degrade, not beside it. This used to fall back to
                # `raw = b""`, which decodes to the empty string — so a document
                # whose bytes did not survive the wire arrived as a document
                # that was empty, with no note in the corpus and nothing said
                # anywhere. Of the two, "this file did not arrive intact" is the
                # one a reader can act on, and it is also the true one.
                raise ValueError(
                    "this file did not arrive intact — its content was not valid base64"
                ) from exc
            # Routed by content first, then by name. A workbook or a PDF
            # attached under the wrong extension is an ordinary mistake and
            # both extractors are right here; reading one as text is not.
            #
            # OLE2 leads, ahead of every extension: encrypted OOXML is not a ZIP
            # at all but an OLE2 compound file, so a password-protected `.xlsx`
            # reached `_xlsx_text` and came back as `zipfile`'s "File is not a
            # zip file" — which is true of the container and says nothing about
            # what the reader should do. A real `.xls` renamed `.xlsx` lands in
            # the same place.
            if raw.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
                raise ValueError(
                    "this is a password-protected or legacy Excel workbook, which cannot "
                    "be read — remove the password, or re-save it as .xlsx"
                )
            if raw.startswith(b"%PDF"):
                text = _pdf_text(raw)
            elif raw.startswith(b"PK\x03\x04"):
                # The magic number is the whole test: text never starts with
                # `PK\x03\x04`, so no `.csv` is caught by this, and a workbook
                # renamed to one no longer reaches the text decoder.
                text = _xlsx_text(raw)
            elif name.lower().endswith(".pdf"):
                text = _pdf_text(raw)
            elif name.lower().endswith((".xlsx", ".xlsm")):
                text = _xlsx_text(raw)
            else:
                text = decode_text(raw)
        except Exception as exc:  # noqa: BLE001 — degrade, don't fail the run
            text = f"[could not extract text: {exc}]"
            failed += 1
            _log.warning(
                "document text extraction failed",
                extra={
                    "event": "document_extract_failed",
                    # `detail` is the one free-text extra the formatter keeps,
                    # and it is redacted on the way to disk like the message is.
                    "detail": f"{kind}: {exc}",
                },
            )
        text = text.strip()[:MAX_CHARS_PER_DOC]
        total += len(text)
        out.append(DocText(id=str(doc.get("id") or ""), filename=name, kind=kind, text=text))
    if failed:
        # The summary an alert groups on: one line per run, with the
        # denominator, so "one scanned PDF was unreadable" and "the extractor
        # is failing on everything" are different lines rather than the same
        # line repeated. `corpus_truncated` reports the same pair for the same
        # reason — see the note on `total` in observability.py's allowlist.
        _log.warning(
            "documents could not be read",
            extra={"event": "documents_unreadable", "count": failed, "total": len(documents)},
        )
    if dropped:
        # Its own line, and its own event, because it is a different incident
        # from the one above: nothing failed, an internal budget was spent, and
        # the documents past it were never opened. `corpus_truncated` is the
        # matching line one layer up and reports only what this loop handed it,
        # so this is the only place the whole shortfall can be stated.
        _log.warning(
            "documents left unread: the extraction budget was already spent",
            extra={"event": "documents_dropped", "count": dropped, "total": len(documents)},
        )
    return out


#: What separates two documents in a rendered corpus. Exported because the
#: budgeting in `pipelines._corpus` has to price a block *plus* its join.
CORPUS_SEPARATOR = "\n\n"

#: What a corpus with nothing in it says. Not "" — a model handed an empty
#: string where documents were promised answers about documents anyway.
EMPTY_CORPUS = "(no documents uploaded)"


def corpus_blocks(docs: list[DocText]) -> list[str]:
    """One rendered block per document, in order.

    Split out of {@link render_corpus} because the corpus is fitted to a
    character budget one document at a time — see `pipelines._corpus`. The
    ordinal is the document's position in the list it was handed, so a caller
    that drops a trailing block does not renumber the ones it keeps.
    """
    return [
        f'--- DOCUMENT {i + 1}: "{d.filename}" (type: {d.kind}) ---\n{d.text or "(empty)"}'
        for i, d in enumerate(docs)
    ]


def render_corpus(docs: list[DocText]) -> str:
    if not docs:
        return EMPTY_CORPUS
    return CORPUS_SEPARATOR.join(corpus_blocks(docs))
