"""A model that answered in JSON, of a shape the prompt did not ask for.

Round 216, methodology M5. Every prompt in `pipelines.py` and every agent asks
for a JSON *object*, and each caller reads its keys behind an
`isinstance(parsed, dict)` guard — so anything else takes the empty branch and
the run produces a complete-looking result with nothing in it. R197 closed the
truncation route into that empty success. This is the third one.

`extract_json` returned whatever `json.loads` produced; its `dict | list`
annotation was a claim, not a check. A model answering a `{"summaries": [...]}`
prompt with the bare array — among the most ordinary things a model does with a
wrapped-list schema — came back as a list, and `null`, a bare number and a
quoted string all landed the same way.

None of those is prose, so none is the `notes` degradation's case: that exists
for a model that ignored "respond ONLY with JSON" and wrote a sentence, and it
is what keeps the analyst's answer from being thrown away. A wrong-shaped JSON
answer is the model misbehaving in a way a retry can fix, which is what a 502
says.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.openrouter import LlmResult
from app.pipelines import TruncatedCompletionError, _safe_result
from app import pipelines


@pytest.fixture
def client():
    return TestClient(app)


def said(content: str, *, finish_reason: str | None = None) -> LlmResult:
    return LlmResult(model="test/fake-model", content=content, finish_reason=finish_reason)


class TestWhatComesBack:
    def test_an_object_is_the_contract_and_passes_through(self):
        assert _safe_result(said('{"gaps": [], "notes": "fine"}')) == {"gaps": [], "notes": "fine"}

    def test_prose_still_degrades_to_notes(self):
        """Unchanged, and the reason the refusals below are narrow: a model that
        wrote a sentence instead of JSON still hands the analyst what it said."""
        out = _safe_result(said("I could not read these documents."))
        assert out == {"notes": "I could not read these documents."}

    @pytest.mark.parametrize(
        "content,kind",
        [
            ('[{"filename": "deck.pdf", "summary": "..."}]', "list"),
            ("null", "NoneType"),
            ("42", "int"),
            ("1.5", "float"),
            ('"I could not read these documents."', "str"),
            ("true", "bool"),
        ],
    )
    def test_a_non_object_answer_is_refused_and_names_what_arrived(self, content, kind):
        with pytest.raises(ValueError) as caught:
            _safe_result(said(content))
        assert f"JSON {kind}" in str(caught.value)
        assert not isinstance(caught.value, TruncatedCompletionError)

    def test_a_fenced_array_is_refused_too(self):
        """The markdown fence is stripped before the parse, so the shape check
        has to sit after it rather than on the raw content."""
        with pytest.raises(ValueError):
            _safe_result(said('```json\n[1, 2, 3]\n```'))

    def test_truncation_still_wins_when_both_are_true(self):
        """A cut-off array can close and parse. The truncation is the better
        explanation and the only one with an action attached, and its own type
        is what keeps `main` answering 422 instead of a retried 502."""
        with pytest.raises(TruncatedCompletionError):
            _safe_result(said("[1, 2", finish_reason="length"))
        with pytest.raises(TruncatedCompletionError):
            _safe_result(said("[1, 2, 3]", finish_reason="length"))


class TestWhichCapWasHit:
    """The refusal names an operator's actual knob, or it names nothing useful.

    `_safe_result` quoted `OPENROUTER_MAX_TOKENS` and OpenRouter's cap for every
    truncation, including one produced by a prompt bound to a `bedrock/` model —
    an instruction to raise a variable that provider never reads, and a token
    figure that is not the one the answer stopped at.
    """

    def test_an_openrouter_truncation_names_the_openrouter_cap(self, monkeypatch):
        monkeypatch.setenv("OPENROUTER_MAX_TOKENS", "512")
        with pytest.raises(TruncatedCompletionError) as caught:
            _safe_result(said("{", finish_reason="length"))
        assert "OPENROUTER_MAX_TOKENS" in str(caught.value)
        assert "512" in str(caught.value)

    def test_a_bedrock_truncation_names_the_bedrock_cap(self, monkeypatch):
        monkeypatch.setenv("OPENROUTER_MAX_TOKENS", "512")
        monkeypatch.setenv("BEDROCK_MAX_TOKENS", "4096")
        cut = LlmResult(
            model="bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
            content="{",
            finish_reason="max_tokens",
        )
        with pytest.raises(TruncatedCompletionError) as caught:
            _safe_result(cut)
        assert "BEDROCK_MAX_TOKENS" in str(caught.value)
        assert "4096" in str(caught.value)
        assert "OPENROUTER_MAX_TOKENS" not in str(caught.value)


class TestThroughTheRoute:
    """What the valuation service is told, which is what decides retry."""

    def _run(self, monkeypatch, client, content, pipeline="summarize"):
        monkeypatch.setattr(
            pipelines, "chat", lambda system, user, **kw: said(content)
        )
        return client.post(f"/ai/v1/pipelines/{pipeline}", json={"valuation": {"company_name": "Acme"}})

    def test_a_bare_array_is_a_502_rather_than_an_empty_success(self, monkeypatch, client):
        """The failure. Before this it was a 200 carrying
        `{"summaries": [], "overall": ""}` — a document summary with no
        documents in it, recorded as a succeeded job."""
        resp = self._run(monkeypatch, client, '[{"filename": "deck.pdf", "summary": "A deck."}]')
        assert resp.status_code == 502
        assert "unusable" in resp.json()["detail"]

    def test_the_detail_says_what_the_model_actually_sent(self, monkeypatch, client):
        resp = self._run(monkeypatch, client, "null")
        assert "JSON NoneType" in resp.json()["detail"]

    def test_prose_is_still_a_200(self, monkeypatch, client):
        resp = self._run(monkeypatch, client, "The documents were unreadable.")
        assert resp.status_code == 200

    def test_a_well_shaped_answer_is_still_a_200(self, monkeypatch, client):
        body = json.dumps({"summaries": [], "overall": "Nothing was uploaded."})
        resp = self._run(monkeypatch, client, body)
        assert resp.status_code == 200
        assert resp.json()["result"]["overall"] == "Nothing was uploaded."
