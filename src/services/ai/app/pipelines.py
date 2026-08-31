"""M1 AI pipelines: missing-data detection, data extraction, public comparables.

Each pipeline builds a prompt from the valuation + params + document corpus,
calls OpenRouter, and normalizes the completion to a stable result schema the
valuation service persists in ai_jobs.result.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import replace
from typing import Any

from . import bedrock
from .anonymize import Redactor
from .documents import (
    CORPUS_SEPARATOR,
    EMPTY_CORPUS,
    DocText,
    corpus_blocks,
    extract_texts,
)
from .llm_router import chat
from .openrouter import LlmResult, extract_json, max_output_tokens

_log = logging.getLogger("pipelines")

# Fields the extraction pipeline may emit — everything else is dropped so a
# hallucinated key can never reach the calculation engine.
ENGINE_INPUT_FIELDS = {
    "shares_outstanding_common",
    "shares_outstanding_preferred",
    "options_outstanding",
    "liquidation_preference",
    "last_round_post_money",
    "last_round_price_per_share",
    "cash",
    "debt",
    "revenue_ltm",
    "revenue_ntm",
    "ebitda_ltm",
    "ebitda_ntm",
    "volatility",
    "risk_free_rate",
}

REQUIRED_CHECKLIST = [
    ("cap_table", "Capitalization table (share classes, counts, preferences)"),
    ("income_statement", "Income statement / P&L"),
    ("balance_sheet", "Balance sheet (cash, debt, assets)"),
    ("projections", "Financial projections / forecast"),
    ("articles_of_incorporation", "Articles of incorporation (liquidation preferences)"),
    ("option_grants", "Option grants / equity plan details"),
]

PARAM_CHECKLIST = [
    ("revenue_status", "Revenue status (pre/post revenue)"),
    ("exit_timeline", "Expected exit timeline"),
    ("weight_opm", "Approach weights"),
    ("dlom_method", "DLOM method"),
]


def _params_summary(params: dict | None) -> str:
    if not params:
        return "(no params set)"
    keep = {
        k: v
        for k, v in params.items()
        if k
        in {
            "revenue_status",
            "exit_timeline",
            "last_round_date",
            "weight_asset",
            "weight_opm",
            "weight_income",
            "weight_market",
            "dloc",
            "dlom_method",
            "market_method",
            "market_horizon",
            "business_overview",
        }
        and v is not None
    }
    return json.dumps(keep, default=str) if keep else "(no params set)"


def _prompt_overrides(payload: dict, default_system: str) -> tuple[str, str | None]:
    """(system_prompt, model) — the valuation service ships the registry row
    (Bot Prompts view) as payload["prompt"]; fall back to the built-in."""
    prompt = payload.get("prompt")
    if not isinstance(prompt, dict):
        return default_system, None
    system = prompt.get("system")
    model = prompt.get("model")
    return (
        system if isinstance(system, str) and system.strip() else default_system,
        model if isinstance(model, str) and model.strip() else None,
    )


def _known_entities(payload: dict) -> tuple[list[str], list[str]]:
    """(company_names, person_names) the caller already knows. The subject
    company name always comes through on the valuation; callers may pass more
    via options.known_companies / options.known_people."""
    valuation = payload.get("valuation") or {}
    options = payload.get("options") or {}
    companies: list[str] = [str(valuation["company_name"])] if valuation.get("company_name") else []
    companies += [str(c) for c in (options.get("known_companies") or []) if c]
    people = [str(p) for p in (options.get("known_people") or []) if p]
    return companies, people


def _redactor(payload: dict) -> Redactor:
    """The redaction policy for one request.

    Everything the request sends outward goes through this one object, so the
    document pass, the prompt fields around it and the gate below cannot
    disagree about whether redaction is on or which entities are known. In
    production the anonymize=false escape hatch is ignored (audit B-1 P1).
    """
    companies, people = _known_entities(payload)
    return Redactor.for_request(
        payload.get("options"),
        company_names=companies,
        person_names=people,
    )


def _ask(red: Redactor, system: str, user: str, model: str | None) -> LlmResult:
    """The only way a prompt leaves this module.

    Fields known to carry client data are struck where they are assembled, so
    that the redaction reads as a deliberate decision at each one. This is the
    backstop for the fields nobody classified. `business_overview` is free text
    a founder typed into a form — it reached five prompts with the company
    name, a founder's name and a contact email still in it, and none of the
    five looked like they were handling PII. A prompt that grows a new
    interpolated field tomorrow cannot leak merely because whoever adds it does
    not know this module redacts anything.

    The system prompt goes through too: it is operator-authored (the Bot
    Prompts registry ships it as payload["prompt"]), which makes it the one
    part of the request no reviewer of a client payload would ever think to
    check.
    """
    return chat(red.text(system), red.text(user), model=model)


def _subject(payload: dict) -> str:
    """How the prompt may name the company.

    Every pipeline opens its prompt with "Company: …" taken straight off the
    valuation record. Redacting the same name out of the documents and then
    printing it in the line above them protects nothing: a model handed
    "Company: Acme Robotics, Inc." and a document reading "[COMPANY] holds
    2,000,000 shares" has been told exactly what the placeholder stands for,
    and the cap table is re-identified in one step. The point of the redaction
    is that the subject of a confidential 409A does not leave the trust
    boundary, so when it is on, the header is a placeholder too.

    Left as-is when redaction is switched off, which is the case that is
    already saying it wants the real thing — and which production cannot
    reach (audit B-1 P1).
    """
    valuation = payload.get("valuation") or {}
    name = valuation.get("company_name")
    if name and _redactor(payload).applied:
        return "[COMPANY]"
    return str(name)


def _load_docs(payload: dict, red: Redactor | None = None) -> tuple[list[DocText], dict]:
    """Extract document texts, redacting PII first (remaining-gaps §2 — the
    cap-table anonymization step) unless options.anonymize is switched off.

    Named-entity redaction (company + known person names) supplements the
    regexes so a cap table's most identifying fields don't leave the trust
    boundary. In production the anonymize=false escape hatch is ignored
    (audit B-1 P1).

    Only the body is touched here. The filename is redacted at render time
    instead — see `_corpus` — because the result the analyst reads has to name
    the file they actually uploaded."""
    red = red or _redactor(payload)
    docs = extract_texts(payload.get("documents") or [])
    for doc in docs:
        doc.text = red.text(doc.text)
    return docs, red.report()


#: Appended to a document the character budget cut short, in the corpus itself.
#:
#: The model is the only reader who can act on it — it is the one being asked
#: to draw a conclusion from the text above, and a cap table that stops in the
#: middle of the preferred rows reads exactly like a cap table with no
#: preferred rows. Everything else on this platform that trims a thing a person
#: will act on says so; this is the same rule for the reader that happens not
#: to be a person.
_CUT_NOTE = "\n[... this document was cut short here; the rest was not sent]"

#: The least of a document worth sending once it has to be cut. Below this a
#: "block" is a header, a line and a half, and the note above — which is not
#: material a conclusion can be drawn from, and is worth less than the budget
#: it spends. Anything under it is left out whole instead.
_MIN_CUT_BLOCK_CHARS = 2000


def _corpus(
    docs: list[DocText], red: Redactor, limit: int
) -> tuple[str, dict[str, DocText], list[DocText]]:
    """The corpus as the model sees it, a map back from the filename it will
    echo to the document that filename belongs to, and the documents the corpus
    actually contains.

    Real 409A uploads are called "Acme Robotics - Cap Table 2025.xlsx" and
    "Ada Lovelace Option Grant.pdf". `render_corpus` heads each block with the
    filename, so the corpus announced the company and its founders directly
    above the body it had just struck them out of.

    The `DocText` keeps its real filename: `documents_reviewed` and the
    per-document summaries are read by the analyst who uploaded the file, and
    they go to our own database, not to the model.

    The third return value is the reason this function budgets per document
    instead of rendering everything and slicing the result to `limit`, which is
    what it used to do. Two facts met there:

    * `extract_texts` allows 20 000 characters per document and 60 000 across
      the corpus, and every caller here passes a `limit` below 60 000 — 15 000
      on one of them. So the cut was not a theoretical ceiling: three ordinary
      spreadsheets overrun the smallest budget on their own.
    * `documents_reviewed` was `[d.filename for d in docs]` — every document
      handed to the pipeline, not every document that survived the slice.

    Together those made an analyst-facing work product that names documents the
    model was never shown, and — worse, because it is silent on both sides — a
    document cut off mid-table that the model reads as complete. That is the
    same defect `routes/ai.ts` names in the valuation service, where
    `document_ids` was recorded off the engagement's whole corpus rather than
    off what `encodeDocuments` actually sent: *a defensibility record naming
    documents a run never saw is worse than one naming none*. This is that
    record, one tier down and about the same documents.

    So: whole documents while they fit, one cut document with the cut declared
    in the text, nothing after it, and a `reviewed` list that says which. A
    document too large for an empty budget is still cut rather than dropped —
    the alternative is a run over no documents at all whenever the first upload
    is bigger than the limit, which is a `limit` of 15 000 against a per-doc
    ceiling of 20 000.
    """
    shown_names = _distinct_filenames([red.text(doc.filename) for doc in docs])
    shown = [replace(doc, filename=name) for doc, name in zip(docs, shown_names)]
    by_shown_filename = dict(zip(shown_names, docs))
    if not docs:
        return EMPTY_CORPUS, by_shown_filename, []

    kept: list[str] = []
    reviewed: list[DocText] = []
    remaining = limit
    for original, block in zip(docs, corpus_blocks(shown)):
        join = len(CORPUS_SEPARATOR) if kept else 0
        if join + len(block) <= remaining:
            kept.append(block)
            reviewed.append(original)
            remaining -= join + len(block)
            continue
        room = remaining - join
        # The first document is cut however little room there is: see above.
        if room <= 0 or (room < _MIN_CUT_BLOCK_CHARS and kept):
            break
        # The note is spent out of the room it declares. A budget smaller than
        # the note itself is degenerate — every real `limit` here is five
        # figures — and there a hard cut is the only thing that fits.
        body = room - len(_CUT_NOTE)
        kept.append(block[:body] + _CUT_NOTE if body > 0 else block[:room])
        reviewed.append(original)
        break

    if len(reviewed) < len(docs):
        _log.warning(
            "corpus truncated to the character budget",
            extra={
                "event": "corpus_truncated",
                "reviewed": len(reviewed),
                "documents": len(docs),
                "detail": f"limit={limit}",
            },
        )
    return CORPUS_SEPARATOR.join(kept) or EMPTY_CORPUS, by_shown_filename, reviewed


def _numbered(name: str, n: int) -> str:
    """`name` with an ordinal, kept before the extension so it still reads as a
    filename: "[NAME] Option Grant.pdf" -> "[NAME] Option Grant (2).pdf"."""
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:  # no extension, or a dotfile like ".env"
        return f"{name} ({n})"
    return f"{stem} ({n}).{ext}"


def _distinct_filenames(names: list[str]) -> list[str]:
    """Make the names the model is shown unique, preserving order.

    Redaction is many-to-one, and filenames are exactly where it collides:
    a 409A engagement uploads one grant letter per employee, and they are
    conventionally named after the grantee, so "Ada Lovelace Option Grant.pdf"
    and "Grace Hopper Option Grant.pdf" both become "[NAME] Option Grant.pdf".
    Two things then broke at once, both silently:

    * the caller's filename -> document map is built from these names, so N
      colliding uploads collapsed to one entry and *every* summary was
      attributed to whichever document happened to be last — the analyst gets
      Ada's numbers under Grace's filename, in an audit work product;
    * the model was shown several identically-headed blocks and asked for "one
      entry per document" keyed by filename, which is unanswerable. It could
      not have got this right even in principle.

    The ordinal is derived from position alone, so it carries nothing that was
    just redacted out. Collisions among *unredacted* names are deduplicated the
    same way — two uploads genuinely called the same thing fail identically.
    """
    used: set[str] = set()
    out: list[str] = []
    for name in names:
        candidate, n = name, 1
        # A loop rather than a counter: the numbered form can itself collide
        # with a later name that was literally called "… (2).pdf".
        while candidate in used:
            n += 1
            candidate = _numbered(name, n)
        used.add(candidate)
        out.append(candidate)
    return out


def _to_number(value: Any) -> float | None:
    """A model-emitted figure as a finite float, or None if it isn't one.

    Non-finite is not a theoretical case here, it is the default behaviour of
    both parsers in the path. ``json.loads`` accepts the non-standard ``NaN``,
    ``Infinity`` and ``-Infinity`` literals, and folds an overflowing literal
    like ``1e400`` to ``inf`` without complaint; ``float()`` accepts the
    strings ``"nan"``, ``"inf"`` and ``"Infinity"`` for the same reason. Either
    one reaches ``engine_inputs``, which the auto-pipeline applies to the
    valuation's params unattended.

    Both ends of that then break. ``json.dumps`` — what FastAPI serialises the
    response with — writes those values back out as the bare tokens ``NaN`` and
    ``Infinity``, which are not JSON, so the valuation service's ``JSON.parse``
    throws and the whole pipeline 500s on a body we produced ourselves. And a
    NaN that did get through compares false against every range check
    downstream (``NaN <= 0`` is False), so it would pass validation and make
    every allocated value NaN — the same failure ``waterfall._finite`` exists
    to stop one layer further in. Refusing the value here leaves the field
    simply absent, which is what "not found" already means to every caller.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        cleaned = value.replace(",", "").replace("$", "").strip()
        try:
            number = float(cleaned)
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def run_missing_data(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    red = _redactor(payload)
    docs, _ = _load_docs(payload, red)
    corpus, _, reviewed = _corpus(docs, red, 30000)
    uploaded_kinds = {d.kind for d in docs}
    params = payload.get("params") or {}

    # Deterministic part: checklist vs uploaded kinds + unset params.
    missing_docs = [
        {"kind": kind, "label": label, "source": "checklist"}
        for kind, label in REQUIRED_CHECKLIST
        if kind not in uploaded_kinds
    ]
    missing_params = [
        {"field": field, "label": label, "source": "checklist"}
        for field, label in PARAM_CHECKLIST
        if params.get(field) is None
    ]

    system, model = _prompt_overrides(
        payload,
        "You are a 409A valuation analyst assistant. You review what a client has "
        "uploaded and identify what is still missing to complete a defensible "
        "valuation. Respond ONLY with JSON.",
    )
    user = f"""Company: {_subject(payload)} ({valuation.get("kind")} valuation)
Params already set: {_params_summary(params)}
Uploaded documents:
{corpus}

Review the uploaded material. Return JSON:
{{
  "gaps": [{{"item": "<what is missing or incomplete>", "why": "<one sentence>", "severity": "blocking|important|nice_to_have"}}],
  "notes": "<one-paragraph overall assessment>"
}}
Only list gaps you can justify from the documents (e.g. a cap table with no
preference amounts, projections without expenses). Maximum 10 gaps."""

    llm = _ask(red, system, user, model)
    parsed = _safe_result(llm)
    gaps = parsed.get("gaps") if isinstance(parsed, dict) else None
    result = {
        "missing_documents": missing_docs,
        "missing_params": missing_params,
        "gaps": gaps if isinstance(gaps, list) else [],
        "notes": parsed.get("notes", "") if isinstance(parsed, dict) else "",
        "documents_reviewed": [d.filename for d in reviewed],
        "anonymization": red.report(),
    }
    return llm.model, result


def run_extract(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    red = _redactor(payload)
    docs, _ = _load_docs(payload, red)
    corpus, _, reviewed = _corpus(docs, red, 45000)

    system, model = _prompt_overrides(
        payload,
        "You are a financial data extraction engine for 409A valuations. Extract "
        "ONLY values explicitly present in the documents. Never invent numbers. "
        "All monetary amounts in plain units (dollars, not thousands). Respond ONLY with JSON.",
    )
    user = f"""Company: {_subject(payload)} (currency {valuation.get("currency", "USD")})
Documents:
{corpus}

Extract what is present. Return JSON:
{{
  "engine_inputs": {{
    "shares_outstanding_common": <number|null>,
    "shares_outstanding_preferred": <number|null>,
    "options_outstanding": <number|null>,
    "liquidation_preference": <number|null>,
    "last_round_post_money": <number|null>,
    "last_round_price_per_share": <number|null>,
    "cash": <number|null>,
    "debt": <number|null>,
    "revenue_ltm": <number|null>,
    "revenue_ntm": <number|null>,
    "ebitda_ltm": <number|null>,
    "ebitda_ntm": <number|null>
  }},
  "extractions": [{{"field": "<engine_inputs key>", "value": <number>, "source_document": "<filename>", "quote": "<short supporting quote>", "confidence": <0-1>}}]
}}
Use null for anything not found. ebitda may be negative."""

    llm = _ask(red, system, user, model)
    parsed = _safe_result(llm)
    raw_inputs = parsed.get("engine_inputs") if isinstance(parsed, dict) else None
    engine_inputs: dict[str, float] = {}
    if isinstance(raw_inputs, dict):
        for key, value in raw_inputs.items():
            num = _to_number(value)
            if key in ENGINE_INPUT_FIELDS and num is not None:
                engine_inputs[key] = num
    extractions = parsed.get("extractions") if isinstance(parsed, dict) else None
    result = {
        "engine_inputs": engine_inputs,
        "extractions": extractions if isinstance(extractions, list) else [],
        "documents_reviewed": [d.filename for d in reviewed],
        "anonymization": red.report(),
    }
    return llm.model, result


def run_comparables(payload: dict) -> tuple[str, dict]:
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}
    red = _redactor(payload)
    docs, _ = _load_docs(payload, red)
    corpus, _, _ = _corpus(docs, red, 15000)

    system, model = _prompt_overrides(
        payload,
        "You are a valuation analyst finding guideline public companies "
        "(market approach / GPC method). Suggest liquid, well-known public "
        "companies in the same or adjacent business. Multiples are EV/Revenue "
        "and EV/EBITDA estimates typical for the sector — mark them as "
        "estimates. Respond ONLY with JSON.",
    )
    # Free text a founder typed into a form. It routinely opens "Acme Robotics
    # is a San Francisco robotics company founded by Ada Lovelace
    # (ada@acme.io)" — the company, a person and a contact address, in the one
    # field on the request that nothing classified as sensitive (round-7 audit).
    overview = red.text(params.get("business_overview") or "")
    user = f"""Company: {_subject(payload)}
Business overview: {overview or "(none provided)"}
Countries served: {valuation.get("service_countries")}
Document excerpts (for business context only):
{corpus}

Return JSON:
{{
  "comparables": [{{"name": "<public company>", "ticker": "<symbol>", "rationale": "<one sentence>", "revenue_multiple": <number>, "ebitda_multiple": <number|null>}}],
  "sector": "<one-line sector classification>",
  "caveats": "<one sentence on reliability of these multiples>"
}}
5 to 8 comparables, ordered by relevance."""

    llm = _ask(red, system, user, model)
    parsed = _safe_result(llm)
    comparables = []
    if isinstance(parsed, dict) and isinstance(parsed.get("comparables"), list):
        for comp in parsed["comparables"][:10]:
            if not isinstance(comp, dict) or not comp.get("name"):
                continue
            comparables.append(
                {
                    "name": str(comp.get("name")),
                    "ticker": str(comp.get("ticker") or ""),
                    "rationale": str(comp.get("rationale") or ""),
                    "revenue_multiple": _to_number(comp.get("revenue_multiple")),
                    "ebitda_multiple": _to_number(comp.get("ebitda_multiple")),
                }
            )
    result = {
        "comparables": comparables,
        "sector": parsed.get("sector", "") if isinstance(parsed, dict) else "",
        "caveats": parsed.get("caveats", "") if isinstance(parsed, dict) else "",
        "anonymization": red.report(),
    }
    return llm.model, result


def run_summarize(payload: dict) -> tuple[str, dict]:
    """Summarize Attachments (remaining-gaps §2 "AI actions & pipelines")."""
    valuation = payload.get("valuation") or {}
    red = _redactor(payload)
    docs, _ = _load_docs(payload, red)
    corpus, by_shown_filename, reviewed = _corpus(docs, red, 45000)

    system, model = _prompt_overrides(
        payload,
        "You are a 409A valuation analyst assistant. Summarize each uploaded "
        "attachment for the analyst working the engagement: what the document "
        "is, what it says, and the figures that matter for a valuation. "
        "Never invent numbers. Respond ONLY with JSON.",
    )
    user = f"""Company: {_subject(payload)} ({valuation.get("kind")} valuation)
Documents:
{corpus}

Return JSON:
{{
  "summaries": [{{"filename": "<document filename>", "summary": "<2-4 sentences>", "key_figures": ["<figure with label>", ...]}}],
  "overall": "<one-paragraph synthesis across all documents>"
}}
One entry per document, in the order given. key_figures only for values
actually present in that document (share counts, preferences, cash, revenue)."""

    llm = _ask(red, system, user, model)
    parsed = _safe_result(llm)
    summaries = []
    if isinstance(parsed, dict) and isinstance(parsed.get("summaries"), list):
        for entry in parsed["summaries"][:20]:
            if not isinstance(entry, dict) or not entry.get("filename"):
                continue
            # The model can only echo the filename it was shown, which is the
            # redacted one; the analyst has to be given back the file they
            # uploaded. An unrecognised name stays as the model wrote it —
            # already redacted, so a wrong guess cannot leak.
            filename = str(entry.get("filename"))
            doc = by_shown_filename.get(filename)
            key_figures = entry.get("key_figures")
            summaries.append(
                {
                    "filename": doc.filename if doc else filename,
                    "kind": doc.kind if doc else "other",
                    "summary": str(entry.get("summary") or ""),
                    "key_figures": [str(f) for f in key_figures[:10]]
                    if isinstance(key_figures, list)
                    else [],
                }
            )
    result = {
        "summaries": summaries,
        "overall": parsed.get("overall", "") if isinstance(parsed, dict) else "",
        "documents_reviewed": [d.filename for d in reviewed],
        "anonymization": red.report(),
    }
    return llm.model, result


QA_SEVERITIES = {"info", "warn", "fail"}
QA_VERDICTS = {"pass", "warn", "fail"}


def _calculation_summary(payload: dict) -> str:
    """Compact JSON of the calculation under review (results + key inputs)."""
    calc = payload.get("calculation")
    if not isinstance(calc, dict):
        return "(no calculation provided)"
    keep = {
        "equity_value": calc.get("equity_value"),
        "fmv_per_share": calc.get("fmv_per_share"),
        "results": calc.get("results"),
        "inputs": calc.get("inputs"),
    }
    return json.dumps(keep, default=str)[:20000]


def run_qa(payload: dict) -> tuple[str, dict]:
    """Output QA reviewer (IMPROVEMENTS_RESEARCH §4.3): judges a finished
    calculation for reasonableness and internal consistency. The valuation
    service runs its deterministic checks first and ships them along; the
    reviewer looks for what rules can't catch. The verdict only ever
    tightens the deterministic outcome — the caller enforces that."""
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}
    checks = payload.get("qa_checks") or []
    red = _redactor(payload)

    system, model = _prompt_overrides(
        payload,
        "You are a senior 409A valuation reviewer performing quality assurance "
        "before delivery. Be skeptical: look for inconsistent figures, "
        "implausible assumptions, and results that would not survive an IRS or "
        "auditor challenge. Do not repeat findings the deterministic checks "
        "already flagged. Respond ONLY with JSON.",
    )
    user = f"""Company: {_subject(payload)} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Params: {_params_summary(params)}
Calculation under review: {_calculation_summary(payload)}
Deterministic checks already run: {json.dumps(checks, default=str)[:8000]}

Review the calculation. Return JSON:
{{
  "findings": [{{"area": "<inputs|assumptions|outputs|consistency>", "finding": "<one sentence>", "severity": "info|warn|fail"}}],
  "assessment": "<one-paragraph overall judgement>",
  "verdict": "pass|warn|fail"
}}
"fail" only for defects that make the result indefensible. Maximum 10 findings."""

    llm = _ask(red, system, user, model)
    parsed = _safe_result(llm)
    raw_findings = parsed.get("findings") if isinstance(parsed, dict) else None
    findings = []
    if isinstance(raw_findings, list):
        for entry in raw_findings[:10]:
            if not isinstance(entry, dict) or not entry.get("finding"):
                continue
            severity = entry.get("severity")
            findings.append(
                {
                    "area": str(entry.get("area") or "outputs"),
                    "finding": str(entry.get("finding")),
                    "severity": severity if severity in QA_SEVERITIES else "info",
                }
            )
    verdict = parsed.get("verdict") if isinstance(parsed, dict) else None
    if verdict not in QA_VERDICTS:
        # Derive from findings when the model skipped/mangled the verdict — but
        # only when it returned a findings *list*, because that is the only case
        # in which an empty set means anything.
        #
        # `_safe_result` hands back `{"notes": ...}` for a model that answered in
        # prose, and a model may equally answer JSON that omits both keys.
        # Either way `raw_findings` is absent, no finding is extracted, the
        # severity set is empty — and the ladder below then read that emptiness
        # as "nothing was wrong" and returned `"pass"`. That verdict is the
        # whole output of this pipeline: it rides to `qa_reviews.ai_findings`
        # via `combineWithAiVerdict`, it is what a reviewer sees under the AI
        # half of the QA tab, and the publish gate consults the review it sits
        # on. So an unreadable answer was recorded as the reviewer having
        # cleared the valuation — and the prose it actually wrote was discarded
        # on the way, because `assessment` reads a key a `notes` dict has not
        # got and comes out `""`. A clean bill of health, from nobody.
        #
        # Refused rather than downgraded to `"warn"`. `routes/qa.ts` writes no
        # review row when this call fails ("a half-run must not open the gate"),
        # which is the correct outcome for a review that did not happen; a
        # `"warn"` would still file one and still claim the reviewer spoke. Plain
        # `ValueError`, which `main` answers 502 — "the model said something
        # unusable" — so the retry ladder gets the one attempt that may well
        # come back with the JSON the prompt asked for.
        if not isinstance(raw_findings, list):
            raise ValueError(
                "the QA reviewer returned neither a verdict nor a list of findings, so there is "
                "nothing to review from — an empty finding set is a claim that the calculation is "
                "clean, and this answer did not make it"
            )
        severities = {f["severity"] for f in findings}
        verdict = "fail" if "fail" in severities else "warn" if "warn" in severities else "pass"
    result = {
        "findings": findings,
        "assessment": str(parsed.get("assessment", "")) if isinstance(parsed, dict) else "",
        "verdict": verdict,
        "anonymization": red.report(),
    }
    return llm.model, result


