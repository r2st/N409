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
from functools import lru_cache


class AnonymizeInputError(Exception):
    """A known-entity list the redactor will not accept. Answered as a 422."""


# Ceiling on the known entities one request may declare.
#
# `_redact_entities` compiles a pattern per entity and runs it over the whole
# string, and `Redactor.text` is called once per document body, once per
# filename and once per interpolated prompt field — so the work is
# entities × fields × chars, and only the middle two of those were bounded.
# `options.known_people` is a free-form list inside a free-form `options` dict,
# so the count was whatever fitted in the 32 MB body cap.
#
# Measured against a 20,000-char document (the per-document cap): 2,000 names
# cost 0.6s for one field and 20,000 cost 6.1s, for ~600 KB of request. `re`
# holds the GIL, so that is not one slow request among forty — it is every
# request on the process waiting, and a handful of them keeps it waiting for
# minutes.
#
# Refused rather than truncated, deliberately. Silently dropping the tail of the
# list would mean a request that asked for an entity to be struck gets a
# response saying redaction was applied while that entity went to an external
# model in the clear — a worse failure than the 422, and an invisible one. The
# bound is far above any real caller: what is known is the subject company and
# its founders, and the valuation service sends one company name plus a handful
# of people.
MAX_KNOWN_ENTITIES = 500

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
        #
        # The word repetition is bounded, and that bound is load-bearing rather
        # than cosmetic. Unbounded (`*`), the locality run happily walks the
        # rest of the document before discovering there is no comma, and it does
        # that from *every* capitalized word — so a page of capitalized words
        # with no address in it costs O(words^2). At the 20k-char per-document
        # cap that is 0.55s of one crafted upload, against 0.002s for ordinary
        # prose of the same size; three documents fill the 60k-char request
        # budget with ~1.7s. `re` holds the GIL, so that is not one slow request
        # among forty — it is the whole service stopped for that long.
        #
        # Six extra words is far past any real locality ("Research Triangle
        # Park" is three), so nothing that used to match stops matching; the
        # possessive `+` then keeps even those six from being re-tried, since
        # the run can never cross the comma it is looking for anyway.
        "addresses",
        re.compile(r"\b[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,6}+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b"),
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


def _optional_comma(part: str) -> str:
    """One whitespace-separated piece of a name, with a trailing comma optional."""
    if len(part) > 1 and part.endswith(","):
        return re.escape(part[:-1]) + ",?"
    return re.escape(part)


# Corporate suffixes, longest first so "L.L.C" is stripped rather than the "C"
# of it. A document names the company in full once, on the cover, and then
# calls it "Acme Robotics" for thirty pages — so the suffix-less form has to be
# struck too, or the most identifying field on a 409A survives every mention
# but one.
#
# Written without a trailing full stop, because these are compared against a
# stem that has already had its trailing punctuation removed; an entry spelled
# "l.l.c." would never match anything.
_CORP_SUFFIXES = (
    "incorporated",
    "corporation",
    "s.a.r.l",
    "limited",
    "company",
    "pty ltd",
    "pte ltd",
    "l.l.c",
    "l.l.p",
    "gmbh",
    "corp",
    "inc",
    "llc",
    "llp",
    "ltd",
    "plc",
    "srl",
    "spa",
    "l.p",
    "lp",
    "co",
    "ag",
    "nv",
    "bv",
    "sa",
    "oy",
    "ab",
)

# A stem that is only one of these is a common noun before it is a name.
# "Systems, Inc." must not turn every "systems" in an engineering memo into
# [COMPANY]: over-redaction is not free here, because the model is being asked
# to reason about the business and a document redacted into nonsense produces
# a worse valuation narrative. Multi-word stems are distinctive enough to keep
# ("Advanced Systems" is a name; "systems" is a word), and a distinctive
# one-word name — "Stripe", "Palantir" — is exactly what must still be struck.
_GENERIC_STEMS = frozenset(
    {
        "capital",
        "company",
        "enterprises",
        "group",
        "holdings",
        "industries",
        "labs",
        "partners",
        "solutions",
        "systems",
        "technologies",
        "ventures",
    }
)


def _short_form(value: str) -> str | None:
    """`value` without its corporate suffix, when that is still a safe thing to
    strike — otherwise None.

    "Acme Robotics, Inc." -> "Acme Robotics". Returns None when nothing was
    stripped, when the remainder is too short to be distinctive, or when a
    one-word remainder is a common noun (see `_GENERIC_STEMS`).
    """
    stem = _TRAILING_PUNCT.sub("", value).strip()
    lowered = stem.lower()
    for suffix in _CORP_SUFFIXES:
        # Match on the suffix as a whole trailing word, so "Metacorp" does not
        # lose a "corp" from the middle of a single word.
        if not lowered.endswith(suffix):
            continue
        head = stem[: len(stem) - len(suffix)]
        if head and not _WHITESPACE_RUN.match(head[-1]) and head[-1] not in ",.":
            continue  # the suffix ran into the previous word — not a suffix
        head = _TRAILING_PUNCT.sub("", head.strip()).strip()
        if len(head) < _MIN_ENTITY_LEN:
            return None
        if " " not in head and head.lower() in _GENERIC_STEMS:
            return None
        return head
    return None


