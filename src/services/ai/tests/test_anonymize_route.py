"""/ai/v1/anonymize — the operator-facing redaction route (parity gap #22).

`test_anonymize.py` covers what the redactor strikes. This file covers the two
things that are only true of the route: that a cap table's *figures* come back
untouched while its identities do not, and that no model is involved in
deciding either.
"""

import base64

import pytest
from fastapi.testclient import TestClient

from app.anonymize import MAX_KNOWN_ENTITIES
from app.main import MAX_REQUEST_DOCUMENTS, app

client = TestClient(app)

CAP_TABLE = """Acme Robotics, Inc. — Capitalization Table
Holder,Class,Shares,Price
Ada Lovelace <ada@acmerobotics.com>,Common,2500000,0.0001
Grace Hopper,Common,1750000,0.0001
Sequoia Capital,Series A Preferred,4200000,1.2345
Contact: (415) 555-0142, 500 Sand Hill Road, Menlo Park, CA 94025
"""


def _doc(filename: str, text: str, kind: str = "cap_table") -> dict:
    return {
        "id": filename,
        "filename": filename,
        "kind": kind,
        "content_base64": base64.b64encode(text.encode()).decode(),
    }


@pytest.fixture(autouse=True)
def _not_enforced(monkeypatch):
    """Neither enforcement env var set — the route redacts regardless, and the
    report should say `enforced: false` rather than inherit a stray value."""
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("ANONYMIZE_ENFORCE", raising=False)


def test_text_is_redacted_and_figures_survive():
    res = client.post(
        "/ai/v1/anonymize",
        json={
            "text": CAP_TABLE,
            "company_names": ["Acme Robotics, Inc."],
            "person_names": ["Ada Lovelace", "Grace Hopper"],
        },
    )
    assert res.status_code == 200
    body = res.json()
    out = body["text"]

    for identity in ("Acme Robotics", "Ada Lovelace", "Grace Hopper", "ada@acmerobotics.com"):
        assert identity not in out
    # The share counts and prices are the reason this cannot go through a model:
    # they must come back character-for-character.
    for figure in ("2500000", "1750000", "4200000", "0.0001", "1.2345"):
        assert figure in out

    report = body["anonymization"]
    assert report["applied"] is True
    assert report["enforced"] is False
    assert report["redacted"]["companies"] >= 1
    assert report["redacted"]["names"] >= 2
    assert report["redacted"]["emails"] == 1
    assert report["redacted"]["phones"] == 1
    assert report["redacted"]["addresses"] >= 1


def test_documents_are_extracted_and_both_filenames_returned():
    res = client.post(
        "/ai/v1/anonymize",
        json={
            "documents": [_doc("Acme Robotics Cap Table.csv", CAP_TABLE)],
            "company_names": ["Acme Robotics, Inc."],
        },
    )
    assert res.status_code == 200
    doc = res.json()["documents"][0]

    # The filename is redacted through the same tally: a sheet whose every row
    # was struck is re-identified by the name of the file it arrived in.
    assert "Acme Robotics" not in doc["filename"]
    assert doc["filename"] == "[COMPANY] Cap Table.csv"
    # …and the original travels back, because it is what the operator
    # recognises in the list they just submitted.
    assert doc["original_filename"] == "Acme Robotics Cap Table.csv"
    assert doc["kind"] == "cap_table"
    assert doc["chars"] == len(CAP_TABLE.strip())
    assert "Acme Robotics" not in doc["text"]
    assert "4200000" in doc["text"]


def test_no_known_entities_still_redacts_the_regex_layer():
    """An operator who pastes a sheet without naming the issuer still gets the
    structured PII struck — the half that needs no prior knowledge."""
    res = client.post("/ai/v1/anonymize", json={"text": CAP_TABLE})
    assert res.status_code == 200
    body = res.json()
    assert "ada@acmerobotics.com" not in body["text"]
    # …and the company name survives, which is exactly why naming it matters.
    assert "Acme Robotics" in body["text"]
    assert "companies" not in body["anonymization"]["redacted"]


def test_empty_request_is_a_clean_no_op():
    res = client.post("/ai/v1/anonymize", json={})
    assert res.status_code == 200
    assert res.json() == {
        "text": "",
        "documents": [],
        "anonymization": {
            "applied": True,
            "redacted": {},
            "declared": {"companies": 0, "people": 0},
            "enforced": False,
        },
    }


def test_idempotent_over_its_own_output():
    """Re-running the route over what it just returned finds nothing left to
    strike — so a caller may safely anonymize at more than one point."""
    payload = {"text": CAP_TABLE, "company_names": ["Acme Robotics, Inc."]}
    once = client.post("/ai/v1/anonymize", json=payload).json()
    twice = client.post("/ai/v1/anonymize", json={**payload, "text": once["text"]}).json()
    assert twice["text"] == once["text"]
    assert twice["anonymization"]["redacted"] == {}


def test_too_many_known_entities_is_422():
    """Refused rather than truncated — see MAX_KNOWN_ENTITIES. A response
    reporting redaction while quietly dropping the tail of the list is the
    failure this bound exists to prevent."""
    res = client.post(
        "/ai/v1/anonymize",
        json={"text": "x", "person_names": [f"Person {i}" for i in range(MAX_KNOWN_ENTITIES + 1)]},
    )
    assert res.status_code == 422
    assert str(MAX_KNOWN_ENTITIES) in res.json()["detail"]


def test_enforcement_is_reported_not_negotiable(monkeypatch):
    """The route has no `options` block to switch redaction off, so the only
    thing enforcement changes is what the report says about why.

    Set through ANONYMIZE_ENFORCE rather than APP_ENV because the latter also
    arms the internal-token gate, and this test is about the redactor.
    """
    monkeypatch.setenv("ANONYMIZE_ENFORCE", "1")
    res = client.post("/ai/v1/anonymize", json={"text": "reach me at ada@example.com"})
    assert res.status_code == 200
    body = res.json()
    assert body["text"] == "reach me at [EMAIL]"
    assert body["anonymization"]["enforced"] is True


def test_options_anonymize_false_is_ignored():
    """An unknown field, not an escape hatch: unlike /ai/v1/test and the
    pipelines, this route cannot be asked to hand its input back."""
    res = client.post(
        "/ai/v1/anonymize",
        json={"text": "ada@example.com", "options": {"anonymize": False}},
    )
    assert res.status_code == 200
    assert res.json()["text"] == "[EMAIL]"


def test_document_list_ceilings_are_the_same_on_both_routes():
    """The pipeline route bounds its corpus the way `/anonymize` always has.

    The ceiling on the other side of this wire is `MAX_AI_DOCUMENTS` (10) in the
    valuation service, the only caller either route has. `/anonymize` stated its
    own; the pipeline route — the one that actually runs the corpus through a
    model — stated none, so the sender's cap was the whole guarantee and this
    side would have taken whatever fitted in the 32 MiB body.

    Asserted as a 422 on both, from one constant, so the pair cannot drift back
    apart: a bound that holds only because of what `extract_texts` does
    downstream is not a bound on this contract.
    """
    over = [_doc(f"sheet-{i}.csv", CAP_TABLE) for i in range(MAX_REQUEST_DOCUMENTS + 1)]
    for url, payload in (
        ("/ai/v1/anonymize", {"text": "", "documents": over}),
        ("/ai/v1/pipelines/cap_table", {"valuation": {"company_name": "Acme"}, "documents": over}),
    ):
        res = client.post(url, json=payload)
        assert res.status_code == 422, (url, res.status_code)
        assert "documents" in res.text