def run_explain(payload: dict) -> tuple[str, dict]:
    """Plain-English report summary (IMPROVEMENTS_RESEARCH §4.5): explains the
    methodology and result to a founder with no valuation background."""
    valuation = payload.get("valuation") or {}
    params = payload.get("params") or {}
    red = _redactor(payload)

    system, model = _prompt_overrides(
        payload,
        "You explain 409A valuations to startup founders in plain English. "
        "No jargon without a one-clause explanation. Describe only what is in "
        "the provided data — never invent figures. This is not legal, tax or "
        "financial advice and must not read as such. Respond ONLY with JSON.",
    )
    user = f"""Company: {_subject(payload)} ({valuation.get("kind")} valuation, {valuation.get("currency", "USD")})
Params: {_params_summary(params)}
Calculation: {_calculation_summary(payload)}

Explain this valuation to the company's founder. Return JSON:
{{
  "summary": "<2-3 plain-English paragraphs: what was concluded and what it means>",
  "methodology": [{{"approach": "<name>", "weight": <0-1|null>, "explanation": "<1-2 sentences on what it does and why it was used>"}}],
  "drivers": ["<key factor that moved the value>", ...],
  "caveats": "<one sentence on limits of this explanation>"
}}
Only include approaches that actually carried weight. Maximum 6 drivers."""

    llm = _ask(red, system, user, model)
    parsed = _safe_result(llm)
    methodology = []
    if isinstance(parsed, dict) and isinstance(parsed.get("methodology"), list):
        for entry in parsed["methodology"][:6]:
            if not isinstance(entry, dict) or not entry.get("approach"):
                continue
            methodology.append(
                {
                    "approach": str(entry.get("approach")),
                    "weight": _to_number(entry.get("weight")),
                    "explanation": str(entry.get("explanation") or ""),
                }
            )
    drivers = parsed.get("drivers") if isinstance(parsed, dict) else None
    result = {
        "summary": str(parsed.get("summary", "")) if isinstance(parsed, dict) else "",
        "methodology": methodology,
        "drivers": [str(d) for d in drivers[:6]] if isinstance(drivers, list) else [],
        "caveats": str(parsed.get("caveats", "")) if isinstance(parsed, dict) else "",
        "anonymization": red.report(),
    }
    return llm.model, result