@lru_cache(maxsize=4096)
def _entity_pattern(value: str) -> re.Pattern[str]:
    """A whole-entity matcher for one known name.

    Memoised because a request redacts many strings against the same entity
    list — every document body, every filename, every interpolated prompt
    field — and the pattern is a pure function of the name. `re` keeps its own
    small cache for `re.compile`, but this one is built through `re.compile` on
    a *derived* string, so the assembly ran again for every field.

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
      also strikes a document that writes "Acme Robotics, Inc";
    * an internal comma is optional too. The comma before a corporate suffix is
      a house style, not part of the name: the certificate of incorporation
      says "Acme Robotics, Inc." and the board minutes say "Acme Robotics Inc."
      Requiring it literally meant the registered name matched only documents
      that punctuated it the same way the valuation record does.

    All three only ever widen the match to text that still contains the whole
    distinctive name, so none of them can redact something unrelated.
    """
    stem = _TRAILING_PUNCT.sub("", value)
    tail = value[len(stem) :]
    if not stem:  # a "name" of nothing but punctuation would match everywhere
        stem, tail = value, ""

    # Split the raw value, not an escaped copy: re.escape backslashes some
    # separators, and rewriting inside that yields a pattern matching a literal
    # backslash.
    body = r"\s+".join(_optional_comma(part) for part in _WHITESPACE_RUN.split(stem) if part)
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
    # Bounded before anything is compiled or scanned — see MAX_KNOWN_ENTITIES.
    # Checked on the raw list rather than the deduplicated set, so the cost of
    # getting here is not itself proportional to an unbounded input.
    if len(entities) > MAX_KNOWN_ENTITIES:
        raise AnonymizeInputError(
            f"too many known {label} to redact against: {len(entities)} "
            f"(the limit is {MAX_KNOWN_ENTITIES})"
        )
    candidates = {e.strip() for e in entities if e and len(e.strip()) >= _MIN_ENTITY_LEN}
    if label == "companies":
        # Only companies: a person is not "Ada Lovelace, Inc.", and stripping a
        # trailing word off a person's name would strike their surname alone.
        # Longest-first ordering below means the full name is always struck
        # before the short form, so a document using both spends one match on
        # each rather than leaving "…, Inc." stranded after "[COMPANY]".
        candidates |= {s for s in (_short_form(e) for e in candidates) if s}
    for value in sorted(candidates, key=len, reverse=True):
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


class Redactor:
    """One request's redaction policy, and a running tally of what it struck.

    `redact` is a function over one string; a request sends out many — document
    bodies, the filenames above them, a founder's free-text business overview,
    the prompt those are assembled into. Each caller deciding for itself
    whether redaction is on, and with which known entities, is how a field ends
    up going out in the clear while the report on the same job says
    ``applied: true``. So the decision is made once, here, and the object is
    threaded through everything the request emits.
    """

    @classmethod
    def for_request(
        cls,
        options: dict | None,
        *,
        company_names: list[str] | None = None,
        person_names: list[str] | None = None,
    ) -> Redactor:
        """The policy for one inbound request: on by default, switchable off by
        ``options.anonymize``, and not switchable off in production (audit
        B-1 P1).

        Every route that sends text to OpenRouter builds its Redactor here.
        The rule is one sentence long and still worth centralising, because the
        failure mode of a second copy is not a wrong answer — it is a route
        that quietly honours ``anonymize: false`` in production while the
        pipelines beside it do not.
        """
        enforced = anonymization_enforced()
        return cls(
            company_names=company_names,
            person_names=person_names,
            applied=enforced or bool((options or {}).get("anonymize", True)),
            enforced=enforced,
        )

    def __init__(
        self,
        *,
        company_names: list[str] | None = None,
        person_names: list[str] | None = None,
        applied: bool = True,
        enforced: bool = False,
    ) -> None:
        self.applied = applied
        self.enforced = enforced
        self._companies = list(company_names or [])
        self._people = list(person_names or [])
        # Bounded here as well as at the choke point in `_redact_entities`, so an
        # over-size list is refused while the request is still being set up —
        # before a document is decoded or a token is spent — rather than on the
        # first field that happens to be redacted.
        for label, values in (("companies", self._companies), ("names", self._people)):
            if len(values) > MAX_KNOWN_ENTITIES:
                raise AnonymizeInputError(
                    f"too many known {label} to redact against: {len(values)} "
                    f"(the limit is {MAX_KNOWN_ENTITIES})"
                )
        self._totals: dict[str, int] = {}

    def text(self, value: str) -> str:
        """Redact one string on its way out, adding what was struck to the tally.

        Idempotent in the way that matters: re-running it over text that has
        already been through it finds nothing left to strike and adds nothing
        to the counts, so a field may safely be redacted where it is assembled
        *and* again at the gate.
        """
        if not self.applied or not value:
            return value
        redacted, counts = redact(value, company_names=self._companies, person_names=self._people)
        for category, n in counts.items():
            self._totals[category] = self._totals.get(category, 0) + n
        return redacted

    def report(self) -> dict:
        """What the persisted job record says about this request's redaction."""
        if not self.applied:
            return {"applied": False, "redacted": {}}
        return {"applied": True, "redacted": dict(self._totals), "enforced": self.enforced}
