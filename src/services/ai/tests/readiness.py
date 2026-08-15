"""Reading `/ready` as an operator (round 74).

`/ready` publishes check names and pass/fail to anyone, and the reasons only to
a caller holding the estate's shared secret — see `main.ready`. Tests that
assert on a *reason* are therefore asserting on the operator view, and have to
ask for it the way an operator does.

Setting the secret here also arms `internal_token_middleware`, which is
harmless: `/ready` is one of its public paths, so the gate lets the probe past
either way. That is the whole point of the split — the load balancer never
needs the secret, and never gets the detail.
"""

from __future__ import annotations

OPERATOR_TOKEN = "round74-operator-token"


def operator_ready(client, monkeypatch):
    """GET /ready with the internal token, i.e. the full operator snapshot."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", OPERATOR_TOKEN)
    return client.get("/ready", headers={"X-Internal-Token": OPERATOR_TOKEN})


def operator_checks(client, monkeypatch) -> dict:
    return operator_ready(client, monkeypatch).json()["checks"]
