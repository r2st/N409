"""Every credential this service reads from the environment is on the redaction net.

`redact` has two halves and only one of them can be reasoned about ahead of
time. The shape rules know `Bearer …`, `sk-…`, `pplx-…` and SigV4 — the shapes
this estate produces — and the literal-value net (`_SECRET_ENV_VARS`) exists
for everything else: "an AWS secret access key is forty characters of base64
with no prefix to recognise", as R241 put it, "so only the literal value can
catch it".

That net is a hand-written tuple, and a hand-written tuple is a list of the
providers somebody remembered. It has now been short twice for the same reason.
R236 added Bedrock with three credential variables and named none of them;
R241 added those three and read "a second completion provider" as the whole of
what had arrived — while `PERPLEXITY_API_KEY`, restored three weeks earlier and
held, sent and verified by this service ever since, sat in neither half.

So membership is derived from the source instead of from anybody noticing. The
scan reads the environment variable names this service actually reads, keeps
the ones whose *name* says credential, and requires each to be either on the
net or declared here with a reason it is not a secret. The next provider's key
fails this test on the commit that first reads it, which is several rounds
earlier than a person tends to look.

Two things it has to get right, both of them the reason a grep would not do:

  * **The name can be an indirection.** `internal_auth.py` reads its token
    through `INTERNAL_TOKEN_ENV = "INTERNAL_SERVICE_TOKEN"`, so a scan that
    only reads string literals inside `os.environ.get(...)` is blind to the one
    credential every service holds. Module-level string constants are resolved.
    (This is the same blind spot `n409-env-scanner-idioms` records on the other
    tier: the contract is matched by idiom, and a helper refactor blinds it.)

  * **A name containing KEY or TOKEN is not necessarily a credential.**
    `OPENROUTER_MAX_TOKENS` is a *count* and `AI_REQUIRE_OPENROUTER_KEY` is a
    boolean about whether one is required — the trap `test_config_check.py`
    already records having fallen into. So the rule is a suffix family, and the
    two survivors of it are declared below rather than being matched away by a
    looser pattern that would also let a real credential through.
"""

from __future__ import annotations

import ast
import pathlib

from app.observability import _SECRET_ENV_VARS

APP = pathlib.Path(__file__).resolve().parents[1] / "app"

# Name endings that mean "this value is a credential". Endings rather than
# substrings: `_MAX_TOKENS` ends in TOKENS and holds an integer, and a rule that
# read it as a secret is a rule somebody switches off.
CREDENTIAL_SUFFIXES = (
    "_API_KEY",
    "_SECRET",
    "_SECRET_KEY",
    "_SECRET_ACCESS_KEY",
    "_SESSION_TOKEN",
    "_SERVICE_TOKEN",
    "_PASSWORD",
)

# Names that end like a credential and are not one. Each needs a reason, for the
# same purpose the exemption reasons in the other tier's censuses serve: the
# reasons are the only record of what this platform decided counts as a secret.
DECLARED_NON_SECRETS = {
    # An identifier, not a credential — AWS publishes it in the very error
    # bodies `redact` cleans. It is matched by shape (`AKIA…`/`ASIA…`) anyway,
    # and putting it on the literal net would run a substring comparison against
    # a value short enough to appear in ordinary text.
    "AWS_ACCESS_KEY_ID": "an identifier AWS itself echoes; struck by shape instead",
}


def _env_names_read_by(path: pathlib.Path) -> set[str]:
    """Environment variable names read in one module, constants resolved."""
    tree = ast.parse(path.read_text())
    constants: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            if isinstance(node.value.value, str):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        constants[target.id] = node.value.value

    def named(node: ast.expr) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            return constants.get(node.id)
        return None

    found: set[str] = set()
    for node in ast.walk(tree):
        # os.environ.get(NAME) / os.getenv(NAME) / env_int(NAME, …)
        if isinstance(node, ast.Call) and node.args:
            name = named(node.args[0])
            if name and name.isupper():
                found.add(name)
        # os.environ[NAME]
        if isinstance(node, ast.Subscript):
            name = named(node.slice)
            if name and name.isupper():
                found.add(name)
    return found


def _credential_env_names() -> set[str]:
    names: set[str] = set()
    for path in sorted(APP.rglob("*.py")):
        names |= _env_names_read_by(path)
    return {n for n in names if n.endswith(CREDENTIAL_SUFFIXES)}


def test_the_scan_still_sees_the_credentials_it_was_written_for() -> None:
    """A census that finds nothing passes for the wrong reason.

    Both of these are read through shapes the scan has to handle — one as a
    literal, one through a module constant — so this is the check that the
    reader still works before the rule below is believed.
    """
    found = _credential_env_names()
    assert "OPENROUTER_API_KEY" in found
    assert "INTERNAL_SERVICE_TOKEN" in found, "the constant indirection stopped resolving"


def test_every_credential_read_here_is_on_the_redaction_net() -> None:
    unlisted = {
        name
        for name in _credential_env_names()
        if name not in _SECRET_ENV_VARS and name not in DECLARED_NON_SECRETS
    }
    assert not unlisted, (
        "credential-shaped environment variables this service reads but "
        f"`observability._SECRET_ENV_VARS` has never been told about: {sorted(unlisted)}. "
        "Add each to the net, or declare it in DECLARED_NON_SECRETS with the reason "
        "it is not a secret."
    )


def test_the_net_does_not_list_something_nothing_reads() -> None:
    """A stale entry is a claim about a provider that has gone.

    Cheap to hold and worth holding: the net is read per line at runtime, so an
    entry for a variable nothing reads is a lookup on every log record and a
    reader's belief that a credential is covered somewhere.
    """
    read = set()
    for path in sorted(APP.rglob("*.py")):
        read |= _env_names_read_by(path)
    stale = [name for name in _SECRET_ENV_VARS if name not in read]
    assert not stale, f"`_SECRET_ENV_VARS` names variables nothing in app/ reads: {stale}"
