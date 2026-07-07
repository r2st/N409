"""Document text extraction for the AI pipelines.

The valuation service ships documents as base64 (they live on its disk).
Supported: PDF (pypdf), and anything text-like (csv/tsv/txt/md/json).
Extraction failures degrade to a note so one bad file never sinks a run.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass

from pypdf import PdfReader

MAX_CHARS_PER_DOC = 20_000
MAX_TOTAL_CHARS = 60_000


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
