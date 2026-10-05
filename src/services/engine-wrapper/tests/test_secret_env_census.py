"""Every credential this service reads from the environment is on the redaction net.

Ported from ``services/ai/tests/test_secret_env_census.py`` (R367, methodology
M4). The AI service has had this guard since R241; the engine-wrapper did not,
even though it carries the same ``_SECRET_ENV_VARS`` tuple. A future commit
adding a credential env var to this service would have gone unnoticed — exactly
the gap the AI tier's census was written to close.
"""

from __future__ import annotations

import ast
import pathlib

from app.observability import _SECRET_ENV_VARS

APP = pathlib.Path(__file__).resolve().parents[1] / "app"

CREDENTIAL_SUFFIXES = (
    "_API_KEY",
    "_SECRET",
    "_SECRET_KEY",
    "_SECRET_ACCESS_KEY",
    "_SESSION_TOKEN",
    "_SERVICE_TOKEN",
    "_PASSWORD",
)

DECLARED_NON_SECRETS = {
    "AWS_ACCESS_KEY_ID": "an identifier AWS itself echoes; struck by shape instead",
}

# Variables the AI tier reads that this service does not, kept on the
# literal-value net because both services share an environment and the value
# could appear in a library error or a traceback this service's formatter sees.
# Each entry must name the service that owns it.
SHARED_ENVIRONMENT_VARS = {
    "OPENROUTER_API_KEY": "AI service — completion provider key, present in shared env",
    "AWS_SECRET_ACCESS_KEY": "AI service — Bedrock signing, present in shared env",
    "AWS_SESSION_TOKEN": "AI service — Bedrock STS session, present in shared env",
    "PERPLEXITY_API_KEY": "AI service — research provider key, present in shared env",
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
        if isinstance(node, ast.Call) and node.args:
            name = named(node.args[0])
            if name and name.isupper():
                found.add(name)
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
    found = _credential_env_names()
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


def test_the_net_does_not_list_something_unaccounted_for() -> None:
    """Every entry is either read by this service or declared as shared-env."""
    read = set()
    for path in sorted(APP.rglob("*.py")):
        read |= _env_names_read_by(path)
    unaccounted = [
        name
        for name in _SECRET_ENV_VARS
        if name not in read and name not in SHARED_ENVIRONMENT_VARS
    ]
    assert not unaccounted, (
        f"`_SECRET_ENV_VARS` names variables this service neither reads nor declares "
        f"as shared-environment: {unaccounted}. If the AI tier owns it and both services "
        f"share an environment, add it to SHARED_ENVIRONMENT_VARS with its owner."
    )
