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


_TRAILING_PUNCT = re.compile(r"[.,;:]+$")
_WHITESPACE_RUN = re.compile(r"\s+")


def _entity_pattern(value: str) -> re.Pattern[str]:
    """A whole-entity matcher for one known name.

    `\\b` asserts a word character on exactly one side, so it only works where
    the entity itself starts and ends on one. Legal entity names usually do not:
    "Acme Robotics, Inc.", "Widgets Ltd.", "Acme (US)" all end in punctuation,
    and a trailing `\\b` after "." can only match when the *next* character is a
    word character — so "Acme, Inc. filed" never matched and the most
    identifying field on a 409A went to the external model intact, with a
    redaction count of zero to say so. Where the edge character is not word-ish,
    the assertion becomes "no word character adjacent", which is the boundary
    that was meant all along.

    Two allowances for the fact that this runs over text pulled out of PDFs and
    spreadsheets rather than a database column:

    * a run of whitespace in the name matches any run in the text, since
      extraction wraps lines and doubles spaces mid-name;
    * trailing punctuation on the name is optional, so "Acme Robotics, Inc."
      also strikes a document that writes "Acme Robotics, Inc".

    Both only ever widen the match to text that still contains the whole
    distinctive name, so neither can redact something unrelated.
    """
    stem = _TRAILING_PUNCT.sub("", value)
    tail = value[len(stem) :]
    if not stem:  # a "name" of nothing but punctuation would match everywhere
        stem, tail = value, ""

    # Split the raw value, not an escaped copy: re.escape backslashes some
    # separators, and rewriting inside that yields a pattern matching a literal
    # backslash.
    body = r"\s+".join(re.escape(part) for part in _WHITESPACE_RUN.split(stem) if part)
    if tail:
        body += f"(?:{re.escape(tail)})?"

    # (?<!\w) / (?!\w) rather than \b. Where the entity does start and end on a
    # word character the two are identical; where it does not, only these are
    # right — which is the whole bug.
    return re.compile(rf"(?<!\w){body}(?!\w)", re.IGNORECASE)


def _redact_entities(text: str, entities: list[str], label: str) -> tuple[str, int]:
    """Strike each known entity by whole-word, case-insensitive match. Longest
    first so "Acme Robotics Inc" is caught before "Acme"."""
    total = 0
    placeholder = _PLACEHOLDERS[label]
    for value in sorted(
        {e.strip() for e in entities if e and len(e.strip()) >= _MIN_ENTITY_LEN},
        key=len,
        reverse=True,
    ):
        text, n = _entity_pattern(value).subn(placeholder, text)
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
