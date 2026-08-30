"""Engagement-tagging agent — chat is monkeypatched, so no network and no key.

Three properties carry the feature and are worth reading first:

  * the vocabulary is supplied by the caller and this service holds no copy of
    it. A payload with no catalogue is refused with a 422 rather than run,
    because free text from an uninstructed model is dropped in its entirety
    downstream and presents as "the documents did not classify this
    engagement" — the one wrong answer that is expensive to disbelieve;

  * a slug outside the supplied catalogue is *surfaced*, not swallowed. A drop
    nobody can see is how a vocabulary quietly stops covering the book of work;
    and

  * the cap counts tags that survive, not tags that were offered. Truncating
    first would let a dozen invented slugs spend the whole budget and return
    nothing, which reads identically to a company nothing could be said about.
"""

import base64
import json

import pytest
from fastapi.testclient import TestClient

from app.agents import _common, tagging
from app.main import app
from app.openrouter import LlmResult


@pytest.fixture
def client():
    return TestClient(app)


def one_chat(response, default_model="test/fake-model"):
    payload = response if isinstance(response, str) else json.dumps(response)

    def _chat(system, user, *, model=None, client=None):
        _chat.calls.append({"system": system, "user": user, "model": model})
        return LlmResult(model=model or default_model, content=payload)

    _chat.calls = []
    return _chat


