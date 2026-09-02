"""Every tunable this service reads is one `config_check` has heard of.

`config_check.SPECS` is the boot-time validator, and its whole argument is that
a helper which falls back on an unusable value tells nobody: not *when* it
happens (the helper validates on its first call, which may be hours in, or
never), and not *which way* the fallback points (`OPENROUTER_TOKEN_BUDGET`
mistyped reads as unlimited). Both of those are true of a variable that is
absent from `SPECS` as well — with the additional property that nothing will
ever notice, because the roster is a hand-written tuple and a hand-written
tuple is a list of the settings somebody remembered.

It had already drifted. `MARKET_FEED_FETCH_TIMEOUT_S` and
`MARKET_FEED_MULTIPLES_BUDGET_S` — the two ceilings that decide how long one
request may hold a threadpool slot against a hung upstream — were added in
R314 and R331 and appeared in neither roster nor test. That is the same vacuity
`preflight.ts` names for systemd units in the other tier: *a check whose scope
is a hardcoded list silently narrows to nothing the moment reality grows past
it*, and the answer there was the same as the answer here — read the estate,
not the list.

So the population is derived from the source: the environment variable names
this service actually reads, each of which must be either specced or declared
below with a reason it is not. The next tunable added fails this test on the
commit that first reads it.

The scan is `test_secret_env_census.py`'s, and it has the same two things to
get right. Names can be indirections — `market_feed` reads its ceilings through
`FETCH_TIMEOUT_ENV = "MARKET_FEED_FETCH_TIMEOUT_S"` precisely so
`envExample.test.ts` can see them — so module-level string constants are
resolved. And the population must not be the whole uppercase vocabulary of the
service: this module holds forty ticker symbols as bare uppercase literals, so
a name is counted when the call is a direct environment read, or when it looks
like an environment variable (an underscore in it) and is the first argument of
a call. `PORT` is the one name in this service that a rule keyed on the
underscore would miss, and it is read directly, so it is in.
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
    # value, which is exactly what must not happen to a credential. Both of
    # these have their own guards — `internal_auth.enforce_token_configured`
    # and the metrics scrape gate.
    "INTERNAL_SERVICE_TOKEN": "a credential; a complaint would quote it",
    "METRICS_TOKEN": "a credential; a complaint would quote it",
    # Build provenance, not configuration. Any string is a valid answer and
    # `build_info` already reports an unreadable file as unknown.
    "BUILD_SHA": "build provenance; every string is valid",
    "BUILD_SHA_FILE": "build provenance; a path, checked by reading it",
    # Read by `healthcheck.py`, which is the script systemd's `ExecStartPre`
    # runs, not the service. It is set by the unit and validated by the socket
    # failing to bind, which is a boot failure already.
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
    # One read through each idiom this service uses: a bare literal, a
    # module-level constant passed to a helper, and a direct read of a name
    # with no underscore in it.
    for name in ("RATE_LIMIT_RPM", "MARKET_FEED_MULTIPLES_BUDGET_S", "PORT"):
        assert name in found, name
    assert len(found) >= 10


def test_no_ticker_symbol_is_mistaken_for_a_variable():
    """The other half of the same guard: a population widened until it passes
    by including everything is a list nobody will keep accurate.
    """
    found = _env_names_read()
    for ticker in ("DDOG", "CRM", "NOW", "CAT"):
        assert ticker not in found, ticker


def test_every_declared_exemption_is_still_read():
    """An exemption for a variable nothing reads any more is a line that only
    protects the next variable that happens to be spelt the same.
    """
    stale = sorted(set(DECLARED_UNSPECCED) - _env_names_read())
    assert stale == [], f"declared unspecced but read by nothing: {stale}"


def test_every_exemption_carries_a_reason():
    assert all(reason.strip() for reason in DECLARED_UNSPECCED.values())
