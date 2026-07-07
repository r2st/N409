"""PII redaction before document text reaches an external LLM
(remaining-gaps §2 "AI model routing" — the cap-table anonymization step).

Deterministic regexes only: emails, SSNs, EINs, and phone numbers.
Conservative on purpose — plain 7–10 digit figures (share counts, dollar
amounts) must survive untouched, so phone matching requires phone-shaped
formatting (separators, parens, or a leading +), and SSN/EIN run first so
their dashed forms aren't half-eaten by the phone pattern.
"""

from __future__ import annotations

import re

# Order matters: most specific first.
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("emails", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("ssns", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("eins", re.compile(r"\b\d{2}-\d{7}\b")),
    (
        "phones",
        re.compile(
            r"""(?<![\d.,$-])            # not inside a larger number
                (?:\+\d{1,3}[\s.-]?)?    # optional country code
                (?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])  # area code needs () or separator
                \d{3}[\s.-]\d{4}
                (?![\d.,-])""",
            re.VERBOSE,
        ),
    ),
]

_PLACEHOLDERS = {"emails": "[EMAIL]", "ssns": "[SSN]", "eins": "[EIN]", "phones": "[PHONE]"}


def redact(text: str) -> tuple[str, dict[str, int]]:
    """Returns (redacted_text, counts-per-category); zero counts are omitted."""
    counts: dict[str, int] = {}
    for category, pattern in _PATTERNS:
        text, n = pattern.subn(_PLACEHOLDERS[category], text)
        if n:
            counts[category] = counts.get(category, 0) + n
    return text, counts