def doc(filename, kind, text):
    return {
        "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "filename": filename,
        "kind": kind,
        "content_type": "text/plain",
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


#: The grouped shape the valuation service sends (`tagCataloguePayload`).
CATALOGUE = [
    {
        "category": "stage",
        "label": "Stage",
        "exclusive": True,
        "tags": [
            {"slug": "seed", "label": "Seed", "definition": "A seed round has closed."},
            {"slug": "series_a", "label": "Series A", "definition": "A Series A is the most recent round."},
        ],
    },
    {
        "category": "revenue",
        "label": "Revenue",
        "exclusive": True,
        "tags": [
            {"slug": "pre_revenue", "label": "Pre-revenue", "definition": "No revenue recognised."},
        ],
    },
    {
        "category": "business_model",
        "label": "Business model",
        "exclusive": False,
        "tags": [
            {"slug": "saas", "label": "SaaS", "definition": "Revenue is recurring subscriptions."},
            {"slug": "medtech", "label": "Medical device", "definition": "Value rests on a device."},
        ],
    },
]

TAGS = {
    "tags": [
        {
            "slug": "series_a",
            "confidence": 0.9,
            "rationale": "The deck reports a Series A closed in March.",
            "evidence": ["deck.pdf"],
        },
        {
            "slug": "saas",
            "confidence": 0.85,
            "rationale": "Revenue is annual subscriptions.",
            "evidence": ["deck.pdf", "financials.csv"],
        },
    ],
    "notes": "The financials do not separate services revenue.",
}


def payload(*, catalogue=CATALOGUE, docs=None, **extra):
    body = {
        "valuation": {
            "id": "01ARZ3NDEKTSV4RRFFQ69G5FAA",
            "kind": "409a",
            "company_name": "Acme Robotics Inc",
            "currency": "USD",
        },
        "params": {"discount_rate": 0.22},
        "documents": docs if docs is not None else [doc("deck.pdf", "pitch_deck", "Series A closed.")],
        "options": {"anonymize": True},
    }
    if catalogue is not None:
        body["tag_catalogue"] = catalogue
    body.update(extra)
    return body


# ── The happy path, and what the model is actually shown ──────────────────────


def test_returns_normalised_tags(monkeypatch):
    monkeypatch.setattr(_common, "chat", one_chat(TAGS))
    model, result = tagging.run_tagging(payload())

    assert model == "test/fake-model"
    assert [t["slug"] for t in result["tags"]] == ["series_a", "saas"]
    assert result["tags"][0]["confidence"] == 0.9
    assert result["tags"][0]["evidence"] == ["deck.pdf"]
    assert result["unknown_slugs"] == []
    assert result["notes"] == "The financials do not separate services revenue."
    assert result["documents_reviewed"] == ["deck.pdf"]
    assert result["catalogue_size"] == 5


def test_category_is_resolved_onto_every_tag(monkeypatch):
    """The category is the caller's, not the model's.

    A model that returned `"category": "risk"` on `saas` would otherwise have
    its own opinion stored next to the slug and quietly disagree with the
    catalogue the filter groups by.
    """
    said = {
        "tags": [{"slug": "saas", "category": "risk", "confidence": 0.8, "rationale": "r", "evidence": []}]
    }
    monkeypatch.setattr(_common, "chat", one_chat(said))
    _, result = tagging.run_tagging(payload())

    assert result["tags"][0]["category"] == "Business model"


def test_prompt_carries_every_slug_with_its_definition(monkeypatch):
    """The definition the analyst reads is the specification the model is given.

    One definition is what stops the model's reading of a tag and the reviewer's
    from drifting apart — they would otherwise agree on the word and disagree on
    the claim.
    """
    chat = one_chat(TAGS)
    monkeypatch.setattr(_common, "chat", chat)
    tagging.run_tagging(payload())

    user = chat.calls[0]["user"]
    for slug in ("seed", "series_a", "pre_revenue", "saas", "medtech"):
        assert slug in user
    assert "A seed round has closed." in user
    assert "Value rests on a device." in user


def test_exclusive_categories_are_marked_in_the_prompt(monkeypatch):
    chat = one_chat(TAGS)
    monkeypatch.setattr(_common, "chat", chat)
    tagging.run_tagging(payload())

    user = chat.calls[0]["user"]
    assert "Stage (choose at most one):" in user
    assert "Business model:" in user
    assert "Business model (choose at most one)" not in user


def test_company_name_never_reaches_the_model(monkeypatch):
    """Same refusal the company-profile agent documents.

    The classification is drawn from the engagement's own material; a prompt
    that quietly carried the name would invite the model to tag from what it
    recalls about the company instead, sourced to nothing.
    """
    chat = one_chat(TAGS)
    monkeypatch.setattr(_common, "chat", chat)
    tagging.run_tagging(payload(docs=[doc("deck.pdf", "pitch_deck", "Acme Robotics Inc raised a Series A.")]))

    blob = chat.calls[0]["system"] + chat.calls[0]["user"]
    assert "Acme Robotics" not in blob


# ── The closed vocabulary ─────────────────────────────────────────────────────


def test_unknown_slugs_are_surfaced_not_swallowed(monkeypatch):
    said = {
        "tags": [
            {"slug": "ai_infrastructure", "confidence": 0.9, "rationale": "r", "evidence": []},
            {"slug": "saas", "confidence": 0.8, "rationale": "r", "evidence": []},
        ]
    }
    monkeypatch.setattr(_common, "chat", one_chat(said))
    _, result = tagging.run_tagging(payload())

    assert [t["slug"] for t in result["tags"]] == ["saas"]
    assert result["unknown_slugs"] == ["ai_infrastructure"]


def test_a_repeated_invented_slug_cannot_fill_the_result(monkeypatch):
    said = {"tags": [{"slug": "ai_infrastructure"} for _ in range(40)] + [{"slug": "saas"}]}
    monkeypatch.setattr(_common, "chat", one_chat(said))
    _, result = tagging.run_tagging(payload())

    assert result["unknown_slugs"] == ["ai_infrastructure"]
    assert [t["slug"] for t in result["tags"]] == ["saas"]


def test_the_cap_counts_tags_that_survive_not_tags_offered(monkeypatch):
    """Twelve invented slugs must not spend the whole budget.

    The failure this prevents is the quiet one: a result with no tags reads as
    "nothing could be said about this engagement", not as "the model answered
    off-vocabulary and the usable answers were behind the noise".
    """
    invented = [{"slug": f"invented_{i}"} for i in range(tagging.MAX_TAGS)]
    real = [{"slug": s} for s in ("seed", "series_a", "pre_revenue", "saas", "medtech")]
    monkeypatch.setattr(_common, "chat", one_chat({"tags": invented + real}))
    _, result = tagging.run_tagging(payload())

    assert [t["slug"] for t in result["tags"]] == ["seed", "series_a", "pre_revenue", "saas", "medtech"]


def test_tags_are_capped(monkeypatch):
    """More than MAX_TAGS real tags are truncated, not returned whole."""
    catalogue = [
        {
            "category": "business_model",
            "label": "Business model",
            "exclusive": False,
            "tags": [{"slug": f"m{i}", "label": f"M{i}", "definition": "d"} for i in range(30)],
        }
    ]
    monkeypatch.setattr(_common, "chat", one_chat({"tags": [{"slug": f"m{i}"} for i in range(30)]}))
    _, result = tagging.run_tagging(payload(catalogue=catalogue))

    assert len(result["tags"]) == tagging.MAX_TAGS


def test_scan_limit_bounds_a_pathological_response(monkeypatch):
    """A list far longer than SCAN_LIMIT is not walked to its end."""
    said = {"tags": [{"slug": f"junk_{i}"} for i in range(500)] + [{"slug": "saas"}]}
    monkeypatch.setattr(_common, "chat", one_chat(said))
    _, result = tagging.run_tagging(payload())

    # `saas` sat past the scan limit, so it is not reached — the bound is real.
    assert result["tags"] == []
    assert len(result["unknown_slugs"]) == tagging.MAX_TAGS


def test_duplicate_slugs_collapse_to_one(monkeypatch):
    said = {"tags": [{"slug": "saas", "confidence": 0.9}, {"slug": "saas", "confidence": 0.2}]}
    monkeypatch.setattr(_common, "chat", one_chat(said))
    _, result = tagging.run_tagging(payload())

    assert len(result["tags"]) == 1
    assert result["tags"][0]["confidence"] == 0.9


# ── A payload with no vocabulary is refused, not attempted ────────────────────


@pytest.mark.parametrize("catalogue", [None, [], "saas,seed", {}, [{"tags": []}], [1, 2, 3]])
def test_missing_or_unusable_catalogue_is_refused(monkeypatch, catalogue):
    chat = one_chat(TAGS)
    monkeypatch.setattr(_common, "chat", chat)

    with pytest.raises(tagging.PipelineInputError):
        tagging.run_tagging(payload(catalogue=catalogue))

    # Refused *before* the model call: an unsalvageable run must not be billed.
    assert chat.calls == []


def test_missing_catalogue_is_a_422_not_a_502(client, monkeypatch):
    """The distinction is which system the operator goes and looks at.

    502 "Model output unusable" would send them to the model for a fault that is
    in the request.
    """
    monkeypatch.setattr(_common, "chat", one_chat(TAGS))
    res = client.post("/ai/v1/pipelines/tagging", json=payload(catalogue=None))

    assert res.status_code == 422
    assert "tag_catalogue" in res.json()["detail"]


# ── Catalogue shapes ──────────────────────────────────────────────────────────


def test_flat_catalogue_shape_is_accepted(monkeypatch):
    """A flat list is the obvious thing a future caller reaches for.

    Tagging nothing would be too quiet a way to say "wrong shape".
    """
    flat = [
        {"slug": "saas", "category": "business_model", "label": "SaaS", "definition": "Subscriptions."},
        {"slug": "seed", "category": "stage", "label": "Seed", "definition": "Seed closed."},
    ]
    monkeypatch.setattr(_common, "chat", one_chat({"tags": [{"slug": "saas"}, {"slug": "seed"}]}))
    _, result = tagging.run_tagging(payload(catalogue=flat))

    assert [t["slug"] for t in result["tags"]] == ["saas", "seed"]
    assert result["tags"][0]["category"] == "business_model"
    assert result["catalogue_size"] == 2


def test_duplicate_slugs_across_groups_are_indexed_once(monkeypatch):
    catalogue = [
        {"label": "A", "exclusive": False, "tags": [{"slug": "saas", "definition": "d"}]},
        {"label": "B", "exclusive": False, "tags": [{"slug": "saas", "definition": "d"}]},
    ]
    monkeypatch.setattr(_common, "chat", one_chat({"tags": [{"slug": "saas"}]}))
    _, result = tagging.run_tagging(payload(catalogue=catalogue))

    assert result["catalogue_size"] == 1
    assert result["tags"][0]["category"] == "A"


def test_malformed_catalogue_entries_are_skipped(monkeypatch):
    catalogue = [
        {"label": "Stage", "exclusive": True, "tags": ["seed", None, {"slug": ""}, {"slug": "series_a"}]},
        "not a group",
    ]
    monkeypatch.setattr(_common, "chat", one_chat({"tags": [{"slug": "series_a"}]}))
    _, result = tagging.run_tagging(payload(catalogue=catalogue))

    assert result["catalogue_size"] == 1
    assert [t["slug"] for t in result["tags"]] == ["series_a"]


# ── Model output that is not what was asked for ───────────────────────────────


def test_confidence_percentages_are_folded_and_nonsense_refused(monkeypatch):
    """A 0-100 answer is a different scale; anything off every scale is not a
    score at all and comes back null rather than clamped to an endpoint. See
    tests/test_confidence_scores.py."""
    said = {
        "tags": [
            {"slug": "saas", "confidence": 90},
            {"slug": "seed", "confidence": -3},
            {"slug": "series_a", "confidence": "not a number"},
            {"slug": "medtech", "confidence": 9999},
        ]
    }
    monkeypatch.setattr(_common, "chat", one_chat(said))
    _, result = tagging.run_tagging(payload())

    by_slug = {t["slug"]: t["confidence"] for t in result["tags"]}
    assert by_slug["saas"] == 0.9
    assert by_slug["seed"] is None
    assert by_slug["series_a"] is None
    assert by_slug["medtech"] is None


def test_evidence_is_bounded_and_blanks_dropped(monkeypatch):
    said = {"tags": [{"slug": "saas", "evidence": ["a.pdf", "", None, *[f"f{i}" for i in range(20)]]}]}
    monkeypatch.setattr(_common, "chat", one_chat(said))
    _, result = tagging.run_tagging(payload())

    evidence = result["tags"][0]["evidence"]
    assert len(evidence) == tagging.MAX_EVIDENCE
    assert "" not in evidence


def test_non_list_evidence_becomes_empty(monkeypatch):
    monkeypatch.setattr(_common, "chat", one_chat({"tags": [{"slug": "saas", "evidence": "deck.pdf"}]}))
    _, result = tagging.run_tagging(payload())

    assert result["tags"][0]["evidence"] == []


def test_blank_rationale_becomes_null(monkeypatch):
    monkeypatch.setattr(_common, "chat", one_chat({"tags": [{"slug": "saas", "rationale": "   "}]}))
    _, result = tagging.run_tagging(payload())

    assert result["tags"][0]["rationale"] is None


def test_unparseable_model_output_yields_no_tags_rather_than_raising(monkeypatch):
    """`safe_result` degrades to notes; the agent must not invent a tag from that.

    Downstream `mapAgentTags` turns an empty set into a 422 the operator can
    read, which is the right place for that message — this layer's job is only
    to avoid manufacturing a classification out of prose.
    """
    monkeypatch.setattr(_common, "chat", one_chat("I could not classify this company."))
    _, result = tagging.run_tagging(payload())

    assert result["tags"] == []
    assert result["unknown_slugs"] == []


def test_tags_not_a_list_yields_no_tags(monkeypatch):
    monkeypatch.setattr(_common, "chat", one_chat({"tags": {"slug": "saas"}}))
    _, result = tagging.run_tagging(payload())

    assert result["tags"] == []


def test_runs_with_no_documents(monkeypatch):
    """Unlike the company-profile agent, the params alone are a usable source.

    Stage, capital structure and valuation context are all readable from stored
    parameters, so an engagement whose documents have not been uploaded yet is
    still partly classifiable — and the agent is not in
    DOCUMENT_DEPENDENT_PIPELINES for that reason.
    """
    monkeypatch.setattr(_common, "chat", one_chat({"tags": [{"slug": "seed"}]}))
    _, result = tagging.run_tagging(payload(docs=[]))

    assert [t["slug"] for t in result["tags"]] == ["seed"]
    assert result["documents_reviewed"] == []


# ── Registration ──────────────────────────────────────────────────────────────


def test_registered_as_a_pipeline(client, monkeypatch):
    monkeypatch.setattr(_common, "chat", one_chat(TAGS))
    res = client.post("/ai/v1/pipelines/tagging", json=payload())

    assert res.status_code == 200
    body = res.json()
    assert body["model"] == "test/fake-model"
    assert [t["slug"] for t in body["result"]["tags"]] == ["series_a", "saas"]


def test_prompt_override_from_the_registry_is_honoured(monkeypatch):
    chat = one_chat(TAGS)
    monkeypatch.setattr(_common, "chat", chat)
    tagging.run_tagging(
        payload(prompt={"system": "You are a bespoke tagger.", "model": "acme/tagger-1"})
    )

    assert chat.calls[0]["system"] == "You are a bespoke tagger."
    assert chat.calls[0]["model"] == "acme/tagger-1"
