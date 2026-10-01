"""Engagement Tagging Agent — 409.ai parity gap #23 (``AI:FindRelevantTags``).

Classifies an engagement against the platform's fixed tag vocabulary — stage,
revenue, business model, capital structure, valuation context and risk — from
its own documents and stored parameters.

## The vocabulary arrives in the payload; it is not defined here

The single decision this agent inherits is that the vocabulary is *closed*, and
the reasoning is written out in ``domain/valuationTags.ts``: a tagging model
asked for free text returns ``saas``, ``SaaS``, ``B2B SaaS`` and
``software-as-a-service`` for one fact across four engagements, and a filter
over that vocabulary returns a quarter of the matches while looking exactly like
a filter that worked.

That catalogue is the analyst's tooltip and the model's specification at once,
which is precisely why it must not exist twice. A Python copy of the forty tags
would be correct on the day it was written and wrong the first time somebody
added a tag on the TypeScript side — and wrong in the quietest possible way,
because the agent would keep proposing a slug the platform no longer honours and
the tags would merely feel thin. So the valuation service ships the catalogue in
``tag_catalogue`` and this module holds no vocabulary of its own.

The consequence is that a run without a catalogue cannot be salvaged, and it is
refused rather than attempted. Free text from an uninstructed model is dropped
in its entirety by ``mapAgentTags`` downstream, which presents as "the documents
did not classify this engagement" — the one answer that is both wrong and
expensive to disbelieve. ``PipelineInputError`` makes it a 422 naming the field.

## Why the filtering here is not the authority

Slugs outside the supplied catalogue are separated into ``unknown_slugs`` rather
than dropped, for the reason ``MappedTagSet.unknown`` gives: a drop nobody can
see is how a vocabulary quietly stops covering the book of work. Surfaced, a
model that keeps proposing ``ai_infrastructure`` is a request to extend the
catalogue, which is a decision a person makes.

But this pass is a convenience, not the gate. ``mapAgentTags`` re-filters
against the real catalogue when the job is applied, because a stored job can
predate a catalogue change by weeks — a tag valid at 3pm on the day of the run
and retired the following sprint must not be written just because it survived
here.

## What is deliberately *not* enforced

Stage and revenue are exclusive categories, and this agent does not collapse
them. Exclusivity is enforced on *acceptance*, in the route, and the domain
module says why: two competing suggestions are useful, because choosing between
them is exactly the judgement the analyst is being asked to make. An agent that
silently picked ``seed`` over ``series_a`` would hide the ambiguity it found.
The prompt asks the model to choose one and to say so in the rationale when it
genuinely cannot — which is a stated finding, not a silent one.
"""

from __future__ import annotations

from typing import Any

from . import _common as c

_SYSTEM = (
    "You are a valuation analyst classifying an engagement for a firm's own "
    "records. You are given a company's documents with identifying details "
    "removed, its stored valuation parameters, and a fixed list of tags with "
    "their definitions. Choose only tags from that list, and only where the "
    "material you were given supports them — a tag you cannot point to evidence "
    "for is worse than a missing tag, because someone will filter on it. Never "
    "invent a tag that is not in the list. Give each tag a short rationale and "
    "name the document or field it came from. Respond ONLY with JSON."
)

#: How much of the corpus one tagging call carries. Matched to the company
#: profile agent's budget rather than the cap table's 45k: this reads the deck's
#: narrative and the top of the financials, not every row of a share ledger.
CORPUS_LIMIT = 30_000

#: How many tags one run may propose. A page of tags is not a classification,
#: and the downstream `MAX_TAGS` is the same number for the same reason.
MAX_TAGS = 12

#: How far down a returned list to look. Bounds the work a pathological response
#: can cause without letting a few malformed entries at the head hide the usable
#: tags behind them — the cap below counts what survives, not what was offered.
SCAN_LIMIT = 60

#: Per-tag citation bound. Eight filenames is a claim an analyst can check;
#: eighty is a wall.
MAX_EVIDENCE = 8


class PipelineInputError(ValueError):
    """The request is unusable, and no model call can fix it.

    Separate from the bare ``ValueError`` an agent raises on unusable *model*
    output, which ``run_pipeline`` maps to 502. This one is a 422 naming the
    field the caller has to supply, and the distinction is the difference
    between "the model misbehaved, retry" and "this request was malformed".
    """


def _catalogue(raw: Any) -> tuple[list[dict], dict[str, str]]:
    """The supplied vocabulary, as prompt groups and a slug -> category index.

    Accepts the grouped shape the valuation service sends
    (``[{category, label, exclusive, tags: [{slug, label, definition}]}]``) and
    a flat ``[{slug, category, label, definition}]`` list, because a flat list is
    the obvious thing a future caller reaches for and silently tagging nothing
    is too quiet a way to say "wrong shape".
    """
    groups: list[dict] = []
    index: dict[str, str] = {}

    def add(group_label: str, exclusive: bool, entries: Any) -> None:
        tags: list[dict] = []
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            slug = c.clean_str(entry.get("slug"), limit=64)
            if not slug or slug in index:
                continue
            index[slug] = group_label
            tags.append(
                {
                    "slug": slug,
                    "label": c.clean_str(entry.get("label"), limit=200) or slug,
                    "definition": c.clean_str(entry.get("definition"), limit=600),
                }
            )
        if tags:
            groups.append({"label": group_label, "exclusive": exclusive, "tags": tags})

    if isinstance(raw, list) and any(isinstance(g, dict) and "tags" in g for g in raw):
        for group in raw:
            if not isinstance(group, dict):
                continue
            label = c.clean_str(group.get("label"), limit=200) or c.clean_str(
                group.get("category"), limit=200
            )
            add(label or "Other", bool(group.get("exclusive")), group.get("tags"))
    elif isinstance(raw, list):
        # Flat list: group by the entry's own category so the prompt still reads
        # as a structured vocabulary rather than forty undifferentiated slugs.
        by_category: dict[str, list[Any]] = {}
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            label = c.clean_str(entry.get("category"), limit=200) or "Other"
            by_category.setdefault(label, []).append(entry)
        for label, entries in by_category.items():
            add(label, False, entries)

    if not index:
        raise PipelineInputError(
            "The tagging digital robot requires a 'tag_catalogue' in the payload — the "
            "vocabulary is closed and is defined by the valuation service, not "
            "by this digital robot"
        )
    return groups, index


