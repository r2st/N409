"""Text extraction against the encodings and containers people actually attach.

The twin of `domain/sheetText.ts` in the valuation service. Both readers turn an
uploaded file into the text something downstream reads, both were written as
`decode("utf-8", …)` with substitution on failure, and neither cites the other —
so the format bug was a candidate in both and was present in both.

This half matters more. The valuation service hands its text to a parser whose
failure an analyst sees on an import screen; this one hands it to a model, whose
output is a narrative paragraph or an extracted cap table with no operator in
the loop to notice that the document it read was `c\x00l\x00a\x00s\x00s\x00`.
"""

import base64

import pytest

from app.documents import decode_text, extract_texts

# `Série A` is the point of the fixture: one non-ASCII character, in the column
# a cap table is keyed by, written by every European export.
CSV = "class,shares\nSérie A,1000\nCommon,6000000\n"


def _doc(raw: bytes, filename: str = "captable.csv") -> dict:
    return {
        "id": "d1",
        "filename": filename,
        "kind": "cap_table",
        "content_base64": base64.b64encode(raw).decode(),
    }


def _text(raw: bytes, filename: str = "captable.csv") -> str:
    [doc] = extract_texts([_doc(raw, filename)])
    return doc.text


@pytest.mark.parametrize(
    "label,raw",
    [
        ("utf-8", CSV.encode("utf-8")),
        ("utf-8-bom", b"\xef\xbb\xbf" + CSV.encode("utf-8")),
        ("utf-16-le-bom", CSV.encode("utf-16-le")[:0] + b"\xff\xfe" + CSV.encode("utf-16-le")),
        ("utf-16-be-bom", b"\xfe\xff" + CSV.encode("utf-16-be")),
        ("utf-16-le-no-bom", CSV.encode("utf-16-le")),
        ("utf-16-be-no-bom", CSV.encode("utf-16-be")),
        ("latin-1", CSV.encode("latin-1")),
        ("cp1252", CSV.encode("cp1252")),
    ],
)
def test_every_encoding_a_spreadsheet_writes_reads_the_same(label, raw):
    """One document, eight encodings, one text.

    Before: UTF-16 came back with a NUL beside every character (NUL is itself
    valid UTF-8, so `errors="replace"` had nothing to replace), and Latin-1 came
    back as `S�rie A` — a security class that will not match the same class
    on any later import, extracted into a cap table as fact.
    """
    assert _text(raw) == CSV.strip(), label


def test_the_byte_order_mark_is_not_left_in_the_first_column_name():
    # Excel's own "CSV UTF-8" writes one, and a header of `﻿class` is a
    # column name that matches nothing.
    assert _text(b"\xef\xbb\xbf" + CSV.encode("utf-8")).startswith("class,")


def test_astral_characters_survive_both_decoders():
    doc = "class\n🚀 Rocket Inc,1000\n"
    assert "🚀" in _text(doc.encode("utf-8"))
    assert "🚀" in _text(b"\xff\xfe" + doc.encode("utf-16-le"))


def test_a_utf16_document_is_not_charged_twice_for_its_length():
    """Two bytes per character used to cost half the document.

    `MAX_CHARS_PER_DOC` counts characters, and the NUL padding was counted as
    characters — so a UTF-16 file reached the model with half its content as
    well as unusable.
    """
    body = "class,shares\n" + "".join(f"Class {i},1000\n" for i in range(400))
    assert _text(b"\xff\xfe" + body.encode("utf-16-le")) == _text(body.encode("utf-8"))


class TestContainersThatAreNotText:
    """A file that is not a document, named as though it were one.

    Each of these used to be sent to the model as its own bytes. The bar is not
    that extraction succeeds — it cannot — but that what comes back says what
    the file is, in the same `[could not extract text: …]` note every other
    failure degrades to. A run is never sunk by one bad attachment.
    """

    def test_a_password_protected_workbook_is_named_rather_than_unzipped(self):
        # Encrypted OOXML is an OLE2 compound file, not a ZIP, so this reached
        # the xlsx reader and came back as zipfile's "File is not a zip file".
        ole2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64
        for name in ("book.xlsx", "book.xls", "captable.csv"):
            assert "password-protected" in _text(ole2, name), name

    def test_utf32_is_named_rather_than_read_as_utf16(self):
        raw = b"\xff\xfe\x00\x00" + "class\n".encode("utf-32-le")
        assert "UTF-32" in _text(raw)

    def test_rtf_and_binaries_are_named(self):
        assert "RTF" in _text(rb"{\rtf1\ansi hello}")
        assert "binary executable" in _text(b"\x7fELF\x02\x01\x01" + b"\x00" * 40)

    def test_a_container_with_nul_bytes_is_refused_rather_than_forwarded(self):
        with pytest.raises(ValueError, match="not a document"):
            decode_text(b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00garbage\x00\x01\x02")

    def test_one_unreadable_attachment_does_not_sink_the_others(self):
        docs = [
            _doc(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64, "locked.xlsx"),
            _doc(CSV.encode("utf-8"), "good.csv"),
        ]
        out = extract_texts(docs)
        assert "password-protected" in out[0].text
        assert out[1].text == CSV.strip()


class TestRoutingByContentRatherThanName:
    """The extension is a hint; the magic number is the fact."""

    def test_a_workbook_attached_as_csv_is_read_as_a_workbook(self):
        from tests.test_documents_xlsx import _xlsx_bytes

        # Renaming a `.xlsx` to `.csv` is an ordinary mistake, and the workbook
        # reader is right here — reading the ZIP as text is not.
        assert "Cap Table" in _text(_xlsx_bytes(), "captable.csv")

    def test_a_text_file_named_csv_is_still_read_as_text(self):
        # The ZIP branch must not swallow ordinary text: only bytes that are a
        # ZIP take it, and these are not.
        assert _text(CSV.encode("utf-8"), "captable.csv") == CSV.strip()
