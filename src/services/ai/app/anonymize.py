"""PII redaction before document text reaches an external LLM
(remaining-gaps §2 "AI model routing" — the cap-table anonymization step;
audit B-1 P1 hardening).

Two layers:

* Deterministic regexes — emails, SSNs, EINs, phones, US-style street
  addresses / PO boxes / "City, ST ZIP" lines, and honorific- or label-led
  person names ("Mr. Ada Lovelace", "Prepared by: …").
* Known-entity redaction — the caller passes the entities it already knows
  (the subject company name, and any founder/employee names), which are struck
  by exact word-boundary match. This is the reliable half: the single most
  identifying field on a 409A is the company name, and we always know it.

Conservative on purpose — plain 7–10 digit figures (share counts, dollar
amounts) must survive untouched, so phone matching requires phone-shaped
formatting and structured patterns run before the looser ones.
"""

from __future__ import annotations

import os
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
                (?!\d)(?![.,]\d)  # no trailing digits; "." ok unless a decimal follows""",
            re.VERBOSE,
        ),
    ),
    (
        # "City, ST 94105" / "City, ST 94105-1234" — a capitalized locality,
        # a two-letter state code, then a ZIP. Specific enough that a bare
        # 5-digit share count never matches.
        "addresses",
        re.compile(r"\b[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+)*,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b"),
    ),
    (
        # "123 Main Street", "45 Sand Hill Rd", "P.O. Box 12" — a house number
        # (or PO box) followed by a street-type suffix.
        "addresses",
        re.compile(
            r"""\b(?:
                    P\.?\s?O\.?\s?Box\s+\d+
                  | \d{1,6}\s+(?:[A-Z][A-Za-z.]+\s+){1,4}
                    (?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|
                       Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|
                       Highway|Hwy|Suite|Ste|Floor|Fl|Unit|Apt)\b\.?
                )""",
            re.VERBOSE | re.IGNORECASE,
        ),
    ),
    (
        # Honorific- or label-led person names: "Dr. Ada Lovelace",
        # "Prepared by: Ada Lovelace", "Attn: Grace Hopper".
        "names",
        re.compile(
            r"""\b(?:
                    (?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?
                  | (?:Prepared|Reviewed|Signed|Approved|Authorized)\s+by
                  | Attn(?:ention)?
                  | Signatory
                )[:.]?\s+
                [A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}""",
            re.VERBOSE,
        ),
    ),
]

_PLACEHOLDERS = {
    "emails": "[EMAIL]",
    "ssns": "[SSN]",
    "eins": "[EIN]",
    "phones": "[PHONE]",
    "addresses": "[ADDRESS]",
    "names": "[NAME]",
    "companies": "[COMPANY]",
}

# Words that are legitimately capitalized and must never be redacted as a
# company name even if one is passed as such by mistake.
_MIN_ENTITY_LEN = 3


def _redact_entities(text: str, entities: list[str], label: str) -> tuple[str, int]:
    """Strike each known entity by whole-word, case-insensitive match. Longest
    first so "Acme Robotics Inc" is caught before "Acme"."""
    total = 0
    placeholder = _PLACEHOLDERS[label]
    for value in sorted({e.strip() for e in entities if e and len(e.strip()) >= _MIN_ENTITY_LEN}, key=len, reverse=True):
        pattern = re.compile(rf"\b{re.escape(value)}\b", re.IGNORECASE)
        text, n = pattern.subn(placeholder, text)
        total += n
    return text, total


def redact(
    text: str,
    *,
    company_names: list[str] | None = None,
    person_names: list[str] | None = None,
) -> tuple[str, dict[str, int]]:
    """Returns (redacted_text, counts-per-category); zero counts are omitted.

    ``company_names`` / ``person_names`` are entities the caller already knows
    (e.g. the subject company). Structured regexes run first so an entity name
    inside an email/URL is already gone before whole-word matching.
    """
    counts: dict[str, int] = {}
    for category, pattern in _PATTERNS:
        text, n = pattern.subn(_PLACEHOLDERS[category], text)
        if n:
            counts[category] = counts.get(category, 0) + n
    if company_names:
        text, n = _redact_entities(text, company_names, "companies")
        if n:
            counts["companies"] = counts.get("companies", 0) + n
    if person_names:
        text, n = _redact_entities(text, person_names, "names")
        if n:
            counts["names"] = counts.get("names", 0) + n
    return text, counts


def anonymization_enforced() -> bool:
    """True when redaction may not be disabled per-request (audit B-1 P1).

    Set ``APP_ENV=production`` (or ``ANONYMIZE_ENFORCE=1``) so confidential
    client financials can never be shipped to an external LLM un-redacted, even
    if a caller passes ``options.anonymize = false``.
    """
    if os.environ.get("APP_ENV", "").lower() == "production":
        return True
    return os.environ.get("ANONYMIZE_ENFORCE", "").lower() in {"1", "true", "yes", "on"}