def _render(groups: list[dict]) -> str:
    """The catalogue as the model reads it.

    The definition travels with every slug. It is the same sentence the analyst
    sees in the tooltip, which is what stops the model's reading of a tag and the
    reviewer's from drifting apart — the two would otherwise agree on the word
    and disagree on the claim.
    """
    lines: list[str] = []
    for group in groups:
        suffix = " (choose at most one)" if group["exclusive"] else ""
        lines.append(f"{group['label']}{suffix}:")
        for tag in group["tags"]:
            definition = f" — {tag['definition']}" if tag["definition"] else ""
            lines.append(f"  {tag['slug']}: {tag['label']}{definition}")
    return "\n".join(lines)


def _tags(raw: Any, index: dict[str, str]) -> tuple[list[dict], list[str]]:
    """Normalised tags, and the slugs that were not in the catalogue.

    The cap counts what survives rather than what was offered — the same
    reasoning ``company_profile._codes`` and ``mapAgentTags`` document.
    Truncating first would let twelve invented slugs spend the whole budget and
    return nothing, reading as "the documents did not classify this engagement"
    when the model in fact proposed six usable tags after them.
    """
    tags: list[dict] = []
    unknown: list[str] = []
    seen: set[str] = set()

    for entry in raw[:SCAN_LIMIT] if isinstance(raw, list) else []:
        if len(tags) >= MAX_TAGS:
            break
        if not isinstance(entry, dict):
            continue
        slug = c.clean_str(entry.get("slug"), limit=64)
        if not slug or slug in seen:
            continue
        seen.add(slug)
        if slug not in index:
            # Deduplicated against the same set and bounded: a response that
            # repeated one invented slug forty times would otherwise fill the
            # job result with it.
            if len(unknown) < MAX_TAGS:
                unknown.append(slug)
            continue
        tags.append(
            {
                "slug": slug,
                "category": index[slug],
                "confidence": c.clamp_confidence(entry.get("confidence")),
                "rationale": c.clean_str(entry.get("rationale"), limit=600) or None,
                # Scanned wide and capped after, not capped and then cleaned:
                # `str_list` truncates before it drops blanks, so passing the
                # cap straight in would let two nulls at the head of the list
                # cost the analyst two real citations.
                "evidence": c.str_list(entry.get("evidence"), limit=SCAN_LIMIT, item_limit=300)[
                    :MAX_EVIDENCE
                ],
            }
        )
    return tags, unknown


def run_tagging(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}

    # Before the redactor and before any document work: a payload with no
    # vocabulary cannot produce a usable answer, and spending an LLM call to
    # discover that would bill the client for a run whose every tag is dropped.
    groups, index = _catalogue(payload.get("tag_catalogue"))

    red = c.redactor(payload)
    corpus, _, reviewed = c.load_corpus(payload, red, CORPUS_LIMIT)

    system, model = c.prompt_overrides(payload, _SYSTEM)
    user = f"""Company: {c.subject(payload)} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Known parameters: {c.params_summary(params)}
The company's own documents:
{corpus}

The tag vocabulary. Use these slugs exactly; no other tag exists:
{_render(groups)}

Classify this engagement. Return JSON:
{{
  "tags": [
    {{
      "slug": "<a slug from the vocabulary above>",
      "confidence": <0-1>,
      "rationale": "<one or two sentences: what in the material supports this tag>",
      "evidence": ["<the filename or parameter name it was read from>", ...]
    }}
  ],
  "notes": "<anything a reviewer should know about this classification, or empty>"
}}
Propose at most {MAX_TAGS} tags. Only tag what the material supports — a tag nobody can check is worse than a missing one, because the firm will filter on it. Where a category is marked "choose at most one" and the material genuinely does not settle the choice, you may return both and must say so in the rationale."""

    llm = c.ask(red, system, user, model)
    parsed = c.safe_result(llm, "tagging")
    doc = parsed if isinstance(parsed, dict) else {}

    tags, unknown = _tags(doc.get("tags"), index)
    result = {
        "tags": tags,
        # Surfaced rather than swallowed: if the model keeps proposing a slug the
        # catalogue does not carry, that is a request to extend the vocabulary,
        # and a person decides it. Eaten silently, the only signal is that the
        # tags feel thin.
        "unknown_slugs": unknown,
        "notes": c.clean_str(doc.get("notes"), limit=2000),
        "documents_reviewed": [d.filename for d in reviewed],
        "catalogue_size": len(index),
        "anonymization": red.report(),
    }
    return llm.model, result