class TruncatedCompletionError(ValueError):
    """The model ran out of output room before it finished its answer.

    A `ValueError` so that anything catching the "model output unusable" case
    still does; its own type so `main` can answer 422 instead of 502, because
    no retry shortens the prompt and the fix is in the request.
    """


class SuppressedCompletionError(ValueError):
    """The provider withheld the answer — a content filter or a guardrail.

    A `ValueError` for the same reason `TruncatedCompletionError` is, and its
    own type for the same reason: `main` answers 422 rather than 502, because
    the same prompt trips the same filter however many times it is sent and the
    fix is in the request, not in retrying it.

    Refused even when what came back happens to parse, which is where this
    differs from truncation. A truncated answer's prefix is the model's own
    words and is worth keeping; a suppressed one's content is the fragment that
    survived the filter, or the guardrail's substituted message — text the model
    did not write, about to be recorded as text the model wrote.
    """


def _suppressed_error(llm: LlmResult) -> SuppressedCompletionError:
    """The refusal, naming what the provider said it did."""
    return SuppressedCompletionError(
        f"the provider withheld this completion ({llm.finish_reason}) — the answer "
        "returned is not the model's, so nothing was read from it; review the "
        "prompt and the documents it carries"
    )


def _truncated_error(llm: LlmResult) -> TruncatedCompletionError:
    """The refusal, naming the cap that was actually hit.

    Two providers answer these prompts and each has its own ceiling and its own
    knob. Naming OpenRouter's unconditionally told an operator whose prompt is
    bound to a `bedrock/` model to raise an environment variable that does not
    apply, and quoted a token figure that was not the one the answer stopped
    at — the whole content of an actionable error, wrong.
    """
    if bedrock.handles(llm.model):
        cap, knob = bedrock.max_output_tokens(), "BEDROCK_MAX_TOKENS"
    else:
        cap, knob = max_output_tokens(), "OPENROUTER_MAX_TOKENS"
    return TruncatedCompletionError(
        f"the model stopped at the {cap}-token output cap "
        f"before completing its answer — send fewer documents, or raise {knob}"
    )


