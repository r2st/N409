"""Every tunable this service reads is one `config_check` has heard of.

`config_check.SPECS` is the boot-time validator, and its whole argument is that
a helper which falls back on an unusable value tells nobody: not *when* it
happens (the helper validates on its first call, which may be hours in, or
never), and not *which way* the fallback points — `OPENROUTER_TOKEN_BUDGET`
mistyped reads as unlimited, which is that module's own opening example. Both
of those are true of a variable that is absent from `SPECS` as well, with the
additional property that nothing will ever notice: the roster is a hand-written
tuple, so it is a list of the settings somebody remembered.

It is the same hand-written tuple `_SECRET_ENV_VARS` was, one file over, and
that one was short twice for the same reason before `test_secret_env_census.py`
derived it from the source. This roster had five gaps of its own — the Bedrock
and Sonar per-call ceilings, and `MAX_RESPONSE_BYTES`, which is the bound on
how much of a far end's answer this process will hold in memory.

So the population is derived from the source: every environment variable this
service reads must be either specced or declared below with a reason it is not
a tunable. The next one added fails this test on the commit that first reads
it.

The scan is `test_secret_env_census.py`'s and has the same indirection to
resolve — `websearch` reads its base URL through `SEARXNG_URL_VAR`, and
`TokenLedger("…_TOKEN_BUDGET")` names its variable as a constructor argument
rather than through `os.environ` at all. A name is counted when the call is a
direct environment read, or when it looks like a variable (an underscore in it)
and is a call's first argument; the underscore is what keeps the engine tier's
copy of this test from counting forty ticker symbols, and it costs `PORT`,
which is read directly and so is in anyway.
"""

from __future__ import annotations

import ast
import pathlib

from app.config_check import SPECS

APP = pathlib.Path(__file__).resolve().parents[1] / "app"

# Variables this service reads that `config_check` deliberately does not judge.
# Each carries its reason: these reasons are the only record of what this
# platform decided is not a tunable, and an entry without one is a variable
# somebody wanted out of the way.
DECLARED_UNSPECCED = {
    # `config_check`'s own rule, and it has a test of its own
    # (`test_no_spec_covers_a_secret`): a complaint here quotes the offending
    # value, which is exactly what must not happen to a credential. These are
    # the redaction net's population, and `test_secret_env_census.py` is what
    # keeps *that* list honest.
    "INTERNAL_SERVICE_TOKEN": "a credential; a complaint would quote it",
    "METRICS_TOKEN": "a credential; a complaint would quote it",
    "OPENROUTER_API_KEY": "a credential; a complaint would quote it",
    "PERPLEXITY_API_KEY": "a credential; a complaint would quote it",
    "AWS_ACCESS_KEY_ID": "an AWS identifier; paired with the secret below",
    "AWS_SECRET_ACCESS_KEY": "a credential; a complaint would quote it",
    "AWS_SESSION_TOKEN": "a credential; a complaint would quote it",
    # Free-form identifiers. Every non-empty string is syntactically a model
    # id, and whether the id exists is answered by the provider — a request for
    # a model the account cannot reach comes back as the provider's own
    # refusal. There is no shape rule this module could apply that the reader
    # does not already apply.
    "OPENROUTER_MODEL": "a model id; only the provider knows which exist",
    "BEDROCK_MODEL": "a model id; only the provider knows which exist",
    "PERPLEXITY_MODEL": "a model id; only the provider knows which exist",
    "RESEARCH_SYNTHESIS_MODEL": "a model id; only the provider knows which exist",
    # Endpoints and a region. Same argument: any string is a syntactically
    # valid host or region name, and a wrong one is a connection that fails
    # with the value in the message rather than a default silently taken.
    "ENGINE_URL": "an endpoint; a wrong one fails loudly at the first call",
    "SEARXNG_URL": "an endpoint; a wrong one fails loudly at the first call",
    "BEDROCK_REGION": "an AWS region; absence is how the provider is left off",
    # Build provenance, not configuration. Any string is a valid answer and
    # `build_info` already reports an unreadable file as unknown.
    "BUILD_SHA": "build provenance; every string is valid",
    "BUILD_SHA_FILE": "build provenance; a path, checked by reading it",
    # Read by `healthcheck.py`, the script systemd runs, not by the service.
    # Set by the unit and validated by the socket failing to bind.
    "PORT": "the listening port; a bad value is a boot that does not bind",
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

    def direct(fn: ast.expr) -> bool:
        """`os.environ.get(...)` / `os.getenv(...)` / `environ.get(...)`."""
        if isinstance(fn, ast.Attribute):
            if fn.attr == "getenv":
                return True
            if fn.attr == "get":
                target = fn.value
                if isinstance(target, ast.Attribute) and target.attr == "environ":
                    return True
                if isinstance(target, ast.Name) and target.id == "environ":
                    return True
        return isinstance(fn, ast.Name) and fn.id == "getenv"

    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and node.args:
            name = named(node.args[0])
            # A direct read names an environment variable whatever it looks
            # like; anything else — `env_int(NAME, …)`, `TokenLedger(NAME)`,
            # `_seconds(NAME, …)` — has to look like one, or every ticker
            # symbol in this service joins the population.
            if name and name.isupper() and (direct(node.func) or "_" in name):
                found.add(name)
        if isinstance(node, ast.Subscript):
            target = node.value
            if isinstance(target, ast.Attribute) and target.attr == "environ":
                name = named(node.slice)
                if name:
                    found.add(name)
    return found


def _env_names_read() -> set[str]:
    names: set[str] = set()
    for path in sorted(APP.rglob("*.py")):
        names |= _env_names_read_by(path)
    return names


def test_every_variable_this_service_reads_is_specced_or_declared():
    specced = {spec.name for spec in SPECS}
    unaccounted = sorted(_env_names_read() - specced - set(DECLARED_UNSPECCED))
    assert unaccounted == [], (
        "these environment variables are read by this service and judged by nothing at boot; "
        "add an EnvSpec, or declare them in DECLARED_UNSPECCED with the reason they are not "
        f"tunables: {unaccounted}"
    )


def test_the_scan_finds_the_variables_it_is_supposed_to_find():
    """Vacuity guard. A scanner blinded by a helper refactor reads nothing and
    passes, which is the failure mode `n409-env-scanner-idioms` records for the
    contract scanner on the other tier.
    """
    found = _env_names_read()
    # One read through each idiom this service uses: a bare literal in
    # `os.environ.get`, a module-level constant, a name handed to `env_int`, a
    # name handed to `TokenLedger`'s constructor, and a direct read of a name
    # with no underscore in it.
    for name in (
        "RATE_LIMIT_RPM",
        "SEARXNG_URL",
        "RESEARCH_MAX_RESULTS",
        "OPENROUTER_TOKEN_BUDGET",
        "PORT",
    ):
        assert name in found, name
    assert len(found) >= 25


def test_every_declared_exemption_is_still_read():
    """An exemption for a variable nothing reads any more is a line that only
    protects the next variable that happens to be spelt the same.
    """
    stale = sorted(set(DECLARED_UNSPECCED) - _env_names_read())
    assert stale == [], f"declared unspecced but read by nothing: {stale}"


def test_every_exemption_carries_a_reason():
    assert all(reason.strip() for reason in DECLARED_UNSPECCED.values())
