"""Shared vocabulary for web-grounded research: the result shape and the gate.

Split out so the two providers can speak the same language without one
importing the other. `perplexity.py` answers a research question by buying
retrieval and synthesis together; `websearch.py` + `research.py` answer it by
retrieving and then synthesising separately. Both return the `ResearchResult`
below, and `research.py` chooses between them — which only works if the choice
can be made without either provider knowing the other exists.

The exception hierarchy here is load-bearing, and it is the one thing in this
file worth reading carefully:

    ResearchError                 anything the subsystem can fail with
     ├── ProviderError            this provider did not answer — try another
     └── ConfidentialityError     stop; do not try another

`ConfidentialityError` is deliberately **not** a subclass of `ProviderError`.
The fallback in `research.py` is written as `except ProviderError`, and if the
confidentiality refusal were catchable there, a query carrying a client's
company name would be refused by the first provider and then handed straight
to the second one — which is the exact failure the refusal exists to prevent,
implemented as a feature. The old `perplexity.py` had these the other way
round (`ConfidentialityError(PerplexityError)`), which was safe only because
nothing had a fallback path yet.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: The redaction placeholders `anonymize.py` substitutes. Their presence in a
#: research query means client text took a wrong turn — see `assert_public`.
#: Mirrored from `anonymize._PLACEHOLDERS` rather than imported so that a
#: placeholder retired there cannot silently stop being refused here; the test
#: suite asserts the two agree.
REDACTION_MARKERS = (
    "[EMAIL]",
    "[SSN]",
    "[EIN]",
    "[PHONE]",
    "[ADDRESS]",
    "[NAME]",
    "[COMPANY]",
)

#: How far back a search may reach. `None` means no filter. One vocabulary for
#: both providers: the route validates against this before dispatching, so a
#: caller's `recency` means the same thing whichever one ends up answering.
RECENCY_FILTERS = ("day", "week", "month", "year")


class ResearchError(Exception):
    """Raised when a research call cannot be completed."""


class ProviderError(ResearchError):
    """Raised when one provider could not answer — a reason to try the next.

    Everything transient or provider-specific lands here: a rejected key, an
    exhausted quota, a 5xx, an unparseable body. The caller is entitled to
    respond by asking somebody else the same question, which is exactly why
    `ConfidentialityError` must not be one of these.
    """


class ConfidentialityError(ResearchError):
    """Raised when a query carries client text that must not be searched.

    A hard stop, not a provider failure. The only correct response is to fix
    whatever assembled the query. Falling back to a second provider here would
    forward the same client text to a second search engine — see this module's
    docstring for why the class hierarchy enforces that rather than trusting a
    comment.
    """


def assert_public(*parts: str) -> None:
    """Refuse text that carries redaction placeholders.

    A tripwire, not a sanitiser. It cannot tell whether a plain company name is
    a client's or a public comparable's — that judgement belongs to the caller,
    which knows which it is holding. What it can tell, with certainty, is that
    text reading "[COMPANY] holds 2,000,000 shares" came off a redaction pass
    over a client document, and no correct path routes that into a web search.

    Called once by `research.research`, before any provider is chosen, so the
    guarantee does not depend on which one answers.
    """
    for part in parts:
        if not part:
            continue
        for marker in REDACTION_MARKERS:
            if marker in part:
                raise ConfidentialityError(
                    f"research query contains the redaction placeholder {marker} — "
                    "client text must not reach a web-search provider"
                )


@dataclass(frozen=True)
class Citation:
    """One source behind an answer. `url` is the only field always supplied."""

    url: str
    title: str = ""
    date: str = ""

    def as_dict(self) -> dict:
        return {"url": self.url, "title": self.title, "date": self.date}


@dataclass
class ResearchResult:
    model: str
    content: str
    citations: list[Citation] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    #: Whether `content` is an answer to the question, or merely a note standing
    #: in for one. False on the sources-only degradation in
    #: `research.fallback_research`: retrieval succeeded, the synthesis model
    #: refused (typically an exhausted quota), and the sources are returned
    #: unread rather than thrown away with the error. Defaulted True so every
    #: existing construction — both providers' success paths — keeps its
    #: meaning without being touched.
    synthesized: bool = True

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def grounded(self) -> bool:
        """Whether this may be quoted in a report.

        Two conditions, and the second is not redundant. Sources are necessary:
        an answer without them is just an expensive completion, and the whole
        reason to take this path is the citation list. But they are not
        sufficient — a sources-only result *has* citations and has no answer,
        and the note where the answer would be ("the sources below were
        retrieved but not summarised") is prose sitting in the field a report
        quotes from. Grounded means "somebody wrote this from those sources",
        so a result nobody wrote is excluded here rather than at each of the
        call sites that would otherwise have to remember to.
        """
        return bool(self.citations) and self.synthesized

    def as_dict(self) -> dict:
        return {
            "model": self.model,
            "content": self.content,
            "citations": [c.as_dict() for c in self.citations],
            "grounded": self.grounded,
            # Sent separately from `grounded` because the two answer different
            # questions and the store keeps both: `grounded` is "may a report
            # quote this", `synthesized` is "why not". Without it a sources-only
            # row is indistinguishable from one whose search came back empty.
            "synthesized": self.synthesized,
            "tokens": self.total_tokens,
        }
