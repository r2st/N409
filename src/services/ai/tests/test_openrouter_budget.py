"""Token ceiling / budget accounting for the OpenRouter client (audit B-2 P2).

Plus the census that makes the ceiling a property of the *service* rather than
of whoever remembered. Two of the three providers here were added without one:
Bedrock (R236) and Perplexity (R246), each on the grounds that it was somebody
else's job, and each billed to a real account the whole time it was outside.
"""

import json
import re
from pathlib import Path

import pytest

from app import openrouter
from app.openrouter import LlmResult, TokenBudgetExceeded, chat, max_output_tokens, tokens_used


class _FakeResponse:
    def __init__(self, payload):
        self.status_code = 200
        self.headers: dict[str, str] = {}
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _FakeClient:
    """Records the JSON body of the last request and returns a canned completion."""

    def __init__(self, completion="{}", usage=None):
        self.last_json = None
        self._completion = completion
        self._usage = usage or {"prompt_tokens": 10, "completion_tokens": 5}

    def post(self, url, headers=None, json=None, timeout=None):  # noqa: A002 - httpx signature
        self.last_json = json
        return _FakeResponse(
            {
                "model": "test/model",
                "choices": [{"message": {"content": self._completion}}],
                "usage": self._usage,
            }
        )


@pytest.fixture(autouse=True)
def _reset_budget(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    openrouter._budget._used = 0
    yield
    openrouter._budget._used = 0


def test_max_output_tokens_default_and_override(monkeypatch):
    monkeypatch.delenv("OPENROUTER_MAX_TOKENS", raising=False)
    assert max_output_tokens() == 2000
    monkeypatch.setenv("OPENROUTER_MAX_TOKENS", "512")
    assert max_output_tokens() == 512
    monkeypatch.setenv("OPENROUTER_MAX_TOKENS", "0")
    assert max_output_tokens() == 2000


def test_chat_sends_max_tokens_and_records_usage(monkeypatch):
    monkeypatch.setenv("OPENROUTER_MAX_TOKENS", "256")
    client = _FakeClient(completion='{"ok": true}')
    result = chat("sys", "user", client=client)
    assert isinstance(result, LlmResult)
    assert client.last_json["max_tokens"] == 256
    assert result.prompt_tokens == 10
    assert result.completion_tokens == 5
    assert result.total_tokens == 15
    assert tokens_used() == 15


def test_budget_exhaustion_raises_before_spending(monkeypatch):
    monkeypatch.setenv("OPENROUTER_TOKEN_BUDGET", "20")
    client = _FakeClient()
    # First call spends 15 (<20), allowed.
    chat("sys", "user", client=client)
    assert tokens_used() == 15
    # Budget now exhausted (15 >= 20 is false, but next check: 15 < 20 passes,
    # spends to 30). Third call is blocked.
    chat("sys", "user", client=client)
    assert tokens_used() == 30
    with pytest.raises(TokenBudgetExceeded):
        chat("sys", "user", client=client)


def test_unset_budget_is_unlimited(monkeypatch):
    monkeypatch.delenv("OPENROUTER_TOKEN_BUDGET", raising=False)
    client = _FakeClient()
    for _ in range(5):
        chat("sys", "user", client=client)
    assert tokens_used() == 75


APP = Path(__file__).resolve().parents[1] / "app"


def test_every_module_that_reads_a_usage_block_charges_a_ledger():
    """A module that reads what a call cost is a module that spends money.

    That is the one signal available in the source, and it is a good one: the
    `usage` block is the provider telling us the bill. Two providers read it
    and charged nobody — `/ready` reported no spend for either, and no ceiling
    anywhere would have stopped a loop through them. The next provider's author
    does not have to know this rule; the census tells them.
    """
    offenders = []
    for path in sorted(APP.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        if not re.search(r'\busage\.get\(\s*["\']', text):
            continue
        if "TokenLedger(" not in text:
            offenders.append(str(path.relative_to(APP)))
    assert offenders == [], (
        "these read a provider's token usage but charge no ledger, so their spend "
        "is invisible to /ready and bounded by nothing:\n  " + "\n  ".join(offenders)
    )


def test_every_ledger_names_a_variable_the_deployment_contract_documents():
    """The ceiling only bounds anything if an operator can set it.

    `envExample.test.ts` scans for `TokenLedger("NAME")` for the same reason
    and from the other side; this end fails first and says which provider.
    """
    names = set()
    for path in sorted(APP.rglob("*.py")):
        names.update(
            re.findall(r'TokenLedger\(\s*["\']([A-Z][A-Z0-9_]{2,})["\']', path.read_text(encoding="utf-8"))
        )
    documented = (Path(__file__).resolve().parents[4] / ".env.example").read_text(encoding="utf-8")
    missing = sorted(n for n in names if f"\n{n}=" not in documented)
    assert missing == [], f"spend ceilings absent from .env.example: {missing}"