def _safe_result(llm: LlmResult) -> dict:
    """The model's JSON object, or its prose under `notes` when it wrote prose.

    The `notes` fallback is a deliberate degradation for a model that ignored
    "respond ONLY with JSON" — the analyst still gets what it said. It is the
    wrong answer for a *truncated* reply, and that is how it was being used:
    every prompt in this module asks for a JSON object, so a completion cut off
    at the output cap is unparseable, fell into `notes`, and each caller below
    then read its own keys off that dict, found none, and returned an empty
    result. The pipeline reported success, the job row said `succeeded`, and the
    AI tab showed a document summary with no documents in it — an answer, drawn
    from a truncation, that nothing anywhere contradicted.

    A JSON value that is not an object is the *third* way into that same empty
    success, and it was open. `extract_json` returns whatever `json.loads`
    produced — its `dict | list` annotation was a claim, not a check — so a
    model that answered a `{"summaries": [...]}` prompt with the bare array,
    which is among the most ordinary things a model does with a wrapped-list
    schema, came back as a list. Every caller below asks `isinstance(parsed,
    dict)` and takes the empty branch when it is not, so the run produced a
    complete-looking result with nothing in it and reported success. `null`,
    a bare number and a quoted string all landed the same way.

    None of those is prose, so none of them is the `notes` case: the model did
    answer in JSON, of a shape the prompt did not ask for, and a retry can fix
    that. Raised as a plain `ValueError`, which `main` already answers 502 —
    "the model said something unusable" — rather than recording a success.

    A withheld completion is the fourth way in, and it does not need the parse
    to fail: `content` on that path is the fragment a content filter left, or a
    guardrail's substituted message, so it is refused before anything is read
    from it. See `SuppressedCompletionError`.
    """
    if llm.suppressed:
        raise _suppressed_error(llm)
    try:
        parsed = extract_json(llm.content)
    except ValueError as exc:
        if llm.truncated:
            raise _truncated_error(llm) from exc
        return {"notes": llm.content[:1000]}
    if not isinstance(parsed, dict):
        # A cut-off array can still close and parse. When both are true the
        # truncation is the better explanation and the actionable one.
        if llm.truncated:
            raise _truncated_error(llm)
        raise ValueError(
            f"the model returned a JSON {type(parsed).__name__} where the prompt "
            f"asked for an object"
        )
    return parsed


PIPELINES = {
    "missing_data": run_missing_data,
    "extract": run_extract,
    "comparables": run_comparables,
    "summarize": run_summarize,
    "qa": run_qa,
    "explain": run_explain,
}
